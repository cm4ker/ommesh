import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("the private key comes back as its 64 bytes, and a firmware built without it answers null", async () => {
  const radio = new FakeRadio();
  const key = new Uint8Array(64).map((_, i) => i);
  radio.script.set(Cmd.ExportPrivateKey, () => [new ByteWriter().u8(Resp.PrivateKey).bytes(key).toBytes()]);
  const client = new MeshCoreClient(radio);
  assert.deepEqual(await client.exportPrivateKey(), key);
  radio.script.set(Cmd.ExportPrivateKey, () => [new Uint8Array([Resp.Disabled])]);
  assert.equal(await client.exportPrivateKey(), null);
});

test("a key the radio takes is true, a firmware built without import false, an unfit key refused", async () => {
  const radio = new FakeRadio();
  const key = new Uint8Array(64).fill(7);
  radio.script.set(Cmd.ImportPrivateKey, () => [new Uint8Array([Resp.Ok])]);
  const client = new MeshCoreClient(radio);
  assert.equal(await client.importPrivateKey(key), true);
  assert.deepEqual(radio.sent[0], new Uint8Array([Cmd.ImportPrivateKey, ...key]));
  radio.script.set(Cmd.ImportPrivateKey, () => [new Uint8Array([Resp.Disabled])]);
  assert.equal(await client.importPrivateKey(key), false);
  radio.script.set(Cmd.ImportPrivateKey, () => [new Uint8Array([Resp.Err, 6])]);
  await assert.rejects(client.importPrivateKey(key), (error: unknown) => error instanceof MeshCoreError && error.code === 6);
});

test("another app's read of a different channel slot is not this one's answer", async () => {
  const radio = new FakeRadio();
  const slot = (index: number, name: string) =>
    new ByteWriter().u8(Resp.ChannelInfo).u8(index).fixedString(name, 32).zeros(16).toBytes();
  // A radio open in two apps writes each answer to both: the other app read
  // slot 0 a moment before this one asked for slot 1.
  radio.script.set(Cmd.GetChannel, (frame) => [slot(0, "Public"), slot(frame[1]!, "#test")]);
  const client = new MeshCoreClient(radio);
  const strays: string[] = [];
  client.onStray((frame) => strays.push(frame.kind));
  const channel = await client.getChannel(1);
  assert.equal(channel.index, 1);
  assert.equal(channel.name, "#test");
  assert.deepEqual(strays, ["channelInfo"]);
});

const START = (count: number) => new ByteWriter().u8(Resp.ContactsStart).u32(count).toBytes();
const END = (lastMod: number) => new ByteWriter().u8(Resp.EndOfContacts).u32(lastMod).toBytes();

function selfInfoFrame(key: Uint8Array): Uint8Array {
  return new ByteWriter().u8(Resp.SelfInfo).u8(1).i8(22).i8(22).bytes(key).i32(0).i32(0).u8(0).u8(0).u8(0).u8(0).u32(869_161).u32(62_500).u8(7).u8(7).toBytes();
}

/** Answers each command code from a list, one entry per time it is asked. */
function inTurn(...answers: Uint8Array[][]): (frame: Uint8Array) => Uint8Array[] {
  let n = 0;
  return () => answers[Math.min(n++, answers.length - 1)]!;
}

test("a contact list another app's read got in the way of is asked for again", async () => {
  const radio = new FakeRadio();
  // The other app's read went first, and the radio refused this one's in the middle of it:
  // the list that came may be filtered by the other app's time.
  radio.script.set(Cmd.GetContacts, inTurn([START(2), contactFrame("A"), new Uint8Array([Resp.Err, 4]), END(5)], [START(2), contactFrame("A"), contactFrame("B"), END(9)]));
  const client = new MeshCoreClient(radio, { retryPauseMs: 1 });
  const result = await client.getContacts();
  assert.deepEqual(
    result.contacts.map((c) => c.name),
    ["A", "B"],
  );
  assert.equal(result.mostRecentLastMod, 9);
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.GetContacts).length, 2);
});

test("a contact list refused while another app's comes out waits for its end, then asks again", async () => {
  const radio = new FakeRadio();
  radio.script.set(Cmd.GetContacts, inTurn([new Uint8Array([Resp.Err, 4]), contactFrame("X"), END(5)], [START(1), contactFrame("A"), END(9)]));
  const client = new MeshCoreClient(radio, { retryPauseMs: 1 });
  const result = await client.getContacts();
  assert.deepEqual(
    result.contacts.map((c) => c.name),
    ["A"],
  );
});

test("another app starting on the radio cuts the contact list short, so it is asked for again", async () => {
  const radio = new FakeRadio();
  radio.script.set(Cmd.GetContacts, inTurn([START(2), contactFrame("A"), selfInfoFrame(KEY)], [START(2), contactFrame("A"), contactFrame("B"), END(9)]));
  const client = new MeshCoreClient(radio, { retryPauseMs: 1 });
  const result = await client.getContacts();
  assert.equal(result.contacts.length, 2);
});

test("the end of another app's contact list, before this one's starts, is not this one's", async () => {
  const radio = new FakeRadio();
  radio.script.set(Cmd.GetContacts, () => [END(5), START(1), contactFrame("A"), END(9)]);
  const client = new MeshCoreClient(radio);
  const result = await client.getContacts();
  assert.equal(result.contacts.length, 1);
  assert.equal(result.mostRecentLastMod, 9);
});

test("while another app is heard, a direct text takes only the sent answer with its own tag", async () => {
  const radio = new FakeRadio();
  const self = new Uint8Array(32).fill(5);
  radio.script.set(Cmd.AppStart, () => [selfInfoFrame(self)]);
  const sent = (tag: number) => new ByteWriter().u8(Resp.Sent).u8(0).u32(tag).u32(2000).toBytes();
  radio.script.set(Cmd.SendTxtMsg, (frame) => {
    // The radio's tag (composeMsgPacket): SHA-256 of the timestamp, the attempt's low bits and the text, then its own key.
    const own = createHash("sha256").update(frame.subarray(3, 7)).update(Uint8Array.of(frame[2]! & 3)).update(frame.subarray(13)).update(self).digest().readUInt32LE(0);
    return [sent(0x0badf00d), sent(own)];
  });
  const client = new MeshCoreClient(radio);
  await client.appStart("test");
  // An answer to the other app's command.
  radio.push(new ByteWriter().u8(Resp.CurrTime).u32(1).toBytes());
  const result = await client.sendTextMessage(KEY.subarray(0, 6), "hi", { timestamp: 1_700_000_000 });
  assert.notEqual(result.ackTag, 0x0badf00d);
});

test("through a phone's relay, a direct text takes the sent answer the relay hands it", async () => {
  const radio = new FakeRadio();
  radio.script.set(Cmd.AppStart, () => [selfInfoFrame(new Uint8Array(32).fill(5)), new Uint8Array([Push.Peer, 0, 1, 1])]);
  radio.script.set(Cmd.SendTxtMsg, () => [new ByteWriter().u8(Resp.Sent).u8(0).u32(0x0badf00d).u32(2000).toBytes()]);
  const client = new MeshCoreClient(radio, { timeoutMs: 50 });
  await client.appStart("test");
  radio.push(new ByteWriter().u8(Resp.CurrTime).u32(1).toBytes());
  const result = await client.sendTextMessage(KEY.subarray(0, 6), "hi");
  assert.equal(result.ackTag, 0x0badf00d);
});

test("a frame nothing answers is done once written, and an answer that comes meanwhile is not its", async () => {
  const radio = new FakeRadio();
  // A late answer to some earlier command, arriving while the frame goes out.
  radio.script.set(Push.Peer, () => [new Uint8Array([Resp.Ok])]);
  radio.script.set(Cmd.GetDeviceTime, () => [new ByteWriter().u8(Resp.CurrTime).u32(1_700_000_000).toBytes()]);
  const client = new MeshCoreClient(radio);
  const strays: string[] = [];
  client.onStray((frame) => strays.push(frame.kind));
  await client.tell(new Uint8Array([Push.Peer, 1, 1, 65]));
  assert.equal(await client.getDeviceTime(), 1_700_000_000);
  assert.deepEqual(strays, ["ok"]);
});
