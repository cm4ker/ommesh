import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ByteWriter, fromHex } from "./protocol/bytes.js";
import { Cmd, Push, Resp, TxtType } from "./protocol/codes.js";
import { groupTextPayload, heardGroupTextPayload } from "./protocol/group.js";
import { channelConversation, CLOCK_RESET_TIME, ClockAheadError, contactConversation, MeshSession, NodeCommandError, pathHashes, routeKey, splitChannelText, traceLegs, type PersistedState } from "./session.js";
import { BaseTransport } from "./transport.js";
import { TimeoutError, TransportClosedError } from "./client.js";

const SELF = fromHex("a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf");
const BOB = fromHex("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");

/** A radio with one contact, one channel, and whatever is put in its queue. */
class ScriptedRadio extends BaseTransport {
  readonly kind: "ble" | "serial";
  constructor(kind: "ble" | "serial" = "ble") {
    super();
    this.kind = kind;
  }
  readonly label = "MeshCore-test";
  sent: Uint8Array[] = [];
  queue: Uint8Array[] = [];
  /** Pushes a phone's relay kept while this app was away: they go out ahead of the next message it reads. */
  kept: Uint8Array[] = [];
  contacts: Uint8Array[] = [contactFrame(BOB, "Bob", 10)];
  time = 1_700_000_000;
  nextAck = 0x11223344;
  binaryTag = 0x55667788;
  /** Whether the radio says a text went out as a flood. */
  sendsFlood = false;
  /** How many contacts it has room for. */
  capacity = 100;
  autoAdd = { config: 0, maxHops: 0 };

  async send(frame: Uint8Array): Promise<void> {
    this.sent.push(frame);
    const replies = this.answer(frame);
    queueMicrotask(() => {
      for (const reply of replies) this.emitFrame(reply);
    });
  }

  private answer(frame: Uint8Array): Uint8Array[] {
    switch (frame[0]) {
      case Cmd.DeviceQuery:
        return [
          new ByteWriter()
            .u8(Resp.DeviceInfo)
            .u8(13)
            .u8(50)
            .u8(2)
            .u32(0)
            .fixedString("d", 12)
            .fixedString("m", 40)
            .fixedString("v1.17.1", 20)
            .toBytes(),
        ];
      case Cmd.AppStart:
        return [
          new ByteWriter()
            .u8(Resp.SelfInfo)
            .u8(1)
            .i8(22)
            .i8(22)
            .bytes(SELF)
            .i32(0)
            .i32(0)
            .u8(0)
            .u8(0)
            .u8(0)
            .u8(0)
            .u32(869_161)
            .u32(62_500)
            .u8(7)
            .u8(7)
            .string("Me")
            .toBytes(),
        ];
      case Cmd.GetDeviceTime:
        return [new ByteWriter().u8(Resp.CurrTime).u32(this.time).toBytes()];
      case Cmd.SetDeviceTime:
        return [new Uint8Array([Resp.Ok])];
      case Cmd.GetContacts:
        return [
          new ByteWriter().u8(Resp.ContactsStart).u32(this.contacts.length).toBytes(),
          ...this.contacts,
          new ByteWriter().u8(Resp.EndOfContacts).u32(10).toBytes(),
        ];
      case Cmd.GetChannel: {
        const index = frame[1]!;
        if (index === 0) {
          return [new ByteWriter().u8(Resp.ChannelInfo).u8(0).fixedString("Public", 32).bytes(new Uint8Array(16).fill(1)).toBytes()];
        }
        return [new ByteWriter().u8(Resp.ChannelInfo).u8(index).fixedString("", 32).zeros(16).toBytes()];
      }
      case Cmd.SyncNextMessage: {
        const next = this.queue.shift();
        return [...this.kept.splice(0), next ?? new Uint8Array([Resp.NoMoreMessages])];
      }
      case Cmd.GetBattAndStorage:
        return [new ByteWriter().u8(Resp.BattAndStorage).u16(4100).u32(1).u32(2).toBytes()];
      case Cmd.SendTxtMsg:
        return [new ByteWriter().u8(Resp.Sent).u8(this.sendsFlood ? 1 : 0).u32(this.nextAck).u32(2000).toBytes()];
      case Cmd.ResetPath: {
        const found = this.contactOf(frame);
        if (found) found[35] = 0xff;
        return [new Uint8Array([Resp.Ok])];
      }
      case Cmd.GetContactByKey: {
        const found = this.contacts.find((c) => c.subarray(1, 33).every((b, i) => b === frame[1 + i]));
        return [found ?? new Uint8Array([Resp.Err, 2])];
      }
      case Cmd.SendChannelTxtMsg:
        return [new Uint8Array([Resp.Ok])];
      case Cmd.SendLogin:
        // The radio names a login by the first four bytes of the node's key.
        return [new ByteWriter().u8(Resp.Sent).u8(this.floods(frame)).bytes(frame.subarray(1, 5)).u32(2000).toBytes()];
      case Cmd.SendStatusReq:
        return [new ByteWriter().u8(Resp.Sent).u8(this.floods(frame)).u32(0x0a0b0c0d).u32(2000).toBytes()];
      case Cmd.SendPathDiscoveryReq:
        // A discovery always floods.
        return [new ByteWriter().u8(Resp.Sent).u8(1).u32(0x0e0f1011).u32(2000).toBytes()];
      case Cmd.SendBinaryReq:
        return [new ByteWriter().u8(Resp.Sent).u8(1).u32(this.binaryTag).u32(2000).toBytes()];
      case Cmd.Logout:
        return [new Uint8Array([Resp.Ok])];
      case Cmd.SendTracePath:
        // The radio echoes the trace's own tag, and estimates the way back.
        return [new ByteWriter().u8(Resp.Sent).u8(0).bytes(frame.subarray(1, 5)).u32(40).toBytes()];
      case Cmd.SendControlData:
        return [new Uint8Array([Resp.Ok])];
      case Cmd.AddUpdateContact: {
        // The command carries a contact laid out as the radio sends one.
        const record = new Uint8Array(frame.length);
        record.set(frame);
        record[0] = Resp.Contact;
        const at = this.contacts.findIndex((c) => c.subarray(1, 33).every((b, i) => b === frame[1 + i]));
        if (at >= 0) this.contacts[at] = record;
        else if (this.contacts.length >= this.capacity) return [new Uint8Array([Resp.Err, 3])];
        else this.contacts.push(record);
        return [new Uint8Array([Resp.Ok])];
      }
      case Cmd.RemoveContact: {
        const at = this.contacts.findIndex((c) => c.subarray(1, 33).every((b, i) => b === frame[1 + i]));
        if (at < 0) return [new Uint8Array([Resp.Err, 2])];
        this.contacts.splice(at, 1);
        return [new Uint8Array([Resp.Ok])];
      }
      case Cmd.GetAutoAddConfig:
        return [new Uint8Array([Resp.AutoAddConfig, this.autoAdd.config, this.autoAdd.maxHops])];
      case Cmd.SetAutoAddConfig:
        this.autoAdd = { config: frame[1]!, maxHops: frame[2] ?? 0 };
        return [new Uint8Array([Resp.Ok])];
      case Cmd.GetStats:
        return [new ByteWriter().u8(Resp.Stats).u8(1).u16(-115 & 0xffff).i8(-90).i8(28).u32(120).u32(3400).toBytes()];
      default:
        return [new Uint8Array([Resp.Err, 1])];
    }
  }

  push(frame: Uint8Array): void {
    this.emitFrame(frame);
  }

  /** The link going away under the session, as a radio out of range does. */
  drop(): void {
    this.emitClose(new Error("gone"));
  }

  /** The contact whose key the command carries after its code. */
  private contactOf(frame: Uint8Array): Uint8Array | undefined {
    return this.contacts.find((c) => c.subarray(1, 33).every((b, i) => b === frame[1 + i]));
  }

  /** 1 when a request to the contact floods, as it does with no route held; 0 when it goes along the route. */
  private floods(frame: Uint8Array): number {
    const found = this.contactOf(frame);
    return !found || found[35] === 0xff ? 1 : 0;
  }

  protected async shutdown(): Promise<void> {}
}

/** `path` is the route the radio holds, one-byte hashes; none when absent. */
function contactFrame(key: Uint8Array, name: string, lastMod: number, type = 1, path?: number[]): Uint8Array {
  const route = new Uint8Array(64);
  route.set(path ?? []);
  return new ByteWriter()
    .u8(Resp.Contact)
    .bytes(key)
    .u8(type)
    .u8(0)
    .u8(path ? path.length : 0xff)
    .bytes(route)
    .fixedString(name, 32)
    .u32(0)
    .i32(0)
    .i32(0)
    .u32(lastMod)
    .toBytes();
}

function dmFrame(from: Uint8Array, text: string): Uint8Array {
  return new ByteWriter()
    .u8(Resp.ContactMsgRecvV3)
    .i8(20)
    .u8(0)
    .u8(0)
    .bytes(from.subarray(0, 6))
    .u8(1)
    .u8(TxtType.Plain)
    .u32(1_700_000_050)
    .string(text)
    .toBytes();
}

function channelFrame(index: number, text: string): Uint8Array {
  return new ByteWriter()
    .u8(Resp.ChannelMsgRecvV3)
    .i8(0)
    .u8(0)
    .u8(0)
    .u8(index)
    .u8(0xff)
    .u8(TxtType.Plain)
    .u32(1_700_000_060)
    .string(text)
    .toBytes();
}

class MemoryStorage {
  saved = new Map<string, PersistedState>();
  async load(key: string): Promise<PersistedState | null> {
    return this.saved.get(key) ?? null;
  }
  async save(key: string, state: PersistedState): Promise<void> {
    this.saved.set(key, structuredClone(state));
  }
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("USB message sync retries a lost reply and keeps the session connected", async () => {
  const radio = new ScriptedRadio("serial");
  radio.queue.push(channelFrame(0, "Alice: after the lost reply"));
  const send = radio.send.bind(radio);
  let attempts = 0;
  radio.send = async (frame) => {
    if (frame[0] === Cmd.SyncNextMessage && ++attempts === 1) throw new TimeoutError("syncNextMessage", 8000);
    await send(frame);
  };
  const session = new MeshSession();
  await session.connect(radio);
  assert.equal(session.getState().status, "ready");
  assert.equal(session.getState().messages.length, 1);
  assert.equal(attempts, 3); // lost reply, message, queue empty
  assert.ok(session.getState().log.some((entry) => entry.text.includes("retrying message sync (1/2)")));
  await session.disconnect();
});

test("persistent USB silence still fails after bounded message sync retries", async () => {
  const radio = new ScriptedRadio("serial");
  const send = radio.send.bind(radio);
  let attempts = 0;
  radio.send = async (frame) => {
    if (frame[0] === Cmd.SyncNextMessage) {
      attempts += 1;
      throw new TimeoutError("syncNextMessage", 8000);
    }
    await send(frame);
  };
  const session = new MeshSession();
  await assert.rejects(session.connect(radio), TimeoutError);
  assert.equal(attempts, 3);
  assert.equal(session.getState().status, "closed");
});

test("a USB transport failure is not retried as a message timeout", async () => {
  const radio = new ScriptedRadio("serial");
  const send = radio.send.bind(radio);
  let attempts = 0;
  radio.send = async (frame) => {
    if (frame[0] === Cmd.SyncNextMessage) {
      attempts += 1;
      throw new TransportClosedError(new Error("cable out"));
    }
    await send(frame);
  };
  const session = new MeshSession();
  await assert.rejects(session.connect(radio), TransportClosedError);
  assert.equal(attempts, 1);
  assert.equal(session.getState().status, "closed");
});

test("disconnect during a USB retry cannot send again or change a new session", async () => {
  const radio = new ScriptedRadio("serial");
  const send = radio.send.bind(radio);
  let attempts = 0;
  radio.send = async (frame) => {
    if (frame[0] === Cmd.SyncNextMessage) {
      attempts += 1;
      throw new TimeoutError("syncNextMessage", 8000);
    }
    await send(frame);
  };
  const session = new MeshSession();
  const retryStarted = new Promise<void>((resolve) => {
    const off = session.subscribe(() => {
      if (session.getState().log.some((entry) => entry.text.includes("retrying message sync"))) {
        off();
        resolve();
      }
    });
  });
  const oldConnect = assert.rejects(session.connect(radio), TimeoutError);
  await retryStarted;
  await session.disconnect();
  await session.connect(new ScriptedRadio());
  await oldConnect;
  assert.equal(attempts, 1);
  assert.equal(session.getState().status, "ready");
  assert.equal(session.getState().error, null);
  await session.disconnect();
});

test("connecting queries the radio, reads its contacts and channels, and drains the queue", async () => {
  const radio = new ScriptedRadio();
  radio.queue.push(dmFrame(BOB, "hello"), channelFrame(0, "Alice: hi all"));
  const session = new MeshSession({ now: () => 1_700_000_100_000 });
  await session.connect(radio);
  const state = session.getState();
  assert.equal(state.status, "ready");
  assert.equal(state.self?.name, "Me");
  assert.equal(state.device?.firmwareVersion, "v1.17.1");
  assert.equal(Object.keys(state.contacts).length, 1);
  assert.equal(state.contacts[bobKey()]?.name, "Bob");
  assert.equal(state.contactsCursor, 10);
  assert.deepEqual(
    state.channels.map((c) => c.name),
    ["Public"],
  );
  assert.equal(state.messages.length, 2);
  const [dm, ch] = state.messages;
  assert.equal(dm?.conversation, contactConversation(bobKey()));
  assert.equal(dm?.sender, "Bob");
  assert.equal(dm?.snr, 5);
  assert.equal(dm?.hops, 1);
  assert.equal(ch?.conversation, channelConversation(0));
  assert.equal(ch?.sender, "Alice");
  assert.equal(ch?.text, "hi all");
  assert.deepEqual(state.unread, { [contactConversation(bobKey())]: 1, [channelConversation(0)]: 1 });
  // The clock was a hundred seconds behind, so it was set.
  assert.ok(radio.sent.some((f) => f[0] === Cmd.SetDeviceTime));
});

test("a resync asks for everything again in order on the same link, and counts what is new", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  radio.contacts.push(contactFrame(fromHex("11".repeat(32)), "Carol", 5));
  radio.queue.push(dmFrame(BOB, "while nobody asked"));
  radio.sent = [];
  const steps: string[] = [];
  const summary = await session.resync((step) => steps.push(step));
  assert.deepEqual(steps, ["device", "self", "clock", "contacts", "channels", "autoAdd", "messages", "battery"]);
  assert.deepEqual(summary, { contacts: 1, messages: 1 });
  // Carol's lastMod is older than the cursor: only a full read finds her.
  assert.equal(Object.keys(session.getState().contacts).length, 2);
  assert.equal(radio.sent[0]?.[0], Cmd.DeviceQuery);
  assert.equal(session.getState().status, "ready");
});

test("a resync that fails names the step and keeps what came before it", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  radio.contacts.push(contactFrame(fromHex("11".repeat(32)), "Carol", 5));
  const send = radio.send.bind(radio);
  radio.send = async (frame) => {
    if (frame[0] === Cmd.GetChannel) throw new Error("gone quiet");
    return send(frame);
  };
  await assert.rejects(session.resync(), (e: Error & { step?: string }) => e.step === "channels" && /gone quiet/.test(e.message));
  assert.equal(Object.keys(session.getState().contacts).length, 2);
});

test("a message-waiting push drains the queue again, and a focused conversation stays read", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  session.focus(contactConversation(bobKey()));
  radio.queue.push(dmFrame(BOB, "again"));
  radio.push(new Uint8Array([Push.MsgWaiting]));
  await tick(5);
  const state = session.getState();
  assert.equal(state.messages.length, 1);
  assert.deepEqual(state.unread, {});
});

test("only messages handed over by the radio are received; the history read back at connect is not", async () => {
  const storage = new MemoryStorage();
  const radio = new ScriptedRadio();
  radio.queue.push(dmFrame(BOB, "old news"));
  const first = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await first.connect(radio);
  await first.disconnect();

  const again = new ScriptedRadio();
  again.queue.push(channelFrame(0, "Alice: fresh"));
  const second = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  const received: { text: string; unread: number }[] = [];
  second.onReceived((m) => received.push({ text: m.text, unread: second.getState().unread[m.conversation] ?? 0 }));
  await second.connect(again);
  assert.deepEqual(second.getState().messages.map((m) => m.text), ["old news", "fresh"]);
  assert.deepEqual(received, [{ text: "fresh", unread: 1 }]);
});

test("a direct message is sent, then delivered when its ack arrives", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  const sent = await session.sendText(contactConversation(bobKey()), "yo");
  assert.equal(sent.status, "sent");
  assert.equal(sent.ackTag, 0x11223344);
  radio.push(new ByteWriter().u8(Push.SendConfirmed).u32(0x11223344).u32(1500).toBytes());
  await tick();
  const message = session.getState().messages.find((m) => m.id === sent.id);
  assert.equal(message?.status, "delivered");
  assert.equal(message?.roundTripMs, 1500);
  await session.disconnect();
});

test("a channel message goes out with the sender's name accounted for, and is 'sent' on OK", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  const message = await session.sendText(channelConversation(0), "hello channel");
  assert.equal(message.status, "sent");
  assert.equal(session.textBudget(channelConversation(0)), 160 - 2 - 2);
  const frame = radio.sent.find((f) => f[0] === Cmd.SendChannelTxtMsg)!;
  assert.equal(frame[2], 0);
});

/** What the phone's relay says the other app sent: the command, then the radio's answer. */
function mirrorFrame(command: Uint8Array, answer: Uint8Array): Uint8Array {
  return new ByteWriter().u8(Push.Mirror).u8(command.length).bytes(command).bytes(answer).toBytes();
}

test("a direct message the other app sent through the relay is kept as ours, and delivered on its ack", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  const command = new ByteWriter().u8(Cmd.SendTxtMsg).u8(TxtType.Plain).u8(0).u32(1_700_000_100).bytes(BOB.subarray(0, 6)).string("from the laptop").toBytes();
  const answer = new ByteWriter().u8(Resp.Sent).u8(0).u32(0x99887766).u32(2000).toBytes();
  radio.push(mirrorFrame(command, answer));
  await tick();
  const kept = session.getState().messages.find((m) => m.text === "from the laptop");
  assert.equal(kept?.direction, "out");
  assert.equal(kept?.conversation, contactConversation(bobKey()));
  assert.equal(kept?.timestamp, 1_700_000_100);
  assert.equal(kept?.status, "sent");
  assert.equal(kept?.ackTag, 0x99887766);
  assert.deepEqual(session.getState().unread, {});
  radio.push(new ByteWriter().u8(Push.SendConfirmed).u32(0x99887766).u32(900).toBytes());
  await tick();
  assert.equal(session.getState().messages.find((m) => m.id === kept!.id)?.status, "delivered");
  // A retry from the other app is the same message, not a second one.
  const retry = new ByteWriter().u8(Cmd.SendTxtMsg).u8(TxtType.Plain).u8(1).u32(1_700_000_100).bytes(BOB.subarray(0, 6)).string("from the laptop").toBytes();
  radio.push(mirrorFrame(retry, new ByteWriter().u8(Resp.Sent).u8(1).u32(0x12121212).u32(2000).toBytes()));
  await tick();
  const all = session.getState().messages.filter((m) => m.text === "from the laptop");
  assert.equal(all.length, 1);
  assert.equal(all[0]?.attempt, 1);
  assert.equal(all[0]?.ackTag, 0x12121212);
  assert.equal(all[0]?.timestamp, 1_700_000_100);
  assert.equal(all[0]?.sentAt, 1_700_000_100);
  await session.disconnect();
});

test("a channel message the other app sent through the relay is kept as ours", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  const command = new ByteWriter().u8(Cmd.SendChannelTxtMsg).u8(TxtType.Plain).u8(0).u32(1_700_000_200).string("hello from the phone").toBytes();
  radio.push(mirrorFrame(command, new Uint8Array([Resp.Ok])));
  await tick();
  const kept = session.getState().messages.find((m) => m.text === "hello from the phone");
  assert.equal(kept?.direction, "out");
  assert.equal(kept?.conversation, channelConversation(0));
  assert.equal(kept?.status, "sent");
  assert.equal(kept?.sender, "Me");
  // Unheard, the other app sends it again with a new stamp: the same message, moved to when it went.
  const retry = new ByteWriter().u8(Cmd.SendChannelTxtMsg).u8(TxtType.Plain).u8(0).u32(1_700_000_260).string("hello from the phone").toBytes();
  radio.push(mirrorFrame(retry, new Uint8Array([Resp.Ok])));
  await tick();
  const all = session.getState().messages.filter((m) => m.text === "hello from the phone");
  assert.equal(all.length, 1);
  assert.equal(all[0]?.timestamp, 1_700_000_260);
  assert.equal(all[0]?.sentAt, 1_700_000_260);
  // A CLI command to a repeater is not a message in a chat.
  const cli = new ByteWriter().u8(Cmd.SendTxtMsg).u8(TxtType.CliData).u8(0).u32(1_700_000_300).bytes(BOB.subarray(0, 6)).string("ver").toBytes();
  radio.push(mirrorFrame(cli, new ByteWriter().u8(Resp.Sent).u8(0).u32(0).u32(2000).toBytes()));
  await tick();
  assert.equal(session.getState().messages.some((m) => m.text === "ver"), false);
  await session.disconnect();
});

test("what was heard survives a reconnect through the storage, keyed by the radio", async () => {
  const storage = new MemoryStorage();
  const radio = new ScriptedRadio();
  radio.queue.push(dmFrame(BOB, "remember me"));
  const session = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await session.connect(radio);
  await session.disconnect();
  assert.equal(session.getState().status, "closed");

  const again = new ScriptedRadio();
  const second = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await second.connect(again);
  assert.equal(second.getState().messages[0]?.text, "remember me");
  // The contact cursor was kept, so the second fetch asked only for changes.
  const fetch = again.sent.find((f) => f[0] === Cmd.GetContacts)!;
  assert.equal(fetch.length, 5);
});

test("back on the same radio, the session goes on from the history it holds, not an older stored copy", async () => {
  // A phone's web view can lose its database in the background: saves fail, and the stored copy falls behind.
  class LosingStorage extends MemoryStorage {
    lost = false;
    override async save(key: string, state: PersistedState): Promise<void> {
      if (this.lost) throw new Error("Connection to Indexed Database server lost");
      await super.save(key, state);
    }
  }
  const storage = new LosingStorage();
  const session = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  const radio = new ScriptedRadio();
  radio.queue.push(dmFrame(BOB, "before"));
  await session.connect(radio);
  await session.disconnect();

  storage.lost = true;
  const again = new ScriptedRadio();
  again.queue.push(dmFrame(BOB, "while nothing saves"));
  await session.connect(again);
  await session.disconnect();

  storage.lost = false;
  await session.connect(new ScriptedRadio());
  assert.deepEqual(session.getState().messages.map((m) => m.text), ["before", "while nothing saves"]);
});

test("while it connects again, the radio and its history stay in the state", async () => {
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  const radio = new ScriptedRadio();
  radio.queue.push(dmFrame(BOB, "still here"));
  await session.connect(radio);
  await session.disconnect();

  const seen: { self: boolean; texts: string[] }[] = [];
  const stop = session.subscribe(() => {
    const state = session.getState();
    if (state.status === "connecting") seen.push({ self: state.self !== null, texts: state.messages.map((m) => m.text) });
  });
  await session.connect(new ScriptedRadio());
  stop();
  assert.ok(seen.length > 0);
  assert.ok(seen.every((s) => s.self && s.texts.includes("still here")));
});

test("a connect says how far it has got: the hello, then the history, then nothing once ready", async () => {
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  const steps: (string | null)[] = [];
  session.subscribe(() => {
    const step = session.getState().connectStep;
    if (steps.at(-1) !== step) steps.push(step);
  });
  await session.connect(new ScriptedRadio());
  assert.deepEqual(steps, ["hello", "history", null]);
  assert.equal(session.getState().status, "ready");
  // The radio known from the first time is there from the start of the next connect, and the step still begins at the hello.
  await session.disconnect();
  steps.length = 0;
  await session.connect(new ScriptedRadio());
  assert.deepEqual(steps, ["hello", "history", null]);
});

test("a connect is ready once the radio has answered, and reads its queue before its contacts and channels", async () => {
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  const radio = new ScriptedRadio();
  let atReady: number[] = [];
  await session.connect(radio, () => {
    atReady = radio.sent.map((f) => f[0]!);
    assert.equal(session.getState().status, "ready");
  });
  assert.deepEqual(atReady, [Cmd.DeviceQuery, Cmd.AppStart, Cmd.GetDeviceTime]);
  const after = radio.sent.slice(atReady.length).map((f) => f[0]!);
  assert.equal(after[0], Cmd.SyncNextMessage);
  assert.ok(after.indexOf(Cmd.GetContacts) > after.lastIndexOf(Cmd.SyncNextMessage));
  assert.ok(after.indexOf(Cmd.GetChannel) > after.indexOf(Cmd.GetContacts));
  // Resolved only once all of it has been read.
  assert.equal(session.getState().channels[0]?.name, "Public");
  assert.ok(Object.keys(session.getState().contacts).length > 0);
});

test("the last radio's stored chats show before it is reached, and stay while it connects", async () => {
  const storage = new MemoryStorage();
  const first = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  const radio = new ScriptedRadio();
  radio.queue.push(dmFrame(BOB, "from last time"));
  await first.connect(radio);
  const { self, device } = first.getState();
  await first.disconnect();
  await first.flush();

  // The next launch: nothing is stored for a radio never connected, and the last one's chats show at once.
  const next = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  assert.equal(await next.resume({ ...self!, key: "ff".repeat(32) }, device), false);
  assert.equal(next.getState().self, null);
  assert.equal(await next.resume(self!, device), true);
  assert.equal(next.getState().status, "idle");
  assert.deepEqual(next.getState().messages.map((m) => m.text), ["from last time"]);
  assert.ok(Object.keys(next.getState().contacts).length > 0);
  // Shown once: a second resume leaves them be.
  assert.equal(await next.resume(self!, device), false);

  const seen: string[][] = [];
  const stop = next.subscribe(() => {
    if (next.getState().status === "connecting") seen.push(next.getState().messages.map((m) => m.text));
  });
  await next.connect(new ScriptedRadio());
  stop();
  assert.ok(seen.length > 0 && seen.every((texts) => texts.includes("from last time")));
  assert.equal(next.getState().status, "ready");
});

test("a stored history that cannot be read is not written over", async () => {
  class UnreadableStorage extends MemoryStorage {
    unreadable = false;
    override async load(key: string): Promise<PersistedState | null> {
      if (this.unreadable) throw new Error("Connection to Indexed Database server lost");
      return super.load(key);
    }
  }
  const storage = new UnreadableStorage();
  const first = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  const radio = new ScriptedRadio();
  radio.queue.push(dmFrame(BOB, "keep me"));
  await first.connect(radio);
  await first.disconnect();
  const key = first.getState().self!.key;

  storage.unreadable = true;
  const second = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  const again = new ScriptedRadio();
  again.queue.push(dmFrame(BOB, "new"));
  await second.connect(again);
  assert.deepEqual(second.getState().messages.map((m) => m.text), ["new"]);
  assert.ok(second.getState().log.some((e) => e.kind === "error" && e.text.startsWith("history could not be read")));
  await second.disconnect();
  assert.deepEqual(storage.saved.get(key)!.messages.map((m) => m.text), ["keep me"]);

  // Readable again, it is read again rather than taken from what the session held meanwhile.
  storage.unreadable = false;
  await second.connect(new ScriptedRadio());
  assert.deepEqual(second.getState().messages.map((m) => m.text), ["keep me"]);
});

test("history saved with the raw path_len byte is read back as a hop count", async () => {
  const storage = new MemoryStorage();
  const session = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  const radio = new ScriptedRadio();
  radio.queue.push(dmFrame(BOB, "one hop, two-byte hashes"));
  await session.connect(radio);
  await session.disconnect();
  const saved = storage.saved.get(session.getState().self!.key)!;
  saved.messages[0]!.hops = 0x41; // what the client stored before it masked the byte

  const second = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await second.connect(new ScriptedRadio());
  assert.equal(second.getState().messages[0]?.hops, 1);
});

test("a channel message heard back from repeaters is an echo, one per distinct path", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  const state = session.getState();
  const sent = await session.sendText("ch:0", "anyone out there?");
  const payload = await groupTextPayload(fromHex(state.channels[0]!.secret), sent.timestamp, state.self!.name, "anyone out there?");
  // A flood GRP_TXT packet as a repeater sends it on: header 0x15, two-byte hashes in the path.
  const heard = (hashes: string[], body: Uint8Array = payload) =>
    new ByteWriter().u8(Push.LogRxData).i8(8).i8(-90).u8(0x15).u8(0x40 | hashes.length).bytes(fromHex(hashes.join(""))).bytes(body).toBytes();
  radio.push(heard(["7932"]));
  radio.push(heard(["7932"])); // the same relay again
  radio.push(heard(["7932", "ce5b"]));
  radio.push(heard(["dc0a"], payload.map((b, i) => (i === 5 ? b ^ 1 : b)))); // someone else's message
  await tick();
  const message = session.getState().messages.find((m) => m.id === sent.id)!;
  assert.deepEqual(message.echoes, [
    { path: ["7932"], snr: 2 },
    { path: ["7932", "ce5b"], snr: 2 },
  ]);
});

/** Lets the replies and pushes queued as microtasks run, with the timers held by the mock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Waits a turn of the event loop at a time until `done`. A channel send works
 * out its packet with WebCrypto first, which answers from a worker thread, so
 * no fixed number of turns is sure to cover it on a busy machine.
 */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 5_000 && !done(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A flood GRP_TXT packet as a repeater sends ours on, for the text as it went out. */
async function echoOf(session: MeshSession, text: string, timestamp: number, hashes: string[]): Promise<Uint8Array> {
  const state = session.getState();
  const payload = await groupTextPayload(fromHex(state.channels[0]!.secret), timestamp, state.self!.name, text);
  return new ByteWriter().u8(Push.LogRxData).i8(8).i8(-90).u8(0x15).u8(0x40 | hashes.length).bytes(fromHex(hashes.join(""))).bytes(payload).toBytes();
}

test("a channel message nobody sends on is unheard after the window, and an echo takes that back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  const connecting = session.connect(radio);
  await settle();
  await connecting;
  const sent = await session.sendText("ch:0", "anyone?");
  const status = () => session.getState().messages.find((m) => m.id === sent.id)!.status;
  assert.equal(status(), "sent");

  t.mock.timers.tick(19_000);
  assert.equal(status(), "sent");
  t.mock.timers.tick(1_000);
  assert.equal(status(), "unheard");

  // A repeater that was slow, or asleep, sends it on after all.
  radio.push(await echoOf(session, "anyone?", sent.timestamp, ["7932"]));
  await settle();
  assert.equal(status(), "sent");
});

test("a message that did not get through can be deleted, and one still on its way cannot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  const connecting = session.connect(radio);
  await settle();
  await connecting;
  const lost = await session.sendText("ch:0", "nobody heard this");
  t.mock.timers.tick(20_000);
  const fresh = await session.sendText("ch:0", "just sent");
  session.discardFailed(fresh.id);
  session.discardFailed(lost.id);
  assert.deepEqual(
    session.getState().messages.map((m) => m.text),
    ["just sent"],
  );
});

test("an echo inside the window keeps a channel message sent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  const connecting = session.connect(radio);
  await settle();
  await connecting;
  const sent = await session.sendText("ch:0", "quick one");
  radio.push(await echoOf(session, "quick one", sent.timestamp, ["7932"]));
  await settle();
  t.mock.timers.tick(20_000);
  assert.equal(session.getState().messages.find((m) => m.id === sent.id)!.status, "sent");
});

test("a link that drops inside the window leaves the message sent, not unheard", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  const connecting = session.connect(radio);
  await settle();
  await connecting;
  const sent = await session.sendText("ch:0", "into the void");
  radio.drop();
  await settle();
  t.mock.timers.tick(20_000);
  assert.equal(session.getState().messages.find((m) => m.id === sent.id)!.status, "sent");
});

test("what the other app sent while this one was away is kept as sent, not waited on for an echo or an ack", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  const connecting = session.connect(radio);
  await settle();
  await connecting;
  const said = (text: string, at: number) => new ByteWriter().u8(Cmd.SendChannelTxtMsg).u8(TxtType.Plain).u8(0).u32(at).string(text).toBytes();
  const direct = new ByteWriter().u8(Cmd.SendTxtMsg).u8(TxtType.Plain).u8(0).u32(1_699_990_100).bytes(BOB.subarray(0, 6)).string("to Bob this morning").toBytes();
  radio.kept.push(
    mirrorFrame(said("said this morning", 1_699_990_000), new Uint8Array([Resp.Ok])),
    mirrorFrame(direct, new ByteWriter().u8(Resp.Sent).u8(0).u32(0x31313131).u32(2000).toBytes()),
    // Sent again an hour later: the same message, moved to then, not to now.
    mirrorFrame(said("said this morning", 1_699_993_600), new Uint8Array([Resp.Ok])),
  );
  radio.push(new Uint8Array([Push.MsgWaiting]));
  await settle();
  t.mock.timers.tick(60_000);
  const channel = session.getState().messages.filter((m) => m.text === "said this morning");
  assert.equal(channel.length, 1);
  assert.equal(channel[0]?.status, "sent");
  assert.equal(channel[0]?.sentAt, 1_699_993_600);
  assert.equal(session.getState().messages.find((m) => m.text === "to Bob this morning")?.status, "sent");
});

test("a channel message sent again goes out with a fresh stamp, and the new packet's echo counts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let clock = 1_700_000_000_000;
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => clock });
  const connecting = session.connect(radio);
  await settle();
  await connecting;
  const sent = await session.sendText("ch:0", "again");
  t.mock.timers.tick(20_000);
  clock += 30_000;

  await session.retry(sent.id);
  const again = session.getState().messages.find((m) => m.id === sent.id)!;
  assert.equal(again.attempt, 1);
  assert.ok(again.timestamp > sent.timestamp, "the stamp moves on, so repeaters see a new packet");
  assert.equal(again.status, "sent");

  // The first packet's echo is late news; the new one's is what takes the alarm down.
  radio.push(await echoOf(session, "again", again.timestamp, ["ce5b"]));
  await settle();
  const now = session.getState().messages.find((m) => m.id === sent.id)!;
  assert.deepEqual(now.echoes, [{ path: ["ce5b"], snr: 2 }]);
  t.mock.timers.tick(20_000);
  assert.equal(session.getState().messages.find((m) => m.id === sent.id)!.status, "sent");
});

test("keep trying sends at once, then along the ladder, and stops at the first echo", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.mock.method(Math, "random", () => 0.5); // no jitter
  let clock = 1_700_000_000_000;
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => clock });
  const connecting = session.connect(radio);
  await settle();
  await connecting;
  const sent = await session.sendText("ch:0", "hello?");
  t.mock.timers.tick(20_000);
  const channelSends = () => radio.sent.filter((f) => f[0] === Cmd.SendChannelTxtMsg).length;
  const message = () => session.getState().messages.find((m) => m.id === sent.id)!;
  assert.equal(channelSends(), 1);

  await session.keepTrying(sent.id);
  assert.equal(channelSends(), 2);
  assert.deepEqual(message().retryPlan, { made: 1, total: 5, nextAt: clock + 45_000 });

  // Not due yet.
  clock += 40_000;
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(channelSends(), 2);

  clock += 5_000;
  t.mock.timers.tick(5_000);
  await until(() => channelSends() === 3);
  assert.equal(channelSends(), 3);
  assert.equal(message().retryPlan?.made, 2);

  radio.push(await echoOf(session, "hello?", message().timestamp, ["7932"]));
  await settle();
  assert.equal(message().retryPlan, null);
  assert.equal(message().status, "sent");

  clock += 600_000;
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(channelSends(), 3, "a loop that got its echo sends nothing more");
});

test("a loop spends no sends while the radio is away, and goes on once it is back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.mock.method(Math, "random", () => 0.5);
  let clock = 1_700_000_000_000;
  const storage = new MemoryStorage();
  const radio = new ScriptedRadio();
  const session = new MeshSession({ storage, now: () => clock });
  let connecting = session.connect(radio);
  await settle();
  await connecting;
  const sent = await session.sendText("ch:0", "still there?");
  await session.keepTrying(sent.id);
  radio.drop();
  await settle();
  const message = () => session.getState().messages.find((m) => m.id === sent.id)!;
  assert.deepEqual(message().retryPlan, { made: 1, total: 5, nextAt: null });

  clock += 3_600_000;
  const back = new ScriptedRadio();
  connecting = session.connect(back);
  await settle();
  await connecting;
  t.mock.timers.tick(5_000);
  await until(() => back.sent.some((f) => f[0] === Cmd.SendChannelTxtMsg));
  assert.equal(back.sent.filter((f) => f[0] === Cmd.SendChannelTxtMsg).length, 1);
  assert.equal(message().retryPlan?.made, 2);
});

test("starting a loop stops the other one in the same chat", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  const connecting = session.connect(radio);
  await settle();
  await connecting;
  const first = await session.sendText("ch:0", "one");
  const second = await session.sendText("ch:0", "two");
  await session.keepTrying(first.id);
  await session.keepTrying(second.id);
  const plan = (id: string) => session.getState().messages.find((m) => m.id === id)!.retryPlan;
  assert.equal(plan(first.id), null);
  assert.equal(plan(second.id)?.made, 1);
  session.stopTrying(second.id);
  assert.equal(plan(second.id), null);
});

/** A session with Bob one relay away, trying a direct message `tries` times, on the mocked clock. */
async function tryingSession(t: TestContext, tries: number) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.mock.method(Math, "random", () => 0.5); // no jitter
  const clock = { now: 1_700_000_000_000 };
  const radio = new ScriptedRadio();
  radio.contacts = [contactFrame(BOB, "Bob", 1_699_999_990, 1, [0x7f])];
  const session = new MeshSession({ now: () => clock.now });
  session.setSendTries(tries);
  const connecting = session.connect(radio);
  await settle();
  await connecting;
  const sent = await session.sendText(contactConversation(bobKey()), "hello?");
  const sends = () => radio.sent.filter((f) => f[0] === Cmd.SendTxtMsg).length;
  const message = () => session.getState().messages.find((m) => m.id === sent.id)!;
  // The radio guesses 2 s for the ack, which the session stretches to 6.
  const wait = async (ms: number) => {
    clock.now += ms;
    t.mock.timers.tick(ms);
    await settle();
  };
  return { clock, radio, session, sends, message, wait };
}

test("a direct message nobody acknowledges goes again on its own, as many times as set", async (t) => {
  const { clock, radio, sends, message, wait } = await tryingSession(t, 3);
  assert.equal(sends(), 1);

  // No ack in time: the second try goes at once, the route dropped so that it floods.
  await wait(6_000);
  await until(() => sends() === 2);
  assert.ok(radio.sent.some((f) => f[0] === Cmd.ResetPath));
  assert.equal(message().attempt, 1);
  assert.deepEqual(message().retryPlan, { made: 2, total: 3, nextAt: clock.now + 45_000 });

  // Its own wait runs out before the gap does: the third waits for the gap.
  await wait(6_000);
  assert.equal(message().status, "unconfirmed");
  assert.equal(sends(), 2);
  await wait(40_000);
  await until(() => sends() === 3);
  assert.equal(sends(), 3);

  await wait(6_000);
  await wait(3_600_000);
  assert.equal(sends(), 3, "the tries are spent");
  assert.equal(message().status, "unconfirmed");
  assert.deepEqual(message().retryPlan, { made: 3, total: 3, nextAt: null });
});

test("one try is left to the user", async (t) => {
  const { sends, message, wait } = await tryingSession(t, 1);
  await wait(6_000);
  await wait(3_600_000);
  assert.equal(sends(), 1);
  assert.equal(message().status, "unconfirmed");
  assert.equal(message().retryPlan, null);
});

test("a late acknowledgement of an earlier try still counts, and the tries stop", async (t) => {
  const { radio, sends, message, wait } = await tryingSession(t, 5);
  radio.nextAck = 0x55555555;
  await wait(6_000);
  await until(() => sends() === 2);
  assert.equal(message().ackTag, 0x55555555);
  assert.deepEqual(message().pastAckTags, [0x11223344]);

  radio.push(new ByteWriter().u8(Push.SendConfirmed).u32(0x11223344).u32(7_000).toBytes());
  await settle();
  assert.equal(message().status, "delivered");
  assert.equal(message().retryPlan, null);
  await wait(3_600_000);
  assert.equal(sends(), 2);
  assert.equal(message().status, "delivered");
});

test("stopped tries stay stopped; sending again starts them over", async (t) => {
  const { session, sends, message, wait } = await tryingSession(t, 3);
  await wait(6_000);
  await until(() => sends() === 2);
  session.stopTrying(message().id);
  assert.deepEqual(message().retryPlan, { made: 2, total: 2, nextAt: null });
  await wait(6_000);
  await wait(3_600_000);
  assert.equal(sends(), 2);
  assert.equal(message().status, "unconfirmed");

  await session.sendAgain(message().id);
  assert.equal(sends(), 3);
  await wait(6_000);
  await until(() => sends() === 4);
  assert.deepEqual(message().retryPlan, { made: 2, total: 3, nextAt: message().retryPlan!.nextAt });
});

test("a direct message that arrives twice, sent again for want of an ack, is kept once", async () => {
  const radio = new ScriptedRadio();
  radio.queue.push(dmFrame(BOB, "see you"), dmFrame(BOB, "see you"), dmFrame(BOB, "and then"));
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  assert.deepEqual(
    session.getState().messages.map((m) => m.text),
    ["see you", "and then"],
  );
  await session.disconnect();
});

test("a message from a sender not yet in the contacts is filed under its prefix, then moved", async () => {
  const radio = new ScriptedRadio();
  radio.contacts = [];
  radio.queue.push(dmFrame(BOB, "who am I"));
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  assert.equal(session.getState().messages[0]?.conversation, "p:010203040506");
  radio.push(new ByteWriter().u8(Push.NewAdvert).bytes(contactFrame(BOB, "Bob", 11).subarray(1)).toBytes());
  await tick();
  assert.equal(session.getState().messages[0]?.conversation, contactConversation(bobKey()));
  assert.equal(session.getState().messages[0]?.sender, "Bob");
});

test("a node the radio does not keep is announced once, and listed as not kept", async () => {
  const radio = new ScriptedRadio();
  radio.contacts = [];
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  const found: string[] = [];
  session.onDiscovered((c) => found.push(c.name));
  await session.connect(radio);
  assert.deepEqual(found, []);
  const advert = new ByteWriter().u8(Push.NewAdvert).bytes(contactFrame(BOB, "Bob", 11).subarray(1)).toBytes();
  radio.push(advert);
  await tick();
  radio.push(advert);
  await tick();
  assert.deepEqual(found, ["Bob"]);
  assert.equal(session.getState().contacts[bobKey()]?.name, "Bob");
  assert.equal(session.getState().contacts[bobKey()]?.unsaved, true);
});

test("a node the radio adds as it hears it is announced once its contact is read; the contacts read at connect are not", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  const found: string[] = [];
  session.onDiscovered((c) => found.push(c.name));
  await session.connect(radio);
  assert.deepEqual(found, []);
  const carol = fromHex("c0".repeat(32));
  radio.contacts.push(contactFrame(carol, "Carol", 12));
  radio.push(new ByteWriter().u8(Push.Advert).bytes(carol).toBytes());
  await tick(600);
  assert.deepEqual(found, ["Carol"]);
  assert.equal(session.getState().contacts["c0".repeat(32)]?.unsaved, undefined);
});

test("removed contacts are kept to be put back, and a node the radio did not keep only leaves the list", async () => {
  const storage = new MemoryStorage();
  const radio = new ScriptedRadio();
  const session = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await session.connect(radio);
  radio.push(new ByteWriter().u8(Push.NewAdvert).bytes(contactFrame(fromHex("d0".repeat(32)), "Dan", 11).subarray(1)).toBytes());
  await tick();
  const { removed, error } = await session.removeContacts([bobKey(), "d0".repeat(32)], "tidy");
  assert.deepEqual(removed, [bobKey(), "d0".repeat(32)]);
  assert.equal(error, null);
  assert.equal(radio.contacts.length, 0);
  assert.deepEqual(Object.keys(session.getState().contacts), []);
  assert.deepEqual(Object.keys(session.getState().removed), [bobKey()]);
  assert.equal(session.getState().removed[bobKey()]?.by, "tidy");
  assert.equal(session.getState().removing, null);
  await session.disconnect();

  const second = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await second.connect(radio);
  assert.equal(second.getState().removed[bobKey()]?.contact.name, "Bob");
  await second.restoreContact(bobKey());
  assert.equal(radio.contacts.length, 1);
  assert.equal(second.getState().contacts[bobKey()]?.name, "Bob");
  assert.deepEqual(second.getState().removed, {});
});

test("a contact the radio already let go of counts as removed", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  radio.contacts = [];
  await session.removeContact(bobKey());
  assert.equal(session.getState().removed[bobKey()]?.by, "you");
});

test("a contact the radio replaced, or lost while nobody listened, is kept as removed by the radio", async () => {
  const storage = new MemoryStorage();
  const radio = new ScriptedRadio();
  const session = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await session.connect(radio);
  radio.push(new ByteWriter().u8(Push.ContactDeleted).bytes(BOB).toBytes());
  await tick();
  assert.equal(session.getState().contacts[bobKey()], undefined);
  assert.equal(session.getState().removed[bobKey()]?.by, "radio");
  await session.disconnect();

  // Bob is back on the radio: the fetch takes him out of the removed.
  const again = new ScriptedRadio();
  const second = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await second.connect(again);
  await second.refreshContacts(true);
  assert.deepEqual(second.getState().removed, {});
  await second.disconnect();

  // And gone again while the app was away.
  again.contacts = [];
  const third = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await third.connect(again);
  assert.equal(third.getState().contacts[bobKey()], undefined);
  assert.equal(third.getState().removed[bobKey()]?.by, "radio");
});

test("a full radio is said to be full until a contact is removed, and refuses one put back", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  await session.removeContact(bobKey());
  radio.capacity = 0;
  radio.push(new Uint8Array([Push.ContactsFull]));
  await tick();
  assert.equal(session.getState().contactsFull, true);
  await assert.rejects(session.restoreContact(bobKey()), /memory is full/);
  assert.ok(session.getState().removed[bobKey()]);
  radio.capacity = 100;
  await session.restoreContact(bobKey());
  await session.removeContact(bobKey());
  assert.equal(session.getState().contactsFull, false);
});

test("the radio's auto-add setting is read at connect and written back", async () => {
  const radio = new ScriptedRadio();
  radio.autoAdd = { config: 0x05, maxHops: 3 };
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  assert.deepEqual(session.getState().autoAdd, { config: 0x05, maxHops: 3 });
  await session.setAutoAdd(0x03, 0);
  assert.deepEqual(radio.autoAdd, { config: 0x03, maxHops: 0 });
  assert.deepEqual(session.getState().autoAdd, { config: 0x03, maxHops: 0 });
});

test("the sender of a channel message is the name before the colon", () => {
  assert.deepEqual(splitChannelText("Alice: hi: there"), { sender: "Alice", text: "hi: there" });
  assert.deepEqual(splitChannelText("no sender"), { sender: null, text: "no sender" });
});

function bobKey(): string {
  return "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
}

// ---- repeaters, rooms and sensors ----

const HILL = fromHex("c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0");
const HILL_KEY = "c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0";
const ROOM = fromHex("e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff00");
const ROOM_KEY = "e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff00";

function statusBody(tail: Uint8Array): Uint8Array {
  return new ByteWriter()
    .u16(4100)
    .u16(1)
    .u16(0xff92) // noise floor -110
    .u16(0xff9e) // last RSSI -98
    .u32(100)
    .u32(50)
    .u32(60)
    .u32(3600)
    .u32(1)
    .u32(2)
    .u32(3)
    .u32(4)
    .u16(0)
    .u16(0xfff8) // last SNR -2 dB, in quarters
    .u16(5)
    .u16(6)
    .bytes(tail)
    .toBytes();
}

/** A console reply, stamped with the node's clock. */
function cliFrame(from: Uint8Array, text: string, stamp = 1_700_000_070): Uint8Array {
  return new ByteWriter()
    .u8(Resp.ContactMsgRecvV3)
    .i8(20)
    .u16(0)
    .bytes(from.subarray(0, 6))
    .u8(0)
    .u8(TxtType.CliData)
    .u32(stamp)
    .string(text)
    .toBytes();
}

async function nodeSession(options: NonNullable<ConstructorParameters<typeof MeshSession>[0]> = {}) {
  const radio = new ScriptedRadio();
  radio.contacts = [contactFrame(HILL, "Hill", 10, 2), contactFrame(ROOM, "Lounge", 11, 3), contactFrame(BOB, "Bob", 12)];
  const session = new MeshSession({ now: () => 1_700_000_000_000, ...options });
  await session.connect(radio);
  return { radio, session };
}

function sentText(frame: Uint8Array): string {
  return new TextDecoder().decode(frame.subarray(13));
}

test("remote requests wait their turn: the second goes out only after the first is answered", async () => {
  const { radio, session } = await nodeSession();
  const login = session.login(HILL_KEY, "secret");
  const status = session.requestStatus(HILL_KEY);
  await tick();
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.SendLogin).length, 1);
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.SendStatusReq).length, 0);
  assert.equal(session.getState().remote.active?.label, "sign in");
  assert.deepEqual(
    session.getState().remote.queued.map((j) => j.label),
    ["status"],
  );

  // Admin: flag 1, the node's clock, permissions 3, firmware level 2.
  radio.push(new ByteWriter().u8(Push.LoginSuccess).u8(1).bytes(HILL.subarray(0, 6)).u32(1_699_999_950).u8(3).u8(2).toBytes());
  const result = await login;
  assert.equal(result.ok, true);
  assert.equal(result.role, 3);
  assert.equal(result.serverTime, 1_699_999_950);
  await tick();
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.SendStatusReq).length, 1);

  const tail = new ByteWriter().u32(90).u32(7).toBytes();
  radio.push(new ByteWriter().u8(Push.StatusResponse).u8(0).bytes(HILL.subarray(0, 6)).bytes(statusBody(tail)).toBytes());
  const answered = await status;
  assert.equal(answered.stats?.noiseFloor, -110);
  assert.equal(answered.stats?.lastSnr, -2);
  assert.equal(answered.stats?.rxAirTimeSecs, 90);
  assert.equal(answered.stats?.posted, null);
  assert.deepEqual(session.getState().statusHistory[HILL_KEY], [{ at: 1_700_000_000_000, batteryMv: 4100, noiseFloor: -110 }]);
  assert.equal(session.getState().remote.active, null);
});

test("a telemetry answer's battery joins the node's week, once per ten minutes", async () => {
  let now = 1_700_000_000_000;
  const radio = new ScriptedRadio();
  radio.contacts = [contactFrame(BOB, "Bob", 12)];
  const session = new MeshSession({ now: () => now });
  await session.connect(radio);
  const answer = (centivolts: number) =>
    new ByteWriter().u8(Push.TelemetryResponse).u8(0).bytes(BOB.subarray(0, 6)).bytes(new Uint8Array([1, 0x74, centivolts >> 8, centivolts & 0xff, 1, 0x67, 0x01, 0x18])).toBytes();
  radio.push(answer(415));
  await tick();
  now += 5 * 60 * 1000;
  radio.push(answer(412));
  await tick();
  now += 20 * 60 * 1000;
  radio.push(answer(402));
  await tick();
  assert.deepEqual(session.getState().batteryHistory[bobKey()], [
    { at: 1_700_000_000_000, mv: 4120 },
    { at: 1_700_001_500_000, mv: 4020 },
  ]);
});

test("a power monitor's voltage and current join the node's day, and a day old ones go", async () => {
  let now = 1_700_000_000_000;
  const radio = new ScriptedRadio();
  radio.contacts = [contactFrame(BOB, "Bob", 12)];
  const session = new MeshSession({ now: () => now });
  await session.connect(radio);
  // Channel 1 is the battery, kept apart; channel 4 an INA219 with its whole-watt power, which is not kept.
  const answer = (milliamps: number) =>
    new ByteWriter()
      .u8(Push.TelemetryResponse)
      .u8(0)
      .bytes(BOB.subarray(0, 6))
      .bytes(new Uint8Array([1, 0x74, 0x01, 0x9f, 4, 0x74, 0x01, 0x52, 4, 0x75, milliamps >> 8, milliamps & 0xff, 4, 0x80, 0x00, 0x00]))
      .toBytes();
  radio.push(answer(119));
  await tick();
  now += 5 * 60 * 1000;
  radio.push(answer(240));
  await tick();
  now += 20 * 60 * 1000;
  radio.push(answer(35));
  await tick();
  assert.deepEqual(session.getState().readingHistory[bobKey()], {
    "4:voltage": [
      { at: 1_700_000_000_000, value: 3.38 },
      { at: 1_700_001_500_000, value: 3.38 },
    ],
    "4:current": [
      { at: 1_700_000_000_000, value: 0.24 },
      { at: 1_700_001_500_000, value: 0.035 },
    ],
  });
  now += 24 * 3600 * 1000 - 60 * 1000;
  radio.push(answer(50));
  await tick();
  assert.deepEqual(session.getState().readingHistory[bobKey()]!["4:current"], [
    { at: 1_700_001_500_000, value: 0.035 },
    { at: now, value: 0.05 },
  ]);
});

test("a room's status tail is its post counts, not receive air time", async () => {
  const { radio, session } = await nodeSession();
  const status = session.requestStatus(ROOM_KEY);
  await tick();
  const tail = new ByteWriter().u16(184).u16(1203).toBytes();
  radio.push(new ByteWriter().u8(Push.StatusResponse).u8(0).bytes(ROOM.subarray(0, 6)).bytes(statusBody(tail)).toBytes());
  const answered = await status;
  assert.equal(answered.stats?.posted, 184);
  assert.equal(answered.stats?.postPushes, 1203);
  assert.equal(answered.stats?.rxAirTimeSecs, null);
});

test("a refused password resolves as not signed in, and frees the queue", async () => {
  const { radio, session } = await nodeSession();
  const login = session.login(HILL_KEY, "wrong");
  await tick();
  radio.push(new ByteWriter().u8(Push.LoginFail).u8(0).bytes(HILL.subarray(0, 6)).toBytes());
  const result = await login;
  assert.equal(result.ok, false);
  assert.equal(result.role, null);
  assert.equal(session.getState().remote.active, null);
});

test("a node that never answers times the request out and lets the next one go", async () => {
  const { radio, session } = await nodeSession({ replyWaitMs: () => 20 });
  const first = session.requestStatus(HILL_KEY);
  const second = session.requestStatus(HILL_KEY);
  await assert.rejects(first, /no reply/);
  await tick();
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.SendStatusReq).length, 2);
  await assert.rejects(second, /no reply/);
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.SendStatusReq).length, 2);
});

test("a request that hears nothing goes once, keeps its route and signs in to nothing", async () => {
  const { radio, session } = await nodeSession({ replyWaitMs: () => 20 });
  radio.contacts = [contactFrame(HILL, "Hill", 10, 2, [0x3f, 0xa1])];
  await session.refreshContacts(true);
  await assert.rejects(session.requestStatus(HILL_KEY), /no reply/);
  await tick(50);
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.SendStatusReq).length, 1);
  assert.ok(!radio.sent.some((f) => f[0] === Cmd.ResetPath || f[0] === Cmd.SendLogin));
  assert.equal(session.getState().contacts[HILL_KEY]?.outPathLen, 2);
  assert.equal(session.getState().remote.active, null);
});

test("a route set by hand is put back when the radio learns another from an answer", async () => {
  const { radio, session } = await nodeSession();
  await session.setRoute(HILL_KEY, ["3f", "a1"]);
  const writes = () => radio.sent.filter((f) => f[0] === Cmd.AddUpdateContact).length;
  const before = writes();
  // An answer came in another way, and the radio took that way as its route.
  radio.contacts = [contactFrame(HILL, "Hill", 10, 2, [0xdc, 0x89])];
  radio.push(new ByteWriter().u8(Push.PathUpdated).bytes(HILL).toBytes());
  await tick(10);
  assert.equal(writes(), before + 1);
  const write = radio.sent.filter((f) => f[0] === Cmd.AddUpdateContact).at(-1)!;
  assert.equal(write[35], 2);
  assert.deepEqual([...write.subarray(36, 38)], [0x3f, 0xa1]);
  assert.ok(session.routeSetByHand(HILL_KEY));
});

test("a route set by hand that the radio replaced meanwhile is written back when contacts are read", async () => {
  const { radio, session } = await nodeSession();
  await session.setRoute(HILL_KEY, ["3f", "a1"]);
  // Another app, or an answer that came another way, left the radio with its own route.
  radio.contacts = [contactFrame(HILL, "Hill", 20, 2, [0xdc, 0x89])];
  const before = radio.sent.filter((f) => f[0] === Cmd.AddUpdateContact).length;
  await session.refreshContacts(true);
  const writes = radio.sent.filter((f) => f[0] === Cmd.AddUpdateContact);
  assert.equal(writes.length, before + 1);
  assert.deepEqual([...writes.at(-1)!.subarray(35, 38)], [2, 0x3f, 0xa1]);
  assert.ok(session.routeSetByHand(HILL_KEY));
});

test("a sign-in by flood goes with no route and puts ours back the moment it has gone", async () => {
  const { radio, session } = await nodeSession();
  await session.setRoute(HILL_KEY, ["3f", "a1"]);
  const from = radio.sent.length;
  const login = session.relearnReturnPath(HILL_KEY, "secret");
  await tick(10);
  const order = radio.sent.slice(from).map((f) => f[0]).filter((c) => c === Cmd.ResetPath || c === Cmd.SendLogin || c === Cmd.AddUpdateContact);
  assert.deepEqual(order, [Cmd.ResetPath, Cmd.SendLogin, Cmd.AddUpdateContact]);
  const write = radio.sent.filter((f) => f[0] === Cmd.AddUpdateContact).at(-1)!;
  assert.deepEqual([...write.subarray(35, 38)], [2, 0x3f, 0xa1]);
  radio.push(new ByteWriter().u8(Push.LoginSuccess).u8(1).bytes(HILL.subarray(0, 6)).u32(1_700_000_000).u8(3).u8(2).toBytes());
  assert.equal((await login).ok, true);
  assert.ok(session.routeSetByHand(HILL_KEY));
});

/** Waits until the scripted radio has been sent a frame of this kind, up to about a second. */
async function sentOne(radio: ScriptedRadio, code: number, count = 1): Promise<void> {
  for (let i = 0; i < 200 && radio.sent.filter((f) => f[0] === code).length < count; i++) await tick(5);
}

test("a console command goes once, and one sent again carries a later stamp", async () => {
  const { radio, session } = await nodeSession({ replyWaitMs: () => 20 });
  radio.contacts = [contactFrame(HILL, "Hill", 10, 2, [0x3f])];
  await session.refreshContacts(true);
  await assert.rejects(session.runCli(HILL_KEY, "get tx"), /no reply/);
  await tick(50);
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.SendTxtMsg).length, 1);
  assert.equal(session.getState().consoles[HILL_KEY]?.[0]?.status, "timeout");

  const reply = session.runCli(HILL_KEY, "get tx");
  await sentOne(radio, Cmd.SendTxtMsg, 2);
  const sends = radio.sent.filter((f) => f[0] === Cmd.SendTxtMsg);
  // Both went within the same second of this clock: the node would take the second for a repeat.
  const stamps = sends.map((f) => new DataView(f.buffer, f.byteOffset).getUint32(3, true));
  assert.ok(stamps[1]! > stamps[0]!);
  radio.queue.push(cliFrame(HILL, `${sentText(sends[1]!).slice(0, 2)}|> 20`));
  radio.push(new Uint8Array([Push.MsgWaiting]));
  assert.equal(await reply, "> 20");
  assert.equal(session.getState().consoles[HILL_KEY]?.[1]?.status, "done");
});

test("a set that hears nothing is not read back or sent again", async () => {
  const { radio, session } = await nodeSession({ replyWaitMs: () => 20 });
  radio.contacts = [contactFrame(HILL, "Hill", 10, 2, [0x3f])];
  await session.refreshContacts(true);
  await assert.rejects(session.writeNodeSetting(HILL_KEY, "tx", "22"), /no reply/);
  await tick(50);
  const sends = radio.sent.filter((f) => f[0] === Cmd.SendTxtMsg).map(sentText);
  assert.equal(sends.length, 1);
  assert.ok(sends[0]!.endsWith("|set tx 22"));
  assert.equal(session.getState().nodeSettings[HILL_KEY]?.["tx"], undefined);
});

test("a path discovery writes the way it found as the route, and says how the answer came back", async () => {
  const { radio, session } = await nodeSession();
  radio.contacts = [contactFrame(HILL, "Hill", 10, 2, [0x77])];
  await session.refreshContacts(true);
  const found = session.discoverPath(HILL_KEY);
  await tick();
  radio.push(new ByteWriter().u8(Push.PathDiscoveryResponse).u8(0).bytes(HILL.subarray(0, 6)).u8(2).bytes(fromHex("3fa1")).u8(3).bytes(fromHex("a1c03f")).toBytes());
  assert.deepEqual(await found, { out: ["3f", "a1"], back: ["a1", "c0", "3f"], changed: true });
  const write = radio.sent.find((f) => f[0] === Cmd.AddUpdateContact)!;
  assert.equal(write[35], 2);
  assert.deepEqual([...write.subarray(36, 38)], [0x3f, 0xa1]);
  assert.equal(session.getState().contacts[HILL_KEY]?.outPathLen, 2);
  assert.equal(session.getState().contacts[HILL_KEY]?.pathSince, 1_700_000_000_000);
});

test("a route put back as learned is not taken for one set by hand", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  await session.setRoute(bobKey(), ["3f"], { learnedAt: 1_699_990_000_000 });
  assert.equal(session.getState().contacts[bobKey()]?.pathSince, 1_699_990_000_000);
  assert.ok(!session.routeSetByHand(bobKey()));
  assert.deepEqual(session.getState().routing.contacts, {});
  await session.disconnect();
});

test("a path discovery that finds the route already held writes nothing", async () => {
  const { radio, session } = await nodeSession();
  radio.contacts = [contactFrame(HILL, "Hill", 10, 2, [0x3f])];
  await session.refreshContacts(true);
  const found = session.discoverPath(HILL_KEY);
  await tick();
  radio.push(new ByteWriter().u8(Push.PathDiscoveryResponse).u8(0).bytes(HILL.subarray(0, 6)).u8(1).bytes(fromHex("3f")).u8(1).bytes(fromHex("3f")).toBytes());
  assert.equal((await found).changed, false);
  assert.ok(!radio.sent.some((f) => f[0] === Cmd.AddUpdateContact));
});

test("neighbours come back under the radio's tag, with prefixes, age and SNR", async () => {
  const { radio, session } = await nodeSession();
  const request = session.requestNeighbours(HILL_KEY, { order: 2 });
  await tick();
  const sent = radio.sent.find((f) => f[0] === Cmd.SendBinaryReq)!;
  // After the key: type 6, version 0, count 10, offset 0 (two bytes), order 2, six-byte prefixes.
  assert.deepEqual([...sent.subarray(33, 40)], [6, 0, 10, 0, 0, 2, 6]);
  // A reply under another tag is not this one.
  radio.push(new ByteWriter().u8(Push.BinaryResponse).u8(0).u32(0x99).u16(0).u16(0).toBytes());
  radio.push(
    new ByteWriter()
      .u8(Push.BinaryResponse)
      .u8(0)
      .u32(radio.binaryTag)
      .u16(14)
      .u16(2)
      .bytes(fromHex("aabbccddeeff"))
      .u32(120)
      .i8(29)
      .bytes(fromHex("010203040506"))
      .u32(3600)
      .i8(-34)
      .toBytes(),
  );
  const list = await request;
  assert.equal(list.total, 14);
  assert.deepEqual(list.neighbours, [
    { prefix: "aabbccddeeff", heardSecsAgo: 120, snr: 7.25 },
    { prefix: "010203040506", heardSecsAgo: 3600, snr: -8.5 },
  ]);
});

function neighboursReply(radio: ScriptedRadio, total: number, rows: [string, number, number][]): Uint8Array {
  const w = new ByteWriter().u8(Push.BinaryResponse).u8(0).u32(radio.binaryTag).u16(total).u16(rows.length);
  for (const [prefix, secs, snr] of rows) w.bytes(fromHex(prefix)).u32(secs).i8(snr * 4);
  return w.toBytes();
}

/** Runs a neighbour search on Hill that the repeater answers with `reply`, and returns it with the sends. */
async function searchHill(prior: [number, [string, number, number][]] | null, reply: string) {
  const { radio, session } = await nodeSession({ searchWaitMs: () => 5 });
  if (prior) {
    const read = session.requestNeighbours(HILL_KEY);
    await sentOne(radio, Cmd.SendBinaryReq);
    radio.push(neighboursReply(radio, prior[0], prior[1]));
    await read;
  }
  const waits: number[] = [];
  const search = session.searchNeighbours(HILL_KEY, (ms) => waits.push(ms));
  await sentOne(radio, Cmd.SendTxtMsg);
  const command = sentText(radio.sent.find((f) => f[0] === Cmd.SendTxtMsg)!);
  radio.queue.push(cliFrame(HILL, `${command.slice(0, 2)}|${reply}`));
  radio.push(new Uint8Array([Push.MsgWaiting]));
  return { radio, session, search, command, waits, reads: prior ? 2 : 1 };
}

test("a neighbour search has the repeater call its neighbours, then reads its list newest first", async () => {
  const { radio, search, command, waits, reads } = await searchHill([2, [["aabbccddeeff", 900, 7.25], ["010203040506", 3600, -8.5]]], "OK - Discover sent");
  assert.match(command, /^[0-9a-f]{2}\|discover\.neighbors$/);
  await sentOne(radio, Cmd.SendBinaryReq, reads);
  assert.deepEqual(waits, [5]);
  // Order 0: the newest first, where the neighbours that answered are.
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.SendBinaryReq)[1]![38], 0);
  radio.push(neighboursReply(radio, 3, [["0a0b0c0d0e0f", 2, -4.75], ["aabbccddeeff", 1, 7.5], ["010203040506", 3602, -8.5]]));
  const found = await search;
  assert.deepEqual(found.answered, ["0a0b0c0d0e0f", "aabbccddeeff"]);
  assert.deepEqual(found.fresh, ["0a0b0c0d0e0f"]);
  assert.equal(found.list.total, 3);
});

test("a neighbour search cannot tell who is new when the list was read only in part", async () => {
  // Twelve known, two of them fetched: the answer from outside those two may be an old one.
  const { radio, search, reads } = await searchHill([12, [["aabbccddeeff", 900, 7.25], ["010203040506", 3600, -8.5]]], "OK - Discover sent");
  await sentOne(radio, Cmd.SendBinaryReq, reads);
  radio.push(neighboursReply(radio, 12, [["0a0b0c0d0e0f", 2, -4.75], ["aabbccddeeff", 1, 7.5]]));
  assert.equal((await search).fresh, null);
});

test("a neighbour search on firmware that lacks it says what the repeater answered", async () => {
  const { radio, search } = await searchHill(null, "Unknown command");
  await assert.rejects(search, (error: Error) => error instanceof NodeCommandError && error.message === "Unknown command");
  assert.ok(!radio.sent.some((f) => f[0] === Cmd.SendBinaryReq));
});

test("a console command carries a tag, and its reply goes to the console, not the chat", async () => {
  const { radio, session } = await nodeSession();
  const reply = session.readNodeSetting(HILL_KEY, "tx");
  await tick();
  const sent = radio.sent.find((f) => f[0] === Cmd.SendTxtMsg)!;
  assert.equal(sent[1], TxtType.CliData);
  const text = sentText(sent);
  assert.match(text, /^[0-9a-f]{2}\|get tx$/);
  radio.queue.push(cliFrame(HILL, `${text.slice(0, 2)}|> 22`));
  radio.push(new Uint8Array([Push.MsgWaiting]));
  assert.equal(await reply, "22");
  const state = session.getState();
  assert.equal(state.messages.length, 0);
  assert.equal(state.nodeSettings[HILL_KEY]?.["tx"]?.value, "22");
  assert.deepEqual(
    state.consoles[HILL_KEY]?.map((e) => [e.command, e.status, e.reply]),
    [["get tx", "done", "> 22"]],
  );
});

/** Answers the console command the session sent last with `reply`, stamped with the node's clock. */
function answerCli(radio: ScriptedRadio, reply: string, stamp?: number): void {
  const tag = sentText(radio.sent.filter((f) => f[0] === Cmd.SendTxtMsg).at(-1)!).slice(0, 2);
  radio.queue.push(cliFrame(HILL, `${tag}|${reply}`, stamp));
  radio.push(new Uint8Array([Push.MsgWaiting]));
}

/** A session signed in to Hill as admin at 1_700_000_000, the node's clock then `behind` seconds behind ours. */
async function signedIn(behind: number, options: NonNullable<ConstructorParameters<typeof MeshSession>[0]> = {}) {
  const { radio, session } = await nodeSession(options);
  const login = session.login(HILL_KEY, "secret");
  await tick();
  radio.push(new ByteWriter().u8(Push.LoginSuccess).u8(1).bytes(HILL.subarray(0, 6)).u32(1_700_000_000 - behind).u8(3).u8(2).toBytes());
  await login;
  return { radio, session };
}

test("a console reply reads the node's clock from its stamp, set against the middle of the round trip", async () => {
  let now = 1_700_000_000_000;
  const { radio, session } = await signedIn(0, { now: () => now });
  assert.equal(session.getState().logins[HILL_KEY]!.clock, undefined);

  const check = session.checkNodeClock(HILL_KEY);
  await tick();
  assert.match(sentText(radio.sent.filter((f) => f[0] === Cmd.SendTxtMsg).at(-1)!), /^[0-9a-f]{2}\|clock$/);
  // Sent at :00 and answered at :04, so the node's stamp stands for :02.
  now += 4_000;
  answerCli(radio, "22:18 - 14/11/2023 UTC", 1_700_000_302);
  await check;
  assert.deepEqual(session.getState().logins[HILL_KEY]!.clock, { drift: -300, at: now });

  // Any console reply reads it again.
  const read = session.readNodeSetting(HILL_KEY, "tx");
  await tick();
  answerCli(radio, "> 22", 1_700_000_004);
  await read;
  assert.equal(session.getState().logins[HILL_KEY]!.clock!.drift, 0);
});

test("a node that takes our time reads as in step by its reply; one whose clock runs ahead says it cannot go back", async () => {
  const { radio, session } = await signedIn(47);

  const sync = session.syncNodeClock(HILL_KEY);
  await tick();
  assert.match(sentText(radio.sent.filter((f) => f[0] === Cmd.SendTxtMsg).at(-1)!), /^[0-9a-f]{2}\|clock sync$/);
  answerCli(radio, "OK - clock set: 22:13 - 14/11/2023 UTC", 1_700_000_000);
  await sync;
  const login = session.getState().logins[HILL_KEY]!;
  assert.equal(login.clock!.drift, 0);
  // The sign-in keeps what the node said then.
  assert.equal(login.serverTime, 1_699_999_953);

  const ahead = session.syncNodeClock(HILL_KEY);
  await tick();
  answerCli(radio, "ERR: clock cannot go backwards", 1_700_000_300);
  await assert.rejects(ahead, (error: Error) => error instanceof ClockAheadError && error instanceof NodeCommandError);
  assert.equal(session.getState().logins[HILL_KEY]!.clock!.drift, -300);
});

test("a clock reset restarts the node, which sends no reply, and leaves its clock at the reset date", async () => {
  const { radio, session } = await signedIn(-300, { replyWaitMs: () => 20 });
  await session.resetNodeClock(HILL_KEY);
  assert.match(sentText(radio.sent.filter((f) => f[0] === Cmd.SendTxtMsg).at(-1)!), /^[0-9a-f]{2}\|clkreboot$/);
  assert.deepEqual(session.getState().logins[HILL_KEY]!.clock, { drift: 1_700_000_000 - CLOCK_RESET_TIME, at: 1_700_000_000_000, reset: true });
});

test("a radio whose clock runs ahead is left there, and says by how much", async () => {
  const { radio, session } = await nodeSession();
  radio.time = 1_700_000_300;
  const before = radio.sent.length;
  assert.equal(await session.syncClock(0), 300);
  assert.ok(!radio.sent.slice(before).some((f) => f[0] === Cmd.SetDeviceTime));
  radio.time = 1_699_999_990;
  assert.equal(await session.syncClock(0), 0);
  assert.ok(radio.sent.slice(before).some((f) => f[0] === Cmd.SetDeviceTime));
});

test("a console reply that comes after the wait ran out still lands on its command", async () => {
  const { radio, session } = await nodeSession({ replyWaitMs: () => 20 });
  await assert.rejects(session.runCli(HILL_KEY, "ver"), /no reply/);
  const tag = sentText(radio.sent.find((f) => f[0] === Cmd.SendTxtMsg)!).slice(0, 2);
  assert.equal(session.getState().consoles[HILL_KEY]?.[0]?.status, "timeout");
  radio.queue.push(cliFrame(HILL, `${tag}|v1.17.1 (Build: 12-Sep-2026)`));
  radio.push(new Uint8Array([Push.MsgWaiting]));
  await tick(5);
  const entry = session.getState().consoles[HILL_KEY]?.[0];
  assert.equal(entry?.status, "done");
  assert.equal(entry?.reply, "v1.17.1 (Build: 12-Sep-2026)");
});

test("a password change shows in the console without the password", async () => {
  const { radio, session } = await nodeSession();
  const change = session.writeNodeSetting(HILL_KEY, "password", "hunter22", "password hunter22", { mask: "password ••••••" });
  await tick();
  const tag = sentText(radio.sent.find((f) => f[0] === Cmd.SendTxtMsg)!).slice(0, 2);
  radio.queue.push(cliFrame(HILL, `${tag}|password now: hunter22`));
  radio.push(new Uint8Array([Push.MsgWaiting]));
  await change;
  const entry = session.getState().consoles[HILL_KEY]![0]!;
  assert.equal(entry.command, "password ••••••");
  assert.equal(entry.reply, "password now: ••••••");
});

test("a room post is filed under the room and named after its author", async () => {
  const { radio, session } = await nodeSession();
  radio.queue.push(
    new ByteWriter()
      .u8(Resp.ContactMsgRecvV3)
      .i8(8)
      .u16(0)
      .bytes(ROOM.subarray(0, 6))
      .u8(1)
      .u8(TxtType.SignedPlain)
      .u32(1_700_000_010)
      .bytes(BOB.subarray(0, 4))
      .string("posted in the room")
      .toBytes(),
  );
  radio.push(new Uint8Array([Push.MsgWaiting]));
  await tick(5);
  const message = session.getState().messages[0]!;
  assert.equal(message.conversation, contactConversation(ROOM_KEY));
  assert.equal(message.sender, "Bob");
  assert.equal(message.text, "posted in the room");
});

test("the role from a sign-in survives a reconnect", async () => {
  const storage = new MemoryStorage();
  const radio = new ScriptedRadio();
  radio.contacts = [contactFrame(HILL, "Hill", 10, 2)];
  const session = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await session.connect(radio);
  const login = session.login(HILL_KEY, "secret");
  await tick();
  radio.push(new ByteWriter().u8(Push.LoginSuccess).u8(1).bytes(HILL.subarray(0, 6)).u32(1).u8(3).u8(2).toBytes());
  await login;
  await session.disconnect();

  const again = new ScriptedRadio();
  again.contacts = [contactFrame(HILL, "Hill", 10, 2)];
  const second = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await second.connect(again);
  assert.equal(second.getState().logins[HILL_KEY]?.role, 3);
});

// ---- routes ----

/** A flooded packet as the radio hands it up on LOG_RX_DATA: header, path_len, one-byte hashes, payload. */
function heardPacket(payloadType: number, hashes: number[], payload: Uint8Array, snr = 8): Uint8Array {
  return new ByteWriter()
    .u8(Push.LogRxData)
    .i8(snr)
    .i8(-90)
    .u8((payloadType << 2) | 1)
    .u8(hashes.length)
    .bytes(new Uint8Array(hashes))
    .bytes(payload)
    .toBytes();
}

test("pinning a contact to flood drops its route now, and again whenever the radio learns one", async () => {
  const radio = new ScriptedRadio();
  radio.contacts = [contactFrame(BOB, "Bob", 1_699_999_000, 1, [0xa3, 0x7f])];
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  assert.equal(session.getState().contacts[bobKey()]?.outPathLen, 2);

  await session.setFloodPinned(bobKey(), true);
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.ResetPath).length, 1);
  assert.equal(session.getState().contacts[bobKey()]?.outPathLen, 0xff);
  assert.deepEqual(session.getState().routing.contacts[bobKey()], { flood: true });

  // The radio learns a route from an acknowledgement.
  radio.contacts = [contactFrame(BOB, "Bob", 1_699_999_100, 1, [0x55])];
  radio.push(new ByteWriter().u8(Push.PathUpdated).bytes(BOB).toBytes());
  await tick(5);
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.ResetPath).length, 2);
  assert.equal(session.getState().contacts[bobKey()]?.outPathLen, 0xff);

  await session.setFloodPinned(bobKey(), false);
  assert.deepEqual(session.getState().routing.contacts, {});
  await session.disconnect();
});

test("a route older than its time limit is dropped before the next message goes", async () => {
  let clock = 1_700_000_000_000;
  const radio = new ScriptedRadio();
  // The radio learned the route a minute ago, while nobody was listening.
  radio.contacts = [contactFrame(BOB, "Bob", 1_699_999_940, 1, [0x7f])];
  const session = new MeshSession({ now: () => clock });
  await session.connect(radio);
  assert.equal(session.getState().contacts[bobKey()]?.pathSince, 1_699_999_940_000);

  session.setDefaultRouteReset(15);
  await tick(5);
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.ResetPath).length, 0);
  assert.equal(session.routeExpiresAt(bobKey()), 1_699_999_940_000 + 15 * 60_000);

  clock += 20 * 60_000;
  await session.sendText(contactConversation(bobKey()), "still there?");
  const codes = radio.sent.map((f) => f[0]);
  const reset = codes.lastIndexOf(Cmd.ResetPath);
  assert.ok(reset >= 0 && reset < codes.lastIndexOf(Cmd.SendTxtMsg), "the route goes before the message");
  assert.equal(session.getState().contacts[bobKey()]?.pathSince, null);

  // A contact of its own that never drops its route is left alone.
  session.setRouteReset(bobKey(), null);
  assert.equal(session.routePolicy(bobKey()).resetAfterMin, null);
  await session.disconnect();
});

test("a direct message that went unacknowledged along a route is retried as a flood", async () => {
  const storage = new MemoryStorage();
  const first = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  const routed = () => {
    const radio = new ScriptedRadio();
    radio.contacts = [contactFrame(BOB, "Bob", 1_699_999_990, 1, [0x7f])];
    return radio;
  };
  await first.connect(routed());
  const sent = await first.sendText(contactConversation(bobKey()), "hello?");
  assert.equal(sent.flood, false);
  assert.deepEqual(sent.route, ["7f"]);
  await first.disconnect();
  // What the ack timer would have done.
  const saved = storage.saved.get(first.getState().self!.key)!;
  saved.messages[0]!.status = "unconfirmed";

  const radio = routed();
  const session = new MeshSession({ storage, now: () => 1_700_000_600_000 });
  await session.connect(radio);
  const message = session.getState().messages[0]!;
  assert.equal(session.retryFloods(message), true);
  await session.retry(message.id);
  const codes = radio.sent.map((f) => f[0]);
  assert.ok(codes.indexOf(Cmd.ResetPath) >= 0 && codes.indexOf(Cmd.ResetPath) < codes.indexOf(Cmd.SendTxtMsg));
  assert.equal(session.getState().messages[0]?.attempt, 1);
  // The stamp stays, being the same message; the chat files it by when it went.
  assert.equal(session.getState().messages[0]?.timestamp, 1_700_000_000);
  assert.equal(session.getState().messages[0]?.sentAt, 1_700_000_600);
  await session.disconnect();
});

test("a message written while the radio is away waits, then goes out stamped with the moment it is sent", async () => {
  const storage = new MemoryStorage();
  let now = 1_700_000_000_000;
  const session = new MeshSession({ storage, now: () => now });
  await session.connect(new ScriptedRadio());
  await session.disconnect();

  const queued = await session.sendText(contactConversation(bobKey()), "on my way");
  const later = await session.sendText(channelConversation(0), "and you?");
  assert.equal(queued.status, "queued");
  assert.equal(later.status, "queued");

  now += 3_600_000;
  const radio = new ScriptedRadio();
  await session.connect(radio);
  await tick(20);
  const [dm, ch] = session.getState().messages;
  assert.equal(dm?.status, "sent");
  assert.equal(ch?.status, "sent");
  // Sent now, an hour after it was written; the second a second after the first.
  assert.equal(dm?.timestamp, Math.floor(now / 1000));
  assert.equal(ch?.timestamp, Math.floor(now / 1000) + 1);
  const codes = radio.sent.map((f) => f[0]);
  assert.ok(codes.indexOf(Cmd.SendTxtMsg) < codes.indexOf(Cmd.SendChannelTxtMsg));
  await session.disconnect();
});

test("a queued message can be taken back before the radio is back", async () => {
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(new ScriptedRadio());
  await session.disconnect();
  const queued = await session.sendText(contactConversation(bobKey()), "never mind");
  session.discardQueued(queued.id);
  assert.equal(session.getState().messages.length, 0);
});

test("a message sent by flood on request drops the route first", async () => {
  const radio = new ScriptedRadio();
  radio.contacts = [contactFrame(BOB, "Bob", 1_699_999_990, 1, [0x7f])];
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  await session.sendText(contactConversation(bobKey()), "flood this", { flood: true });
  const codes = radio.sent.map((f) => f[0]);
  assert.ok(codes.indexOf(Cmd.ResetPath) >= 0 && codes.indexOf(Cmd.ResetPath) < codes.indexOf(Cmd.SendTxtMsg));
  await session.disconnect();
});

test("a text too long for the attempt number goes round its first four attempts again", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  const long = await session.sendText(contactConversation(bobKey()), "x".repeat(159));
  const short = await session.sendText(contactConversation(bobKey()), "short");
  for (let i = 0; i < 5; i++) {
    await session.retry(long.id);
    await session.retry(short.id);
  }
  const attempts = radio.sent.filter((f) => f[0] === Cmd.SendTxtMsg).map((f) => ({ attempt: f[2], length: f.length }));
  const longOnes = attempts.filter((a) => a.length > 100).map((a) => a.attempt);
  const shortOnes = attempts.filter((a) => a.length <= 100).map((a) => a.attempt);
  assert.deepEqual(longOnes, [0, 1, 2, 3, 0, 1]);
  assert.deepEqual(shortOnes, [0, 1, 2, 3, 4, 5]);
  assert.equal(session.getState().messages.find((m) => m.id === long.id)?.attempt, 5);
  await session.disconnect();
});

test("a flood's acknowledgement brings back the route it took", async () => {
  const radio = new ScriptedRadio();
  radio.sendsFlood = true;
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  const sent = await session.sendText(contactConversation(bobKey()), "anyone?");
  assert.equal(sent.flood, true);
  assert.equal(sent.route, null);
  // The path return: the radio learns the route, then matches the ack inside it.
  radio.contacts = [contactFrame(BOB, "Bob", 1_700_000_000, 1, [0xe0, 0x7f])];
  radio.push(new ByteWriter().u8(Push.PathUpdated).bytes(BOB).toBytes());
  radio.push(new ByteWriter().u8(Push.SendConfirmed).u32(0x11223344).u32(4800).toBytes());
  await tick(5);
  const message = session.getState().messages.find((m) => m.id === sent.id)!;
  assert.equal(message.status, "delivered");
  assert.deepEqual(message.route, ["e0", "7f"]);
  assert.equal(session.getState().contacts[bobKey()]?.pathSince, 1_700_000_000_000);
  await session.disconnect();
});

test("an incoming channel message gathers every copy the radio heard, before it and after", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  const secret = fromHex(session.getState().channels[0]!.secret);
  const payload = await heardGroupTextPayload(secret, 1_700_000_060, TxtType.Plain, "Alice: who hears me?");
  radio.push(heardPacket(5, [0x7f, 0xa3], payload, 12));
  radio.push(heardPacket(5, [0x9d], payload.map((b, i) => (i === 3 ? b ^ 1 : b)))); // somebody else's
  radio.queue.push(channelFrame(0, "Alice: who hears me?"));
  radio.push(new Uint8Array([Push.MsgWaiting]));
  await tick(10);
  radio.push(heardPacket(5, [0x9d], payload, -20));
  radio.push(heardPacket(5, [0x7f, 0xa3], payload)); // the same path again
  await tick(5);
  const message = session.getState().messages.find((m) => m.direction === "in")!;
  assert.equal(message.sender, "Alice");
  assert.deepEqual(message.echoes, [
    { path: ["7f", "a3"], snr: 3 },
    { path: ["9d"], snr: -5 },
  ]);
  await session.disconnect();
});

test("an incoming flooded direct message takes the packet addressed from its sender to us", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  const sealed = (to: number, from: number) => new Uint8Array([to, from, 0x12, 0x34, ...new Uint8Array(16).fill(from)]);
  radio.push(heardPacket(2, [0x44], sealed(0xa0, 0x99))); // from somebody else
  radio.push(heardPacket(2, [0x7f], sealed(0xa0, 0x01)));
  radio.push(heardPacket(2, [0x55], sealed(0xb0, 0x01))); // to somebody else
  radio.queue.push(dmFrame(BOB, "one hop away"));
  radio.push(new Uint8Array([Push.MsgWaiting]));
  await tick(5);
  radio.push(heardPacket(2, [0x4b], sealed(0xa0, 0x01), -12));
  await tick(5);
  const message = session.getState().messages[0]!;
  assert.equal(message.hops, 1);
  assert.deepEqual(message.echoes, [
    { path: ["7f"], snr: 2 },
    { path: ["4b"], snr: -3 },
  ]);
  await session.disconnect();
});

test("the routing settings survive a reconnect", async () => {
  const storage = new MemoryStorage();
  const session = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await session.connect(new ScriptedRadio());
  session.setDefaultRouteReset(30);
  session.setRouteReset(bobKey(), 5);
  await session.disconnect();

  const second = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await second.connect(new ScriptedRadio());
  assert.deepEqual(second.getState().routing, { resetAfterMin: 30, contacts: { [bobKey()]: { resetAfterMin: 5 } } });
  await second.disconnect();
});

test("flush serializes writes so an older pending save cannot overwrite the latest history", async () => {
  const snapshots: PersistedState[] = [];
  let release!: () => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const storage = {
    load: async () => null,
    save: async (_key: string, snapshot: PersistedState) => {
      if (snapshots.length === 0) { started(); await pending; }
      snapshots.push(snapshot);
    },
  };
  const session = new MeshSession({ storage });
  await session.connect(new ScriptedRadio());
  session.setDefaultRouteReset(10);
  const first = session.flush();
  await firstStarted;
  session.setDefaultRouteReset(20);
  const second = session.flush();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(snapshots.map((state) => state.routing?.resetAfterMin), [10, 20]);
  await session.disconnect();
  await session.flush();
  assert.equal(snapshots.at(-1)!.routing?.resetAfterMin, 20);
});

test("flush reports a storage failure and allows a subsequent retry", async () => {
  let fail = true;
  let saved = 0;
  const session = new MeshSession({ storage: {
    load: async () => null,
    save: async () => { if (fail) throw new Error("disk full"); saved++; },
  } });
  await session.connect(new ScriptedRadio());
  await assert.rejects(session.flush(), /disk full/);
  fail = false;
  await session.flush();
  assert.equal(saved, 1);
  await session.disconnect();
});

// ---- diagnostics ----

test("a trace's SNRs split into legs: out along the path, back the other way", () => {
  // Out through two relays and back: at the first, the second, the first again, then ours.
  assert.deepEqual(traceLegs([-2.5, 8.5, 7.75, -4], 2), [[-2.5, -4], [8.5, 7.75]]);
  assert.deepEqual(traceLegs([3, 1.5], 1), [[3, 1.5]]);
  assert.deepEqual(traceLegs([3], 1), []);
});

test("a path's hashes are read at the size its length byte gives, and routes compare by what they hold", () => {
  assert.deepEqual(pathHashes(2, "3fa1"), ["3f", "a1"]);
  assert.deepEqual(pathHashes(0x42, "3f01a102"), ["3f01", "a102"]);
  assert.equal(routeKey(2, "3fa1".padEnd(128, "0")), "2:3fa1");
  assert.equal(routeKey(0xff, ""), "none");
});

test("a trace goes out and back along the path, and resolves with every hop's SNR", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ traceWaitMs: () => 500 });
  await session.connect(radio);
  const result = session.traceRoute(["3f", "a1"]);
  await tick();
  const frame = radio.sent.find((f) => f[0] === Cmd.SendTracePath)!;
  assert.deepEqual([...frame.subarray(9)], [0, 0x3f, 0xa1, 0x3f]);
  radio.push(
    new ByteWriter()
      .u8(Push.TraceData)
      .u8(0)
      .u8(3)
      .u8(0)
      .bytes(frame.subarray(1, 5))
      .u32(0)
      .bytes(new Uint8Array([0x3f, 0xa1, 0x3f]))
      .i8(-10)
      .i8(34)
      .i8(31)
      .i8(-16)
      .toBytes(),
  );
  const back = await result;
  assert.ok(back);
  assert.deepEqual(back.snrs, [-2.5, 8.5, 7.75, -4]);
  await session.disconnect();
});

test("a trace can come home another way than it went", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ traceWaitMs: () => 30 });
  await session.connect(radio);
  // Out through 3f and a1, home through 5c and 3f; two-byte hashes are traced at the shortest size given.
  await session.traceRoute(["3f01", "a102"], ["5c", "3f"]);
  const frame = radio.sent.find((f) => f[0] === Cmd.SendTracePath)!;
  assert.deepEqual([...frame.subarray(9)], [0, 0x3f, 0xa1, 0x5c, 0x3f]);
  await session.disconnect();
});

test("a trace that comes back after it was given up on is still heard, up to the radio's estimate", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ traceWaitMs: () => 30 });
  await session.connect(radio);
  const late: number[][] = [];
  assert.equal(await session.traceRoute(["3f"], undefined, (r) => late.push(r.snrs)), null);
  const frame = radio.sent.find((f) => f[0] === Cmd.SendTracePath)!;
  radio.push(new ByteWriter().u8(Push.TraceData).u8(0).u8(1).u8(0).bytes(frame.subarray(1, 5)).u32(0).bytes(new Uint8Array([0x3f])).i8(8).i8(12).toBytes());
  await tick();
  assert.deepEqual(late, [[2, 3]]);
  await session.disconnect();
});

test("a trace that does not come back resolves with nothing", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ traceWaitMs: () => 30 });
  await session.connect(radio);
  assert.equal(await session.traceRoute(["3f"]), null);
  await session.disconnect();
});

test("who hears me asks the repeaters in range, and keeps the answers to this ask", async () => {
  const radio = new ScriptedRadio();
  radio.contacts = [contactFrame(BOB, "Hill", 10, 2)];
  const session = new MeshSession();
  await session.connect(radio);
  const heard: string[] = [];
  const asked = session.discoverRepeaters(60, (r) => heard.push(r.key));
  await tick();
  const frame = radio.sent.find((f) => f[0] === Cmd.SendControlData)!;
  assert.equal(frame[1], 0x80);
  assert.equal(frame[2], 1 << 2);
  const tag = frame.subarray(3, 7);
  const answer = (t: Uint8Array) =>
    new ByteWriter().u8(Push.ControlData).i8(-16).i8(-100).u8(0).u8(0x92).i8(-10).bytes(t).bytes(BOB).toBytes();
  radio.push(answer(tag));
  radio.push(answer(new Uint8Array([9, 9, 9, 9])));
  const replies = await asked;
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0], { key: bobKey(), known: true, type: 2, heardUs: -2.5, heardThem: -4, rssi: -100, at: replies[0]!.at });
  assert.deepEqual(heard, [bobKey()]);
  await session.disconnect();
});

test("a route written by hand goes to the radio and outlives the time limit on learned routes", async () => {
  let now = 1_700_000_000_000;
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => now });
  await session.connect(radio);
  await session.setRoute(bobKey(), ["3f", "a1"]);
  const frame = radio.sent.find((f) => f[0] === Cmd.AddUpdateContact)!;
  assert.equal(frame[35], 2);
  assert.deepEqual([...frame.subarray(36, 38)], [0x3f, 0xa1]);
  assert.equal(session.getState().contacts[bobKey()]?.outPathLen, 2);
  assert.ok(session.routeSetByHand(bobKey()));
  now += 30 * 60_000;
  session.setDefaultRouteReset(5);
  await tick();
  assert.ok(!radio.sent.some((f) => f[0] === Cmd.ResetPath));
  await session.disconnect();
});

test("the radio's own receiver is read without going on the air", async () => {
  const session = new MeshSession();
  await session.connect(new ScriptedRadio());
  const stats = await session.radioStats();
  assert.equal(stats.noiseFloor, -115);
  assert.equal(stats.lastSnr, 7);
  assert.equal(stats.rxAirSecs, 3400);
  await session.disconnect();
});

test("history from a file comes in once, beside what is here", async () => {
  const now = 1_700_000_000_000;
  const session = new MeshSession({ now: () => now });
  const radio = new ScriptedRadio();
  radio.queue.push(dmFrame(BOB, "from last time"));
  await session.connect(radio);
  const here = session.getState().messages[0]!;
  const bob = session.getState().contacts[here.conversation.slice(2)]!;
  const older = { ...here, id: "official:dm:1", text: "long ago", timestamp: here.timestamp - 3600, receivedAt: here.receivedAt - 3_600_000 };
  // Another file's message that happens to carry an id taken here.
  const clash = { ...here, text: "same id, other text", timestamp: here.timestamp - 60, receivedAt: here.receivedAt - 60_000 };
  const gone = { ...bob, key: "ee".repeat(32), prefix: "ee".repeat(6), name: "Gone" };
  const taken = { ...bob, key: "ab".repeat(32), prefix: "ab".repeat(6), name: "Taken off" };
  const heard = { ...bob, key: "dd".repeat(32), prefix: "dd".repeat(6), name: "Heard", lastHeardAt: 1_699_999_000_000 };
  const history = {
    messages: [older, { ...here, id: "official:dm:2" }, clash],
    contacts: [bob, gone],
    removed: [{ contact: taken, at: now - 200 * 86_400_000, by: "you" as const }],
    heard: [heard],
  };

  const unread = session.getState().unread;
  const summary = session.importHistory(history);
  assert.deepEqual(summary, { messages: 2, already: 1, removedContacts: 2, heard: 1 });
  const state = session.getState();
  // Filed by when they arrived: the old ones go first. Old messages are not unread.
  assert.deepEqual(state.messages.map((m) => m.text), ["long ago", "same id, other text", "from last time"]);
  assert.notEqual(state.messages[1]!.id, here.id);
  assert.equal(new Set(state.messages.map((m) => m.id)).size, 3);
  assert.deepEqual(state.unread, unread);
  // The radio's own contact stays as it is; one it lost is kept as removed; a heard node is not saved.
  assert.equal(state.contacts[bob.key], bob);
  assert.equal(state.removed[gone.key]?.contact.name, "Gone");
  assert.equal(state.removed[gone.key]?.by, "radio");
  // One removed before keeps who removed it, and is kept as long as one removed now.
  assert.deepEqual(state.removed[taken.key], { contact: taken, at: now, by: "you" });
  assert.equal(state.contacts[heard.key]?.unsaved, true);

  // The same file again adds nothing.
  assert.deepEqual(session.importHistory(history), { messages: 0, already: 3, removedContacts: 0, heard: 0 });

  // What is here already is never written over: not a contact on the radio, a removed one, or a node heard.
  const renamed = (c: typeof bob) => ({ ...c, name: `${c.name} from the file`, lat: 1, lon: 2, flags: 0xff });
  session.importHistory({
    messages: [],
    contacts: [renamed(bob), renamed(gone), renamed(heard)],
    removed: [renamed(bob), renamed(gone), renamed(heard)].map((contact) => ({ contact, at: now, by: "you" as const })),
    heard: [renamed(bob), renamed(gone), renamed(heard)],
  });
  const after = session.getState();
  assert.equal(after.contacts[bob.key], bob);
  assert.equal(after.removed[gone.key]?.contact.name, "Gone");
  assert.equal(after.contacts[heard.key]?.name, "Heard");
  assert.equal(after.contacts[gone.key], undefined);
  assert.equal(after.removed[heard.key], undefined);
  await session.disconnect();
});
