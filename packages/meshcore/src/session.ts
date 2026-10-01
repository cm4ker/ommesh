/**
 * The state of a radio and everything heard through it, kept in one immutable
 * snapshot the UI subscribes to: contacts, channels, conversations, what the
 * radio said about itself, and what the last push was.
 *
 * The radio holds contacts and channels and a short queue of unread messages;
 * it does not keep history. So the session does, through a `SessionStorage`
 * the shell supplies, keyed by the radio's public key so two radios on one
 * phone do not mix.
 */

import { MeshCoreClient, MeshCoreError, TimeoutError, type TextSendResult } from "./client.js";
import { ByteReader, bytesEqual, fromHex, pathByteLength, toHex, unixNow } from "./protocol/bytes.js";
import { neighbourSearchMs, traceBudgetMs } from "./protocol/airtime.js";
import { groupTextPayload, heardGroupTextPayload } from "./protocol/group.js";
import { PayloadType, parseRawPacket, type RawPacket } from "./protocol/packet.js";
import { AclRole, AdvType, Cmd, ContactFlag, ControlType, ErrCode, MAX_TEXT_LEN, NeighbourOrder, PUB_KEY_PREFIX_SIZE, StatsType, TxtType } from "./protocol/codes.js";
import {
  accessListRequest,
  avgMinMaxRequest,
  neighboursRequest,
  nodeDiscoverRequest,
  ownerInfoRequest,
  type OtherParams,
  type RadioParams,
} from "./protocol/commands.js";
import {
  decodeFrame,
  readAccessList,
  readAvgMinMax,
  readNeighbours,
  readNodeStats,
  readOwnerInfo,
  type Contact,
  type DeviceInfo,
  type NodeStats,
  type PushFrame,
  type SelfInfo,
  type SeriesSummary,
} from "./protocol/frames.js";
import type { LppReading } from "./protocol/lpp.js";
import type { Transport } from "./transport.js";

export interface ContactRecord {
  /** Hex of the 32-byte key; the identity everywhere in this app. */
  key: string;
  /** Hex of the first six bytes, which is how messages name their sender. */
  prefix: string;
  type: number;
  flags: number;
  outPathLen: number;
  outPath: string;
  name: string;
  lastAdvert: number;
  lat: number;
  lon: number;
  lastMod: number;
  /** Local clock, ms: the last time the radio heard from this contact while we were listening. */
  lastHeardAt: number | null;
  /**
   * Local clock, ms: when the radio learned the route it holds, so it can be
   * dropped once stale. `lastMod` cannot say: adverts and messages move it too.
   * Null while there is no route.
   */
  pathSince: number | null;
  /**
   * Heard in an advert the radio did not keep: new contacts are added by
   * hand, the node was too many hops away, or the radio's memory was full.
   * Only this app knows it; absent for a contact the radio holds.
   */
  unsaved?: true;
}

/** Who took a contact off the radio: you, the tidy-up rule, or the radio itself (full, or another app). */
export type RemovedBy = "you" | "tidy" | "radio";

/** A contact taken off the radio, kept so it can be put back. */
export interface RemovedContact {
  contact: ContactRecord;
  /** Local ms. */
  at: number;
  by: RemovedBy;
}

export interface ChannelRecord {
  index: number;
  name: string;
  /** Hex of the 16-byte secret. */
  secret: string;
}

/** `queued`: written while the radio was away; it goes out, in order, once the radio is back. */
export type MessageStatus = "queued" | "sending" | "sent" | "delivered" | "unheard" | "unconfirmed" | "failed";

/**
 * A message being sent again on its own until a repeater is heard sending it
 * on. It lives on the message, so it outlives a dropped link and a restart.
 */
export interface RetryPlan {
  /** Sends made under the plan, the one that started it included. */
  made: number;
  /** How many sends the plan makes at most. */
  total: number;
  /** Local ms of the next send; null while the radio is away, and once the last send is made. */
  nextAt: number | null;
}

/**
 * A copy of a message the radio heard: for one of ours on a channel, a repeater
 * sending it on; for one that came in, each copy that reached us.
 */
export interface MessageEcho {
  /** The relays it had passed, first relay first, each as the hex hash it signs the path with. */
  path: string[];
  snr: number;
}

export interface MessageRecord {
  id: string;
  /** `c:<key>` for a contact, `ch:<index>` for a channel, `p:<prefix>` for a sender the radio did not name. */
  conversation: string;
  direction: "in" | "out";
  text: string;
  /** On a channel: the name before the colon. On a DM: the contact's name at the time. */
  sender: string | null;
  senderPrefix: string | null;
  /** Unix seconds, the sender's clock, which may be far off: a radio that lost its clock stamps a date years back. */
  timestamp: number;
  /** Local clock, ms: when it came in, or when ours was written. A chat files its messages by this, not by `timestamp`. */
  receivedAt: number;
  snr: number | null;
  hops: number | null;
  txtType: number;
  status: MessageStatus | null;
  ackTag: number | null;
  roundTripMs: number | null;
  flood: boolean | null;
  attempt: number;
  error: string | null;
  /**
   * Copies the radio heard, one per distinct path. For ours on a channel, the
   * repeaters sending it on; for an incoming flood, every copy that reached us,
   * the one delivered first. Empty when the radio heard none while we listened.
   */
  echoes: MessageEcho[];
  /**
   * Our direct message: the relays it went along, as hex hashes, first relay
   * first. A flood has none until its acknowledgement brings back the route it
   * took. Empty for a neighbour heard direct; null when not known.
   */
  route: string[] | null;
  /** What was typed, when the text sent was reworked to fit (lookalike letters packed). */
  original?: string;
  /**
   * Our message sent again: when the last send went, unix seconds. A direct
   * message keeps its stamp on a retry, but the chat shows and files it by
   * this, the moment it went.
   */
  sentAt?: number;
  /**
   * Our direct message sent more than once: the acknowledgements the earlier
   * tries wait for. Each try is its own packet with its own, and one that
   * comes late still says the text arrived.
   */
  pastAckTags?: number[];
  /**
   * Set while the message is being sent again and again; null when nothing is
   * being tried. A direct message keeps it once its tries are spent or stopped
   * (`made` equals `total`), so the chat can say how many went unanswered.
   */
  retryPlan: RetryPlan | null;
}

/** How direct messages to one contact are routed; unset fields follow the defaults. */
export interface RoutePolicy {
  /** Every message floods: the learned route is dropped before each send, and whenever the radio learns one. */
  flood?: boolean;
  /** Minutes a learned route is kept before it is dropped; null keeps it. Absent follows `RoutingSettings.resetAfterMin`. */
  resetAfterMin?: number | null;
  /**
   * The route last written by hand, as `routeKey` gives it. While the radio
   * still holds that route it is not dropped for its age; the radio replaces
   * it as soon as it learns another.
   */
  manual?: string;
}

export interface RoutingSettings {
  /** Minutes a route to a chat or a room is kept after the radio learned it; null keeps it until the radio replaces it. */
  resetAfterMin: number | null;
  contacts: Record<string, RoutePolicy>;
}

export interface LogEntry {
  at: number;
  kind: string;
  text: string;
}

/** What a repeater, room or sensor said the last time we signed in to it. */
export interface NodeLogin {
  ok: boolean;
  /** An `AclRole`, when the node said; a legacy "OK" does not. */
  role: number | null;
  /** The node's clock at sign-in, unix seconds. */
  serverTime: number | null;
  firmwareLevel: number | null;
  /** Local clock, ms. */
  at: number;
  /** The node's clock as read since the sign-in, from the stamp on a console reply. */
  clock?: ClockReading;
}

/** A node's clock against ours at one moment. */
export interface ClockReading {
  /** Seconds the node's clock was behind ours; negative when it ran ahead. */
  drift: number;
  /** Local clock, ms. */
  at: number;
  /** Not read but known: this client sent `clkreboot`, which puts the clock back to `CLOCK_RESET_TIME`. */
  reset?: true;
}

/** Where `clkreboot` puts a node's clock: 15 May 2024, as the firmware has it. */
export const CLOCK_RESET_TIME = 1_715_770_351;

export interface NodeStatus {
  stats: NodeStats | null;
  /** Hex of the body, for a shape this client does not read. */
  raw: string;
  at: number;
}

/** One status answer, kept for the trend lines. */
export interface StatusSample {
  at: number;
  batteryMv: number;
  noiseFloor: number;
}

export interface NeighbourRecord {
  /** Hex of the six-byte key prefix. */
  prefix: string;
  heardSecsAgo: number;
  snr: number;
}

export interface NeighbourList {
  /** How many the node knows, of which `neighbours` is the part fetched so far. */
  total: number;
  /** A `NeighbourOrder`. */
  order: number;
  neighbours: NeighbourRecord[];
  at: number;
}

export interface AccessRecord {
  prefix: string;
  permissions: number;
}

export interface OwnerInfo {
  firmware: string;
  name: string;
  owner: string;
  at: number;
}

export interface SeriesWindow {
  /** How far back the window reaches, seconds. */
  windowSecs: number;
  /** The sensor's clock when it answered. */
  time: number;
  series: SeriesSummary[];
  at: number;
}

export type ConsoleStatus = "queued" | "waiting" | "done" | "timeout" | "failed";

/** A console command and what came back, or a line the node sent unasked. */
export interface ConsoleEntry {
  id: string;
  /** Empty for a line nobody here asked for. */
  command: string;
  /** The two characters before `|` the node echoes back. */
  tag: string;
  at: number;
  status: ConsoleStatus;
  reply: string | null;
  repliedAt: number | null;
  error: string | null;
}

/** A value read from a node with `get`, or confirmed by a `set`. */
export interface NodeSetting {
  value: string;
  at: number;
}

/** A request to a remote node, waiting its turn or on the air. */
export interface RemoteJobInfo {
  id: string;
  key: string;
  label: string;
  /** Local ms when it went out; null while queued. */
  startedAt: number | null;
  /** Local ms by which its reply is due, once it went out. */
  until: number | null;
}

export interface SessionState {
  status: "idle" | "connecting" | "ready" | "closed";
  link: { kind: Transport["kind"]; label: string } | null;
  device: DeviceInfo | null;
  self: (Omit<SelfInfo, "publicKey"> & { key: string; prefix: string }) | null;
  contacts: Record<string, ContactRecord>;
  /** The `lastMod` cursor the next incremental contact fetch starts from. */
  contactsCursor: number;
  /** Contacts taken off the radio in the last 90 days, by key. */
  removed: Record<string, RemovedContact>;
  /** Which new nodes the radio keeps by itself and how far away; null when its firmware does not say. */
  autoAdd: { config: number; maxHops: number } | null;
  /** The radio said its memory is full and it dropped a node; cleared once there is room. */
  contactsFull: boolean;
  /** Contacts being taken off the radio one by one, while that runs. */
  removing: { done: number; total: number } | null;
  channels: ChannelRecord[];
  messages: MessageRecord[];
  unread: Record<string, number>;
  battery: { mv: number; at: number } | null;
  tuning: { rxDelayBase: number; airtimeFactor: number } | null;
  /** Keyed by contact key, like everything about remote nodes below. */
  logins: Record<string, NodeLogin>;
  telemetry: Record<string, { readings: LppReading[]; at: number }>;
  statuses: Record<string, NodeStatus>;
  /** A week of status answers per node, oldest first. */
  statusHistory: Record<string, StatusSample[]>;
  /**
   * A week of battery voltages per node from anything but a status answer: the voltage on a
   * telemetry's channel 1, keyed like `telemetry`, and this radio's own battery as "self".
   * One sample per ten minutes at most, oldest first.
   */
  batteryHistory: Record<string, BatterySample[]>;
  /**
   * A day of the voltages and currents a node reports off its own channel, a power monitor's
   * such as an INA219, keyed like `telemetry`, then by channel and type ("4:current"). One
   * sample per ten minutes at most, oldest first.
   */
  readingHistory: Record<string, Record<string, ReadingSample[]>>;
  neighbours: Record<string, NeighbourList>;
  accessLists: Record<string, { entries: AccessRecord[]; at: number }>;
  ownerInfo: Record<string, OwnerInfo>;
  series: Record<string, SeriesWindow>;
  nodeSettings: Record<string, Record<string, NodeSetting>>;
  consoles: Record<string, ConsoleEntry[]>;
  /** The radio carries one request to a remote node at a time; the rest wait here. */
  remote: { active: RemoteJobInfo | null; queued: RemoteJobInfo[] };
  /** How direct messages are routed: a flood pinned per contact, and how long a learned route is trusted. */
  routing: RoutingSettings;
  /** The most recent pushes and errors, newest last, for a log pane. */
  log: LogEntry[];
  error: string | null;
  syncing: boolean;
  /**
   * How far a connect has got, for a screen to show while it waits: `hello`
   * until the radio has said who it is, `history` while its stored chats are
   * read back; null otherwise.
   */
  connectStep: "hello" | "history" | null;
}

/** What survives a disconnect, per radio. */
export interface PersistedState {
  contacts: Record<string, ContactRecord>;
  contactsCursor: number;
  /** Absent in history saved before removed contacts were kept. */
  removed?: Record<string, RemovedContact>;
  channels: ChannelRecord[];
  messages: MessageRecord[];
  unread: Record<string, number>;
  /** Absent in history saved before remote nodes were managed. */
  logins?: Record<string, NodeLogin>;
  statusHistory?: Record<string, StatusSample[]>;
  /** Absent in history saved before battery readings were kept outside a status. */
  batteryHistory?: Record<string, BatterySample[]>;
  /** Absent in history saved before a power monitor's readings were kept. */
  readingHistory?: Record<string, Record<string, ReadingSample[]>>;
  /** Absent in history saved before routes could be pinned or timed out. */
  routing?: RoutingSettings;
}

/** History brought in from a file, as `importHistory` takes it. */
export interface ImportedHistory {
  messages: MessageRecord[];
  /** The contacts the radio held when the file was written; the radio's own list decides which of them still are. */
  contacts: ContactRecord[];
  /** Contacts that were already taken off the radio then. */
  removed: RemovedContact[];
  /** Nodes heard but not kept by the radio. */
  heard: ContactRecord[];
}

export interface ImportSummary {
  messages: number;
  /** Messages that were here already. */
  already: number;
  /** Contacts the radio does not hold, kept as removed. */
  removedContacts: number;
  heard: number;
}

export interface SessionStorage {
  /** Null when nothing is stored for the radio. A history that is there but cannot be read rejects: it is not the same as none. */
  load(radioKey: string): Promise<PersistedState | null>;
  save(radioKey: string, state: PersistedState): Promise<void>;
}

export interface SessionOptions {
  appName?: string;
  storage?: SessionStorage;
  /** Overrides the clock, for tests. Returns ms. */
  now?: () => number;
  /** How long to wait for a remote node, from the radio's estimate; for tests. */
  replyWaitMs?: (estimateMs: number, extraMs: number) => number;
  trace?: ConstructorParameters<typeof MeshCoreClient>[1] extends infer O ? (O extends { trace?: infer T } ? T : never) : never;
  /** How long to wait for a trace to come back, from the time worked out for it; for tests. */
  traceWaitMs?: (estimateMs: number) => number;
  /** How long a neighbour search waits for the neighbours' answers, from the time worked out for it; for tests. */
  searchWaitMs?: (estimateMs: number) => number;
}

/** One trace that came back. */
export interface TraceResult {
  /** From the radio saying it sent the trace to the trace coming back, ms. */
  rttMs: number;
  /** The SNR at each node along the path, out and back, then ours of the last hop, dB. */
  snrs: number[];
}

/** What a path discovery found: the way to the node, and the way its answer came back. */
export interface PathFound {
  /** The relays from this radio to the node, first relay first, as hex hashes; none when heard direct. */
  out: string[];
  /** The relays its answer came back through, nearest to it first. */
  back: string[];
  /** Whether the route the radio held before was another one. */
  changed: boolean;
}

/** A node in direct range that answered "who hears me". */
export interface DiscoverReply {
  /** Its whole key; only the hex it sent, when it sent a prefix. */
  key: string;
  /** Whether it is among the contacts. */
  known: boolean;
  /** Its `AdvType`. */
  type: number;
  /** How well it heard this radio, dB. */
  heardUs: number;
  /** How well this radio heard its answer, dB. */
  heardThem: number;
  rssi: number;
  /** Local clock, ms. */
  at: number;
}

/** What a repeater's neighbour search found. */
export interface NeighbourSearch {
  /** The list read after the neighbours had time to answer, newest first. */
  list: NeighbourList;
  /** The prefixes of the neighbours in `list` that answered. */
  answered: string[];
  /**
   * Those of them the list did not hold before. Null when that cannot be
   * told: the list had not been read, or only part of it, and more answered
   * from outside that part than it grew by.
   */
  fresh: string[] | null;
}

/** One battery reading kept for a node's week. */
export interface BatterySample {
  at: number;
  mv: number;
}

/** One reading kept for a node's day, in the reading's own unit: volts, amperes. */
export interface ReadingSample {
  at: number;
  value: number;
}

/** What the radio says about itself: its battery and how long it has been up. */
export interface CoreStats {
  batteryMv: number;
  uptimeSecs: number;
  /** Local clock, ms. */
  at: number;
}

/** What the radio says about its own receiver. */
export interface RadioStats {
  /** dBm. */
  noiseFloor: number;
  lastRssi: number;
  lastSnr: number;
  /** Seconds on the air since it booted, sending and receiving. */
  txAirSecs: number;
  rxAirSecs: number;
  /** Local clock, ms. */
  at: number;
}

/** A packet the radio received, whoever it was for. */
export interface HeardPacket {
  /** Local clock, ms. */
  at: number;
  snr: number;
  rssi: number;
  /** The whole packet as it was on the air, bytes. */
  size: number;
  /** Null when the bytes are not a packet. */
  packet: RawPacket | null;
}

export function contactConversation(key: string): string {
  return `c:${key}`;
}

/** A message in a chat with one node, a person or a room, which acknowledges it; not one on a channel. */
export function isDirect(message: Pick<MessageRecord, "conversation">): boolean {
  return message.conversation.startsWith("c:");
}

export function channelConversation(index: number): string {
  return `ch:${index}`;
}

export function parseConversation(id: string): { kind: "contact"; key: string } | { kind: "channel"; index: number } | { kind: "prefix"; prefix: string } {
  if (id.startsWith("c:")) return { kind: "contact", key: id.slice(2) };
  if (id.startsWith("ch:")) return { kind: "channel", index: Number(id.slice(3)) };
  if (id.startsWith("p:")) return { kind: "prefix", prefix: id.slice(2) };
  throw new Error(`not a conversation id: ${id}`);
}

/** `<sender>: <text>`, as the firmware writes a channel message. */
export function splitChannelText(text: string): { sender: string | null; text: string } {
  const at = text.indexOf(": ");
  if (at <= 0) return { sender: null, text };
  return { sender: text.slice(0, at), text: text.slice(at + 2) };
}

export function isFavourite(contact: ContactRecord): boolean {
  return (contact.flags & ContactFlag.Favourite) !== 0;
}

/** The three bits that let a contact read what the radio opens to trusted contacts only. */
const TRUSTED = ContactFlag.TelemetryBase | ContactFlag.TelemetryLocation | ContactFlag.TelemetryEnvironment;

/**
 * Whether a contact may read what the radio opens to trusted contacts. Another
 * app may have set only some of the three bits; any one of them counts.
 */
export function isTrusted(contact: ContactRecord): boolean {
  return (contact.flags & TRUSTED) !== 0;
}

export function contactHops(contact: ContactRecord): number | null {
  return contact.outPathLen === 0xff ? null : contact.outPathLen & 63;
}

/** The hashes of a path as the firmware writes one: the low six bits of `pathLen` count them, the top two size them. */
export function pathHashes(pathLen: number, path: Uint8Array | string): string[] {
  const hex = typeof path === "string" ? path : toHex(path);
  const size = ((pathLen >> 6) + 1) * 2;
  const hashes: string[] = [];
  for (let i = 0; i < (pathLen & 63); i++) hashes.push(hex.slice(i * size, (i + 1) * size));
  return hashes;
}

/** The length byte and path the radio holds for a route of these hashes, which are all of one size. */
export function pathOf(hashes: string[]): { outPathLen: number; outPath: string } {
  const size = hashes[0] ? hashes[0].length / 2 : 1;
  // Kept at the radio's full width, as it hands contacts back.
  return { outPathLen: hashes.length | ((size - 1) << 6), outPath: hashes.join("").padEnd(128, "0") };
}

/** A route as one string, so two can be compared: its length byte and the hashes it holds. */
export function routeKey(outPathLen: number, outPath: string): string {
  return outPathLen === 0xff ? "none" : `${outPathLen}:${outPath.slice(0, pathByteLength(outPathLen) * 2)}`;
}

/**
 * A trace that went out through `relays` nodes and came back the same way,
 * leg by leg from this radio outwards: the SNR at the far end of each leg
 * going out, and at the near end coming back.
 */
export function traceLegs(snrs: number[], relays: number): [out: number, back: number][] {
  const legs: [number, number][] = [];
  for (let j = 0; j < relays; j++) {
    const out = snrs[j];
    const back = snrs[2 * relays - 1 - j];
    if (out === undefined || back === undefined) break;
    legs.push([out, back]);
  }
  return legs;
}

function randomU32(): number {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === "function") return c.getRandomValues(new Uint32Array(1))[0]!;
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

/** The relays of the route the radio holds for a contact, as hex hashes, first relay first; null with none. */
export function contactRoute(contact: Pick<ContactRecord, "outPathLen" | "outPath">): string[] | null {
  if (contact.outPathLen === 0xff) return null;
  const count = contact.outPathLen & 63;
  const size = ((contact.outPathLen >> 6) + 1) * 2;
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) hashes.push(contact.outPath.slice(i * size, (i + 1) * size));
  return hashes;
}

/** The contacts one writes to, whose direct messages the routing settings govern: chats and rooms. */
export function isConversationType(type: number): boolean {
  return type === AdvType.Chat || type === AdvType.Room;
}

export function contactTypeName(type: number): string {
  switch (type) {
    case AdvType.Chat:
      return "chat";
    case AdvType.Repeater:
      return "repeater";
    case AdvType.Room:
      return "room";
    case AdvType.Sensor:
      return "sensor";
    default:
      return "unknown";
  }
}

export function isNodeType(type: number): boolean {
  return type === AdvType.Repeater || type === AdvType.Room || type === AdvType.Sensor;
}

export function aclRoleName(role: number): string {
  switch (role & 3) {
    case AclRole.Admin:
      return "admin";
    case AclRole.ReadWrite:
      return "read-write";
    case AclRole.ReadOnly:
      return "read-only";
    default:
      return "guest";
  }
}

/** Nothing came back from a remote node within the time the radio said it would take. */
export class NoReplyError extends Error {
  constructor(label: string, ms: number) {
    super(`${label}: no reply in ${Math.round(ms / 1000)} s`);
    this.name = "NoReplyError";
  }
}

/** What `resync` asks the radio for, in the order it asks. */
export const RESYNC_STEPS = ["device", "self", "clock", "contacts", "channels", "autoAdd", "messages", "battery"] as const;
export type ResyncStep = (typeof RESYNC_STEPS)[number];

/** What a resync brought that was not here before it. */
export interface ResyncSummary {
  contacts: number;
  messages: number;
}

/** A resync stopped at `step`. */
export class ResyncError extends Error {
  constructor(readonly step: ResyncStep, message: string) {
    super(message);
    this.name = "ResyncError";
  }
}

/** A node answered a console command with an error of its own. */
export class NodeCommandError extends Error {
  constructor(readonly reply: string) {
    super(reply);
    this.name = "NodeCommandError";
  }
}

/** A node refused `clock sync` because its clock runs ahead of ours: it moves its clock only forward. */
export class ClockAheadError extends NodeCommandError {
  constructor(reply: string) {
    super(reply);
    this.name = "ClockAheadError";
  }
}

/**
 * Replies that mean the node refused: `Err - bad params`, `Error, …`,
 * `Unknown command`, `unknown config: key`, `??: key`, `Board not supported`.
 */
export function isCliError(reply: string): boolean {
  const text = reply.trim();
  return /^(err\b|error|unknown|\?\?)/i.test(text) || /\bnot supported$/i.test(text);
}

/** The value of a `get` reply, which the node writes as `> value`. */
export function cliValue(reply: string): string | null {
  const trimmed = reply.replace(/\s+$/, "");
  return trimmed.startsWith("> ") ? trimmed.slice(2) : trimmed === ">" ? "" : null;
}

/**
 * When a route the radio learned while nobody was listening came to be: the
 * contact's `lastMod`, if it is a time at all, and now otherwise, so a route
 * of unknown age is not dropped the moment it is seen.
 */
function guessPathSince(lastMod: number, now: number): number {
  const at = lastMod * 1000;
  return at > now - 7 * 24 * 3600 * 1000 && at <= now ? at : now;
}

/** The part of the state that is kept per radio. */
function historyOf(state: SessionState): PersistedState {
  const { contacts, contactsCursor, removed, channels, messages, unread, logins, statusHistory, batteryHistory, readingHistory, routing } = state;
  return { contacts, contactsCursor, removed, channels, messages, unread, logins, statusHistory, batteryHistory, readingHistory, routing };
}

/** How long a removed contact is kept to be put back. */
const REMOVED_KEEP_MS = 90 * 24 * 3600 * 1000;

/** How long a node the radio did not keep stays in the list after it was last heard. */
export const UNSAVED_KEEP_MS = 7 * 24 * 3600 * 1000;

/** A contact as the radio holds it, without what only this app knows. */
function saved(record: ContactRecord): ContactRecord {
  const { unsaved: _omit, ...rest } = record;
  return rest;
}

/**
 * `previous` is what was known of the contact: its route's age carries over
 * while the route is the same. `learnedAt` is set when the radio has just said
 * it learned this route.
 */
function toRecord(contact: Contact, lastHeardAt: number | null, previous: ContactRecord | undefined, now: number, learnedAt?: number): ContactRecord {
  const key = toHex(contact.publicKey);
  const outPath = toHex(contact.outPath);
  let pathSince: number | null = null;
  if (contact.outPathLen !== 0xff) {
    const same = previous !== undefined && previous.outPathLen === contact.outPathLen && previous.outPath === outPath && previous.pathSince !== null;
    pathSince = learnedAt ?? (same ? previous.pathSince : guessPathSince(contact.lastMod, now));
  }
  return {
    key,
    prefix: key.slice(0, PUB_KEY_PREFIX_SIZE * 2),
    type: contact.type,
    flags: contact.flags,
    outPathLen: contact.outPathLen,
    outPath,
    name: contact.name,
    lastAdvert: contact.lastAdvert,
    lat: contact.lat,
    lon: contact.lon,
    lastMod: contact.lastMod,
    lastHeardAt,
    pathSince,
  };
}

const LOG_LIMIT = 400;

let idCounter = 0;
function newId(now: number): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  idCounter += 1;
  return `${now.toString(36)}-${idCounter.toString(36)}`;
}

const EMPTY: SessionState = {
  status: "idle",
  link: null,
  device: null,
  self: null,
  contacts: {},
  contactsCursor: 0,
  removed: {},
  autoAdd: null,
  contactsFull: false,
  removing: null,
  channels: [],
  messages: [],
  unread: {},
  battery: null,
  tuning: null,
  logins: {},
  telemetry: {},
  statuses: {},
  statusHistory: {},
  batteryHistory: {},
  readingHistory: {},
  neighbours: {},
  accessLists: {},
  ownerInfo: {},
  series: {},
  nodeSettings: {},
  consoles: {},
  remote: { active: null, queued: [] },
  routing: { resetAfterMin: null, contacts: {} },
  log: [],
  error: null,
  syncing: false,
  connectStep: null,
};

/** How long after sending a channel message its echoes are still looked for. */
const ECHO_WINDOW_MS = 15 * 60 * 1000;

/**
 * How long a channel message waits for a repeater to send it on before it is
 * called unheard. A repeater holds a packet for a random moment before it
 * goes on, so the first echo is usually back within a few seconds; this leaves
 * room for that wait plus the airtime of a couple of hops.
 */
const SILENCE_MS = 20 * 1000;

/**
 * The gaps before each send of a retry loop. The first goes at once, and the
 * gaps grow: the air is shared, and a repeater that is down stays down for a
 * while. Each is jittered, so two radios with the same trouble do not fall
 * into step.
 */
const RETRY_LADDER_MS = [0, 45_000, 120_000, 300_000, 720_000];

/**
 * The gaps after each try of a direct message before the next, by the number
 * of tries made, counted from when the last went out; a try also waits out its
 * acknowledgement. The second goes as soon as the first is given up on, and by
 * flood: a route that broke is the likeliest reason. Then the gaps grow as on a
 * channel, since a node out of reach stays out of reach for a while and every
 * flood takes the whole mesh's air. Past the end the last gap repeats.
 */
const DIRECT_LADDER_MS = [0, 0, 45_000, 120_000, 300_000, 720_000];

/** How often messages with a retry plan are checked against their next send. */
const RETRY_SWEEP_MS = 5 * 1000;

/** How often learned routes are checked against their time limit while connected. */
const ROUTE_SWEEP_MS = 30 * 1000;

/** How long a packet the radio overheard is kept, to find the copies of a message that arrives after it. */
const HEARD_WINDOW_MS = 30 * 1000;
const HEARD_LIMIT = 64;

/** How long after an incoming message later copies of it are still looked for. */
const IN_ECHO_WINDOW_MS = 60 * 1000;

/** How far back a direct message's packet may have been heard before the radio handed the message up. */
const DM_MATCH_MS = 15 * 1000;

/** How far back status answers are kept, and at most how many a node. */
/** The telemetry channel a node reports itself on: its battery, its board, its GPS (TELEM_CHANNEL_SELF). */
const TELEMETRY_SELF_CHANNEL = 1;
const HISTORY_MS = 7 * 24 * 3600 * 1000;
const HISTORY_LIMIT = 600;
/** Readings closer together than this keep one sample, the latest value at the first one's time. */
const SAMPLE_SPACING_MS = 10 * 60 * 1000;
/** How far back a power monitor's readings are kept: a day, to show how they swing through it (#55). */
const READINGS_MS = 24 * 3600 * 1000;

/** A sample onto the end of a series, taking the place of the last one when they are too close. */
function spaced<T extends { at: number }>(kept: T[], sample: T): T[] {
  const last = kept.at(-1);
  return last && sample.at - last.at < SAMPLE_SPACING_MS ? [...kept.slice(0, -1), { ...sample, at: last.at }] : [...kept, sample];
}

/** The last this many console lines a node are kept. */
const CONSOLE_LIMIT = 200;

/** What a remote node's reply is matched by. */
type RemoteEvent =
  | { kind: "login"; prefix: string; ok: boolean }
  | { kind: "status"; prefix: string }
  | { kind: "telemetry"; prefix: string; readings: LppReading[] }
  | { kind: "binary"; tag: number; data: Uint8Array }
  | { kind: "path"; prefix: string; outPathLen: number; outPath: string; inPathLen: number; inPath: string }
  | { kind: "cli"; prefix: string; tag: string | null; text: string; stamp: number };

interface RemoteJob {
  info: RemoteJobInfo;
  /** Sends the request; the radio answers with the tag and how long the reply may take. */
  start: (client: MeshCoreClient) => Promise<TextSendResult>;
  /** Whether this event is the reply, given what the radio said when it sent the request. */
  answers: (event: RemoteEvent, sent: TextSendResult | null) => boolean;
  /** Added to the radio's estimate: a node holds a console reply back before it sends it. */
  extraWaitMs: number;
  /** What the radio said of the send, once it has. */
  sent: TextSendResult | null;
  /** Events that arrived before the radio had confirmed the send. */
  early: RemoteEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (event: RemoteEvent) => void;
  reject: (error: Error) => void;
}

interface RemoteOptions {
  extraWaitMs?: number;
  onStart?: () => void;
}

/** How long to wait for a remote node: the radio's estimate with room to spare, but not forever. */
function replyWaitMs(estimateMs: number, extraMs: number): number {
  return Math.min(60_000, Math.max(6_000, estimateMs * 1.25 + 1_500 + extraMs));
}

export class MeshSession {
  private state: SessionState = EMPTY;
  private listeners = new Set<() => void>();
  private discoveredListeners = new Set<(contact: ContactRecord) => void>();
  private receivedListeners = new Set<(message: MessageRecord) => void>();
  private client: MeshCoreClient | null = null;
  private readonly appName: string;
  private readonly storage: SessionStorage | null;
  private readonly now: () => number;
  private readonly replyWait: (estimateMs: number, extraMs: number) => number;
  private readonly trace: SessionOptions["trace"];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  /** The radio whose stored history could not be read at connect: nothing is written over it until it can be. */
  private unreadHistory: string | null = null;
  /** The history of the radio last connected, kept through failed attempts to connect again. */
  private held: { key: string; history: PersistedState } | null = null;
  private syncQueued = false;
  private contactsRefreshQueued = false;
  private focused: string | null = null;
  private ackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** How many tries a direct message gets before it is given up on; 1 leaves the next to the user. */
  private sendTries = 1;
  /** Channel messages waiting to hear a repeater send them on, by message id. */
  private silenceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Drives the retry loops while the radio is here. */
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  /** The queue of messages written while the radio was away is being sent. */
  private flushing = false;
  /**
   * What recent messages look like on the air (payload hex), to know their
   * copies by: ours on a channel, and incoming ones whose packet was found.
   */
  private echoWatch = new Map<string, { id: string; at: number; incoming: boolean }>();
  /** Packets the radio overheard lately, newest last; a message's packet is heard before the message is handed up. */
  private heard: { at: number; snr: number; packet: RawPacket; hex: string }[] = [];
  /** Payloads already matched to an incoming direct message, so a second one from the same sender takes the next. */
  private claimed = new Set<string>();
  /** The last route the radio said it learned: the acknowledgement of a flood rides in on it. */
  private lastPathUpdate: { key: string; at: number; record: Promise<ContactRecord | null> } | null = null;
  private routeTimer: ReturnType<typeof setInterval> | null = null;
  /** Contacts whose route is being dropped right now, so the sweep and a send do not both do it. */
  private droppingRoutes = new Set<string>();
  private remoteQueue: RemoteJob[] = [];
  private remoteActive: RemoteJob | null = null;
  private jobCounter = 0;
  /** The next console tag; two hex digits, so the node's `XX|` rule holds. */
  private cliTag = Math.floor(Math.random() * 256);
  /** The last console stamp sent to each node. */
  private cliStamps = new Map<string, number>();
  /** Traces on the air, by tag, each waiting for its way back. */
  private traceWaiters = new Map<number, (frame: Extract<PushFrame, { kind: "traceData" }>) => void>();
  private controlListeners = new Set<(frame: Extract<PushFrame, { kind: "controlData" }>) => void>();
  private heardListeners = new Set<(packet: HeardPacket) => void>();
  private readonly traceWait: (estimateMs: number) => number;
  private readonly searchWait: (estimateMs: number) => number;

  constructor(options: SessionOptions = {}) {
    this.appName = options.appName ?? "Meshnet";
    this.storage = options.storage ?? null;
    this.now = options.now ?? (() => Date.now());
    this.replyWait = options.replyWaitMs ?? replyWaitMs;
    this.traceWait = options.traceWaitMs ?? ((budget) => Math.min(30_000, Math.max(2_500, budget)));
    this.searchWait = options.searchWaitMs ?? ((budget) => budget);
    this.trace = options.trace;
  }

  // ---- the store ----

  getState(): SessionState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * A node the radio has just heard advertise for the first time: its
   * `NEW_ADVERT` push, which the firmware sends for a key it did not know,
   * whether or not it added the contact. The contacts read at connect are
   * not new and say nothing.
   */
  onDiscovered(listener: (contact: ContactRecord) => void): () => void {
    this.discoveredListeners.add(listener);
    return () => this.discoveredListeners.delete(listener);
  }

  /**
   * A message the radio has just handed over from its queue, once it is in
   * the state. The history read back from the storage at connect was handed
   * over on an earlier run and says nothing.
   */
  onReceived(listener: (message: MessageRecord) => void): () => void {
    this.receivedListeners.add(listener);
    return () => this.receivedListeners.delete(listener);
  }

  /** Every packet the radio receives, as it hands them up; kept out of the state, which would change with each. */
  onHeard(listener: (packet: HeardPacket) => void): () => void {
    this.heardListeners.add(listener);
    return () => this.heardListeners.delete(listener);
  }

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
    if (
      "contacts" in patch ||
      "contactsCursor" in patch ||
      "removed" in patch ||
      "channels" in patch ||
      "messages" in patch ||
      "unread" in patch ||
      "logins" in patch ||
      "statusHistory" in patch ||
      "batteryHistory" in patch ||
      "readingHistory" in patch ||
      "routing" in patch
    ) {
      this.scheduleSave();
    }
  }

  private log(kind: string, text: string): void {
    const entry: LogEntry = { at: this.now(), kind, text };
    const log = this.state.log.length >= LOG_LIMIT ? this.state.log.slice(-LOG_LIMIT + 1) : this.state.log;
    this.set({ log: [...log, entry] });
  }

  private scheduleSave(): void {
    if (!this.storage || !this.state.self) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, 400);
  }

  private async saveNow(strict = false): Promise<void> {
    if (!this.storage || !this.state.self) return;
    const storage = this.storage;
    const key = this.state.self.key;
    if (this.unreadHistory === key) return;
    const history = historyOf(this.state);
    const saving = this.saveChain.catch(() => undefined).then(() => storage.save(key, history));
    this.saveChain = saving;
    try {
      await saving;
    } catch (error) {
      this.log("error", `could not save: ${(error as Error).message}`);
      if (strict) throw error;
    }
  }

  /** Wait for the latest history to reach storage before an update exits the app. */
  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.saveNow(true);
  }

  // ---- connecting ----

  get isReady(): boolean {
    return this.state.status === "ready" && this.client !== null;
  }

  get hasPendingCommands(): boolean {
    return this.client?.isBusy ?? false;
  }

  private need(): MeshCoreClient {
    if (!this.client || this.client.isClosed) throw new Error("not connected");
    return this.client;
  }

  /**
   * Connects, and resolves once the radio's queue, contacts and channels have
   * been read. `onReady` is called earlier, once the link is usable and the
   * status is `ready`; a failure after it closes the link like a drop.
   */
  async connect(transport: Transport, onReady?: () => void): Promise<void> {
    if (this.client) await this.disconnect();
    // What changed since the link dropped (a message queued meanwhile) is
    // saved before the history is read back from the storage.
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.saveNow();
    }
    // The history this session already holds. Back on the same radio it goes
    // on from there rather than from the stored copy, which is never newer and
    // is older when a save failed: a phone's web view can lose its database
    // while the app is in the background, and a reconnect then read nothing and
    // showed the chats empty. It is kept aside, since an attempt that fails
    // leaves the state empty and a weak link can take a few. A history that
    // could not be read at connect is read again instead.
    if (this.state.self) this.held = this.unreadHistory === this.state.self.key ? null : { key: this.state.self.key, history: historyOf(this.state) };
    const client = new MeshCoreClient(transport, this.trace ? { trace: this.trace } : {});
    this.client = client;
    // While it connects again, the radio and its history stay in sight, so the
    // chats stay on screen rather than giving way to the connect screen.
    const staying = this.held ? { self: this.state.self, device: this.state.device, ...this.held.history } : {};
    this.set({
      ...EMPTY,
      ...staying,
      status: "connecting",
      connectStep: "hello",
      link: { kind: transport.kind, label: transport.label },
      log: this.state.log,
    });
    client.onPush((frame) => this.onPush(frame));
    client.onClose((reason) => {
      if (this.client !== client) return;
      this.client = null;
      for (const timer of this.ackTimers.values()) clearTimeout(timer);
      this.ackTimers.clear();
      // A message whose window was still running is left as it was: with the
      // radio gone the app heard nothing, which says nothing about the air.
      for (const timer of this.silenceTimers.values()) clearTimeout(timer);
      this.silenceTimers.clear();
      if (this.routeTimer) clearInterval(this.routeTimer);
      this.routeTimer = null;
      if (this.retryTimer) clearInterval(this.retryTimer);
      this.retryTimer = null;
      this.holdRetryPlans();
      this.dropRemoteJobs(reason ? `link dropped: ${reason.message}` : "disconnected");
      this.set({ status: "closed", syncing: false, connectStep: null, error: reason ? reason.message : this.state.error });
      this.log("link", reason ? `link dropped: ${reason.message}` : "disconnected");
    });

    try {
      const device = await client.deviceQuery();
      const selfInfo = await client.appStart(this.appName);
      const key = toHex(selfInfo.publicKey);
      const { publicKey: _omit, ...rest } = selfInfo;
      const self = { ...rest, key, prefix: key.slice(0, PUB_KEY_PREFIX_SIZE * 2) };

      this.set({ connectStep: "history" });
      const persisted = this.held?.key === key ? this.held.history : await this.readHistory(key);
      this.held = null;
      this.set({ device, self, ...this.restored(persisted), autoAdd: null, contactsFull: false, removing: null });
      this.log("link", `connected to ${self.name} (${device.firmwareVersion})`);

      await this.syncClock();
      // Ready once the radio has answered and its history is back: the link is
      // usable from here. What follows only catches up, and over BLE it is slow,
      // paced by the firmware at a frame per 60 ms or more: a hundred contacts
      // take 7–10 s and forty channel slots another 8. The chats are on screen
      // meanwhile, with the stored contacts and channels.
      this.set({ status: "ready", connectStep: null });
      onReady?.();
      this.routeTimer = setInterval(() => void this.sweepRoutes(), ROUTE_SWEEP_MS);
      // Node keeps a process alive for an interval; a browser has no such notion.
      (this.routeTimer as { unref?: () => void }).unref?.();
      this.retryTimer = setInterval(() => void this.sweepRetries(), RETRY_SWEEP_MS);
      (this.retryTimer as { unref?: () => void }).unref?.();
      this.resumeRetryPlans();
      // What arrived while the app was away comes first, then what waited to go
      // out, then whatever the radio may have changed. A channel message names
      // its channel by index, so it needs no fresh channel list; a message from a
      // contact the radio added meanwhile is tied to it once contacts are read.
      await this.syncMessages();
      void this.flushQueue();
      await this.refreshContacts();
      await this.refreshChannels();
      await this.readAutoAdd(client);
      void this.refreshBattery();
      void this.sweepRoutes();
    } catch (error) {
      const message = (error as Error).message;
      if (this.client === client) {
        this.set({ error: message });
        this.log("error", `connect failed: ${message}`);
      }
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Shows the stored chats of `self`, the radio last connected, before it is
   * reached: the app opens on them rather than on the connect screen, and a
   * connect that follows goes on from them as it does after a drop. False
   * when nothing is stored for it, or a radio is already shown.
   */
  async resume(self: NonNullable<SessionState["self"]>, device: DeviceInfo | null): Promise<boolean> {
    if (this.client || this.state.self) return false;
    const persisted = await this.readHistory(self.key);
    if (!persisted || this.client || this.state.self) return false;
    this.set({ self, device, ...this.restored(persisted) });
    return true;
  }

  /** A stored history as the state holds it, brought up to date with what older saves lack. */
  private restored(persisted: PersistedState | null): Partial<SessionState> {
    const now = this.now();
    // Contacts saved before route ages were kept have none: a route of theirs
    // is dated as a route learned while nobody was listening.
    const contacts: Record<string, ContactRecord> = {};
    for (const [k, c] of Object.entries(persisted?.contacts ?? {})) {
      // A node the radio never kept goes once it has been quiet for a while.
      if (c.unsaved && (c.lastHeardAt ?? 0) < now - UNSAVED_KEEP_MS) continue;
      contacts[k] = c.pathSince !== undefined ? c : { ...c, pathSince: c.outPathLen === 0xff ? null : guessPathSince(c.lastMod, now) };
    }
    const removed: Record<string, RemovedContact> = {};
    for (const [k, r] of Object.entries(persisted?.removed ?? {})) if (r.at > now - REMOVED_KEEP_MS) removed[k] = r;
    return {
      contacts,
      contactsCursor: persisted?.contactsCursor ?? 0,
      removed,
      channels: persisted?.channels ?? [],
      // History saved before the hop count was masked holds the raw path_len
      // byte (the low six bits are the hops either way), and history saved
      // before echoes were kept has none.
      messages: (persisted?.messages ?? []).map((m) => ({
        ...m,
        hops: m.hops === null ? null : m.hops & 63,
        echoes: m.echoes ?? [],
        route: m.route ?? null,
        retryPlan: m.retryPlan ?? null,
      })),
      unread: persisted?.unread ?? {},
      logins: persisted?.logins ?? {},
      statusHistory: persisted?.statusHistory ?? {},
      batteryHistory: persisted?.batteryHistory ?? {},
      readingHistory: persisted?.readingHistory ?? {},
      routing: persisted?.routing ?? EMPTY.routing,
    };
  }

  /** The stored history of a radio, or null; one that cannot be read is logged, and kept from being written over. */
  private async readHistory(key: string): Promise<PersistedState | null> {
    if (!this.storage) return null;
    try {
      const history = await this.storage.load(key);
      if (this.unreadHistory === key) this.unreadHistory = null;
      return history;
    } catch (error) {
      this.unreadHistory = key;
      this.log("error", `history could not be read, and is not saved over: ${(error as Error).message}`);
      return null;
    }
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    if (!client) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.saveNow();
    }
    await client.close();
  }

  /**
   * Asks the radio again for all it was asked at connect, on the link as it
   * is. A step that fails stops the rest, and the error names the step; what
   * came in before it is kept. Contacts are read in full, not from the cursor.
   */
  async resync(onStep?: (step: ResyncStep, index: number) => void): Promise<ResyncSummary> {
    const client = this.need();
    const contactsBefore = new Set(Object.keys(this.state.contacts));
    const messagesBefore = new Set(this.state.messages.filter((m) => m.direction === "in").map((m) => m.id));
    const run: Record<ResyncStep, () => Promise<unknown>> = {
      device: async () => this.set({ device: await client.deviceQuery() }),
      self: async () => {
        const { publicKey, ...rest } = await client.appStart(this.appName);
        const key = toHex(publicKey);
        this.set({ self: { ...rest, key, prefix: key.slice(0, PUB_KEY_PREFIX_SIZE * 2) } });
      },
      clock: () => this.syncClock(),
      contacts: () => this.refreshContacts(true),
      channels: () => this.refreshChannels(),
      autoAdd: () => this.readAutoAdd(client),
      messages: () => this.syncMessages(),
      battery: async () => {
        const { batteryMv } = await client.getBattAndStorage();
        this.set({ battery: { mv: batteryMv, at: this.now() }, ...this.noteBattery("self", batteryMv) });
      },
    };
    for (const [index, step] of RESYNC_STEPS.entries()) {
      onStep?.(step, index);
      try {
        await run[step]();
      } catch (error) {
        const message = (error as Error).message;
        this.log("error", `refresh stopped at ${step}: ${message}`);
        throw new ResyncError(step, message);
      }
    }
    const summary = {
      contacts: Object.keys(this.state.contacts).filter((k) => !contactsBefore.has(k)).length,
      messages: this.state.messages.filter((m) => m.direction === "in" && !messagesBefore.has(m.id)).length,
    };
    this.log("link", `refreshed from the radio: ${summary.contacts} new contacts, ${summary.messages} new messages`);
    return summary;
  }

  /**
   * The radio's clock is set from ours when it lags by more than `slack` seconds. It refuses to
   * go back, so a lead is left, and the lead is what this resolves with, seconds; 0 when the
   * radio is not ahead.
   */
  async syncClock(slack = 30): Promise<number> {
    const client = this.need();
    const radio = await client.getDeviceTime();
    const ours = Math.floor(this.now() / 1000);
    if (radio < ours - slack) {
      await client.setDeviceTime(ours);
      this.log("clock", `radio clock was ${ours - radio} s behind; set`);
    }
    return Math.max(0, radio - ours);
  }

  // ---- contacts ----

  /** `announce`: contacts new to this app were just added by the radio as it heard them, and are told to `onDiscovered`. */
  async refreshContacts(full = false, announce = false): Promise<void> {
    const client = this.need();
    const since = full || this.state.contactsCursor === 0 ? undefined : this.state.contactsCursor;
    const { total, contacts: fresh, mostRecentLastMod } = await client.getContacts(since);
    const contacts = { ...this.state.contacts };
    const now = this.now();
    const found: ContactRecord[] = [];
    for (const c of fresh) {
      const previous = contacts[toHex(c.publicKey)];
      const isNew = announce && !previous && !this.state.removed[toHex(c.publicKey)];
      const record = toRecord(c, isNew ? now : (previous?.lastHeardAt ?? null), previous, now);
      contacts[record.key] = record;
      if (isNew) found.push(record);
    }
    const cursor = Math.max(this.state.contactsCursor, mostRecentLastMod);
    this.set({ contacts, contactsCursor: cursor, removed: this.withoutRemoved(fresh.map((c) => toHex(c.publicKey))), ...this.fullAfter(total) });
    this.rebindOrphans();
    for (const record of found) this.announceDiscovered(record);
    // Fewer on the radio than we remember: it was reset, or contacts were
    // removed by another app. The cursor cannot say which, so ask for all.
    if (total < this.savedCount()) {
      await this.reconcileContacts(client, since === undefined ? fresh : undefined);
    }
    // A route set by hand that the radio replaced while this app was away (another app, a way
    // an answer came in) is written back.
    for (const c of fresh) {
      const key = toHex(c.publicKey);
      const manual = this.manualRoute(key);
      const record = this.state.contacts[key];
      if (manual && record && routeKey(record.outPathLen, record.outPath) !== routeKey(manual.outPathLen, manual.outPath)) {
        await this.writeContact({ ...record, ...manual }).catch((e: Error) => this.log("error", e.message));
        this.log("path", `${record.name || key.slice(0, 12)}: route set by hand put back over ${pathHashes(record.outPathLen, record.outPath).join(" ") || "none"}`);
      }
    }
  }

  /**
   * The contacts as the radio holds them now. One this app knew that the radio
   * no longer holds was taken off it while nobody was listening: it is kept as
   * removed. Nodes the radio never kept stay as they are.
   */
  private async reconcileContacts(client: MeshCoreClient, all?: Contact[]): Promise<void> {
    const got = all ? null : await client.getContacts();
    const fresh = all ?? got!.contacts;
    const contacts: Record<string, ContactRecord> = {};
    const now = this.now();
    for (const c of fresh) {
      const key = toHex(c.publicKey);
      const previous = this.state.contacts[key];
      contacts[key] = toRecord(c, previous?.lastHeardAt ?? null, previous, now);
    }
    const gone = Object.values(this.state.contacts).filter((c) => !c.unsaved && !contacts[c.key]);
    for (const c of Object.values(this.state.contacts)) if (c.unsaved && !contacts[c.key]) contacts[c.key] = c;
    const removed = this.withRemoved(gone, "radio");
    if (gone.length) this.log("contact", `${gone.length} ${gone.length === 1 ? "contact is" : "contacts are"} no longer on the radio`);
    this.set({ contacts, removed, ...(got ? { contactsCursor: got.mostRecentLastMod } : {}) });
  }

  /** How many contacts the radio holds, as far as this app knows. */
  private savedCount(): number {
    let n = 0;
    for (const c of Object.values(this.state.contacts)) if (!c.unsaved) n++;
    return n;
  }

  /** "Full" goes once the radio holds fewer than it can. */
  private fullAfter(total: number): Partial<SessionState> {
    const max = this.state.device?.maxContacts ?? 0;
    return this.state.contactsFull && max > 0 && total < max ? { contactsFull: false } : {};
  }

  /** The removed contacts with these added; the newest removal of a contact wins. */
  private withRemoved(contacts: ContactRecord[], by: RemovedBy): Record<string, RemovedContact> {
    if (contacts.length === 0) return this.state.removed;
    const removed = { ...this.state.removed };
    const at = this.now();
    for (const c of contacts) if (!c.unsaved) removed[c.key] = { contact: c, at, by };
    return removed;
  }

  /** The removed contacts without these, which are on the radio again. */
  private withoutRemoved(keys: string[]): Record<string, RemovedContact> {
    if (!keys.some((k) => this.state.removed[k])) return this.state.removed;
    const removed = { ...this.state.removed };
    for (const k of keys) delete removed[k];
    return removed;
  }

  private async readAutoAdd(client: MeshCoreClient): Promise<void> {
    try {
      const { config, maxHops } = await client.getAutoAddConfig();
      this.set({ autoAdd: { config, maxHops } });
    } catch (error) {
      // Firmware before 1.10 has no such setting.
      if (!(error instanceof MeshCoreError)) throw error;
      this.set({ autoAdd: null });
    }
  }

  /**
   * Which new nodes the radio keeps by itself when new contacts are added by
   * hand (`AutoAdd` kind bits), whether it replaces its oldest contact when it
   * is full, and how far away a new node may be (0: any).
   */
  async setAutoAdd(config: number, maxHops: number): Promise<void> {
    await this.need().setAutoAddConfig(config, maxHops);
    this.set({ autoAdd: { config, maxHops } });
  }

  private queueContactsRefresh(): void {
    if (this.contactsRefreshQueued) return;
    this.contactsRefreshQueued = true;
    setTimeout(() => {
      this.contactsRefreshQueued = false;
      if (this.isReady) this.refreshContacts(false, true).catch((e: Error) => this.log("error", e.message));
    }, 500);
  }

  private announceDiscovered(record: ContactRecord): void {
    this.log("advert", `new: ${record.name || record.prefix} (${contactTypeName(record.type)})${record.unsaved ? ", not kept by the radio" : ""}`);
    for (const listener of this.discoveredListeners) {
      try {
        listener(record);
      } catch (error) {
        console.error("discovered listener threw", error);
      }
    }
  }

  /** Messages filed under a bare prefix are moved to the contact once one is known. */
  private rebindOrphans(): void {
    let changed = false;
    const byPrefix = new Map<string, ContactRecord>();
    for (const c of Object.values(this.state.contacts)) byPrefix.set(c.prefix, c);
    const messages = this.state.messages.map((m) => {
      if (!m.conversation.startsWith("p:")) return m;
      const contact = byPrefix.get(m.conversation.slice(2));
      if (!contact) return m;
      changed = true;
      // A room post keeps its author; only a direct message is named after its sender.
      const sender = m.txtType === TxtType.SignedPlain ? m.sender : contact.name;
      return { ...m, conversation: contactConversation(contact.key), sender };
    });
    if (!changed) return;
    const unread: Record<string, number> = {};
    for (const [conv, n] of Object.entries(this.state.unread)) {
      const contact = conv.startsWith("p:") ? byPrefix.get(conv.slice(2)) : null;
      const target = contact ? contactConversation(contact.key) : conv;
      unread[target] = (unread[target] ?? 0) + n;
    }
    this.set({ messages, unread });
  }

  /** `learnedAt` is set when the radio has just said it learned this contact's route. */
  private upsertContact(contact: Contact, heard: boolean, learnedAt?: number, unsaved = false): ContactRecord {
    const key = toHex(contact.publicKey);
    const previous = this.state.contacts[key];
    const fresh = toRecord(contact, heard ? this.now() : (previous?.lastHeardAt ?? null), previous, this.now(), learnedAt);
    const record: ContactRecord = unsaved ? { ...fresh, unsaved: true } : fresh;
    this.set({ contacts: { ...this.state.contacts, [key]: record }, ...(unsaved ? {} : { removed: this.withoutRemoved([key]) }) });
    this.rebindOrphans();
    return record;
  }

  contactByPrefix(prefix: string): ContactRecord | null {
    for (const c of Object.values(this.state.contacts)) if (c.prefix === prefix) return c;
    return null;
  }

  /** A contact whose key starts with this hex, however short; ourselves included. */
  contactByKeyStart(hex: string): ContactRecord | { name: string } | null {
    if (this.state.self && this.state.self.key.startsWith(hex)) return { name: this.state.self.name };
    for (const c of Object.values(this.state.contacts)) if (c.key.startsWith(hex)) return c;
    return null;
  }

  private contactBytes(key: string): Uint8Array {
    if (!this.state.contacts[key]) throw new Error("unknown contact");
    return fromHex(key);
  }

  /**
   * Takes the contact off the radio and keeps it as removed, to be put back.
   * A node the radio never kept only leaves the list. One the radio has
   * already let go of counts as removed.
   */
  async removeContact(key: string, by: RemovedBy = "you"): Promise<void> {
    const contact = this.state.contacts[key];
    if (!contact) throw new Error("unknown contact");
    if (!contact.unsaved) {
      try {
        await this.need().removeContact(fromHex(key));
      } catch (error) {
        if (!(error instanceof MeshCoreError && error.code === ErrCode.NotFound)) throw error;
      }
    }
    const contacts = { ...this.state.contacts };
    delete contacts[key];
    this.set({ contacts, removed: this.withRemoved([contact], by), contactsFull: false });
  }

  private stopRemoval = false;

  /**
   * Takes these contacts off the radio one at a time, with `removing` counting
   * them. Stops when asked, or at the first failure, the link dropping
   * included; what was removed by then stays removed.
   */
  async removeContacts(keys: string[], by: RemovedBy): Promise<{ removed: string[]; error: Error | null }> {
    if (this.state.removing) throw new Error("already removing contacts");
    this.stopRemoval = false;
    const removed: string[] = [];
    let error: Error | null = null;
    this.set({ removing: { done: 0, total: keys.length } });
    try {
      for (const key of keys) {
        if (this.stopRemoval) break;
        if (!this.state.contacts[key]) continue;
        try {
          await this.removeContact(key, by);
        } catch (e) {
          error = e as Error;
          break;
        }
        removed.push(key);
        this.set({ removing: { done: removed.length, total: keys.length } });
      }
    } finally {
      this.set({ removing: null });
    }
    const who = by === "tidy" ? "tidy-up" : by === "radio" ? "radio" : "you";
    if (removed.length) this.log("contact", `${who} removed ${removed.length} ${removed.length === 1 ? "contact" : "contacts"}`);
    if (error) this.log("error", `removing contacts stopped: ${error.message}`);
    return { removed, error };
  }

  /** Stops `removeContacts` after the contact it is on. */
  stopRemoving(): void {
    this.stopRemoval = true;
  }

  /** A removed contact written back to the radio, or a node it did not keep, added to it. */
  async restoreContact(key: string): Promise<void> {
    const record = this.state.removed[key]?.contact ?? this.state.contacts[key];
    if (!record) throw new Error("unknown contact");
    try {
      await this.writeContact(saved(record));
    } catch (error) {
      if (error instanceof MeshCoreError && error.code === ErrCode.TableFull) throw new Error("The radio's memory is full. Remove a few contacts first.");
      throw error;
    }
    this.set({ removed: this.withoutRemoved([key]) });
  }

  /** Puts these back one at a time; stops at the first that fails. */
  async restoreContacts(keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) {
      await this.restoreContact(key);
      n++;
    }
    return n;
  }

  async setFavourite(key: string, favourite: boolean): Promise<void> {
    const contact = this.state.contacts[key];
    if (!contact) throw new Error("unknown contact");
    const flags = favourite ? contact.flags | ContactFlag.Favourite : contact.flags & ~ContactFlag.Favourite;
    await this.writeContact({ ...contact, flags });
  }

  /** Trusts a contact with all three kinds at once; the radio's own settings say which of them it gets. */
  async setTrusted(key: string, trusted: boolean): Promise<void> {
    const contact = this.state.contacts[key];
    if (!contact) throw new Error("unknown contact");
    const flags = trusted ? contact.flags | TRUSTED : contact.flags & ~TRUSTED;
    await this.writeContact({ ...contact, flags });
  }

  async renameContact(key: string, name: string): Promise<void> {
    const contact = this.state.contacts[key];
    if (!contact) throw new Error("unknown contact");
    await this.writeContact({ ...contact, name });
  }

  private async writeContact(record: ContactRecord): Promise<void> {
    const client = this.need();
    const lastMod = unixNow();
    await client.addUpdateContact({
      publicKey: fromHex(record.key),
      type: record.type,
      flags: record.flags,
      outPathLen: record.outPathLen,
      outPath: fromHex(record.outPath),
      name: record.name,
      lastAdvert: record.lastAdvert,
      lat: record.lat,
      lon: record.lon,
      lastMod,
    });
    this.set({ contacts: { ...this.state.contacts, [record.key]: { ...saved(record), lastMod } } });
  }

  async resetPath(key: string): Promise<void> {
    await this.dropRoute(this.need(), key, "forgotten by hand");
  }

  // ---- routes ----
  //
  // The radio sends a direct message along the route it last learned for the
  // contact, and floods only when it knows none. It keeps a route until a new
  // one replaces it, however long ago the contact moved away. So the session
  // drops routes: before every message to a contact whose flood is pinned, and
  // once a route is older than its time limit. A dropped route costs nothing
  // on the air; the next message floods and its acknowledgement brings a
  // fresh route back.

  /** What governs this contact's route once the defaults are filled in. */
  routePolicy(key: string): { flood: boolean; resetAfterMin: number | null } {
    const own = this.state.routing.contacts[key] ?? {};
    return {
      flood: own.flood ?? false,
      resetAfterMin: own.resetAfterMin !== undefined ? own.resetAfterMin : this.state.routing.resetAfterMin,
    };
  }

  /** Local ms at which the route to this contact will be dropped for its age; null when it will not be. */
  routeExpiresAt(key: string): number | null {
    const contact = this.state.contacts[key];
    if (!contact || contact.outPathLen === 0xff || contact.pathSince === null || !isConversationType(contact.type)) return null;
    const { flood, resetAfterMin } = this.routePolicy(key);
    if (flood || resetAfterMin === null) return null;
    return contact.pathSince + resetAfterMin * 60_000;
  }

  /** Pins every message to this contact to a flood, or lets it use learned routes again. */
  async setFloodPinned(key: string, flood: boolean): Promise<void> {
    const contact = this.needContact(key);
    this.setPolicy(key, { flood });
    this.log("path", `${contact.name || key.slice(0, 12)}: ${flood ? "messages always flood" : "learned routes are used again"}`);
    if (flood && this.isReady && contact.outPathLen !== 0xff) await this.dropRoute(this.need(), key, "flood pinned");
  }

  /** Minutes a learned route to this contact is kept; null keeps it; undefined follows the default. */
  setRouteReset(key: string, minutes: number | null | undefined): void {
    this.needContact(key);
    this.setPolicy(key, { resetAfterMin: minutes });
    void this.sweepRoutes();
  }

  /** Minutes a learned route to a chat or a room is kept unless the contact says otherwise; null keeps it. */
  setDefaultRouteReset(minutes: number | null): void {
    this.set({ routing: { ...this.state.routing, resetAfterMin: minutes } });
    void this.sweepRoutes();
  }

  private setPolicy(key: string, patch: { flood?: boolean; resetAfterMin?: number | null | undefined; manual?: string | undefined }): void {
    const current = this.state.routing.contacts[key] ?? {};
    const flood = "flood" in patch ? patch.flood : current.flood;
    const resetAfterMin = "resetAfterMin" in patch ? patch.resetAfterMin : current.resetAfterMin;
    const manual = "manual" in patch ? patch.manual : current.manual;
    // What follows the default is stored as absence.
    const policy: RoutePolicy = {};
    if (flood) policy.flood = true;
    if (resetAfterMin !== undefined) policy.resetAfterMin = resetAfterMin;
    if (manual !== undefined) policy.manual = manual;
    const contacts = { ...this.state.routing.contacts };
    if (Object.keys(policy).length === 0) delete contacts[key];
    else contacts[key] = policy;
    this.set({ routing: { ...this.state.routing, contacts } });
  }

  /**
   * Writes the route to a contact by hand: the relays in order, as hex hashes
   * of one size, none for a neighbour heard direct. It unpins a flood, and is
   * kept past the time limit until the radio learns a route of its own.
   * `learnedAt` puts back a route the radio had learned then, as learned.
   */
  async setRoute(key: string, hashes: string[], options: { learnedAt?: number | null } = {}): Promise<void> {
    const contact = this.needContact(key);
    const size = hashes[0] ? hashes[0].length / 2 : (this.state.device?.pathHashMode ?? 0) + 1;
    if (!Number.isInteger(size) || size < 1 || size > 4 || hashes.some((h) => h.length !== size * 2 || !/^[0-9a-f]+$/.test(h)) || hashes.length > 63 || hashes.length * size > 64) {
      throw new Error("not a route the radio can hold");
    }
    const outPathLen = hashes.length | ((size - 1) << 6);
    // Kept at the radio's full width, as it hands contacts back.
    const outPath = hashes.join("").padEnd(128, "0");
    if (options.learnedAt !== undefined) {
      await this.writeContact({ ...contact, outPathLen, outPath, pathSince: options.learnedAt });
      this.log("path", `${contact.name || key.slice(0, 12)}: route put back, ${hashes.length ? hashes.join(" ") : "direct"}`);
      return;
    }
    await this.writeContact({ ...contact, outPathLen, outPath, pathSince: this.now() });
    this.setPolicy(key, { flood: false, manual: routeKey(outPathLen, outPath) });
    this.log("path", `${contact.name || key.slice(0, 12)}: route set by hand, ${hashes.length ? hashes.join(" ") : "direct"}`);
  }

  /** The route last written by hand for this contact, whatever the radio holds now. */
  private manualRoute(key: string): { outPathLen: number; outPath: string } | null {
    const manual = this.state.routing.contacts[key]?.manual;
    if (!manual || manual === "none") return null;
    const [len, hex = ""] = manual.split(":");
    return { outPathLen: Number(len), outPath: hex.padEnd(128, "0") };
  }

  /** Whether the route the radio holds for this contact is the one last written by hand. */
  routeSetByHand(key: string): boolean {
    const contact = this.state.contacts[key];
    const manual = this.state.routing.contacts[key]?.manual;
    return !!contact && !!manual && contact.outPathLen !== 0xff && manual === routeKey(contact.outPathLen, contact.outPath);
  }

  /** Why the route to this contact should go now, or null if it may stay. */
  private staleReason(contact: ContactRecord): string | null {
    if (contact.outPathLen === 0xff || !isConversationType(contact.type)) return null;
    const { flood, resetAfterMin } = this.routePolicy(contact.key);
    if (flood) return "flood pinned";
    if (this.routeSetByHand(contact.key)) return null;
    if (resetAfterMin === null || contact.pathSince === null) return null;
    return this.now() - contact.pathSince >= resetAfterMin * 60_000 ? `older than ${resetAfterMin} min` : null;
  }

  private async dropRoute(client: MeshCoreClient, key: string, reason: string): Promise<void> {
    if (this.droppingRoutes.has(key)) return;
    this.droppingRoutes.add(key);
    // The route goes from the state at once. The command waits its turn behind whatever the
    // radio is busy with, and the contacts it streams after a connect take seconds over BLE
    // (74 took 4.6 s on an Android phone). Nothing sent after it can overtake it, so what
    // goes next to this contact floods. Should the radio refuse, the route comes back.
    const held = this.state.contacts[key];
    if (held && held.outPathLen !== 0xff) {
      this.set({ contacts: { ...this.state.contacts, [key]: { ...held, outPathLen: 0xff, pathSince: null } } });
    }
    try {
      await client.resetPath(this.contactBytes(key));
      const contact = this.state.contacts[key];
      if (!contact) return;
      // Again: the radio may have learned a route meanwhile, before the command reached it.
      this.set({ contacts: { ...this.state.contacts, [key]: { ...contact, outPathLen: 0xff, pathSince: null } } });
      this.log("path", `route to ${contact.name || key.slice(0, 12)} dropped: ${reason}`);
    } catch (error) {
      const now = this.state.contacts[key];
      if (held && held.outPathLen !== 0xff && now && now.outPathLen === 0xff) {
        this.set({ contacts: { ...this.state.contacts, [key]: { ...now, outPathLen: held.outPathLen, outPath: held.outPath, pathSince: held.pathSince } } });
      }
      throw error;
    } finally {
      this.droppingRoutes.delete(key);
    }
  }

  /** Drops every route past its time or pinned to a flood. Runs on a timer while connected. */
  private async sweepRoutes(): Promise<void> {
    const client = this.client;
    if (!client || client.isClosed || this.state.status !== "ready") return;
    for (const contact of Object.values(this.state.contacts)) {
      const reason = this.staleReason(contact);
      if (!reason) continue;
      try {
        await this.dropRoute(client, contact.key, reason);
      } catch (error) {
        this.log("error", `could not drop the route to ${contact.name}: ${(error as Error).message}`);
      }
    }
  }

  async shareContact(key: string): Promise<void> {
    await this.need().shareContact(this.contactBytes(key));
  }

  /** The bytes of an advert, as `exportContact` gives them or a link carries them. */
  async importContact(advert: Uint8Array): Promise<void> {
    await this.need().importContact(advert);
    await this.refreshContacts();
  }

  exportContact(key?: string): Promise<Uint8Array> {
    return this.need().exportContact(key ? this.contactBytes(key) : undefined);
  }

  // ---- channels ----

  async refreshChannels(): Promise<void> {
    const client = this.need();
    const max = this.state.device?.maxChannels ?? 8;
    const channels: ChannelRecord[] = [];
    for (let i = 0; i < max; i++) {
      try {
        const ch = await client.getChannel(i);
        const secret = toHex(ch.secret);
        if (ch.name === "" && /^0+$/.test(secret)) continue;
        channels.push({ index: i, name: ch.name, secret });
      } catch (error) {
        if (error instanceof MeshCoreError) break;
        throw error;
      }
    }
    this.set({ channels });
  }

  async setChannel(index: number, name: string, secret: Uint8Array): Promise<void> {
    await this.need().setChannel(index, name, secret);
    const record: ChannelRecord = { index, name, secret: toHex(secret) };
    const channels = this.state.channels.filter((c) => c.index !== index).concat(record);
    channels.sort((a, b) => a.index - b.index);
    this.set({ channels });
  }

  async clearChannel(index: number): Promise<void> {
    await this.need().setChannel(index, "", new Uint8Array(16));
    this.set({ channels: this.state.channels.filter((c) => c.index !== index) });
  }

  // ---- messages ----

  /** The conversation on screen; its messages arrive read. */
  focus(conversation: string | null): void {
    this.focused = conversation;
    if (conversation) this.markRead(conversation);
  }

  markRead(conversation: string): void {
    if (!this.state.unread[conversation]) return;
    const unread = { ...this.state.unread };
    delete unread[conversation];
    this.set({ unread });
  }

  deleteConversation(conversation: string): void {
    const unread = { ...this.state.unread };
    delete unread[conversation];
    this.set({ messages: this.state.messages.filter((m) => m.conversation !== conversation), unread });
  }

  /**
   * History kept for this radio elsewhere, brought in beside what is here. A
   * message already here (the same text, stamp and sender in the same chat)
   * is not added again, so bringing the same file in twice adds nothing; one
   * whose id is taken by another message gets an id of its own. A contact the
   * radio holds stays as the radio has it; one it does not hold is kept as
   * removed, to be put back. Old messages are not unread.
   */
  importHistory(history: ImportedHistory): ImportSummary {
    if (!this.state.self) throw new Error("no radio");
    const same = (m: MessageRecord) =>
      [m.conversation, m.direction, m.timestamp, m.direction === "in" && m.conversation.startsWith("ch:") ? m.sender : m.senderPrefix, m.text].join("\n");
    const ids = new Set(this.state.messages.map((m) => m.id));
    const seen = new Set(this.state.messages.map(same));
    const added: MessageRecord[] = [];
    for (const m of history.messages) {
      const key = same(m);
      if (seen.has(key)) continue;
      const id = ids.has(m.id) ? newId(this.now()) : m.id;
      ids.add(id);
      seen.add(key);
      added.push(id === m.id ? m : { ...m, id });
    }

    const contacts = { ...this.state.contacts };
    const removed = { ...this.state.removed };
    const at = this.now();
    let gone = 0;
    for (const contact of history.contacts) {
      if (contacts[contact.key] || removed[contact.key]) continue;
      removed[contact.key] = { contact, at, by: "radio" };
      gone++;
    }
    for (const entry of history.removed) {
      if (contacts[entry.contact.key] || removed[entry.contact.key]) continue;
      // Kept as long as one removed now, however long ago it went.
      removed[entry.contact.key] = { ...entry, at };
      gone++;
    }
    let heard = 0;
    for (const node of history.heard) {
      if (contacts[node.key] || removed[node.key]) continue;
      contacts[node.key] = { ...node, unsaved: true };
      heard++;
    }

    // Filed by when they arrived, as the radio's own come in.
    const messages = added.length ? [...this.state.messages, ...added].sort((a, b) => a.receivedAt - b.receivedAt) : this.state.messages;
    this.set({ messages, contacts, removed });
    this.rebindOrphans();
    this.log("import", `brought in ${added.length} messages, ${gone} contacts not on the radio and ${heard} nodes heard`);
    return { messages: added.length, already: history.messages.length - added.length, removedContacts: gone, heard };
  }

  /** Drains the radio's queue. Re-entrant calls collapse into one more pass. */
  async syncMessages(): Promise<void> {
    if (this.state.syncing) {
      this.syncQueued = true;
      return;
    }
    const client = this.need();
    this.set({ syncing: true });
    let retries = 0;
    try {
      do {
        this.syncQueued = false;
        for (;;) {
          let frame;
          try {
            frame = await client.syncNextMessage();
          } catch (error) {
            // A lost USB frame need not mean a lost link. Give the stream a
            // quiet interval to discard its partial frame, then resume draining.
            if (
              !(error instanceof TimeoutError) || client.transport.kind !== "serial" ||
              retries >= 2 || this.client !== client || client.isClosed
            ) throw error;
            retries += 1;
            this.log("error", `${error.message}; retrying message sync (${retries}/2)`);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            if (this.client !== client || client.isClosed) throw error;
            continue;
          }
          retries = 0;
          if (!frame) break;
          this.receive(frame);
        }
      } while (this.syncQueued);
    } finally {
      if (this.client === client) this.set({ syncing: false });
    }
  }

  private receive(frame: NonNullable<Awaited<ReturnType<MeshCoreClient["syncNextMessage"]>>>): void {
    const now = this.now();
    let message: MessageRecord;
    if (frame.kind === "contactMessage") {
      const prefix = toHex(frame.senderPrefix);
      if (frame.txtType === TxtType.CliData) {
        this.receiveCli(prefix, frame.text, frame.timestamp);
        return;
      }
      const contact = this.contactByPrefix(prefix);
      if (!contact) this.queueContactsRefresh();
      // A room relays its members' posts signed with the author's key prefix.
      const signer = frame.signerPrefix ? toHex(frame.signerPrefix) : null;
      const author = signer ? this.contactByKeyStart(signer) : null;
      const conversation = contact ? contactConversation(contact.key) : `p:${prefix}`;
      // A sender that heard no acknowledgement sends the same message again,
      // stamp and all, and the radio hands up every copy that arrives.
      const twin = this.state.messages.some(
        (m) => m.direction === "in" && m.conversation === conversation && m.timestamp === frame.timestamp && m.senderPrefix === (signer ?? prefix) && m.text === frame.text,
      );
      if (twin) {
        this.log("message", `another copy of a message from ${contact?.name ?? prefix}, sent again`);
        return;
      }
      message = {
        id: newId(now),
        conversation,
        direction: "in",
        text: frame.text,
        sender: signer ? (author?.name ?? signer) : (contact?.name ?? null),
        senderPrefix: signer ?? prefix,
        timestamp: frame.timestamp,
        receivedAt: now,
        snr: frame.snr,
        hops: frame.pathLen,
        txtType: frame.txtType,
        status: null,
        ackTag: null,
        roundTripMs: null,
        flood: null,
        attempt: 0,
        error: null,
        echoes: [],
        route: null,
        retryPlan: null,
      };
    } else if (frame.kind === "channelMessage") {
      const { sender, text } = splitChannelText(frame.text);
      message = {
        id: newId(now),
        conversation: channelConversation(frame.channelIndex),
        direction: "in",
        text,
        sender,
        senderPrefix: null,
        timestamp: frame.timestamp,
        receivedAt: now,
        snr: frame.snr,
        hops: frame.pathLen,
        txtType: frame.txtType,
        status: null,
        ackTag: null,
        roundTripMs: null,
        flood: null,
        attempt: 0,
        error: null,
        echoes: [],
        route: null,
        retryPlan: null,
      };
    } else {
      this.log("channelData", `channel ${frame.channelIndex} type ${frame.dataType}: ${toHex(frame.data)}`);
      return;
    }
    const unread =
      this.focused === message.conversation
        ? this.state.unread
        : { ...this.state.unread, [message.conversation]: (this.state.unread[message.conversation] ?? 0) + 1 };
    this.set({ messages: [...this.state.messages, message], unread });
    for (const listener of this.receivedListeners) {
      try {
        listener(message);
      } catch (error) {
        console.error("received listener threw", error);
      }
    }
    if (frame.kind === "channelMessage") {
      void this.findChannelCopies(message.id, frame.channelIndex, frame.timestamp, frame.txtType, frame.text);
    } else if (frame.pathLen !== null && message.senderPrefix) {
      this.findDirectCopies(message.id, toHex(frame.senderPrefix), frame.pathLen);
    }
  }

  // ---- the copies the radio heard ----
  //
  // The radio hands up a message with its hop count only; the path it took is
  // in the packet, which the radio also hands up whole (`logRxData`) as it
  // hears it, a moment before the message itself, and once more for every
  // other copy a repeater sends its way. Those packets are kept for a little
  // while and matched to messages: a channel message by its payload, which
  // can be worked out exactly; a direct message, sealed with a key this side
  // does not hold, by who it is to and from and how far it came.

  private async findChannelCopies(id: string, channelIndex: number, timestamp: number, txtType: number, text: string): Promise<void> {
    const channel = this.state.channels.find((c) => c.index === channelIndex);
    if (!channel) return;
    try {
      const payload = await heardGroupTextPayload(fromHex(channel.secret), timestamp, txtType, text);
      this.adoptCopies(id, toHex(payload));
    } catch (error) {
      this.log("echo", `cannot work out the payload: ${(error as Error).message}`);
    }
  }

  /** A flooded direct message: its packet names us and the sender by their first key byte, and came as many hops. */
  private findDirectCopies(id: string, senderPrefix: string, hops: number): void {
    const self = this.state.self;
    if (!self) return;
    const to = parseInt(self.key.slice(0, 2), 16);
    const from = parseInt(senderPrefix.slice(0, 2), 16);
    const now = this.now();
    const first = this.heard.find(
      (h) =>
        now - h.at <= DM_MATCH_MS &&
        h.packet.payloadType === PayloadType.TxtMsg &&
        h.packet.path.length === hops &&
        h.packet.payload[0] === to &&
        h.packet.payload[1] === from &&
        !this.claimed.has(h.hex),
    );
    if (!first) return;
    this.claimed.add(first.hex);
    this.adoptCopies(id, first.hex);
  }

  /** Every copy of this payload heard so far goes on the message, and later ones will. */
  private adoptCopies(id: string, hex: string): void {
    const now = this.now();
    this.pruneWatch(now);
    this.echoWatch.set(hex, { id, at: now, incoming: true });
    for (const h of this.heard) if (h.hex === hex) this.addEcho(id, h.packet.path, h.snr);
  }

  private pruneWatch(now: number): void {
    for (const [key, watch] of this.echoWatch) {
      if (now - watch.at > (watch.incoming ? IN_ECHO_WINDOW_MS : ECHO_WINDOW_MS)) this.echoWatch.delete(key);
    }
  }

  private addEcho(id: string, path: string[], snr: number): void {
    const message = this.state.messages.find((m) => m.id === id);
    if (!message) return;
    const key = path.join(",");
    if (message.echoes.some((e) => e.path.join(",") === key)) return;
    const patch: Partial<MessageRecord> = { echoes: [...message.echoes, { path, snr }] };
    if (message.direction === "out") {
      // Someone sent it on after all: the window is over, an alarm already
      // raised is taken back, and a loop has nothing left to try for.
      const timer = this.silenceTimers.get(id);
      if (timer) clearTimeout(timer);
      this.silenceTimers.delete(id);
      if (message.status === "unheard") patch.status = "sent";
      if (message.retryPlan) patch.retryPlan = null;
    }
    this.patchMessage(id, patch);
  }

  private patchMessage(id: string, patch: Partial<MessageRecord>): void {
    const messages = this.state.messages.map((m) => (m.id === id ? { ...m, ...patch } : m));
    this.set({ messages });
  }

  /**
   * Sends text to a conversation and records it; the record's status follows
   * the ack. `original` is what was typed, when `text` was reworked to fit.
   * `flood` drops a contact's route first, so that this message floods. With
   * the radio away the message is queued, and goes out once it is back.
   */
  async sendText(conversation: string, text: string, options: { original?: string; flood?: boolean } = {}): Promise<MessageRecord> {
    const target = parseConversation(conversation);
    if (target.kind === "prefix") throw new Error("this sender is not in the contacts yet");
    const client = this.isReady ? this.client : null;
    const now = this.now();
    const message: MessageRecord = {
      id: newId(now),
      conversation,
      direction: "out",
      text,
      sender: this.state.self?.name ?? null,
      senderPrefix: this.state.self?.prefix ?? null,
      timestamp: Math.floor(now / 1000),
      receivedAt: now,
      snr: null,
      hops: null,
      txtType: TxtType.Plain,
      status: client ? "sending" : "queued",
      ackTag: null,
      roundTripMs: null,
      // A queued message keeps the wish to flood here until it goes; the send then says how it went.
      flood: !client && options.flood ? true : null,
      attempt: 0,
      error: null,
      echoes: [],
      route: null,
      retryPlan: null,
      ...(options.original !== undefined && options.original !== text ? { original: options.original } : {}),
    };
    this.set({ messages: [...this.state.messages, message] });
    if (!client) return message;
    await this.transmit(client, message, target, options.flood ? "flood asked for" : false);
    return this.state.messages.find((m) => m.id === message.id) ?? message;
  }

  /**
   * Sends what was written while the radio was away, oldest first. A new
   * message goes out stamped with the moment it is sent: the others sort by
   * the sender's clock, and an hour-old stamp would file it an hour back in
   * their chats. A retry keeps its stamp, being the same message again.
   */
  private async flushQueue(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      let last = 0;
      for (;;) {
        const client = this.isReady ? this.client : null;
        const next = this.state.messages.find((m) => m.status === "queued");
        if (!client || !next) return;
        // A retry keeps its stamp, except on a channel, where the same stamp is the same packet (see `retry`).
        const keep = next.attempt > 0 && parseConversation(next.conversation).kind !== "channel";
        const timestamp = keep ? next.timestamp : Math.max(Math.floor(this.now() / 1000), last + 1, next.timestamp + (next.attempt > 0 ? 1 : 0));
        last = timestamp;
        this.patchMessage(next.id, { status: "sending", timestamp, ...(next.attempt > 0 ? { sentAt: Math.max(Math.floor(this.now() / 1000), timestamp) } : {}) });
        try {
          await this.transmit(client, { ...next, timestamp }, parseConversation(next.conversation), next.flood === true ? "flood asked for" : false);
        } catch {
          // The record says it failed; the rest still go.
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Takes back a message still waiting for the radio. */
  discardQueued(id: string): void {
    const messages = this.state.messages.filter((m) => !(m.id === id && m.status === "queued"));
    if (messages.length !== this.state.messages.length) this.set({ messages });
  }

  /**
   * Forgets one of ours that failed, went unheard or unconfirmed, or is being
   * tried in a loop, which stops with it. Only here: a copy that did reach
   * someone stays with them.
   */
  discardFailed(id: string): void {
    const message = this.state.messages.find((m) => m.id === id);
    if (!message || message.direction !== "out") return;
    if (message.status !== "failed" && message.status !== "unheard" && message.status !== "unconfirmed" && !message.retryPlan) return;
    for (const timers of [this.ackTimers, this.silenceTimers]) {
      const timer = timers.get(id);
      if (timer) clearTimeout(timer);
      timers.delete(id);
    }
    this.set({ messages: this.state.messages.filter((m) => m.id !== id) });
  }

  /**
   * Sends an unheard, unconfirmed or failed message again, one attempt up. A direct
   * message that went unacknowledged along a learned route floods this time:
   * the route is the likeliest thing to have broken.
   */
  async retry(id: string): Promise<void> {
    const message = this.state.messages.find((m) => m.id === id);
    if (!message || message.direction !== "out") throw new Error("not an outgoing message");
    const attempt = message.attempt + 1;
    const flood = message.status === "unconfirmed" && message.flood === false;
    const past = message.ackTag === null ? {} : { pastAckTags: [...(message.pastAckTags ?? []), message.ackTag] };
    if (!this.isReady) {
      // It goes again with the queue, once the radio is back.
      this.patchMessage(id, { status: "queued", error: null, attempt, ackTag: null, roundTripMs: null, route: null, flood: flood ? true : null, ...past });
      return;
    }
    const client = this.need();
    const target = parseConversation(message.conversation);
    // A channel message goes out with a fresh stamp. Its packet is the text,
    // the sender and the stamp, and a repeater drops a packet it has carried
    // before: sent again to the byte, the copy would be thrown away by every
    // repeater that did hear the first one.
    const timestamp = target.kind === "channel" ? Math.max(Math.floor(this.now() / 1000), message.timestamp + 1) : message.timestamp;
    const sentAt = Math.max(Math.floor(this.now() / 1000), timestamp);
    this.patchMessage(id, { status: "sending", error: null, attempt, timestamp, sentAt, ackTag: null, roundTripMs: null, route: null, ...past });
    await this.transmit(client, { ...message, attempt, timestamp }, target, flood ? "no acknowledgement" : false);
  }

  /**
   * Sends one of ours again as the user asks: a direct message whose tries
   * were spent or stopped starts a fresh run of them, the rest go once more.
   */
  async sendAgain(id: string): Promise<void> {
    const message = this.state.messages.find((m) => m.id === id);
    if (message?.retryPlan && message.retryPlan.made >= message.retryPlan.total) this.patchMessage(id, { retryPlan: null });
    await this.retry(id);
  }

  /** How many tries a direct message gets before it is given up on; 1 sends it once and leaves the rest to the user. */
  setSendTries(tries: number): void {
    this.sendTries = Math.max(1, Math.floor(tries));
  }

  /** The gaps between the tries of a direct message, so the app can say how long they take. */
  get directRetryLadder(): readonly number[] {
    return DIRECT_LADDER_MS;
  }

  /** Whether a retry of this message will drop the route and flood. */
  retryFloods(message: MessageRecord): boolean {
    return message.direction === "out" && message.status === "unconfirmed" && message.flood === false && message.conversation.startsWith("c:");
  }

  /** `dropRoute`, when given, is why a contact's route is dropped before the send, so that it floods. */
  private async transmit(
    client: MeshCoreClient,
    message: MessageRecord,
    target: ReturnType<typeof parseConversation>,
    dropRoute: string | false = false,
  ): Promise<void> {
    try {
      if (target.kind === "channel") {
        await this.watchEchoes(message, target.index);
        await client.sendChannelTextMessage(target.index, message.text, {
          timestamp: message.timestamp,
          ...(this.state.self ? { senderName: this.state.self.name } : {}),
        });
        this.patchMessage(message.id, { status: "sent" });
        this.armSilence(message.id);
        return;
      }
      if (target.kind !== "contact") throw new Error("unreachable");
      const contact = this.state.contacts[target.key];
      if (!contact) throw new Error("unknown contact");
      // The sweep runs every half minute and a phone may have slept through
      // it, so a route past its time is caught here too.
      const reason = contact.outPathLen === 0xff ? null : dropRoute || this.staleReason(contact);
      if (reason) {
        try {
          await this.dropRoute(client, contact.key, reason);
        } catch (error) {
          this.log("error", `could not drop the route to ${contact.name}: ${(error as Error).message}`);
        }
      }
      const route = contactRoute(this.state.contacts[target.key] ?? contact);
      // Past the fourth attempt the firmware hides the attempt number in two
      // bytes after the text, which a text this long has no room for, and
      // refuses the send; such a text goes round its four attempts again.
      const long = new TextEncoder().encode(message.text).length > MAX_TEXT_LEN - 2;
      const result = await client.sendTextMessage(fromHex(contact.prefix), message.text, {
        attempt: long && message.attempt > 3 ? message.attempt & 3 : message.attempt,
        timestamp: message.timestamp,
      });
      // An earlier try's acknowledgement came while this one was going out: the text is there already.
      if (this.state.messages.find((m) => m.id === message.id)?.status === "delivered") return;
      this.armAck(message.id, result, result.flood ? null : route);
    } catch (error) {
      this.patchMessage(message.id, { status: "failed", error: (error as Error).message });
      throw error;
    }
  }

  /**
   * Works out what the radio will put on the air for this message, so that
   * the copies repeaters send back can be told from everyone else's packets.
   * Done before the send: the first echo can be back within a second.
   */
  private async watchEchoes(message: MessageRecord, channelIndex: number): Promise<void> {
    const channel = this.state.channels.find((c) => c.index === channelIndex);
    if (!channel || !this.state.self) return;
    try {
      const payload = await groupTextPayload(fromHex(channel.secret), message.timestamp, this.state.self.name, message.text);
      const now = this.now();
      this.pruneWatch(now);
      this.echoWatch.set(toHex(payload), { id: message.id, at: now, incoming: false });
    } catch (error) {
      this.log("echo", `cannot work out the payload: ${(error as Error).message}`);
    }
  }

  /**
   * A text packet the radio heard: kept a while for a message that has not been
   * handed up yet, and added to one already known, ours coming back from a
   * repeater or another copy of one that came in.
   */
  private noteHeard(snr: number, raw: Uint8Array): void {
    const packet = parseRawPacket(raw);
    if (!packet || !packet.flood || (packet.payloadType !== PayloadType.GroupText && packet.payloadType !== PayloadType.TxtMsg)) return;
    const now = this.now();
    const hex = toHex(packet.payload);
    const kept = this.heard.filter((h) => now - h.at <= HEARD_WINDOW_MS);
    this.heard = [...kept.slice(-(HEARD_LIMIT - 1)), { at: now, snr, packet, hex }];
    for (const c of this.claimed) if (!this.heard.some((h) => h.hex === c)) this.claimed.delete(c);
    const watch = this.echoWatch.get(hex);
    if (!watch) return;
    // Ours is never heard from us: a copy with no relays in it is not an echo.
    if (!watch.incoming && packet.path.length === 0) return;
    this.addEcho(watch.id, packet.path, snr);
  }

  /**
   * A channel message has no acknowledgement, so the only word that it went
   * anywhere is a repeater sending it on. Nothing heard within the window and
   * the message is called unheard: not proof it was missed, since a neighbour
   * in direct range answers nothing, but the only sign the radio can give.
   */
  private armSilence(id: string): void {
    const previous = this.silenceTimers.get(id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.silenceTimers.delete(id);
      const current = this.state.messages.find((m) => m.id === id);
      if (current?.status !== "sent" || current.echoes.length > 0) return;
      this.patchMessage(id, { status: "unheard" });
    }, SILENCE_MS);
    (timer as { unref?: () => void }).unref?.();
    this.silenceTimers.set(id, timer);
  }

  /**
   * Sends a message again and again until a repeater is heard sending it on.
   * The first send goes at once; the rest follow the ladder. One loop runs per
   * conversation: a second would only double what the air carries.
   */
  async keepTrying(id: string): Promise<void> {
    const message = this.state.messages.find((m) => m.id === id);
    if (!message || message.direction !== "out") throw new Error("not an outgoing message");
    for (const other of this.state.messages) {
      if (other.id !== id && other.retryPlan && other.conversation === message.conversation) this.patchMessage(other.id, { retryPlan: null });
    }
    this.patchMessage(id, { retryPlan: { made: 0, total: RETRY_LADDER_MS.length, nextAt: this.now() } });
    await this.sendUnderPlan(id);
  }

  /**
   * Stops a loop; what it has already sent stays as it is. A direct message
   * keeps its plan, cut to the tries made: with none, going unanswered would
   * start a fresh run of them.
   */
  stopTrying(id: string): void {
    const message = this.state.messages.find((m) => m.id === id);
    const plan = message?.retryPlan;
    if (!message || !plan) return;
    if (isDirect(message)) this.patchMessage(id, { retryPlan: { ...plan, total: plan.made, nextAt: null } });
    else this.patchMessage(id, { retryPlan: null });
  }

  /** How many sends a loop makes, so the app can say so before one is started. */
  get retryLadder(): readonly number[] {
    return RETRY_LADDER_MS;
  }

  /** One send of a loop, counted and dated before it goes. */
  private async sendUnderPlan(id: string): Promise<void> {
    const message = this.state.messages.find((m) => m.id === id);
    const plan = message?.retryPlan;
    if (!message || !plan || plan.made >= plan.total) return;
    if (!this.isReady) {
      // The radio is away: the attempt is not spent, and the loop goes on once it is back.
      if (plan.nextAt !== null) this.patchMessage(id, { retryPlan: { ...plan, nextAt: null } });
      return;
    }
    const made = plan.made + 1;
    const ladder = isDirect(message) ? DIRECT_LADDER_MS : RETRY_LADDER_MS;
    const gap = ladder[made] ?? ladder.at(-1) ?? 0;
    const jittered = this.now() + Math.round(gap * (0.8 + Math.random() * 0.4));
    this.patchMessage(id, { retryPlan: { ...plan, made, nextAt: made >= plan.total ? null : jittered } });
    try {
      await this.retry(id);
    } catch (error) {
      this.log("retry", `send ${made} of ${plan.total} failed: ${(error as Error).message}`);
    }
  }

  /**
   * Sends whatever loop is due; run from the sweep while the radio is here. A
   * direct message still waiting for its acknowledgement waits it out first.
   */
  private async sweepRetries(): Promise<void> {
    if (!this.isReady) return;
    const isDue = (m: MessageRecord | undefined): m is MessageRecord =>
      !!m &&
      !!m.retryPlan &&
      m.retryPlan.nextAt !== null &&
      m.retryPlan.nextAt <= this.now() &&
      m.retryPlan.made < m.retryPlan.total &&
      m.status !== "sending" &&
      m.status !== "queued" &&
      m.status !== "delivered" &&
      !this.ackTimers.has(m.id);
    const due = this.state.messages.filter(isDue).map((m) => m.id);
    // Asked again before each send: another sweep may have sent one while this one waited on the radio.
    for (const id of due) if (isDue(this.state.messages.find((m) => m.id === id))) await this.sendUnderPlan(id);
  }

  /**
   * A direct message that went unanswered goes again on its own, as many
   * times as the app allows; the first time it does, a plan is made for it.
   */
  private tryAgainOnItsOwn(id: string): void {
    const message = this.state.messages.find((m) => m.id === id);
    if (!message || !isDirect(message)) return;
    if (!message.retryPlan) {
      if (this.sendTries < 2) return;
      this.patchMessage(id, { retryPlan: { made: 1, total: this.sendTries, nextAt: this.now() } });
    }
    void this.sweepRetries();
  }

  /** The link dropped: the loops stop counting down until it is back. */
  private holdRetryPlans(): void {
    const messages = this.state.messages.map((m) => (m.retryPlan && m.retryPlan.nextAt !== null ? { ...m, retryPlan: { ...m.retryPlan, nextAt: null } } : m));
    if (messages.some((m, i) => m !== this.state.messages[i])) this.set({ messages });
  }

  /** The radio is back: a loop with sends left goes on from where it stopped. */
  private resumeRetryPlans(): void {
    const now = this.now();
    const messages = this.state.messages.map((m) =>
      m.retryPlan && m.retryPlan.nextAt === null && m.retryPlan.made < m.retryPlan.total ? { ...m, retryPlan: { ...m.retryPlan, nextAt: now } } : m,
    );
    if (messages.some((m, i) => m !== this.state.messages[i])) this.set({ messages });
  }

  /** `route` is the path a direct message was sent along; a flood learns its own from the ack. */
  private armAck(id: string, result: TextSendResult, route: string[] | null = null): void {
    if (result.ackTag === 0) {
      this.patchMessage(id, { status: "sent", flood: result.flood, ackTag: null, route });
      return;
    }
    this.patchMessage(id, { status: "sent", flood: result.flood, ackTag: result.ackTag, route });
    const wait = Math.max(result.estTimeoutMs, 4000) * 1.5;
    const timer = setTimeout(() => {
      this.ackTimers.delete(id);
      const current = this.state.messages.find((m) => m.id === id);
      if (current?.status !== "sent") return;
      this.patchMessage(id, { status: "unconfirmed" });
      this.tryAgainOnItsOwn(id);
    }, wait);
    const previous = this.ackTimers.get(id);
    if (previous) clearTimeout(previous);
    this.ackTimers.set(id, timer);
  }

  /**
   * A text the other app sharing the radio sent (the phone's relay tells the
   * one what the other sent): kept as ours, as if sent from here, so both show
   * the whole conversation. Its acknowledgement reaches both, so a direct
   * message is marked delivered here too. The same text again, a retry, is
   * the same message.
   *
   * The relay keeps what was sent while this app was away, and hands it over
   * ahead of the next message this app reads: one that comes during a sync
   * went out long ago. What came of it only the other app saw, so it is kept
   * as sent, not waited on for an echo or an ack that will not come again.
   */
  private mirrored(command: Uint8Array, answer: Uint8Array): void {
    try {
      const r = new ByteReader(command);
      const code = r.u8();
      if (code !== Cmd.SendTxtMsg && code !== Cmd.SendChannelTxtMsg) return;
      if (r.u8() !== TxtType.Plain) return;
      const late = this.state.syncing;
      let conversation: string;
      let contact: ContactRecord | undefined;
      let attempt = 0;
      if (code === Cmd.SendTxtMsg) {
        attempt = r.u8();
        const timestamp = r.u32();
        const prefix = toHex(r.take(PUB_KEY_PREFIX_SIZE));
        contact = Object.values(this.state.contacts).find((c) => c.prefix === prefix);
        if (!contact) return;
        conversation = contactConversation(contact.key);
        this.keepMirrored(conversation, timestamp, r.restString(), attempt, late, (id) => {
          const sent = decodeFrame(answer);
          if (sent.kind === "sent") this.armAck(id, sent, sent.flood ? null : contactRoute(contact!));
          else this.patchMessage(id, { status: "sent" });
        });
      } else {
        const index = r.u8();
        const timestamp = r.u32();
        conversation = channelConversation(index);
        const text = r.restString();
        this.keepMirrored(conversation, timestamp, text, attempt, late, (id, fresh) => {
          this.patchMessage(id, { status: "sent" });
          if (fresh) {
            const message = this.state.messages.find((m) => m.id === id);
            if (message) void this.watchEchoes(message, index);
          }
          this.armSilence(id);
        });
      }
    } catch (error) {
      this.log("error", `could not read what the other app sent: ${(error as Error).message}`);
    }
  }

  /**
   * `fresh` says the packet is new to us: a message we did not have, or a
   * channel retry, which goes with a new stamp and so is a different packet.
   */
  private keepMirrored(conversation: string, timestamp: number, text: string, attempt: number, late: boolean, sent: (id: string, fresh: boolean) => void): void {
    const same = (m: MessageRecord) => m.direction === "out" && m.conversation === conversation && m.text === text;
    // A direct retry keeps its stamp. A channel retry carries a new one and
    // no attempt count, so it is known by being the same text as ours that
    // nobody was heard sending on: the one the other app was offered to send again.
    const known =
      this.state.messages.find((m) => same(m) && Math.abs(m.timestamp - timestamp) <= 2) ??
      this.state.messages.findLast(
        (m) => same(m) && m.timestamp < timestamp && m.echoes.length === 0 && m.status !== "delivered" && m.status !== "sending",
      );
    if (known) {
      const again = known.timestamp !== timestamp || attempt > known.attempt;
      if (late) {
        // Sent again while this app was away: moved to when it went, its outcome unknown here.
        if (again) {
          this.patchMessage(known.id, {
            timestamp,
            attempt: Math.max(known.attempt, attempt),
            error: null,
            ...(known.timestamp !== timestamp ? { sentAt: timestamp } : {}),
            ...(known.status === "delivered" ? {} : { status: "sent" as const }),
          });
        }
        return;
      }
      this.patchMessage(known.id, {
        timestamp,
        attempt: Math.max(known.attempt, attempt),
        error: null,
        ackTag: null,
        roundTripMs: null,
        ...(again ? { sentAt: Math.max(Math.floor(this.now() / 1000), timestamp) } : {}),
      });
      sent(known.id, known.timestamp !== timestamp);
      return;
    }
    const now = this.now();
    const message: MessageRecord = {
      id: newId(now),
      conversation,
      direction: "out",
      text,
      sender: this.state.self?.name ?? null,
      senderPrefix: this.state.self?.prefix ?? null,
      timestamp,
      receivedAt: now,
      snr: null,
      hops: null,
      txtType: TxtType.Plain,
      status: late ? "sent" : "sending",
      ackTag: null,
      roundTripMs: null,
      flood: null,
      attempt,
      error: null,
      echoes: [],
      route: null,
      retryPlan: null,
    };
    this.set({ messages: [...this.state.messages, message] });
    if (!late) sent(message.id, true);
  }

  /** How many bytes of text a message to this conversation may carry. */
  textBudget(conversation: string): number {
    const target = parseConversation(conversation);
    if (target.kind !== "channel") return MAX_TEXT_LEN;
    const name = this.state.self?.name ?? "";
    return MAX_TEXT_LEN - new TextEncoder().encode(name).length - 2;
  }

  // ---- the radio's own settings ----

  async setName(name: string): Promise<void> {
    await this.need().setAdvertName(name);
    if (this.state.self) this.set({ self: { ...this.state.self, name } });
  }

  async setLocation(lat: number, lon: number): Promise<void> {
    await this.need().setAdvertLatLon(lat, lon);
    if (this.state.self) this.set({ self: { ...this.state.self, lat, lon } });
  }

  async setRadioParams(params: RadioParams): Promise<void> {
    await this.need().setRadioParams(params);
    if (this.state.self) {
      this.set({
        self: {
          ...this.state.self,
          frequencyKhz: params.frequencyKhz,
          bandwidthHz: params.bandwidthHz,
          spreadingFactor: params.spreadingFactor,
          codingRate: params.codingRate,
        },
      });
    }
  }

  async setTxPower(dbm: number): Promise<void> {
    await this.need().setRadioTxPower(dbm);
    if (this.state.self) this.set({ self: { ...this.state.self, txPower: dbm } });
  }

  async setOtherParams(params: OtherParams): Promise<void> {
    await this.need().setOtherParams(params);
    if (this.state.self) {
      this.set({
        self: {
          ...this.state.self,
          manualAddContacts: params.manualAddContacts,
          telemetryModeBase: params.telemetryModeBase,
          telemetryModeLocation: params.telemetryModeLocation,
          telemetryModeEnvironment: params.telemetryModeEnvironment,
          advertLocPolicy: params.advertLocPolicy,
          multiAcks: params.multiAcks,
        },
      });
    }
  }

  async refreshTuning(): Promise<void> {
    const tuning = await this.need().getTuningParams();
    this.set({ tuning });
  }

  async setTuning(rxDelayBase: number, airtimeFactor: number): Promise<void> {
    await this.need().setTuningParams(rxDelayBase, airtimeFactor);
    this.set({ tuning: { rxDelayBase, airtimeFactor } });
  }

  async sendAdvert(flood: boolean): Promise<void> {
    await this.need().sendSelfAdvert(flood);
    this.log("advert", flood ? "advert flooded" : "advert sent zero-hop");
  }

  async refreshBattery(): Promise<void> {
    try {
      const { batteryMv } = await this.need().getBattAndStorage();
      this.set({ battery: { mv: batteryMv, at: this.now() }, ...this.noteBattery("self", batteryMv) });
    } catch (error) {
      this.log("error", `battery: ${(error as Error).message}`);
    }
  }

  async reboot(): Promise<void> {
    await this.need().reboot();
  }

  async factoryReset(): Promise<void> {
    await this.need().factoryReset();
  }

  // ---- diagnostics ----
  //
  // A trace goes out along a path of hashes, each repeater on it adding how
  // well it heard the one before, and the radio hands it up when it gets back.
  // It takes no place in the queue for remote nodes below: the radio keeps no
  // pending request for it, only its tag. Nothing here goes out unless asked.

  /**
   * What a trace to this contact goes along: the relays of its route, and the
   * contact itself when it relays too. A repeater nobody has written to has
   * no route, but its adverts came in along one. Null when neither is known.
   */
  async pingPath(key: string): Promise<{ relays: string[]; target: string | null } | null> {
    const contact = this.needContact(key);
    let relays = contactRoute(contact);
    if (relays === null && contact.type === AdvType.Repeater && this.isReady) {
      try {
        const advert = await this.need().getAdvertPath(fromHex(key));
        relays = pathHashes(advert.pathLen, advert.path).reverse();
      } catch {
        relays = null;
      }
    }
    if (relays === null) return null;
    const size = relays[0] ? relays[0].length / 2 : (this.state.device?.pathHashMode ?? 0) + 1;
    return { relays, target: contact.type === AdvType.Repeater ? key.slice(0, size * 2) : null };
  }

  /**
   * One trace out along `hashes` and back: the same way, or through
   * `homeVia`, the relays from the last of `hashes` home, nearest it first. The radio
   * does not care which way a trace comes back, only that it ends in range.
   * Resolves with how it came back, or null when it did not in time.
   *
   * The time is worked out from the radio's own settings (`traceBudgetMs`):
   * the radio's estimate allows six airtimes a hop where a hop takes at most
   * about two and a half, so a lost trace would be waited on three times as
   * long as it needs. Should one come back later all the same, up to the
   * radio's estimate, `onLate` hears it.
   */
  async traceRoute(hashes: string[], homeVia?: string[], onLate?: (result: TraceResult) => void): Promise<TraceResult | null> {
    if (hashes.length === 0) throw new Error("nothing to trace");
    const client = this.need();
    const home = homeVia ?? hashes.slice(0, -1).reverse();
    // A trace sizes its hashes in powers of two; a three-byte route is traced on two.
    const shortest = Math.min(...[...hashes, ...home].map((h) => h.length / 2));
    const size = shortest >= 4 ? 4 : shortest >= 2 ? 2 : 1;
    const path = [...hashes, ...home].map((h) => h.slice(0, size * 2));
    const tag = randomU32();
    let arrive: (frame: Extract<PushFrame, { kind: "traceData" }>) => void = () => undefined;
    const back = new Promise<Extract<PushFrame, { kind: "traceData" }>>((resolve) => (arrive = resolve));
    this.traceWaiters.set(tag, (frame) => arrive(frame));
    let timer: ReturnType<typeof setTimeout> | null = null;
    let listening = false;
    try {
      const sent = await client.sendTracePath(tag, 0, Math.log2(size), fromHex(path.join("")));
      const started = this.now();
      const self = this.state.self;
      const budget = self && self.bandwidthHz > 0 ? Math.min(sent.estTimeoutMs, traceBudgetMs(path.length, size, self)) : sent.estTimeoutMs * 1.2 + 500;
      const wait = this.traceWait(budget);
      const frame = await Promise.race([back, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), wait)))]);
      if (!frame) {
        this.log("trace", `${path.join(" ")}: no answer in ${(wait / 1000).toFixed(1)} s`);
        const lateFor = sent.estTimeoutMs * 1.2 + 500 - wait;
        if (onLate && lateFor > 0) {
          // Still listened for, up to the radio's own estimate.
          listening = true;
          const giveUp = setTimeout(() => this.traceWaiters.delete(tag), lateFor);
          this.traceWaiters.set(tag, (late) => {
            clearTimeout(giveUp);
            this.traceWaiters.delete(tag);
            const rttMs = Math.max(0, this.now() - started);
            this.log("trace", `${path.join(" ")}: back late, in ${rttMs} ms`);
            onLate({ rttMs, snrs: late.snrs });
          });
        }
        return null;
      }
      const rttMs = Math.max(0, this.now() - started);
      this.log("trace", `${path.join(" ")}: back in ${rttMs} ms, snr ${frame.snrs.map((x) => x.toFixed(2)).join(" / ")}`);
      return { rttMs, snrs: frame.snrs };
    } finally {
      if (timer) clearTimeout(timer);
      if (!listening) this.traceWaiters.delete(tag);
    }
  }

  /**
   * Asks the repeaters in direct range how well they hear this radio, and
   * listens for `listenMs`. Each answers after a random pause, and no more
   * than four times in two minutes; `onReply` hears each answer as it comes.
   */
  async discoverRepeaters(listenMs = 10_000, onReply?: (reply: DiscoverReply) => void): Promise<DiscoverReply[]> {
    const client = this.need();
    const tag = randomU32();
    const replies = new Map<string, DiscoverReply>();
    const listener = (frame: Extract<PushFrame, { kind: "controlData" }>) => {
      const p = frame.payload;
      if (p.length < 14 || (p[0]! & 0xf0) !== ControlType.NodeDiscoverResp) return;
      if ((p[2]! | (p[3]! << 8) | (p[4]! << 16) | (p[5]! << 24)) >>> 0 !== tag) return;
      const hex = toHex(p.subarray(6));
      const contact = Object.values(this.state.contacts).find((c) => c.key.startsWith(hex)) ?? null;
      const reply: DiscoverReply = {
        key: contact?.key ?? hex,
        known: contact !== null,
        type: p[0]! & 0x0f,
        heardUs: ((p[1]! << 24) >> 24) / 4,
        heardThem: frame.snr,
        rssi: frame.rssi,
        at: this.now(),
      };
      replies.set(reply.key, reply);
      onReply?.(reply);
    };
    this.controlListeners.add(listener);
    try {
      await client.sendControlData(nodeDiscoverRequest(tag, 1 << AdvType.Repeater));
      this.log("discover", "asked who hears this radio");
      await new Promise((resolve) => setTimeout(resolve, listenMs));
    } finally {
      this.controlListeners.delete(listener);
    }
    this.log("discover", `${replies.size} repeater(s) answered`);
    return [...replies.values()];
  }

  /** The radio's own uptime and battery. Asked of the radio, not of the air. */
  async coreStats(): Promise<CoreStats> {
    const frame = await this.need().getStats(StatsType.Core);
    if (frame.kind !== "statsCore") throw new Error(`core stats: the radio answered ${frame.kind}`);
    return { batteryMv: frame.batteryMv, uptimeSecs: frame.uptimeSecs, at: this.now() };
  }

  /** The radio's own receiver: its noise floor, and how long it has been on the air. Asked of the radio, not of the air. */
  async radioStats(): Promise<RadioStats> {
    const frame = await this.need().getStats(StatsType.Radio);
    if (frame.kind !== "statsRadio") throw new Error(`radio stats: the radio answered ${frame.kind}`);
    const { noiseFloor, lastRssi, lastSnr, txAirSecs, rxAirSecs } = frame;
    return { noiseFloor, lastRssi, lastSnr, txAirSecs, rxAirSecs, at: this.now() };
  }

  /** The radio's settings for its sensors, such as whether its own GPS is on (`gps` is "1"). Asked of the radio, not of the air. */
  customVars(): Promise<Record<string, string>> {
    return this.need().getCustomVars();
  }

  // ---- repeaters, rooms and sensors ----
  //
  // The radio keeps one request to a remote node pending at a time: each new
  // login, status, telemetry, path or binary request makes it forget the
  // last (`clearPendingReqs`), and a reply nobody is waiting for is dropped.
  // So they go through one queue here, each waiting for its reply or for the
  // time the radio estimated before the next is sent. Console commands do not
  // take the radio's slot, but they share the air and queue here all the same.
  // Each goes once: the reader sends it again.

  private needContact(key: string): ContactRecord {
    const contact = this.state.contacts[key];
    if (!contact) throw new Error("unknown contact");
    return contact;
  }

  /** Signs in. Resolves with what the node said, `ok: false` when it refused the password. */
  async login(key: string, password: string): Promise<NodeLogin> {
    const contact = this.needContact(key);
    const bytes = fromHex(key);
    await this.remoteRequest(
      key,
      "sign in",
      (client) => client.sendLogin(bytes, password),
      (event) => event.kind === "login" && event.prefix === contact.prefix,
    );
    return this.state.logins[key]!;
  }

  /**
   * Makes a node learn the way back to this radio anew, and signs in. A node
   * answers along a route it holds for us, learned from a path packet our radio
   * once sent it, and keeps it however stale it gets: then every request of
   * ours reaches it and every answer is lost, while a check of the route, which
   * comes back the way we choose, still passes. A sign-in that reaches it as a
   * flood makes it forget that route and answer by flood. So the sign-in goes
   * as a flood, and our own route to the node is put back the moment it has
   * gone: when the flooded answer reaches us, our radio, holding a route to the
   * node, sends it the way that answer came, directly along ours. Resolves like
   * `login`.
   */
  async relearnReturnPath(key: string, password: string): Promise<NodeLogin> {
    const contact = this.needContact(key);
    const bytes = fromHex(key);
    const held = this.manualRoute(key) ?? (contact.outPathLen === 0xff ? null : { outPathLen: contact.outPathLen, outPath: contact.outPath });
    await this.remoteRequest(
      key,
      "sign in by flood",
      async (client) => {
        await client.resetPath(bytes);
        const sent = await client.sendLogin(bytes, password);
        const now = this.state.contacts[key] ?? contact;
        if (held) await this.writeContact({ ...now, ...held, pathSince: now.pathSince });
        return sent;
      },
      (event) => event.kind === "login" && event.prefix === contact.prefix,
    );
    const login = this.state.logins[key]!;
    this.log("path", `${contact.name || key.slice(0, 12)}: ${login.ok ? "signed in by flood; it now learns the way back" : "sign-in by flood refused"}`);
    return login;
  }

  /** Ends a room's keep-alive and forgets the role; the node keeps its own record of us. */
  async logout(key: string): Promise<void> {
    await this.need().logout(this.contactBytes(key));
    const logins = { ...this.state.logins };
    delete logins[key];
    this.set({ logins });
  }

  async requestStatus(key: string): Promise<NodeStatus> {
    const contact = this.needContact(key);
    const bytes = fromHex(key);
    await this.remoteRequest(
      key,
      "status",
      (client) => client.sendStatusReq(bytes),
      (event) => event.kind === "status" && event.prefix === contact.prefix,
    );
    return this.state.statuses[key]!;
  }

  /** Without a key, the radio's own sensors, answered at once and outside the queue. */
  async requestTelemetry(key?: string): Promise<LppReading[] | null> {
    if (!key) {
      await this.need().sendTelemetryReq();
      return null;
    }
    const contact = this.needContact(key);
    const bytes = fromHex(key);
    const event = await this.remoteRequest(
      key,
      "telemetry",
      (client) => client.sendTelemetryReq(bytes).then((sent) => sent!),
      (event) => event.kind === "telemetry" && event.prefix === contact.prefix,
    );
    return event.kind === "telemetry" ? event.readings : null;
  }

  /**
   * Floods a request to the node and resolves with the way it went there and
   * the way its answer came back. The radio keeps no route from a discovery,
   * so the way there, which has just worked, is written as the contact's
   * route here; not for a contact pinned to flood. A repeater or a room
   * answers only a radio signed in to it.
   */
  async discoverPath(key: string): Promise<PathFound> {
    const contact = this.needContact(key);
    const bytes = fromHex(key);
    const event = await this.remoteRequest(
      key,
      "path discovery",
      (client) => client.sendPathDiscoveryReq(bytes),
      (event) => event.kind === "path" && event.prefix === contact.prefix,
    );
    if (event.kind !== "path") throw new Error("unreachable");
    const held = this.state.contacts[key] ?? contact;
    const outPath = event.outPath.padEnd(128, "0");
    const changed = routeKey(held.outPathLen, held.outPath) !== routeKey(event.outPathLen, outPath);
    if (!(isConversationType(held.type) && this.routePolicy(key).flood) && this.isReady) {
      if (changed) {
        await this.writeContact({ ...held, outPathLen: event.outPathLen, outPath, pathSince: this.now() });
        this.log("path", `${held.name || key.slice(0, 12)}: route set from discovery, ${pathHashes(event.outPathLen, event.outPath).join(" ") || "direct"}`);
      } else {
        this.set({ contacts: { ...this.state.contacts, [key]: { ...held, pathSince: this.now() } } });
      }
    }
    return { out: pathHashes(event.outPathLen, event.outPath), back: pathHashes(event.inPathLen, event.inPath), changed };
  }

  /** A page of the repeaters a repeater hears direct. A page past the first is added to what was fetched. */
  async requestNeighbours(key: string, options: { order?: number; offset?: number; count?: number } = {}): Promise<NeighbourList> {
    const order = options.order ?? 0;
    const offset = options.offset ?? 0;
    const data = await this.binaryRequest(key, offset > 0 ? "more neighbours" : "neighbours", neighboursRequest({ order, offset, count: options.count ?? 10 }));
    const { total, neighbours } = readNeighbours(data);
    const page = neighbours.map((n) => ({ prefix: toHex(n.prefix), heardSecsAgo: n.heardSecsAgo, snr: n.snr }));
    const prior = this.state.neighbours[key];
    const list = offset > 0 && prior && prior.order === order ? [...prior.neighbours.slice(0, offset), ...page] : page;
    const record: NeighbourList = { total, order, neighbours: list, at: this.now() };
    this.set({ neighbours: { ...this.state.neighbours, [key]: record } });
    return record;
  }

  /**
   * Has a repeater call the repeaters it hears direct (`discover.neighbors`),
   * then reads its list once they have had time to answer. The repeater asks
   * zero hop, and each neighbour answers after a random pause; every one
   * that answers goes into the list as heard now, so the list is read newest
   * first. A neighbour with relaying off stays silent, and so does one that
   * has answered four searches in two minutes. `onCalled` hears how long the
   * wait for the answers is, once the repeater says it has called them.
   */
  async searchNeighbours(key: string, onCalled?: (waitMs: number) => void): Promise<NeighbourSearch> {
    const prior = this.state.neighbours[key];
    const reply = (await this.runCli(key, "discover.neighbors")).trim();
    if (!/^ok\b/i.test(reply)) throw new NodeCommandError(reply);
    const calledAt = this.now();
    const self = this.state.self;
    const wait = this.searchWait(self && self.bandwidthHz > 0 ? neighbourSearchMs(self) : 12_000);
    onCalled?.(wait);
    await new Promise((resolve) => setTimeout(resolve, wait));
    const list = await this.requestNeighbours(key, { order: NeighbourOrder.Newest });
    // The repeater says how long ago it heard each, by its own clock. It called them a
    // moment before its reply reached us, however long that reply took on the way back.
    const since = Math.ceil((this.now() - calledAt) / 1000) + 3;
    const answered = list.neighbours.filter((n) => n.heardSecsAgo <= since).map((n) => n.prefix);
    const known = new Set(prior?.neighbours.map((n) => n.prefix));
    const outside = answered.filter((prefix) => !known.has(prefix));
    // Of a list read only in part, an answer from outside that part may be an old neighbour
    // not fetched; they are new for certain only when the list grew by as many.
    const whole = prior !== undefined && prior.neighbours.length >= prior.total;
    const fresh = prior && (whole || outside.length <= list.total - prior.total) ? outside : null;
    this.log("neighbours", `${this.state.contacts[key]?.name || key.slice(0, 12)}: ${answered.length} answered a search, ${fresh ? fresh.length : "unknown how many"} new`);
    return { list, answered, fresh };
  }

  async requestAccessList(key: string): Promise<AccessRecord[]> {
    const data = await this.binaryRequest(key, "access list", accessListRequest());
    const entries = readAccessList(data).map((e) => ({ prefix: toHex(e.prefix), permissions: e.permissions }));
    this.set({ accessLists: { ...this.state.accessLists, [key]: { entries, at: this.now() } } });
    return entries;
  }

  async requestOwnerInfo(key: string): Promise<OwnerInfo> {
    const data = await this.binaryRequest(key, "owner info", ownerInfoRequest());
    const info: OwnerInfo = { ...readOwnerInfo(data), at: this.now() };
    this.set({ ownerInfo: { ...this.state.ownerInfo, [key]: info } });
    return info;
  }

  /** A sensor's min, max and mean of each series over the last `windowSecs`. */
  async requestSeries(key: string, windowSecs: number): Promise<SeriesWindow> {
    const data = await this.binaryRequest(key, "min/max/avg", avgMinMaxRequest(windowSecs, 0));
    const { time, series } = readAvgMinMax(data);
    const record: SeriesWindow = { windowSecs, time, series, at: this.now() };
    this.set({ series: { ...this.state.series, [key]: record } });
    return record;
  }

  private async binaryRequest(key: string, label: string, body: Uint8Array): Promise<Uint8Array> {
    this.needContact(key);
    const bytes = fromHex(key);
    const event = await this.remoteRequest(
      key,
      label,
      (client) => client.sendBinaryReq(bytes, body),
      (event, sent) => event.kind === "binary" && sent !== null && event.tag === sent.ackTag,
    );
    if (event.kind !== "binary") throw new Error("unreachable");
    return event.data;
  }

  /**
   * Runs a console command on a node and resolves with its reply. The node
   * answers admins only, and says nothing to a command whose stamp is not past
   * the last it had from us. `mask` is what the console shows in place of the
   * command and its reply, for a command that carries a password.
   */
  async runCli(key: string, command: string, options: { mask?: string } = {}): Promise<string> {
    const contact = this.needContact(key);
    const prefix = fromHex(contact.prefix);
    const tag = (this.cliTag++ & 0xff).toString(16).padStart(2, "0");
    if (options.mask) this.maskedTags.add(`${contact.prefix}:${tag}`);
    const entry: ConsoleEntry = {
      id: newId(this.now()),
      command: options.mask ?? command,
      tag,
      at: this.now(),
      status: "queued",
      reply: null,
      repliedAt: null,
      error: null,
    };
    this.appendConsole(key, entry);
    let sentAt = this.now();
    try {
      const event = await this.remoteRequest(
        key,
        options.mask ?? command,
        (client) => client.sendCliCommand(prefix, `${tag}|${command}`, this.cliStamp(key)),
        (event) => event.kind === "cli" && event.prefix === contact.prefix && event.tag === tag,
        {
          // The node holds a console reply back for about half a second.
          extraWaitMs: 1_500,
          onStart: () => {
            sentAt = this.now();
            this.patchConsole(key, entry.id, { status: "waiting", at: sentAt });
          },
        },
      );
      if (event.kind !== "cli") throw new Error("unreachable");
      this.noteClock(key, sentAt, event.stamp);
      const reply = event.text;
      this.patchConsole(key, entry.id, { status: "done", reply: options.mask ? maskReply(reply) : reply, repliedAt: this.now() });
      return reply;
    } catch (error) {
      this.patchConsole(key, entry.id, { status: error instanceof NoReplyError ? "timeout" : "failed", error: (error as Error).message });
      throw error;
    }
  }

  /** The stamp for a console command: this clock's second, but past any the node has had from us, which it would take for a repeat. */
  private cliStamp(key: string): number {
    const stamp = Math.max(Math.floor(this.now() / 1000), (this.cliStamps.get(key) ?? 0) + 1);
    this.cliStamps.set(key, stamp);
    return stamp;
  }

  /**
   * A node stamps each console reply with its own clock, to the second, as it answers. That
   * moment is taken as the middle of the round trip, so the way there and the way back mostly
   * cancel out and the reading is good to a second or two. It is kept on the sign-in, and only
   * for a node we are signed in to, since no other answers the console.
   */
  private noteClock(key: string, sentAt: number, stamp: number): void {
    const now = this.now();
    this.keepClock(key, { drift: Math.round((sentAt + now) / 2000 - stamp), at: now });
  }

  private keepClock(key: string, clock: ClockReading): void {
    const login = this.state.logins[key];
    if (login?.ok) this.set({ logins: { ...this.state.logins, [key]: { ...login, clock } } });
  }

  /** Reads a node's clock with `clock`: its reply's stamp is the reading, kept on the sign-in. */
  async checkNodeClock(key: string): Promise<void> {
    const reply = await this.runCli(key, "clock");
    if (isCliError(reply)) throw new NodeCommandError(reply);
  }

  /**
   * Sets a node's clock from ours with `clock sync`. The node moves its clock only forward, so
   * one that runs ahead answers "ERR: clock cannot go backwards", which throws a
   * `ClockAheadError`. The reply is stamped after the command, so it tells whether the clock took.
   */
  async syncNodeClock(key: string): Promise<void> {
    const reply = await this.runCli(key, "clock sync");
    if (/cannot go backwards/i.test(reply)) throw new ClockAheadError(reply);
    if (isCliError(reply)) throw new NodeCommandError(reply);
  }

  /**
   * `clkreboot`: the node puts its clock back to 15 May 2024 and restarts, the one way back for
   * a clock that runs ahead. It restarts before it can answer; once it is up, its clock can be
   * set from ours. Until then its clock is where the reset put it.
   */
  async resetNodeClock(key: string): Promise<void> {
    try {
      await this.runCli(key, "clkreboot");
    } catch (error) {
      if (!(error instanceof NoReplyError)) throw error;
    }
    const now = this.now();
    this.keepClock(key, { drift: Math.round(now / 1000) - CLOCK_RESET_TIME, at: now, reset: true });
  }

  /** `get <name>`, or another command whose reply is the value; remembered per node. */
  async readNodeSetting(key: string, name: string, command = `get ${name}`): Promise<string> {
    const reply = await this.runCli(key, command);
    if (isCliError(reply)) throw new NodeCommandError(reply);
    // `get` answers "> value"; a few commands (powersaving) answer the bare value.
    const value = cliValue(reply) ?? reply.trim();
    this.storeSetting(key, name, value);
    return value;
  }

  /** `set <name> <value>`, or the command given; the value is remembered when the node says OK. */
  async writeNodeSetting(key: string, name: string, value: string, command = `set ${name} ${value}`, options: { mask?: string } = {}): Promise<string> {
    const reply = await this.runCli(key, command, options);
    if (isCliError(reply)) throw new NodeCommandError(reply);
    if (!options.mask) this.storeSetting(key, name, value);
    return reply;
  }

  private storeSetting(key: string, name: string, value: string): void {
    const settings = { ...this.state.nodeSettings[key], [name]: { value, at: this.now() } };
    this.set({ nodeSettings: { ...this.state.nodeSettings, [key]: settings } });
  }

  /** Drops what this client remembers about a node: its role, its status trend, the console. */
  forgetNode(key: string): void {
    const without = <T,>(record: Record<string, T>): Record<string, T> => {
      const copy = { ...record };
      delete copy[key];
      return copy;
    };
    this.set({
      logins: without(this.state.logins),
      statusHistory: without(this.state.statusHistory),
      batteryHistory: without(this.state.batteryHistory),
      readingHistory: without(this.state.readingHistory),
      statuses: without(this.state.statuses),
      neighbours: without(this.state.neighbours),
      accessLists: without(this.state.accessLists),
      ownerInfo: without(this.state.ownerInfo),
      nodeSettings: without(this.state.nodeSettings),
      consoles: without(this.state.consoles),
      series: without(this.state.series),
    });
  }

  clearConsole(key: string): void {
    const consoles = { ...this.state.consoles };
    delete consoles[key];
    this.set({ consoles });
  }

  /** Takes a request out of the queue before it goes on the air. One already out cannot be called back. */
  cancelRemote(id: string): void {
    const index = this.remoteQueue.findIndex((j) => j.info.id === id);
    if (index < 0) return;
    const [job] = this.remoteQueue.splice(index, 1);
    job!.reject(new Error("cancelled"));
    this.publishRemote();
  }

  private maskedTags = new Set<string>();

  private appendConsole(key: string, entry: ConsoleEntry): void {
    const prior = this.state.consoles[key] ?? [];
    const list = prior.length >= CONSOLE_LIMIT ? prior.slice(-CONSOLE_LIMIT + 1) : prior;
    this.set({ consoles: { ...this.state.consoles, [key]: [...list, entry] } });
  }

  private patchConsole(key: string, id: string, patch: Partial<ConsoleEntry>): void {
    const list = this.state.consoles[key];
    if (!list) return;
    this.set({ consoles: { ...this.state.consoles, [key]: list.map((e) => (e.id === id ? { ...e, ...patch } : e)) } });
  }

  /** A console reply: to the command waiting for it, to one that gave up on it, or a line of its own. */
  private receiveCli(prefix: string, text: string, stamp: number): void {
    const match = /^([0-9a-fA-F]{2})\|/.exec(text);
    const tag = match ? match[1]!.toLowerCase() : null;
    const body = match ? text.slice(3) : text;
    if (this.remoteEvent({ kind: "cli", prefix, tag, text: body, stamp })) return;
    const contact = this.contactByPrefix(prefix);
    const key = contact?.key ?? prefix;
    const masked = tag !== null && this.maskedTags.has(`${prefix}:${tag}`);
    const reply = masked ? maskReply(body) : body;
    const late = tag === null ? undefined : this.state.consoles[key]?.find((e) => e.tag === tag && e.status !== "done");
    if (late) {
      this.patchConsole(key, late.id, { status: "done", reply, repliedAt: this.now(), error: null });
      return;
    }
    this.appendConsole(key, { id: newId(this.now()), command: "", tag: tag ?? "", at: this.now(), status: "done", reply, repliedAt: this.now(), error: null });
  }

  /**
   * A request to a node, sent once when its turn in the queue comes. Nothing
   * goes again by itself: every repeater that hears a flood sends it on, and a
   * request repeated or flooded on silence, times every node an admin asks,
   * once filled the air (28 September 2026). The reader sends again.
   */
  private remoteRequest(
    key: string,
    label: string,
    start: RemoteJob["start"],
    answers: (event: RemoteEvent, sent: TextSendResult | null) => boolean,
    options: RemoteOptions = {},
  ): Promise<RemoteEvent> {
    if (!this.client || this.client.isClosed) return Promise.reject(new Error("not connected"));
    const { extraWaitMs = 0, onStart } = options;
    return new Promise((resolve, reject) => {
      this.jobCounter += 1;
      this.remoteQueue.push({
        info: { id: `r${this.jobCounter}`, key, label, startedAt: null, until: null },
        start: async (client) => {
          onStart?.();
          return start(client);
        },
        answers,
        extraWaitMs,
        sent: null,
        early: [],
        timer: null,
        resolve,
        reject,
      });
      this.publishRemote();
      void this.pumpRemote();
    });
  }

  private async pumpRemote(): Promise<void> {
    if (this.remoteActive) return;
    const job = this.remoteQueue.shift();
    if (!job) return;
    this.remoteActive = job;
    job.info = { ...job.info, startedAt: this.now() };
    this.publishRemote();
    await this.launchRemote(job);
  }

  /**
   * Sends the request in the radio's slot and waits for its reply. Along a
   * route it goes that way, with none the radio floods it; silence drops
   * nothing, since a lost round trip on a weak route says nothing about it.
   */
  private async launchRemote(job: RemoteJob): Promise<void> {
    const client = this.client;
    if (!client || client.isClosed) {
      this.finishRemote(job, new Error("not connected"));
      return;
    }
    const name = this.state.contacts[job.info.key]?.name || job.info.key.slice(0, 12);
    try {
      const sent = await job.start(client);
      if (this.remoteActive !== job) return;
      job.sent = sent;
      const wait = this.replyWait(sent.estTimeoutMs, job.extraWaitMs);
      job.info = { ...job.info, until: this.now() + wait };
      this.publishRemote();
      this.log("remote", `${job.info.label} to ${name}: ${sent.flood ? "as a flood" : "along its route"}`);
      job.timer = setTimeout(() => {
        job.timer = null;
        this.log("remote", `${job.info.label} to ${name}: no reply`);
        this.finishRemote(job, new NoReplyError(job.info.label, wait));
      }, wait);
      for (const event of job.early.splice(0)) this.remoteEvent(event);
    } catch (error) {
      this.finishRemote(job, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private finishRemote(job: RemoteJob, error: Error | null, event?: RemoteEvent): void {
    if (this.remoteActive !== job) return;
    this.remoteActive = null;
    if (job.timer) clearTimeout(job.timer);
    if (error) job.reject(error);
    else job.resolve(event!);
    this.publishRemote();
    void this.pumpRemote();
  }

  /** Hands a reply from a remote node to the request waiting for it; says whether one was. */
  private remoteEvent(event: RemoteEvent): boolean {
    const job = this.remoteActive;
    if (!job) return false;
    // A binary reply is known by the tag the radio gave when it sent the
    // request; one that overtakes that answer waits for it.
    if (event.kind === "binary" && !job.sent) {
      job.early.push(event);
      return true;
    }
    if (!job.answers(event, job.sent)) return false;
    this.finishRemote(job, null, event);
    return true;
  }

  private publishRemote(): void {
    this.set({ remote: { active: this.remoteActive?.info ?? null, queued: this.remoteQueue.map((j) => j.info) } });
  }

  private dropRemoteJobs(reason: string): void {
    const jobs = [...(this.remoteActive ? [this.remoteActive] : []), ...this.remoteQueue];
    this.remoteActive = null;
    this.remoteQueue = [];
    for (const job of jobs) {
      if (job.timer) clearTimeout(job.timer);
      job.reject(new Error(reason));
    }
    this.publishRemote();
  }

  /** A battery reading into its node's week: one sample per ten minutes, carrying the latest value. */
  private noteBattery(key: string, mv: number): Partial<SessionState> {
    const at = this.now();
    const kept = (this.state.batteryHistory[key] ?? []).filter((s) => at - s.at < HISTORY_MS);
    return { batteryHistory: { ...this.state.batteryHistory, [key]: spaced(kept, { at, mv }).slice(-HISTORY_LIMIT) } };
  }

  /**
   * A telemetry answer's voltages and currents off the node's own channel into its day, spaced
   * like the battery; the first of each type a channel reports, as the supply it makes. Every
   * series of the node is trimmed to the day on the way, so one that stopped coming goes.
   */
  private noteReadings(key: string, readings: LppReading[]): Partial<SessionState> {
    const at = this.now();
    const fresh = new Map<string, number>();
    for (const r of readings) {
      if (r.channel === TELEMETRY_SELF_CHANNEL) continue;
      const value = r.type === "voltage" ? r.volts : r.type === "current" ? r.amps : null;
      const id = `${r.channel}:${r.type}`;
      if (value !== null && !fresh.has(id)) fresh.set(id, value);
    }
    const before = this.state.readingHistory[key];
    if (fresh.size === 0 && !before) return {};
    const series: Record<string, ReadingSample[]> = {};
    for (const [id, samples] of Object.entries(before ?? {})) {
      const kept = samples.filter((s) => at - s.at < READINGS_MS);
      if (kept.length) series[id] = kept;
    }
    for (const [id, value] of fresh) series[id] = spaced(series[id] ?? [], { at, value });
    const readingHistory = { ...this.state.readingHistory };
    if (Object.keys(series).length) readingHistory[key] = series;
    else delete readingHistory[key];
    return { readingHistory };
  }

  private noteStatus(key: string, contact: ContactRecord | null, raw: Uint8Array): void {
    // The tail differs between a repeater and a room, and only the contact says which answered.
    const stats = contact ? readNodeStats(raw, contact.type === AdvType.Room ? "room" : "repeater") : null;
    const at = this.now();
    const patch: Partial<SessionState> = { statuses: { ...this.state.statuses, [key]: { stats, raw: toHex(raw), at } } };
    if (stats) {
      const kept = (this.state.statusHistory[key] ?? []).filter((s) => at - s.at < HISTORY_MS);
      const history = [...kept, { at, batteryMv: stats.batteryMv, noiseFloor: stats.noiseFloor }].slice(-HISTORY_LIMIT);
      patch.statusHistory = { ...this.state.statusHistory, [key]: history };
    }
    this.set(patch);
  }

  // ---- pushes ----

  private onPush(frame: PushFrame): void {
    switch (frame.kind) {
      case "msgWaiting":
        if (this.isReady) this.syncMessages().catch((e: Error) => this.log("error", e.message));
        return;
      case "mirror":
        this.mirrored(frame.command, frame.answer);
        return;
      case "sendConfirmed": {
        // The latest try's acknowledgement, or a late one of an earlier try: either way the text arrived.
        const message = this.state.messages.find((m) => m.direction === "out" && (m.ackTag === frame.ackTag || m.pastAckTags?.includes(frame.ackTag)));
        if (message) {
          const timer = this.ackTimers.get(message.id);
          if (timer) clearTimeout(timer);
          this.ackTimers.delete(message.id);
          this.patchMessage(message.id, { status: "delivered", roundTripMs: frame.roundTripMs, retryPlan: null });
          // A flood's ack comes back inside the path the message took, and the
          // radio says it learned that path just before it says the ack came.
          const update = this.lastPathUpdate;
          if (message.flood && update && message.conversation === contactConversation(update.key) && this.now() - update.at < 5000) {
            void update.record.then((record) => {
              if (record) this.patchMessage(message.id, { route: contactRoute(record) });
            });
          }
        }
        return;
      }
      case "advert": {
        const key = toHex(frame.publicKey);
        const contact = this.state.contacts[key];
        // Only a contact the radio holds is announced this way: one it did not keep before has been added now.
        if (contact?.unsaved) {
          this.queueContactsRefresh();
        } else if (contact) {
          this.set({
            contacts: {
              ...this.state.contacts,
              [key]: { ...contact, lastHeardAt: this.now(), lastAdvert: Math.floor(this.now() / 1000) },
            },
          });
        } else {
          this.queueContactsRefresh();
        }
        return;
      }
      case "newAdvert": {
        // The radio sends the whole contact only for a node it did not keep;
        // one it keeps comes as a plain advert (firmware `onDiscoveredContact`).
        const known = this.state.contacts[toHex(frame.contact.publicKey)];
        const record = this.upsertContact(frame.contact, true, undefined, true);
        if (!known) this.announceDiscovered(record);
        return;
      }
      case "pathUpdated": {
        const key = toHex(frame.publicKey);
        const client = this.client;
        if (!client) return;
        const at = this.now();
        const record = client
          .getContactByKey(frame.publicKey)
          .then((c) => this.upsertContact(c, false, at))
          .catch(() => {
            this.queueContactsRefresh();
            return null;
          });
        this.lastPathUpdate = { key, at, record };
        // A contact pinned to flood keeps no route, not even for the acks the
        // radio sends back to its messages.
        void record.then((r) => {
          if (r && r.outPathLen !== 0xff && isConversationType(r.type) && this.routePolicy(key).flood && this.client === client) {
            this.dropRoute(client, key, "flood pinned").catch((e: Error) => this.log("error", e.message));
          }
          // The radio takes the way an answer came in as its route to the sender; a route set
          // by hand is put back, since it was chosen over what the radio learns.
          const manual = this.manualRoute(key);
          if (r && manual && routeKey(r.outPathLen, r.outPath) !== routeKey(manual.outPathLen, manual.outPath) && this.client === client) {
            this.writeContact({ ...r, ...manual })
              .then(() => this.log("path", `${r.name || key.slice(0, 12)}: route set by hand put back over ${pathHashes(r.outPathLen, r.outPath).join(" ") || "direct"}`))
              .catch((e: Error) => this.log("error", e.message));
          }
        });
        this.log("path", `route to ${this.state.contacts[key]?.name ?? key.slice(0, 12)} updated`);
        return;
      }
      case "contactDeleted": {
        // The radio replaced its oldest contact with a new node.
        const key = toHex(frame.publicKey);
        const gone = this.state.contacts[key];
        const contacts = { ...this.state.contacts };
        delete contacts[key];
        this.set({ contacts, removed: gone ? this.withRemoved([gone], "radio") : this.state.removed });
        this.log("contact", `radio replaced ${gone?.name || key.slice(0, 12)}: its memory is full`);
        return;
      }
      case "contactsFull":
        this.set({ contactsFull: true });
        this.log("contact", "the radio's memory is full: a new node was not kept");
        return;
      case "loginSuccess":
      case "loginFail": {
        const prefix = toHex(frame.prefix);
        const contact = this.contactByPrefix(prefix);
        const key = contact?.key ?? prefix;
        const ok = frame.kind === "loginSuccess";
        const login: NodeLogin = ok
          ? {
              ok,
              role: frame.permissions === null ? null : frame.permissions & 3,
              serverTime: frame.serverTime,
              firmwareLevel: frame.firmwareLevel,
              at: this.now(),
            }
          : { ok, role: null, serverTime: null, firmwareLevel: null, at: this.now() };
        this.set({ logins: { ...this.state.logins, [key]: login } });
        this.log("login", `${contact?.name ?? prefix}: ${ok ? `signed in${login.role === null ? "" : ` as ${aclRoleName(login.role)}`}` : "password refused"}`);
        this.remoteEvent({ kind: "login", prefix, ok });
        return;
      }
      case "statusResponse": {
        const prefix = toHex(frame.prefix);
        const contact = this.contactByPrefix(prefix);
        this.noteStatus(contact?.key ?? prefix, contact, frame.raw);
        this.log("status", `${contact?.name ?? prefix}: status received`);
        this.remoteEvent({ kind: "status", prefix });
        return;
      }
      case "telemetryResponse": {
        const prefix = toHex(frame.prefix);
        const contact = this.contactByPrefix(prefix);
        const key = this.state.self?.prefix === prefix ? "self" : (contact?.key ?? prefix);
        const battery = frame.readings.find((r) => r.channel === TELEMETRY_SELF_CHANNEL && r.type === "voltage");
        this.set({
          telemetry: { ...this.state.telemetry, [key]: { readings: frame.readings, at: this.now() } },
          ...(battery?.type === "voltage" ? this.noteBattery(key, Math.round(battery.volts * 1000)) : {}),
          ...this.noteReadings(key, frame.readings),
        });
        this.log("telemetry", `${key === "self" ? "this radio" : (contact?.name ?? prefix)}: ${frame.readings.length} reading(s)`);
        if (key !== "self") this.remoteEvent({ kind: "telemetry", prefix, readings: frame.readings });
        return;
      }
      case "pathDiscoveryResponse": {
        const prefix = toHex(frame.prefix);
        const contact = this.contactByPrefix(prefix);
        this.log(
          "path",
          `${contact?.name ?? prefix}: out ${frame.outPathLen & 63} hop(s) ${toHex(frame.outPath)}, in ${frame.inPathLen & 63} hop(s) ${toHex(frame.inPath)}`,
        );
        this.remoteEvent({ kind: "path", prefix, outPathLen: frame.outPathLen, outPath: toHex(frame.outPath), inPathLen: frame.inPathLen, inPath: toHex(frame.inPath) });
        return;
      }
      case "traceData": {
        const waiter = this.traceWaiters.get(frame.tag);
        if (waiter) waiter(frame);
        else this.log("trace", `tag ${frame.tag.toString(16)}: ${toHex(frame.hashes)} snr ${frame.snrs.map((s) => s.toFixed(1)).join("/")}`);
        return;
      }
      case "binaryResponse":
        this.log("binary", `tag ${frame.tag.toString(16)}: ${frame.data.length} byte(s)`);
        this.remoteEvent({ kind: "binary", tag: frame.tag, data: frame.data });
        return;
      case "rawData":
        this.log("raw", `snr ${frame.snr} rssi ${frame.rssi}: ${toHex(frame.payload)}`);
        return;
      case "logRxData": {
        // Not logged: a packet is heard every few seconds, and its hex would push every event out of the log. On the air shows them in words.
        this.noteHeard(frame.snr, frame.raw);
        if (this.heardListeners.size === 0) return;
        const heard: HeardPacket = { at: this.now(), snr: frame.snr, rssi: frame.rssi, size: frame.raw.length, packet: parseRawPacket(frame.raw) };
        for (const listener of this.heardListeners) {
          try {
            listener(heard);
          } catch (error) {
            console.error("heard listener threw", error);
          }
        }
        return;
      }
      case "controlData":
        this.log("control", `snr ${frame.snr} rssi ${frame.rssi}: ${toHex(frame.payload)}`);
        for (const listener of this.controlListeners) listener(frame);
        return;
    }
  }
}

/** A console reply with a password in it, as the console shows it. */
function maskReply(reply: string): string {
  return reply.replace(/^(password now:\s*).*$/is, "$1••••••");
}

/** Whether `a` and `b` name the same radio. */
export function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return bytesEqual(a, b);
}
