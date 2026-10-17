/**
 * A command/response client over a transport.
 *
 * The firmware handles one command at a time and answers in order, and it
 * interleaves pushes (codes 0x80 and up) whenever it likes. So: commands are
 * queued and sent one at a time; every response frame belongs to the command
 * in flight; every push goes to the push listeners. Some commands answer with
 * several frames (`getContacts` streams them), so a request carries a
 * predicate that says when its answer is complete.
 *
 * A radio with Bluetooth and Wi-Fi at once (MeshCore 1.18) writes every answer
 * to every link, so another app on the other link sees ours and we see its. A
 * request that names the kinds of answer it takes leaves the others alone, and
 * they go to the stray listeners with the answers nobody here asked for.
 */

import { bytesEqual, concat } from "./protocol/bytes.js";
import { ErrCode, errorName, TxtType } from "./protocol/codes.js";
import * as cmd from "./protocol/commands.js";
import {
  decodeFrame,
  isPushFrame,
  type Contact,
  type DeviceInfo,
  type Frame,
  type PushFrame,
  type ResponseFrame,
  type SelfInfo,
} from "./protocol/frames.js";
import type { Transport } from "./transport.js";

export class MeshCoreError extends Error {
  constructor(
    readonly code: number,
    readonly command: string,
  ) {
    super(`${command}: ${errorName(code)}`);
    this.name = "MeshCoreError";
  }
}

/**
 * Whether the radio refused a send for want of a free packet. A companion has
 * sixteen for everything it receives, sends and passes on, and a busy air
 * keeps them queued; its "table full" to a send means that. An anonymous
 * request says the same when the contacts are full, so it is left out.
 */
export function noRoom(error: unknown): error is MeshCoreError {
  return error instanceof MeshCoreError && error.code === ErrCode.TableFull && error.command.startsWith("send") && error.command !== "sendAnonReq";
}

export class TransportClosedError extends Error {
  constructor(reason: Error | null) {
    super(reason ? `link closed: ${reason.message}` : "link closed");
    this.name = "TransportClosedError";
  }
}

export class TimeoutError extends Error {
  constructor(command: string, ms: number) {
    super(`${command}: no answer in ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Another app on the same radio asked at the same moment: the answer that came
 * may have been that app's, or that app cut it short.
 */
export class OverlapError extends Error {
  constructor(command: string) {
    super(`${command}: another app on the radio asked at the same time`);
    this.name = "OverlapError";
  }
}

/** Answers `"more"` while a response is still arriving, `"done"` on its last frame. */
type Completion = (frame: ResponseFrame, collected: ResponseFrame[]) => "more" | "done";

interface Pending {
  name: string;
  bytes: Uint8Array;
  complete: Completion;
  /** The kinds of answer this command takes besides an error; null takes any. */
  expect: ReadonlySet<ResponseFrame["kind"]> | null;
  /**
   * Of those, the one that is its own, where the answer names what was asked:
   * a radio open in two apps writes every answer to both, and another app's
   * read of slot 3 must not pass for this one's read of slot 1.
   */
  accepts: ((frame: ResponseFrame, collected: ResponseFrame[]) => boolean) | null;
  /** Stray answers after which nothing more of a stream comes. */
  cutBy: ReadonlySet<ResponseFrame["kind"]> | null;
  /**
   * Set when an error comes after the first frame. The firmware answers a
   * command once, or opens a stream with its first frame, so the error is
   * another app's command refused, and the stream may be that app's.
   */
  contested: boolean;
  timeoutMs: number;
  /** Set when the firmware answers nothing at all, as on reboot. */
  fireAndForget: boolean;
  /** Set for a frame nothing ever answers, which is done once it is written. */
  answerless: boolean;
  collected: ResponseFrame[];
  resolve: (frames: ResponseFrame[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ClientOptions {
  /** How long a command may go unanswered. Streaming answers restart it per frame. */
  timeoutMs?: number;
  /** How long a command that rewrites the radio's contacts file may go unanswered. */
  savingTimeoutMs?: number;
  /** Every frame in either direction, for a log pane. */
  trace?: (direction: "in" | "out", bytes: Uint8Array, frame?: Frame) => void;
  /** The clock a stray answer is dated by, milliseconds. */
  now?: () => number;
  /** The longest pause before a contact list read another app got in the way of is asked again. */
  retryPauseMs?: number;
}

const single: Completion = () => "done";

/**
 * An answer that comes this long after one of ours went unanswered, or after
 * the link opened, is more likely that late answer, or one from before this
 * client, than another app's.
 */
const LATE_ANSWER_MS = 60_000;
const OPENING_MS = 5_000;

/** The answers that carry a message from the radio's queue, and the one that says it is empty. */
const SYNC_ANSWERS: ResponseFrame["kind"][] = ["contactMessage", "channelMessage", "channelData", "noMoreMessages"];

/**
 * Some firmware (Smart UI 0.05 on a Heltec) writes its whole contacts file to
 * flash before it answers a command that changes a contact, and 350 contacts on
 * SPIFFS can take longer than the usual wait. An answer that comes after the
 * wait goes to the next command instead: a status request was once answered by
 * a forgotten route's "ok" (#78). The radio core on phones waits as long.
 */
const SAVING_TIMEOUT_MS = 30_000;

/** How many times the contact list is asked for while another app keeps reading it too. */
const CONTACT_READS = 4;

/** How long after another app's last answer this one is taken to share the radio still. */
const SHARED_MS = 5 * 60_000;

export interface TextSendResult {
  /** Whether the packet went out as a flood (no known route) or direct. */
  flood: boolean;
  /** Matches a later `sendConfirmed` push. Zero when no ack is expected. */
  ackTag: number;
  /** The firmware's guess at how long the ack will take. */
  estTimeoutMs: number;
}

export type MessageFrame = Extract<ResponseFrame, { kind: "contactMessage" | "channelMessage" | "channelData" }>;

export class MeshCoreClient {
  private queue: Pending[] = [];
  private inFlight: Pending | null = null;
  private pushListeners = new Set<(frame: PushFrame) => void>();
  private strayListeners = new Set<(frame: ResponseFrame, late: boolean) => void>();
  private closeListeners = new Set<(reason: Error | null) => void>();
  private refusedListeners = new Set<(error: MeshCoreError) => void>();
  private closedWith: Error | null | undefined;
  private readonly timeoutMs: number;
  private readonly savingTimeoutMs: number;
  private readonly trace: ClientOptions["trace"];
  private readonly now: () => number;
  private readonly retryPauseMs: number;
  private readonly openedAt: number;
  private timedOutAt = -Infinity;
  /** When an answer nothing here asked for last came, which is mostly another app's. */
  private strayAt = -Infinity;
  /** The radio's own key, from its answer to `appStart`: a direct text's tag is worked out with it. */
  private selfKey: Uint8Array | null = null;
  /**
   * Set once a phone's relay says this app reaches the radio through it. The
   * relay hands each answer to one app by its kind and cannot work out a
   * text's tag, so a `sent` it hands here is taken as it is: waiting for
   * another would only wait out the timeout.
   */
  private relayed = false;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(readonly transport: Transport, options: ClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.savingTimeoutMs = options.savingTimeoutMs ?? Math.max(SAVING_TIMEOUT_MS, this.timeoutMs);
    this.trace = options.trace;
    this.now = options.now ?? Date.now;
    this.retryPauseMs = options.retryPauseMs ?? 1000;
    this.openedAt = this.now();
    this.unsubscribe.push(transport.onFrame((bytes) => this.onBytes(bytes)));
    this.unsubscribe.push(transport.onClose((reason) => this.onClosed(reason)));
  }

  get isClosed(): boolean {
    return this.closedWith !== undefined;
  }

  /** Includes local radio commands as well as requests waiting in the command queue. */
  get isBusy(): boolean {
    return this.inFlight !== null || this.queue.length > 0;
  }

  onPush(listener: (frame: PushFrame) => void): () => void {
    this.pushListeners.add(listener);
    return () => this.pushListeners.delete(listener);
  }

  /**
   * An answer no command here is waiting for: another app's, on a radio that
   * answers every link, or `late`, when it may be a late answer to one of ours.
   */
  onStray(listener: (frame: ResponseFrame, late: boolean) => void): () => void {
    this.strayListeners.add(listener);
    return () => this.strayListeners.delete(listener);
  }

  onClose(listener: (reason: Error | null) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** A command the radio refused, heard before its caller hears it. */
  onRefused(listener: (error: MeshCoreError) => void): () => void {
    this.refusedListeners.add(listener);
    return () => this.refusedListeners.delete(listener);
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  // ---- the request machinery ----

  private onBytes(bytes: Uint8Array): void {
    const frame = decodeFrame(bytes);
    this.trace?.("in", bytes, frame);
    if (frame.kind === "unknown") {
      if (frame.code >= 0x80) return; // a push this client does not know
      // An unknown response still belongs to whatever is in flight; an
      // unknown answer is an answer, and holding the queue for it helps nothing.
      this.finish(new Error(`unrecognised response 0x${frame.code.toString(16)} to ${this.inFlight?.name ?? "nothing"}`));
      return;
    }
    if (isPushFrame(frame)) {
      if (frame.kind === "peerHello") this.relayed = true;
      for (const listener of this.pushListeners) {
        try {
          listener(frame);
        } catch (error) {
          console.error("push listener threw", error);
        }
      }
      return;
    }
    const pending = this.inFlight;
    if (pending && frame.kind === "err" && pending.collected.length > 0) {
      pending.contested = true;
      this.stray(frame);
      return;
    }
    // Nothing waits for it, or what waits takes another kind: the firmware
    // finishing an answer to a command that timed out, a frame from before
    // this client attached, or another app's answer. A frame nothing answers
    // waits for none.
    if (
      !pending ||
      pending.answerless ||
      (frame.kind !== "err" &&
        ((pending.expect && !pending.expect.has(frame.kind)) || (pending.accepts && !pending.accepts(frame, pending.collected))))
    ) {
      this.stray(frame);
      if (pending && pending.collected.length > 0 && pending.cutBy?.has(frame.kind)) this.finish(new OverlapError(pending.name));
      return;
    }
    if (frame.kind === "err") {
      const error = new MeshCoreError(frame.code, pending.name);
      for (const listener of this.refusedListeners) {
        try {
          listener(error);
        } catch (failure) {
          console.error("refused listener threw", failure);
        }
      }
      this.finish(error);
      return;
    }
    pending.collected.push(frame);
    if (pending.complete(frame, pending.collected) === "done") {
      this.finish(null);
    } else {
      this.armTimer(pending);
    }
  }

  /** Resolves when a stray answer of this kind comes, or after `ms`. */
  private strayOf(kind: ResponseFrame["kind"], ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(done, ms);
      const off = this.onStray((frame) => {
        if (frame.kind === kind) done();
      });
    });
  }

  private stray(frame: ResponseFrame): void {
    const now = this.now();
    this.strayAt = now;
    const late = now - this.timedOutAt < LATE_ANSWER_MS || now - this.openedAt < OPENING_MS;
    for (const listener of this.strayListeners) {
      try {
        listener(frame, late);
      } catch (error) {
        console.error("stray listener threw", error);
      }
    }
  }

  private onClosed(reason: Error | null): void {
    this.closedWith = reason;
    const error = new TransportClosedError(reason);
    const pending = this.inFlight;
    this.inFlight = null;
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.fireAndForget) pending.resolve(pending.collected);
      else pending.reject(error);
    }
    for (const queued of this.queue) queued.reject(error);
    this.queue = [];
    for (const listener of this.closeListeners) {
      try {
        listener(reason);
      } catch (error) {
        console.error("close listener threw", error);
      }
    }
    for (const off of this.unsubscribe) off();
  }

  private armTimer(pending: Pending): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (this.inFlight === pending) {
        if (pending.fireAndForget) {
          this.finish(null);
        } else {
          this.timedOutAt = this.now();
          this.finish(new TimeoutError(pending.name, pending.timeoutMs));
        }
      }
    }, pending.timeoutMs);
  }

  private finish(error: Error | null): void {
    const pending = this.inFlight;
    if (!pending) return;
    this.inFlight = null;
    if (pending.timer) clearTimeout(pending.timer);
    if (!error && pending.contested) error = new OverlapError(pending.name);
    if (error) pending.reject(error);
    else pending.resolve(pending.collected);
    this.pump();
  }

  private pump(): void {
    if (this.inFlight || this.closedWith !== undefined) return;
    const next = this.queue.shift();
    if (!next) return;
    this.inFlight = next;
    this.trace?.("out", next.bytes);
    this.transport.send(next.bytes).then(
      () => {
        if (this.inFlight !== next) return;
        if (next.answerless) this.finish(null);
        else this.armTimer(next);
      },
      (error: unknown) => {
        if (this.inFlight === next) {
          this.finish(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
  }

  /** Sends a command and resolves with every response frame it produced. */
  request(
    name: string,
    bytes: Uint8Array,
    options: {
      complete?: Completion;
      expect?: ResponseFrame["kind"][];
      accepts?: (frame: ResponseFrame, collected: ResponseFrame[]) => boolean;
      cutBy?: ResponseFrame["kind"][];
      timeoutMs?: number;
      fireAndForget?: boolean;
      answerless?: boolean;
    } = {},
  ): Promise<ResponseFrame[]> {
    if (this.closedWith !== undefined) {
      return Promise.reject(new TransportClosedError(this.closedWith));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({
        name,
        bytes,
        complete: options.complete ?? single,
        expect: options.expect ? new Set(options.expect) : null,
        accepts: options.accepts ?? null,
        cutBy: options.cutBy ? new Set(options.cutBy) : null,
        contested: false,
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        fireAndForget: options.fireAndForget ?? false,
        answerless: options.answerless ?? false,
        collected: [],
        resolve,
        reject,
        timer: null,
      });
      this.pump();
    });
  }

  private async one<K extends ResponseFrame["kind"]>(
    name: string,
    bytes: Uint8Array,
    kind: K,
    timeoutMs?: number,
  ): Promise<Extract<ResponseFrame, { kind: K }>> {
    const frames = await this.request(name, bytes, timeoutMs === undefined ? { expect: [kind] } : { expect: [kind], timeoutMs });
    const frame = frames[0];
    if (!frame || frame.kind !== kind) {
      throw new Error(`${name}: expected ${kind}, got ${frame?.kind ?? "nothing"}`);
    }
    return frame as Extract<ResponseFrame, { kind: K }>;
  }

  private async ok(name: string, bytes: Uint8Array, timeoutMs?: number): Promise<void> {
    await this.one(name, bytes, "ok", timeoutMs);
  }

  // ---- the commands, typed ----

  /**
   * A frame for the other app sharing the radio through the phone (`peer.ts`).
   * The phone's relay takes it and answers nothing; it waits its turn behind
   * the commands before it all the same, since a link writes one frame at a time.
   */
  async tell(bytes: Uint8Array): Promise<void> {
    await this.request("tell", bytes, { answerless: true });
  }

  deviceQuery(): Promise<DeviceInfo> {
    return this.one("deviceQuery", cmd.deviceQuery(), "deviceInfo").then((f) => f.info);
  }

  async appStart(appName: string): Promise<SelfInfo> {
    const { info } = await this.one("appStart", cmd.appStart(appName), "selfInfo");
    this.selfKey = info.publicKey;
    return info;
  }

  /**
   * Streams the radio's contacts. With `since`, only those modified after it;
   * `mostRecentLastMod` is the cursor for the next call.
   *
   * Another app on the radio's other link may read them at the same moment.
   * The radio reads out one list at a time and refuses the second, both apps
   * hear both answers, and neither can tell whose list came, which matters when
   * the two asked for changes since different times. So each asks again a
   * random moment later, which takes two apps asking in step out of step.
   */
  async getContacts(since?: number): Promise<{ total: number; contacts: Contact[]; mostRecentLastMod: number }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.readContacts(since);
      } catch (error) {
        const busy = error instanceof MeshCoreError && error.code === ErrCode.BadState;
        if (!(busy || error instanceof OverlapError) || attempt >= CONTACT_READS) throw error;
        // The other app's list is still coming out.
        if (busy) await this.strayOf("endOfContacts", 20000);
        await new Promise((resolve) => setTimeout(resolve, Math.random() * this.retryPauseMs));
      }
    }
  }

  private async readContacts(since?: number): Promise<{ total: number; contacts: Contact[]; mostRecentLastMod: number }> {
    const frames = await this.request("getContacts", cmd.getContacts(since), {
      complete: (frame) => (frame.kind === "endOfContacts" ? "done" : "more"),
      expect: ["contactsStart", "contact", "endOfContacts"],
      // The end of another app's list, read just before, is not this one's.
      accepts: (frame, collected) => collected.length > 0 || frame.kind === "contactsStart",
      // Another app starting on the radio stops the list it is reading out.
      cutBy: ["selfInfo"],
      // A hundred contacts over BLE, paced by the firmware's write-busy check.
      timeoutMs: 20000,
    });
    let total = 0;
    let mostRecentLastMod = 0;
    const contacts: Contact[] = [];
    for (const frame of frames) {
      if (frame.kind === "contactsStart") total = frame.count;
      else if (frame.kind === "contact") contacts.push(frame.contact);
      else if (frame.kind === "endOfContacts") mostRecentLastMod = frame.mostRecentLastMod;
    }
    return { total, contacts, mostRecentLastMod };
  }

  async sendTextMessage(
    recipientPrefix: Uint8Array,
    text: string,
    options: Parameters<typeof cmd.sendTextMessage>[2] = {},
  ): Promise<TextSendResult> {
    const bytes = cmd.sendTextMessage(recipientPrefix, text, options);
    return this.sent("sendTextMessage", bytes, await this.textTag(bytes));
  }

  /** Its `ackTag` is always zero: the answer is a `CliData` message, not an ack. */
  async sendCliCommand(recipientPrefix: Uint8Array, text: string, timestamp?: number): Promise<TextSendResult> {
    return this.sent("sendCliCommand", cmd.sendCliCommand(recipientPrefix, text, timestamp), 0);
  }

  /**
   * A send whose `sent` answer carries the tag given, when this side can work
   * it out, so that another app's send at the same moment is not taken for it.
   * The tag is checked only while another app's answers are heard: an app
   * alone on the radio has no other `sent` to mix it up with.
   */
  private async sent(name: string, bytes: Uint8Array, tag: number | null): Promise<TextSendResult> {
    const check = tag !== null && !this.relayed && this.now() - this.strayAt < SHARED_MS;
    const [f] = await this.request(name, bytes, {
      expect: ["sent"],
      ...(check ? { accepts: (frame) => frame.kind === "sent" && frame.ackTag === tag } : {}),
    });
    if (f?.kind !== "sent") throw new Error(`${name}: expected sent, got ${f?.kind ?? "nothing"}`);
    return { flood: f.flood, ackTag: f.ackTag, estTimeoutMs: f.estTimeoutMs };
  }

  /**
   * The tag the radio gives a direct text and its ack brings back
   * (`composeMsgPacket` in BaseChatMesh.cpp): the first four bytes of SHA-256
   * over the timestamp, the attempt's low two bits and the text up to any zero
   * byte, then the radio's own key. A console line has none.
   */
  private async textTag(bytes: Uint8Array): Promise<number | null> {
    const txtType = bytes[1];
    if (txtType === TxtType.CliData || txtType === TxtType.CliCommand) return 0;
    const subtle = globalThis.crypto?.subtle;
    if (txtType !== TxtType.Plain || !this.selfKey || !subtle) return null;
    const text = bytes.subarray(13);
    const end = text.indexOf(0);
    const digest = await subtle.digest(
      "SHA-256",
      new Uint8Array(concat(bytes.subarray(3, 7), Uint8Array.of(bytes[2]! & 3), end < 0 ? text : text.subarray(0, end), this.selfKey)),
    );
    return new DataView(digest).getUint32(0, true);
  }

  sendChannelTextMessage(
    channelIndex: number,
    text: string,
    options: Parameters<typeof cmd.sendChannelTextMessage>[2] = {},
  ): Promise<void> {
    return this.ok("sendChannelTextMessage", cmd.sendChannelTextMessage(channelIndex, text, options));
  }

  /** The next queued message, or null when the radio's queue is empty. */
  async syncNextMessage(): Promise<MessageFrame | null> {
    const frames = await this.request("syncNextMessage", cmd.syncNextMessage(), { expect: SYNC_ANSWERS });
    const frame = frames[0];
    if (!frame || frame.kind === "noMoreMessages") return null;
    if (frame.kind === "contactMessage" || frame.kind === "channelMessage" || frame.kind === "channelData") {
      return frame;
    }
    throw new Error(`syncNextMessage: unexpected ${frame.kind}`);
  }

  getDeviceTime(): Promise<number> {
    return this.one("getDeviceTime", cmd.getDeviceTime(), "currTime").then((f) => f.time);
  }

  setDeviceTime(unixSeconds?: number): Promise<void> {
    return this.ok("setDeviceTime", cmd.setDeviceTime(unixSeconds));
  }

  sendSelfAdvert(flood = false): Promise<void> {
    return this.ok("sendSelfAdvert", cmd.sendSelfAdvert(flood));
  }

  setAdvertName(name: string): Promise<void> {
    return this.ok("setAdvertName", cmd.setAdvertName(name));
  }

  setAdvertLatLon(lat: number, lon: number): Promise<void> {
    return this.ok("setAdvertLatLon", cmd.setAdvertLatLon(lat, lon));
  }

  addUpdateContact(contact: cmd.ContactRecordInput): Promise<void> {
    return this.ok("addUpdateContact", cmd.addUpdateContact(contact), this.savingTimeoutMs);
  }

  removeContact(publicKey: Uint8Array): Promise<void> {
    return this.ok("removeContact", cmd.removeContact(publicKey), this.savingTimeoutMs);
  }

  resetPath(publicKey: Uint8Array): Promise<void> {
    return this.ok("resetPath", cmd.resetPath(publicKey), this.savingTimeoutMs);
  }

  shareContact(publicKey: Uint8Array): Promise<void> {
    return this.ok("shareContact", cmd.shareContact(publicKey));
  }

  async getContactByKey(publicKey: Uint8Array): Promise<Contact> {
    const [frame] = await this.request("getContactByKey", cmd.getContactByKey(publicKey), {
      expect: ["contact"],
      accepts: (f) => f.kind === "contact" && bytesEqual(f.contact.publicKey, publicKey),
    });
    if (frame?.kind !== "contact") throw new Error(`getContactByKey: expected contact, got ${frame?.kind ?? "nothing"}`);
    return frame.contact;
  }

  exportContact(publicKey?: Uint8Array): Promise<Uint8Array> {
    return this.one("exportContact", cmd.exportContact(publicKey), "exportContact").then((f) => f.advert);
  }

  importContact(advert: Uint8Array): Promise<void> {
    return this.ok("importContact", cmd.importContact(advert));
  }

  /** Resolves once the command is written; the radio reboots without answering. */
  reboot(): Promise<void> {
    return this.request("reboot", cmd.reboot(), { fireAndForget: true, timeoutMs: 1500 }).then(() => undefined);
  }

  factoryReset(): Promise<void> {
    return this.request("factoryReset", cmd.factoryReset(), { fireAndForget: true, timeoutMs: 3000 }).then(
      () => undefined,
    );
  }

  getBattAndStorage(): Promise<{ batteryMv: number; storageUsedKb: number; storageTotalKb: number }> {
    return this.one("getBattAndStorage", cmd.getBattAndStorage(), "battAndStorage");
  }

  setRadioParams(params: cmd.RadioParams): Promise<void> {
    return this.ok("setRadioParams", cmd.setRadioParams(params));
  }

  setRadioTxPower(dbm: number): Promise<void> {
    return this.ok("setRadioTxPower", cmd.setRadioTxPower(dbm));
  }

  getTuningParams(): Promise<{ rxDelayBase: number; airtimeFactor: number }> {
    return this.one("getTuningParams", cmd.getTuningParams(), "tuningParams");
  }

  setTuningParams(rxDelayBase: number, airtimeFactor: number): Promise<void> {
    return this.ok("setTuningParams", cmd.setTuningParams(rxDelayBase, airtimeFactor));
  }

  setOtherParams(params: cmd.OtherParams): Promise<void> {
    return this.ok("setOtherParams", cmd.setOtherParams(params));
  }

  setPathHashMode(mode: number): Promise<void> {
    return this.ok("setPathHashMode", cmd.setPathHashMode(mode));
  }

  async getChannel(index: number): Promise<{ index: number; name: string; secret: Uint8Array }> {
    const [frame] = await this.request("getChannel", cmd.getChannel(index), {
      expect: ["channelInfo"],
      accepts: (f) => f.kind === "channelInfo" && f.index === index,
    });
    if (frame?.kind !== "channelInfo") throw new Error(`getChannel: expected channelInfo, got ${frame?.kind ?? "nothing"}`);
    return frame;
  }

  setChannel(index: number, name: string, secret: Uint8Array): Promise<void> {
    return this.ok("setChannel", cmd.setChannel(index, name, secret));
  }

  /** The radio tags a sign-in with the first four bytes of the key it goes to. */
  sendLogin(publicKey: Uint8Array, password: string): Promise<TextSendResult> {
    const tag = new DataView(publicKey.buffer, publicKey.byteOffset, 4).getUint32(0, true);
    return this.sent("sendLogin", cmd.sendLogin(publicKey, password), tag);
  }

  logout(publicKey: Uint8Array): Promise<void> {
    return this.ok("logout", cmd.logout(publicKey));
  }

  async hasConnection(publicKey: Uint8Array): Promise<boolean> {
    try {
      await this.ok("hasConnection", cmd.hasConnection(publicKey));
      return true;
    } catch (error) {
      if (error instanceof MeshCoreError) return false;
      throw error;
    }
  }

  sendStatusReq(publicKey: Uint8Array): Promise<TextSendResult> {
    return this.one("sendStatusReq", cmd.sendStatusReq(publicKey), "sent");
  }

  /** For a contact, answered with `sent` then a `telemetryResponse` push; for self, only the push. */
  async sendTelemetryReq(publicKey?: Uint8Array): Promise<TextSendResult | null> {
    if (!publicKey) {
      await this.request("sendTelemetryReq", cmd.sendTelemetryReq(), { fireAndForget: true, timeoutMs: 300 });
      return null;
    }
    return this.one("sendTelemetryReq", cmd.sendTelemetryReq(publicKey), "sent");
  }

  sendBinaryReq(publicKey: Uint8Array, request: Uint8Array): Promise<TextSendResult> {
    return this.one("sendBinaryReq", cmd.sendBinaryReq(publicKey, request), "sent");
  }

  sendAnonReq(publicKey: Uint8Array, request: Uint8Array): Promise<TextSendResult> {
    return this.one("sendAnonReq", cmd.sendAnonReq(publicKey, request), "sent");
  }

  /** The region floods are marked with until the radio restarts; null goes back to the one it keeps. */
  setFloodScope(regionKey: Uint8Array | null): Promise<void> {
    return this.ok("setFloodScope", cmd.setFloodScope(regionKey));
  }

  /** Floods without a region until `setFloodScope` (protocol 12). */
  setFloodUnscoped(): Promise<void> {
    return this.ok("setFloodUnscoped", cmd.setFloodUnscoped());
  }

  setDefaultFloodScope(region: { name: string; key: Uint8Array } | null): Promise<void> {
    return this.ok("setDefaultFloodScope", cmd.setDefaultFloodScope(region));
  }

  /** The region the radio keeps (protocol 11), or null when it keeps none. */
  async getDefaultFloodScope(): Promise<{ name: string; key: Uint8Array } | null> {
    const f = await this.one("getDefaultFloodScope", cmd.getDefaultFloodScope(), "defaultFloodScope");
    return f.name && f.key ? { name: f.name, key: f.key } : null;
  }

  sendTracePath(tag: number, auth: number, flags: number, path: Uint8Array): Promise<TextSendResult> {
    return this.sent("sendTracePath", cmd.sendTracePath(tag, auth, flags, path), tag >>> 0);
  }

  sendPathDiscoveryReq(publicKey: Uint8Array): Promise<TextSendResult> {
    return this.one("sendPathDiscoveryReq", cmd.sendPathDiscoveryReq(publicKey), "sent");
  }

  async getStats(type: number): Promise<Extract<ResponseFrame, { kind: "statsCore" | "statsRadio" | "statsPackets" }>> {
    const kind = (["statsCore", "statsRadio", "statsPackets"] as const)[type];
    const frames = await this.request("getStats", cmd.getStats(type), { expect: kind ? [kind] : ["statsCore", "statsRadio", "statsPackets"] });
    const frame = frames[0];
    if (frame && (frame.kind === "statsCore" || frame.kind === "statsRadio" || frame.kind === "statsPackets")) {
      return frame;
    }
    throw new Error(`getStats: unexpected ${frame?.kind ?? "nothing"}`);
  }

  getAdvertPath(publicKey: Uint8Array): Promise<{ receivedAt: number; pathLen: number; path: Uint8Array }> {
    return this.one("getAdvertPath", cmd.getAdvertPath(publicKey), "advertPath");
  }

  setDevicePin(pin: number): Promise<void> {
    return this.ok("setDevicePin", cmd.setDevicePin(pin));
  }

  getCustomVars(): Promise<Record<string, string>> {
    return this.one("getCustomVars", cmd.getCustomVars(), "customVars").then((f) => f.vars);
  }

  setCustomVar(name: string, value: string): Promise<void> {
    return this.ok("setCustomVar", cmd.setCustomVar(name, value));
  }

  /** The radio's private key, 64 bytes; null when its firmware was built not to give it (`ENABLE_PRIVATE_KEY_EXPORT`). */
  async exportPrivateKey(): Promise<Uint8Array | null> {
    const [frame] = await this.request("exportPrivateKey", cmd.exportPrivateKey(), { expect: ["disabled", "privateKey"] });
    if (frame?.kind === "disabled") return null;
    if (frame?.kind !== "privateKey") throw new Error(`exportPrivateKey: expected privateKey, got ${frame?.kind ?? "nothing"}`);
    return frame.key;
  }

  /**
   * Makes `privateKey` the radio's own from now on, and false when its firmware
   * was built not to take one (`ENABLE_PRIVATE_KEY_IMPORT`). A key it finds unfit
   * is refused as an illegal argument.
   */
  async importPrivateKey(privateKey: Uint8Array): Promise<boolean> {
    const [frame] = await this.request("importPrivateKey", cmd.importPrivateKey(privateKey), { expect: ["disabled", "ok"] });
    if (frame?.kind === "disabled") return false;
    if (frame?.kind !== "ok") throw new Error(`importPrivateKey: expected ok, got ${frame?.kind ?? "nothing"}`);
    return true;
  }

  /** A console line run by this radio itself (protocol 14); an older radio refuses it as unsupported. */
  runCliCommand(text: string): Promise<string> {
    return this.one("runCliCommand", cmd.runCliCommand(text), "cliReply").then((f) => f.text);
  }

  /** A console line the radio does not answer, as it reboots or turns off at once (`poweroff`). */
  async runCliCommandUnanswered(text: string): Promise<void> {
    await this.request("runCliCommand", cmd.runCliCommand(text), { fireAndForget: true, timeoutMs: 1500 });
  }

  setAutoAddConfig(config: number, maxHops?: number): Promise<void> {
    return this.ok("setAutoAddConfig", cmd.setAutoAddConfig(config, maxHops));
  }

  getAutoAddConfig(): Promise<{ config: number; maxHops: number }> {
    return this.one("getAutoAddConfig", cmd.getAutoAddConfig(), "autoAddConfig");
  }

  getAllowedRepeatFreq(): Promise<{ lowerKhz: number; upperKhz: number }[]> {
    return this.one("getAllowedRepeatFreq", cmd.getAllowedRepeatFreq(), "allowedRepeatFreq").then((f) => f.ranges);
  }

  /** A zero-hop control packet (`nodeDiscoverRequest`); the answers come as `controlData` pushes. */
  sendControlData(payload: Uint8Array): Promise<void> {
    return this.ok("sendControlData", cmd.sendControlData(payload));
  }

  sendRawData(path: Uint8Array, payload: Uint8Array, hashSize = 1): Promise<void> {
    return this.ok("sendRawData", cmd.sendRawData(path, payload, hashSize));
  }

  sendChannelData(channelIndex: number, dataType: number, payload: Uint8Array, path?: Uint8Array, hashSize = 1): Promise<void> {
    return this.ok("sendChannelData", cmd.sendChannelData(channelIndex, dataType, payload, path, hashSize));
  }
}
