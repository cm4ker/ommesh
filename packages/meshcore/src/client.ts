/**
 * A command/response client over a transport.
 *
 * The firmware handles one command at a time and answers in order, and it
 * interleaves pushes (codes 0x80 and up) whenever it likes. So: commands are
 * queued and sent one at a time; every response frame belongs to the command
 * in flight; every push goes to the push listeners. Some commands answer with
 * several frames (`getContacts` streams them), so a request carries a
 * predicate that says when its answer is complete.
 */

import { errorName } from "./protocol/codes.js";
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

/** Answers `"more"` while a response is still arriving, `"done"` on its last frame. */
type Completion = (frame: ResponseFrame, collected: ResponseFrame[]) => "more" | "done";

interface Pending {
  name: string;
  bytes: Uint8Array;
  complete: Completion;
  timeoutMs: number;
  /** Set when the firmware answers nothing at all, as on reboot. */
  fireAndForget: boolean;
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
}

const single: Completion = () => "done";

/**
 * Some firmware (Smart UI 0.05 on a Heltec) writes its whole contacts file to
 * flash before it answers a command that changes a contact, and 350 contacts on
 * SPIFFS can take longer than the usual wait. An answer that comes after the
 * wait goes to the next command instead: a status request was once answered by
 * a forgotten route's "ok" (#78). The radio core on phones waits as long.
 */
const SAVING_TIMEOUT_MS = 30_000;

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
  private closeListeners = new Set<(reason: Error | null) => void>();
  private closedWith: Error | null | undefined;
  private readonly timeoutMs: number;
  private readonly savingTimeoutMs: number;
  private readonly trace: ClientOptions["trace"];
  private readonly unsubscribe: (() => void)[] = [];

  constructor(readonly transport: Transport, options: ClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.savingTimeoutMs = options.savingTimeoutMs ?? Math.max(SAVING_TIMEOUT_MS, this.timeoutMs);
    this.trace = options.trace;
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

  onClose(listener: (reason: Error | null) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
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
    if (!pending) {
      // The firmware finishing an answer to a command that timed out, or a
      // frame from before this client attached. Nothing to give it to.
      return;
    }
    if (frame.kind === "err") {
      this.finish(new MeshCoreError(frame.code, pending.name));
      return;
    }
    pending.collected.push(frame);
    if (pending.complete(frame, pending.collected) === "done") {
      this.finish(null);
    } else {
      this.armTimer(pending);
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
        if (pending.fireAndForget) this.finish(null);
        else this.finish(new TimeoutError(pending.name, pending.timeoutMs));
      }
    }, pending.timeoutMs);
  }

  private finish(error: Error | null): void {
    const pending = this.inFlight;
    if (!pending) return;
    this.inFlight = null;
    if (pending.timer) clearTimeout(pending.timer);
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
        if (this.inFlight === next) this.armTimer(next);
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
    options: { complete?: Completion; timeoutMs?: number; fireAndForget?: boolean } = {},
  ): Promise<ResponseFrame[]> {
    if (this.closedWith !== undefined) {
      return Promise.reject(new TransportClosedError(this.closedWith));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({
        name,
        bytes,
        complete: options.complete ?? single,
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        fireAndForget: options.fireAndForget ?? false,
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
    const frames = await this.request(name, bytes, timeoutMs === undefined ? {} : { timeoutMs });
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

  deviceQuery(): Promise<DeviceInfo> {
    return this.one("deviceQuery", cmd.deviceQuery(), "deviceInfo").then((f) => f.info);
  }

  appStart(appName: string): Promise<SelfInfo> {
    return this.one("appStart", cmd.appStart(appName), "selfInfo").then((f) => f.info);
  }

  /**
   * Streams the radio's contacts. With `since`, only those modified after it;
   * `mostRecentLastMod` is the cursor for the next call.
   */
  async getContacts(since?: number): Promise<{ total: number; contacts: Contact[]; mostRecentLastMod: number }> {
    const frames = await this.request("getContacts", cmd.getContacts(since), {
      complete: (frame) => (frame.kind === "endOfContacts" ? "done" : "more"),
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
    const f = await this.one("sendTextMessage", cmd.sendTextMessage(recipientPrefix, text, options), "sent");
    return { flood: f.flood, ackTag: f.ackTag, estTimeoutMs: f.estTimeoutMs };
  }

  /** Its `ackTag` is always zero: the answer is a `CliData` message, not an ack. */
  async sendCliCommand(recipientPrefix: Uint8Array, text: string, timestamp?: number): Promise<TextSendResult> {
    const f = await this.one("sendCliCommand", cmd.sendCliCommand(recipientPrefix, text, timestamp), "sent");
    return { flood: f.flood, ackTag: f.ackTag, estTimeoutMs: f.estTimeoutMs };
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
    const frames = await this.request("syncNextMessage", cmd.syncNextMessage());
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

  getContactByKey(publicKey: Uint8Array): Promise<Contact> {
    return this.one("getContactByKey", cmd.getContactByKey(publicKey), "contact").then((f) => f.contact);
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

  getChannel(index: number): Promise<{ index: number; name: string; secret: Uint8Array }> {
    return this.one("getChannel", cmd.getChannel(index), "channelInfo");
  }

  setChannel(index: number, name: string, secret: Uint8Array): Promise<void> {
    return this.ok("setChannel", cmd.setChannel(index, name, secret));
  }

  sendLogin(publicKey: Uint8Array, password: string): Promise<TextSendResult> {
    return this.one("sendLogin", cmd.sendLogin(publicKey, password), "sent");
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

  sendTracePath(tag: number, auth: number, flags: number, path: Uint8Array): Promise<TextSendResult> {
    return this.one("sendTracePath", cmd.sendTracePath(tag, auth, flags, path), "sent");
  }

  sendPathDiscoveryReq(publicKey: Uint8Array): Promise<TextSendResult> {
    return this.one("sendPathDiscoveryReq", cmd.sendPathDiscoveryReq(publicKey), "sent");
  }

  async getStats(type: number): Promise<Extract<ResponseFrame, { kind: "statsCore" | "statsRadio" | "statsPackets" }>> {
    const frames = await this.request("getStats", cmd.getStats(type));
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

  /** A console line run by this radio itself (protocol 14); an older radio refuses it as unsupported. */
  runCliCommand(text: string): Promise<string> {
    return this.one("runCliCommand", cmd.runCliCommand(text), "cliReply").then((f) => f.text);
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

  sendRawData(path: Uint8Array, payload: Uint8Array): Promise<void> {
    return this.ok("sendRawData", cmd.sendRawData(path, payload));
  }

  sendChannelData(channelIndex: number, dataType: number, payload: Uint8Array, path?: Uint8Array): Promise<void> {
    return this.ok("sendChannelData", cmd.sendChannelData(channelIndex, dataType, payload, path));
  }
}
