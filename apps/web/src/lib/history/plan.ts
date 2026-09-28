import {
  pathOf,
  PUB_KEY_PREFIX_SIZE,
  TxtType,
  UNSAVED_KEEP_MS,
  type ChannelRecord,
  type ContactRecord,
  type ImportedHistory,
  type MessageRecord,
  type MessageStatus,
} from "@meshnet/meshcore";
import { conversationOf, HistoryFileError, KIND_TYPES, parseHistory, type HistoryBody, type HistoryContact, type HistoryMessage } from "./format.js";
import { readMeshCoreApp } from "./meshcoreApp.js";

/** A history picked to bring in, whichever app wrote it, before it is matched to the radio. */
export interface HistorySource {
  kind: "ommesh" | "meshcoreApp";
  /** The radio it is the history of; null when the source does not say. */
  radioKey: string | null;
  body: HistoryBody;
  /** Lines of a repeater's console the source held, left behind. */
  console: number;
}

const SQLITE = "SQLite format 3\u0000";

/** A picked file read as a history: the MeshCore app's database by its first bytes, anything else as a history file. */
export function readHistorySource(bytes: Uint8Array): HistorySource {
  if (bytes.length >= 16 && String.fromCharCode(...bytes.subarray(0, 16)) === SQLITE) {
    const { radioKey, body, console } = readMeshCoreApp(bytes);
    return { kind: "meshcoreApp", radioKey, body, console };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HistoryFileError("notHistory");
  }
  const file = parseHistory(text);
  return { kind: "ommesh", radioKey: file.radio.key, body: file, console: 0 };
}

export interface ImportTarget {
  self: { key: string; name: string; prefix: string };
  /** The radio's channel slots now: a channel's messages go to the slot that holds its secret. */
  channels: ChannelRecord[];
  /** Contacts this app knows, to name a room post's author. */
  contacts: Record<string, ContactRecord>;
  now: number;
}

/** What bringing a history in would do, for the reader to see before it is done. */
export interface ImportPlan {
  kind: HistorySource["kind"];
  history: ImportedHistory;
  /** Chats the messages go to. */
  chats: number;
  /** When the first and last of them arrived, local ms; null without messages. */
  from: number | null;
  to: number | null;
  left: {
    /** Channels no slot on the radio holds now, by name, with how many messages each had. */
    channels: { name: string; messages: number }[];
    console: number;
    /** Nodes heard but not kept that have been quiet longer than the list keeps them. */
    quietNodes: number;
  };
}

/** Thrown for a history of another radio than the one it would go to. */
export class OtherRadioError extends Error {
  constructor(readonly radioKey: string) {
    super(`this history belongs to radio ${radioKey.slice(0, 8)}`);
  }
}

/** The history matched to the radio: channels to its slots, messages to its records, contacts sorted by where they go. */
export function planImport(source: HistorySource, target: ImportTarget): ImportPlan {
  if (source.radioKey !== null && source.radioKey !== target.self.key) throw new OtherRadioError(source.radioKey);
  const { now, self } = target;

  const contacts: ContactRecord[] = [];
  const removed: ImportedHistory["removed"] = [];
  const heard: ContactRecord[] = [];
  let quietNodes = 0;
  for (const c of source.body.contacts) {
    const record = contactRecord(c, now);
    if (c.on === "removed") removed.push({ contact: record, at: now, by: c.removedBy ?? "radio" });
    else if (c.on !== "heard") contacts.push(record);
    // A node heard but not kept stays as long as one heard here would.
    else if (record.lastHeardAt !== null && record.lastHeardAt >= now - UNSAVED_KEEP_MS) heard.push({ ...record, unsaved: true });
    else quietNodes++;
  }

  const everyone = [...Object.values(target.contacts), ...contacts, ...removed.map((r) => r.contact), ...heard];
  const nameOf = (keyStart: string): string | null => {
    if (self.key.startsWith(keyStart)) return self.name;
    return everyone.find((c) => c.key.startsWith(keyStart))?.name ?? null;
  };

  const slots = new Map(target.channels.map((c) => [c.secret.toLowerCase(), c.index]));
  const channelNames = new Map(source.body.channels.map((c) => [c.secret, c.name]));
  const skipped = new Map<string, number>();
  const messages: MessageRecord[] = [];
  for (const m of source.body.messages) {
    const conversation = conversationOf(m.chat, slots);
    if (conversation === null) {
      const secret = "channel" in m.chat ? m.chat.channel : "";
      const name = channelNames.get(secret) || secret.slice(0, 8);
      skipped.set(name, (skipped.get(name) ?? 0) + 1);
      continue;
    }
    messages.push(messageRecord(m, conversation, messages.length, self, nameOf));
  }

  let from: number | null = null;
  let to: number | null = null;
  for (const m of messages) {
    if (from === null || m.receivedAt < from) from = m.receivedAt;
    if (to === null || m.receivedAt > to) to = m.receivedAt;
  }
  return {
    kind: source.kind,
    history: { messages, contacts, removed, heard },
    chats: new Set(messages.map((m) => m.conversation)).size,
    from,
    to,
    left: { channels: [...skipped].map(([name, count]) => ({ name, messages: count })), console: source.console, quietNodes },
  };
}

/**
 * Our message as it was left: one still waiting to go was written elsewhere
 * and never went from here, so it is not sent now; one that was going is not
 * waited for.
 */
const STATUS_HERE: Partial<Record<MessageStatus, MessageStatus>> = { queued: "failed", sending: "unconfirmed" };

function messageRecord(m: HistoryMessage, conversation: string, n: number, self: ImportTarget["self"], nameOf: (keyStart: string) => string | null): MessageRecord {
  const sentMs = Date.parse(m.sentAt);
  const receivedAt = m.receivedAt === undefined ? sentMs : Date.parse(m.receivedAt);
  const out = m.direction === "out";
  const channel = conversation.startsWith("ch:");
  let sender: string | null;
  let senderPrefix: string | null;
  if (out) {
    sender = self.name;
    senderPrefix = self.prefix;
  } else if (channel) {
    sender = m.from?.name ?? null;
    senderPrefix = m.from?.key ?? null;
  } else {
    // A direct message is from its chat's node; a room post from the author it names.
    const peer = conversation.startsWith("c:") ? conversation.slice(2, 2 + PUB_KEY_PREFIX_SIZE * 2) : conversation.slice(2);
    senderPrefix = m.from?.key ?? peer;
    sender = m.from?.name ?? nameOf(senderPrefix);
  }
  const echoes = m.echoes ?? [];
  const status: MessageStatus | null = out ? (m.status ? (STATUS_HERE[m.status] ?? m.status) : channel ? "sent" : "unconfirmed") : null;
  return {
    // A file from another program need not name its messages; the text and stamp then tell them apart.
    id: m.id ?? `import:${n}:${sentMs}`,
    conversation,
    direction: m.direction,
    text: m.text,
    sender,
    senderPrefix,
    timestamp: Math.floor(sentMs / 1000),
    receivedAt,
    snr: m.snr ?? null,
    hops: m.hops ?? null,
    txtType: m.roomPost ? TxtType.SignedPlain : TxtType.Plain,
    status,
    ackTag: null,
    roundTripMs: m.roundTripMs ?? null,
    flood: null,
    attempt: 0,
    error: m.error ?? null,
    echoes: echoes.map((e) => ({ path: e.path, snr: e.snr })),
    route: m.route ?? null,
    retryPlan: null,
  };
}

function contactRecord(c: HistoryContact, now: number): ContactRecord {
  const route = c.route ?? null;
  const { outPathLen, outPath } = route ? pathOf(route) : { outPathLen: 0xff, outPath: "".padEnd(128, "0") };
  const lastAdvert = c.lastAdvert === undefined ? 0 : Math.floor(Date.parse(c.lastAdvert) / 1000);
  return {
    key: c.key,
    prefix: c.key.slice(0, PUB_KEY_PREFIX_SIZE * 2),
    type: KIND_TYPES[c.kind ?? "chat"],
    flags: c.flags ?? 0,
    outPathLen,
    outPath,
    name: c.name ?? "",
    lastAdvert,
    lat: c.lat ?? 0,
    lon: c.lon ?? 0,
    lastMod: lastAdvert,
    // Clocks run fast on some nodes: nothing was heard later than now.
    lastHeardAt: c.lastHeard === undefined ? null : Math.min(Date.parse(c.lastHeard), now),
    pathSince: route ? Math.min(lastAdvert * 1000, now) : null,
  };
}
