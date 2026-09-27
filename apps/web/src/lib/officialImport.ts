import {
  channelConversation,
  contactConversation,
  pathHashes,
  PUB_KEY_PREFIX_SIZE,
  splitChannelText,
  toHex,
  TxtType,
  type ChannelRecord,
  type ContactRecord,
  type MessageEcho,
  type MessageRecord,
  type MessageStatus,
} from "@meshnet/meshcore";
import { SqliteFile, type SqliteValue } from "./sqlite.js";

/**
 * The history the official MeshCore app keeps, from its "export database"
 * file (an SQLite database named after the radio's key), turned into this
 * app's records for the radio connected now. Only what this app keeps is
 * taken: the messages of the last 30 days, contacts and the nodes heard; the
 * repeater console, read marks and passwords stay behind.
 */
export interface OfficialHistory {
  /** The radio the file belongs to, as far as it says: its own messages carry its key. */
  radioKey: string | null;
  messages: MessageRecord[];
  /** The contacts the official app held. */
  contacts: ContactRecord[];
  /** Nodes it heard but did not add: kept as nodes the radio did not keep. */
  heard: ContactRecord[];
  skipped: {
    /** Channels no slot on the radio holds now, by name, with how many messages each had. */
    channels: { name: string; messages: number }[];
    /** Messages older than `MESSAGE_KEEP_MS`. */
    oldMessages: number;
    /** Replies and commands of a repeater's console. */
    console: number;
    /** Heard nodes silent for longer than the tidy-up rule keeps them. */
    quietNodes: number;
  };
}

export interface ImportTarget {
  self: { key: string; name: string; prefix: string };
  /** The radio's channel slots now: a channel's messages go to the slot that holds its secret. */
  channels: ChannelRecord[];
  /** Contacts this app knows, to name a room post's author. */
  contacts: Record<string, ContactRecord>;
  /** How long a node the radio did not keep stays after it was last heard, as the session's `unsavedKeepMs` says; null keeps all. */
  heardKeepMs: number | null;
  now: number;
}

/** How far back messages are brought in, by when the official app received or sent them. */
export const MESSAGE_KEEP_MS = 30 * 24 * 3600 * 1000;

const NEEDED = ["channels", "channel_messages", "contacts", "contact_messages"];

export function readOfficialHistory(bytes: Uint8Array, target: ImportTarget): OfficialHistory {
  const db = new SqliteFile(bytes);
  for (const name of NEEDED) if (!db.tables.has(name)) throw new Error(`not an official MeshCore app export: no ${name} table`);

  const contacts = [...db.rows("contacts")].map((row) => contactOf(row, target.now));
  const known = new Map(contacts.map((c) => [c.key, c]));
  const heard: ContactRecord[] = [];
  let quietNodes = 0;
  if (db.tables.has("discovered_contacts")) {
    for (const row of db.rows("discovered_contacts")) {
      const node = contactOf(row, target.now);
      if (known.has(node.key)) continue;
      const at = Math.min(node.lastAdvert * 1000, target.now);
      if (target.heardKeepMs !== null && at < target.now - target.heardKeepMs) {
        quietNodes++;
        continue;
      }
      heard.push({ ...node, lastHeardAt: at, unsaved: true });
    }
  }
  const everyone = [...Object.values(target.contacts), ...contacts, ...heard];
  const nameOf = (keyStart: string): string | null => {
    if (target.self.key.startsWith(keyStart)) return target.self.name;
    return everyone.find((c) => c.key.startsWith(keyStart))?.name ?? null;
  };

  const radioKeys = new Set<string>();
  const messages: MessageRecord[] = [];
  // Old messages still say whose file it is; they are only not brought in.
  const since = target.now - MESSAGE_KEEP_MS;
  let oldMessages = 0;

  // Channels: the file names each message's channel by its secret, the radio by slot.
  const slots = new Map(target.channels.map((c) => [c.secret.toLowerCase(), c.index]));
  const channelNames = new Map<string, string>();
  for (const row of db.rows("channels")) {
    const secret = hex(row.secret);
    if (secret && !/^0+$/.test(secret)) channelNames.set(secret, str(row.name));
  }
  const echoes = echoesOf(db);
  const skippedChannels = new Map<string, number>();
  for (const row of db.rows("channel_messages")) {
    const from = row.from === null ? null : str(row.from).toLowerCase();
    const out = from !== null;
    if (out) radioKeys.add(from);
    if (num(row.timestamp) < since) {
      oldMessages++;
      continue;
    }
    const secret = hex(row.channel_secret);
    const index = secret ? slots.get(secret) : undefined;
    if (index === undefined) {
      const name = (secret && channelNames.get(secret)) || (secret ? secret.slice(0, 8) : "?");
      skippedChannels.set(name, (skippedChannels.get(name) ?? 0) + 1);
      continue;
    }
    const base = messageBase(`official:ch:${num(row.id)}`, channelConversation(index), row);
    if (out) {
      const heardCopies = echoes.get(num(row.id)) ?? [];
      messages.push({
        ...base,
        direction: "out",
        text: str(row.text),
        sender: target.self.name,
        senderPrefix: target.self.prefix,
        snr: null,
        hops: null,
        status: heardCopies.length > 0 || num(row.repeats_heard_count) > 0 ? "sent" : "unheard",
        echoes: heardCopies,
      });
    } else {
      const { sender, text } = splitChannelText(str(row.text));
      messages.push({ ...base, direction: "in", text, sender, senderPrefix: null });
    }
  }

  // Direct messages and room posts; the console's traffic is not history here.
  let consoleLines = 0;
  for (const row of db.rows("contact_messages")) {
    const txtType = num(row.txt_type);
    if (txtType === TxtType.CliData) {
      consoleLines++;
      continue;
    }
    const status = str(row.status);
    const out = status !== "received";
    const from = str(row.from).toLowerCase();
    const to = str(row.to).toLowerCase();
    radioKeys.add(out ? from : to);
    if (num(row.timestamp) < since) {
      oldMessages++;
      continue;
    }
    const peer = out ? to : from;
    const base = messageBase(`official:dm:${num(row.id)}`, contactConversation(peer), row);
    if (out) {
      messages.push({
        ...base,
        direction: "out",
        sender: target.self.name,
        senderPrefix: target.self.prefix,
        snr: null,
        hops: null,
        status: STATUS[status] ?? "unconfirmed",
        ackTag: row.expected_ack_crc === null ? null : num(row.expected_ack_crc),
        roundTripMs: row.rtt === null ? null : num(row.rtt),
        attempt: row.attempt === null ? 0 : num(row.attempt),
        error: row.error === null ? null : str(row.error),
      });
    } else {
      // A room relays its members' posts signed with the start of the author's key.
      const author = row.room_post_author_pub_key_prefix === null ? null : str(row.room_post_author_pub_key_prefix).toLowerCase();
      messages.push({
        ...base,
        direction: "in",
        sender: author ? (nameOf(author) ?? author) : (known.get(peer)?.name ?? target.contacts[peer]?.name ?? null),
        senderPrefix: author ?? peer.slice(0, PUB_KEY_PREFIX_SIZE * 2),
      });
    }
  }

  return {
    radioKey: radioKeys.size === 1 ? [...radioKeys][0]! : null,
    messages,
    contacts,
    heard,
    skipped: {
      channels: [...skippedChannels].map(([name, count]) => ({ name, messages: count })),
      oldMessages,
      console: consoleLines,
      quietNodes,
    },
  };
}

const STATUS: Record<string, MessageStatus> = {
  delivered: "delivered",
  failed: "failed",
  // Never acknowledged: the official app kept waiting.
  sending: "unconfirmed",
};

/** What a message from either table shares: when it was sent and heard, and how it came. */
function messageBase(id: string, conversation: string, row: Record<string, SqliteValue>): MessageRecord {
  return {
    id,
    conversation,
    direction: "in",
    text: str(row.text),
    sender: null,
    senderPrefix: null,
    timestamp: num(row.sender_timestamp),
    // The official app keeps its own clock in ms.
    receivedAt: num(row.timestamp),
    snr: row.snr === null ? null : num(row.snr),
    hops: hopsOf(row.path_len),
    txtType: num(row.txt_type),
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
}

/** The copies of our channel messages that repeaters sent on, one per distinct path. */
function echoesOf(db: SqliteFile): Map<number, MessageEcho[]> {
  const byMessage = new Map<number, MessageEcho[]>();
  if (!db.tables.has("channel_message_heard_repeats")) return byMessage;
  const ours = new Set<number>();
  for (const row of db.rows("channel_messages")) if (row.from !== null) ours.add(num(row.id));
  for (const row of db.rows("channel_message_heard_repeats")) {
    const id = num(row.channel_message_id);
    if (!ours.has(id)) continue;
    const bytes = row.path instanceof Uint8Array ? row.path : new Uint8Array();
    // Without the length byte the hashes are taken as one byte each, the firmware's default.
    const pathLen = row.path_len === null ? bytes.length : num(row.path_len) & 0xff;
    const path = pathHashes(pathLen, bytes);
    const list = byMessage.get(id) ?? [];
    if (!list.some((e) => e.path.join() === path.join())) list.push({ path, snr: num(row.snr) });
    byMessage.set(id, list);
  }
  return byMessage;
}

function contactOf(row: Record<string, SqliteValue>, now: number): ContactRecord {
  const key = hex(row.public_key) ?? "";
  const outPathLen = num(row.out_path_len) & 0xff;
  const lastMod = num(row.last_mod);
  const name = row.custom_name === undefined || row.custom_name === null || row.custom_name === "" ? str(row.adv_name) : str(row.custom_name);
  return {
    key,
    prefix: key.slice(0, PUB_KEY_PREFIX_SIZE * 2),
    type: num(row.type),
    flags: num(row.flags),
    outPathLen,
    outPath: hex(row.out_path) ?? "",
    name,
    lastAdvert: num(row.last_advert),
    lat: num(row.adv_lat) / 1e6,
    lon: num(row.adv_lon) / 1e6,
    lastMod,
    lastHeardAt: null,
    pathSince: outPathLen === 0xff ? null : Math.min(lastMod * 1000, now),
  };
}

/** The low six bits of the length byte count the hops; 0xff, stored signed as -1, is a message that came direct. */
function hopsOf(value: SqliteValue | undefined): number | null {
  if (value === null || value === undefined) return null;
  const pathLen = num(value) & 0xff;
  return pathLen === 0xff ? null : pathLen & 63;
}

function num(value: SqliteValue | undefined): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function str(value: SqliteValue | undefined): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return value === null || value === undefined ? "" : String(value);
}

/** A key or secret, as this app writes one: lower-case hex. Keys in text are taken as they are. */
function hex(value: SqliteValue | undefined): string | null {
  if (value instanceof Uint8Array) return toHex(value);
  if (typeof value === "string" && /^[0-9a-f]+$/i.test(value)) return value.toLowerCase();
  return null;
}
