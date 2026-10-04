import { test } from "node:test";
import assert from "node:assert/strict";
import { MeshCoreClient, MeshCoreError, TimeoutError, TransportClosedError } from "./client.js";
import { ByteWriter, fromHex } from "./protocol/bytes.js";
import { Cmd, Push, Resp } from "./protocol/codes.js";
import { BaseTransport } from "./transport.js";

/** A radio that answers by script: each command code maps to the frames it writes back. */
class FakeRadio extends BaseTransport {
  readonly kind = "serial" as const;
  readonly label = "fake";
  sent: Uint8Array[] = [];
  script = new Map<number, (frame: Uint8Array) => Uint8Array[]>();
  delayMs = 0;

  async send(frame: Uint8Array): Promise<void> {
    this.sent.push(frame);
    const handler = this.script.get(frame[0]!);
    if (!handler) return;
    const replies = handler(frame);
    const deliver = () => {
      for (const reply of replies) this.emitFrame(reply);
    };
    if (this.delayMs) setTimeout(deliver, this.delayMs);
    else queueMicrotask(deliver);
  }

  push(frame: Uint8Array): void {
    this.emitFrame(frame);
  }

  drop(reason: Error | null): void {
    this.emitClose(reason);
  }

  protected async shutdown(): Promise<void> {}
}

const KEY = fromHex("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");

function contactFrame(name: string): Uint8Array {
  return new ByteWriter()
    .u8(Resp.Contact)
    .bytes(KEY)
    .u8(1)
    .u8(0)
    .u8(0xff)
    .zeros(64)
    .fixedString(name, 32)
    .u32(0)
    .i32(0)
    .i32(0)
    .u32(5)
    .toBytes();
}

test("a command is answered by the frame the radio writes back", async () => {
  const radio = new FakeRadio();
  radio.script.set(Cmd.GetDeviceTime, () => [new ByteWriter().u8(Resp.CurrTime).u32(1234).toBytes()]);
  const client = new MeshCoreClient(radio);
  assert.equal(await client.getDeviceTime(), 1234);
});

test("pending commands stay busy until both the active reply and the queue finish", async () => {
  const radio = new FakeRadio();
  const client = new MeshCoreClient(radio);
  assert.equal(client.isBusy, false);
  const first = client.getDeviceTime();
  const second = client.getDeviceTime();
  assert.equal(client.isBusy, true);
  radio.push(new ByteWriter().u8(Resp.CurrTime).u32(1).toBytes());
  assert.equal(await first, 1);
  assert.equal(client.isBusy, true);
  radio.push(new ByteWriter().u8(Resp.CurrTime).u32(2).toBytes());
  assert.equal(await second, 2);
  assert.equal(client.isBusy, false);
  await client.close();
});

test("an error frame rejects with its code and the command's name", async () => {
  const radio = new FakeRadio();
  radio.script.set(Cmd.RemoveContact, () => [new Uint8Array([Resp.Err, 2])]);
  const client = new MeshCoreClient(radio);
  await assert.rejects(client.removeContact(KEY), (error: unknown) => {
    assert.ok(error instanceof MeshCoreError);
    assert.equal(error.code, 2);
    assert.match(error.message, /removeContact: not found/);
    return true;
  });
});

test("get contacts collects the stream until the end marker, and reports the cursor", async () => {
  const radio = new FakeRadio();
  radio.script.set(Cmd.GetContacts, () => [
    new ByteWriter().u8(Resp.ContactsStart).u32(2).toBytes(),
    contactFrame("A"),
    contactFrame("B"),
    new ByteWriter().u8(Resp.EndOfContacts).u32(99).toBytes(),
  ]);
  const client = new MeshCoreClient(radio);
  const result = await client.getContacts();
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.contacts.map((c) => c.name),
    ["A", "B"],
  );
  assert.equal(result.mostRecentLastMod, 99);
});

test("a push in the middle of an answer goes to the push listeners, not the answer", async () => {
  const radio = new FakeRadio();
  radio.script.set(Cmd.GetContacts, () => [
    new ByteWriter().u8(Resp.ContactsStart).u32(1).toBytes(),
    new Uint8Array([Push.MsgWaiting]),
    contactFrame("A"),
    new ByteWriter().u8(Resp.EndOfContacts).u32(1).toBytes(),
  ]);
  const client = new MeshCoreClient(radio);
  const pushes: string[] = [];
  client.onPush((frame) => pushes.push(frame.kind));
  const result = await client.getContacts();
  assert.equal(result.contacts.length, 1);
  assert.deepEqual(pushes, ["msgWaiting"]);
});

test("commands go out one at a time, in order", async () => {
  const radio = new FakeRadio();
  radio.delayMs = 5;
  radio.script.set(Cmd.GetDeviceTime, () => [new ByteWriter().u8(Resp.CurrTime).u32(1).toBytes()]);
  radio.script.set(Cmd.GetBattAndStorage, () => [new ByteWriter().u8(Resp.BattAndStorage).u16(4000).u32(1).u32(2).toBytes()]);
  const client = new MeshCoreClient(radio);
  const [time, batt] = await Promise.all([client.getDeviceTime(), client.getBattAndStorage()]);
  assert.equal(time, 1);
  assert.equal(batt.batteryMv, 4000);
  assert.deepEqual(
    radio.sent.map((f) => f[0]),
    [Cmd.GetDeviceTime, Cmd.GetBattAndStorage],
  );
});

test("silence is a timeout, and the next command still goes out", async () => {
  const radio = new FakeRadio();
  radio.script.set(Cmd.GetDeviceTime, () => [new ByteWriter().u8(Resp.CurrTime).u32(7).toBytes()]);
  const client = new MeshCoreClient(radio, { timeoutMs: 20 });
  await assert.rejects(client.getBattAndStorage(), TimeoutError);
  assert.equal(await client.getDeviceTime(), 7);
});

test("a command that rewrites the contacts file waits longer, so its late answer is not the next command's", async () => {
  const radio = new FakeRadio();
  radio.script.set(Cmd.ResetPath, () => []);
  radio.script.set(Cmd.SendStatusReq, () => [new ByteWriter().u8(Resp.Sent).u8(0).u32(9).u32(5000).toBytes()]);
  const client = new MeshCoreClient(radio, { timeoutMs: 20, savingTimeoutMs: 500 });
  const forgetting = client.resetPath(KEY);
  const status = client.sendStatusReq(KEY);
  // The radio saves for longer than the usual wait, then answers.
  setTimeout(() => radio.push(new Uint8Array([Resp.Ok])), 60);
  await forgetting;
  assert.equal((await status).ackTag, 9);
});

test("a dropped link rejects what is in flight and what is queued, and closes the client", async () => {
  const radio = new FakeRadio();
  radio.delayMs = 1000;
  radio.script.set(Cmd.GetDeviceTime, () => [new ByteWriter().u8(Resp.CurrTime).u32(7).toBytes()]);
  const client = new MeshCoreClient(radio);
  let closedWith: unknown = "unset";
  client.onClose((reason) => (closedWith = reason));
  const a = client.getDeviceTime();
  const b = client.getDeviceTime();
  radio.drop(new Error("cable out"));
  await assert.rejects(a, TransportClosedError);
  await assert.rejects(b, TransportClosedError);
  assert.equal((closedWith as Error).message, "cable out");
  assert.ok(client.isClosed);
  await assert.rejects(client.getDeviceTime(), TransportClosedError);
});

test("reboot resolves without an answer", async () => {
  const radio = new FakeRadio();
  const client = new MeshCoreClient(radio);
  await client.reboot();
  assert.equal(radio.sent[0]![0], Cmd.Reboot);
});

test("sync next message returns null on the empty-queue answer", async () => {
  const radio = new FakeRadio();
  radio.script.set(Cmd.SyncNextMessage, () => [new Uint8Array([Resp.NoMoreMessages])]);
  const client = new MeshCoreClient(radio);
  assert.equal(await client.syncNextMessage(), null);
});
