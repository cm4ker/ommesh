/**
 * The history file: what Ommesh writes when a radio's history is saved and
 * reads when one is brought in. Its schema is public (docs/history-format.md
 * and docs/schema/history-v1.json) so that other programs can write and read
 * it too, and this module is the app's side of it. The file names things its
 * own way rather than as this app's records do, so the records can change
 * while the file stays as documented.
 */

import {
  AdvType,
  channelConversation,
  contactConversation,
  parseConversation,
  pathHashes,
  TxtType,
  type ContactRecord,
  type MessageRecord,
  type MessageStatus,
  type RemovedBy,
  type SessionState,
} from "@meshnet/meshcore";

export const HISTORY_FORMAT = "ommesh-history";
export const HISTORY_VERSION = 1;
export const HISTORY_SCHEMA = "https://raw.githubusercontent.com/cm4ker/ommesh/master/docs/schema/history-v1.json";

export type ContactKind = "chat" | "repeater" | "room" | "sensor";

/** A chat is named by what stays the same on every radio: a channel's secret, a node's key. */
export type HistoryChat = { channel: string } | { contact: string } | { prefix: string };

export interface HistoryChannel {
  secret: string;
  name: string;
}

export interface HistoryContact {
  key: string;
  name?: string;
  kind?: ContactKind;
  /** Where the contact was when the file was written: on the radio, taken off it, or heard but not kept. */
  on?: "radio" | "removed" | "heard";
  removedBy?: RemovedBy;
  flags?: number;
  lat?: number;
  lon?: number;
  lastAdvert?: string;
  lastHeard?: string;
  /** Null: no route, the next message floods. Empty: a neighbour heard direct. */
  route?: string[] | null;
}

export interface HistoryEcho {
  path: string[];
  snr: number;
}

export interface HistoryMessage {
  id?: string;
  chat: HistoryChat;
  direction: "in" | "out";
  text: string;
  /** By the sender's clock. */
  sentAt: string;
  /** By the clock of the device that kept the history. */
  receivedAt?: string;
  from?: { name?: string; key?: string };
  roomPost?: boolean;
  snr?: number;
  hops?: number;
  status?: MessageStatus;
  roundTripMs?: number;
  error?: string;
  route?: string[];
  echoes?: HistoryEcho[];
}

/** What a history holds, whatever wrote it. */
export interface HistoryBody {
  channels: HistoryChannel[];
  contacts: HistoryContact[];
  messages: HistoryMessage[];
}

export interface HistoryFile extends HistoryBody {
  $schema?: string;
  format: typeof HISTORY_FORMAT;
  version: number;
  exportedAt?: string;
  app?: string;
  radio: { key: string; name?: string };
}

/** Why a file could not be read as a history: not one at all, one from a newer app, or one with a field wrong at `path`. */
export class HistoryFileError extends Error {
  constructor(
    readonly kind: "notHistory" | "newer" | "field",
    readonly path = "",
  ) {
    super(kind === "field" ? `the history file is wrong at ${path}` : kind === "newer" ? "the history file is of a newer version" : "not a history file");
  }
}

const KINDS: Record<number, ContactKind> = { [AdvType.Chat]: "chat", [AdvType.Repeater]: "repeater", [AdvType.Room]: "room", [AdvType.Sensor]: "sensor" };
export const KIND_TYPES: Record<ContactKind, number> = { chat: AdvType.Chat, repeater: AdvType.Repeater, room: AdvType.Room, sensor: AdvType.Sensor };
const STATUSES: MessageStatus[] = ["queued", "sending", "sent", "delivered", "unheard", "unconfirmed", "failed"];
const REMOVED_BY: RemovedBy[] = ["you", "tidy", "radio"];

// ---- writing ----

/** The radio's history as a file: every chat, contact and message there is, nothing about this app's settings. */
export function writeHistory(state: Pick<SessionState, "self" | "channels" | "contacts" | "removed" | "messages">, app: string, now: number): HistoryFile {
  const self = state.self;
  if (!self) throw new Error("no radio");
  const secrets = new Map(state.channels.map((c) => [c.index, c.secret]));
  const messages: HistoryMessage[] = [];
  for (const m of state.messages) {
    // A node's console lives in its own log, not in a chat.
    if (m.txtType === TxtType.CliData) continue;
    const conversation = parseConversation(m.conversation);
    let chat: HistoryChat;
    if (conversation.kind === "channel") {
      const secret = secrets.get(conversation.index);
      // A slot that holds no channel now: nobody can tell which channel it was.
      if (!secret) continue;
      chat = { channel: secret };
    } else chat = conversation.kind === "contact" ? { contact: conversation.key } : { prefix: conversation.prefix };
    messages.push(messageOf(m, chat));
  }
  return {
    $schema: HISTORY_SCHEMA,
    format: HISTORY_FORMAT,
    version: HISTORY_VERSION,
    exportedAt: iso(now),
    app,
    radio: { key: self.key, name: self.name },
    channels: state.channels.map((c) => ({ secret: c.secret, name: c.name })),
    contacts: [
      ...Object.values(state.contacts).map((c) => contactOf(c, c.unsaved ? "heard" : "radio")),
      ...Object.values(state.removed).map((r) => ({ ...contactOf(r.contact, "removed"), removedBy: r.by })),
    ],
    messages,
  };
}

function messageOf(m: MessageRecord, chat: HistoryChat): HistoryMessage {
  const out: HistoryMessage = { id: m.id, chat, direction: m.direction, text: m.text, sentAt: iso(m.timestamp * 1000), receivedAt: iso(m.receivedAt) };
  if (m.direction === "in") {
    const from: NonNullable<HistoryMessage["from"]> = {};
    if (m.sender) from.name = m.sender;
    if (m.senderPrefix) from.key = m.senderPrefix;
    if (from.name !== undefined || from.key !== undefined) out.from = from;
  }
  if (m.txtType === TxtType.SignedPlain) out.roomPost = true;
  if (m.snr !== null) out.snr = m.snr;
  if (m.hops !== null) out.hops = m.hops;
  if (m.status !== null) out.status = m.status;
  if (m.roundTripMs !== null) out.roundTripMs = m.roundTripMs;
  if (m.error !== null) out.error = m.error;
  if (m.route !== null) out.route = m.route;
  if (m.echoes.length) out.echoes = m.echoes.map((e) => ({ path: e.path, snr: e.snr }));
  return out;
}

function contactOf(c: ContactRecord, on: NonNullable<HistoryContact["on"]>): HistoryContact {
  const out: HistoryContact = { key: c.key, name: c.name, kind: KINDS[c.type] ?? "chat", on };
  if (c.flags) out.flags = c.flags;
  if (c.lat || c.lon) Object.assign(out, { lat: c.lat, lon: c.lon });
  if (c.lastAdvert) out.lastAdvert = iso(c.lastAdvert * 1000);
  if (c.lastHeardAt !== null) out.lastHeard = iso(c.lastHeardAt);
  out.route = c.outPathLen === 0xff ? null : pathHashes(c.outPathLen, c.outPath);
  return out;
}

/** A name for the file that says whose history it is and when it was saved, safe on every system. */
export function historyFileName(radioName: string, now: number): string {
  const name = radioName.replace(/[\\/:*?"<>|\s.]+/g, "-").replace(/^-+|-+$/g, "") || "radio";
  const day = new Date(now);
  const date = [day.getFullYear(), day.getMonth() + 1, day.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
  return `ommesh-${name}-${date}.json`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---- reading ----

/** A history file read and checked; keys, secrets and hashes come back lower-case, and absent lists empty. */
export function parseHistory(text: string): HistoryFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new HistoryFileError("notHistory");
  }
  if (!isObject(json) || json.format !== HISTORY_FORMAT) throw new HistoryFileError("notHistory");
  if (typeof json.version !== "number" || !Number.isInteger(json.version) || json.version < 1) throw new HistoryFileError("field", "version");
  if (json.version > HISTORY_VERSION) throw new HistoryFileError("newer");
  const radio = json.radio;
  if (!isObject(radio)) throw new HistoryFileError("field", "radio");
  const file: HistoryFile = {
    format: HISTORY_FORMAT,
    version: json.version,
    radio: { key: hex(radio.key, "radio.key", KEY), ...optional(radio, "name", "radio", str) },
    channels: list(json.channels, "channels", channelOf),
    contacts: list(json.contacts, "contacts", contactIn),
    messages: list(json.messages, "messages", messageIn),
  };
  if (json.exportedAt !== undefined) file.exportedAt = time(json.exportedAt, "exportedAt");
  if (json.app !== undefined) file.app = str(json.app, "app");
  return file;
}

type Json = Record<string, unknown>;

const KEY = /^[0-9a-f]{64}$/;
const SECRET = /^[0-9a-f]{32}$/;
/** The start of a key, whole bytes. */
const KEY_START = /^(?:[0-9a-f]{2}){1,32}$/;
/** A relay's hash in a path: one to four bytes. */
const HASH = /^(?:[0-9a-f]{2}){1,4}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function channelOf(value: unknown, path: string): HistoryChannel {
  const o = object(value, path);
  return { secret: hex(o.secret, `${path}.secret`, SECRET), name: str(o.name, `${path}.name`) };
}

function contactIn(value: unknown, path: string): HistoryContact {
  const o = object(value, path);
  const out: HistoryContact = { key: hex(o.key, `${path}.key`, KEY) };
  Object.assign(out, optional(o, "name", path, str));
  Object.assign(out, optional(o, "kind", path, oneOf(Object.keys(KIND_TYPES) as ContactKind[])));
  Object.assign(out, optional(o, "on", path, oneOf(["radio", "removed", "heard"] as const)));
  Object.assign(out, optional(o, "removedBy", path, oneOf(REMOVED_BY)));
  Object.assign(out, optional(o, "flags", path, byte));
  Object.assign(out, optional(o, "lat", path, between(-90, 90)));
  Object.assign(out, optional(o, "lon", path, between(-180, 180)));
  Object.assign(out, optional(o, "lastAdvert", path, time));
  Object.assign(out, optional(o, "lastHeard", path, time));
  if (o.route !== undefined) out.route = o.route === null ? null : route(o.route, `${path}.route`);
  return out;
}

function messageIn(value: unknown, path: string): HistoryMessage {
  const o = object(value, path);
  const direction = oneOf(["in", "out"] as const)(o.direction, `${path}.direction`);
  const out: HistoryMessage = { chat: chatOf(o.chat, `${path}.chat`), direction, text: str(o.text, `${path}.text`), sentAt: time(o.sentAt, `${path}.sentAt`) };
  Object.assign(out, optional(o, "id", path, str));
  Object.assign(out, optional(o, "receivedAt", path, time));
  if (o.from !== undefined) {
    const from = object(o.from, `${path}.from`);
    out.from = { ...optional(from, "name", `${path}.from`, str), ...optional(from, "key", `${path}.from`, (v, p) => hex(v, p, KEY_START)) };
  }
  Object.assign(out, optional(o, "roomPost", path, boolean));
  Object.assign(out, optional(o, "snr", path, number));
  Object.assign(out, optional(o, "hops", path, between(0, 63, true)));
  Object.assign(out, optional(o, "status", path, oneOf(STATUSES)));
  Object.assign(out, optional(o, "roundTripMs", path, between(0, Number.MAX_SAFE_INTEGER, true)));
  Object.assign(out, optional(o, "error", path, str));
  Object.assign(out, optional(o, "route", path, route));
  if (o.echoes !== undefined)
    out.echoes = list(o.echoes, `${path}.echoes`, (e, p) => {
      const echo = object(e, p);
      return { path: route(echo.path, `${p}.path`), snr: number(echo.snr, `${p}.snr`) };
    });
  return out;
}

function chatOf(value: unknown, path: string): HistoryChat {
  const o = object(value, path);
  const named = ["channel", "contact", "prefix"].filter((k) => o[k] !== undefined);
  if (named.length !== 1) throw new HistoryFileError("field", path);
  if (o.channel !== undefined) return { channel: hex(o.channel, `${path}.channel`, SECRET) };
  if (o.contact !== undefined) return { contact: hex(o.contact, `${path}.contact`, KEY) };
  return { prefix: hex(o.prefix, `${path}.prefix`, KEY_START) };
}

/** Relays' hashes, all of one size, as many as a packet's path carries. */
function route(value: unknown, path: string): string[] {
  const hashes = list(value, path, (h, p) => hex(h, p, HASH));
  if (hashes.length > 63 || hashes.some((h) => h.length !== hashes[0]!.length) || hashes.join("").length > 128) throw new HistoryFileError("field", path);
  return hashes;
}

function list<T>(value: unknown, path: string, item: (value: unknown, path: string) => T): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HistoryFileError("field", path);
  return value.map((v, i) => item(v, `${path}[${i}]`));
}

/** `{ [key]: value }` when the field is there, `{}` when it is not; a field that is there must read right. */
function optional<K extends string, T>(o: Json, key: K, path: string, read: (value: unknown, path: string) => T): { [P in K]?: T } {
  return o[key] === undefined ? {} : ({ [key]: read(o[key], `${path}.${key}`) } as { [P in K]?: T });
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, path: string): Json {
  if (!isObject(value)) throw new HistoryFileError("field", path);
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") throw new HistoryFileError("field", path);
  return value;
}

function hex(value: unknown, path: string, shape: RegExp): string {
  const s = typeof value === "string" ? value.toLowerCase() : null;
  if (s === null || !shape.test(s)) throw new HistoryFileError("field", path);
  return s;
}

function time(value: unknown, path: string): string {
  if (typeof value !== "string" || !TIME.test(value) || Number.isNaN(Date.parse(value))) throw new HistoryFileError("field", path);
  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HistoryFileError("field", path);
  return value;
}

function between(min: number, max: number, whole = false) {
  return (value: unknown, path: string): number => {
    const n = number(value, path);
    if (n < min || n > max || (whole && !Number.isInteger(n))) throw new HistoryFileError("field", path);
    return n;
  };
}

const byte = between(0, 255, true);

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new HistoryFileError("field", path);
  return value;
}

function oneOf<T extends string>(values: readonly T[]) {
  return (value: unknown, path: string): T => {
    if (!values.includes(value as T)) throw new HistoryFileError("field", path);
    return value as T;
  };
}

/** The chat a message of the file goes to on this radio, or null for a channel no slot holds. */
export function conversationOf(chat: HistoryChat, slots: Map<string, number>): string | null {
  if ("channel" in chat) {
    const index = slots.get(chat.channel);
    return index === undefined ? null : channelConversation(index);
  }
  return "contact" in chat ? contactConversation(chat.contact) : `p:${chat.prefix}`;
}
