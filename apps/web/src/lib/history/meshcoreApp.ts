import { pathHashes, PUB_KEY_PREFIX_SIZE, splitChannelText, toHex, TxtType, type MessageStatus } from "@meshnet/meshcore";
import { KIND_TYPES, type ContactKind, type HistoryBody, type HistoryContact, type HistoryEcho, type HistoryMessage } from "./format.js";
import { SqliteFile, type SqliteValue } from "./sqlite.js";

/**
 * The history the official MeshCore app keeps, from its "export database"
 * file (an SQLite database named after the radio's key), as a history file
 * holds it. Its messages, channels, contacts and the nodes it heard come
 * across; the repeater console, read marks and passwords stay behind.
 */
export interface MeshCoreAppHistory {
  /** The radio the file belongs to, as far as it says: its own messages carry its key. */
  radioKey: string | null;
  body: HistoryBody;
  /** Replies and commands of a repeater's console, left behind. */
  console: number;
}

const NEEDED = ["channels", "channel_messages", "contacts", "contact_messages"];

/** Throws when the bytes are no SQLite database, or not one the MeshCore app wrote. */
export function readMeshCoreApp(bytes: Uint8Array): MeshCoreAppHistory {
  const db = new SqliteFile(bytes);
  for (const name of NEEDED) if (!db.tables.has(name)) throw new Error(`not an official MeshCore app export: no ${name} table`);

  // A row without a whole key names nobody this app could reach.
  const contacts = [...db.rows("contacts")].map((row) => contactOf(row, "radio")).filter((c) => c.key.length === 64);
  const known = new Map(contacts.map((c) => [c.key, c]));
  const heard: HistoryContact[] = [];
  if (db.tables.has("discovered_contacts")) {
    for (const row of db.rows("discovered_contacts")) {
      const node = contactOf(row, "heard");
      // The app only knows when the node's advert was sent; that is when it was heard, near enough.
      if (node.key.length === 64 && !known.has(node.key)) heard.push({ ...node, ...(node.lastAdvert ? { lastHeard: node.lastAdvert } : {}) });
    }
  }
  const everyone = [...contacts, ...heard];
  const nameOf = (keyStart: string) => everyone.find((c) => c.key.startsWith(keyStart))?.name;

  const radioKeys = new Set<string>();
  const messages: HistoryMessage[] = [];

  const channels: HistoryBody["channels"] = [];
  for (const row of db.rows("channels")) {
    const secret = hex(row.secret);
    if (secret && secret.length === 32 && !/^0+$/.test(secret)) channels.push({ secret, name: str(row.name) });
  }
  const echoes = echoesOf(db);
  for (const row of db.rows("channel_messages")) {
    const from = row.from === null ? null : str(row.from).toLowerCase();
    const out = from !== null;
    if (out) radioKeys.add(from);
    const secret = hex(row.channel_secret);
    // A message whose channel the file does not say cannot be put anywhere.
    if (!secret || secret.length !== 32) continue;
    const base = { id: `official:ch:${num(row.id)}`, chat: { channel: secret }, ...stamps(row), ...signal(row) };
    if (out) {
      const copies = echoes.get(num(row.id)) ?? [];
      const heardOn = copies.length > 0 || num(row.repeats_heard_count) > 0;
      messages.push({ ...base, direction: "out", text: str(row.text), status: heardOn ? "sent" : "unheard", ...(copies.length ? { echoes: copies } : {}) });
    } else {
      const { sender, text } = splitChannelText(str(row.text));
      messages.push({ ...base, direction: "in", text, ...(sender ? { from: { name: sender } } : {}) });
    }
  }

  // Direct messages and room posts; the console's traffic is not history here.
  let console = 0;
  for (const row of db.rows("contact_messages")) {
    if (num(row.txt_type) === TxtType.CliData) {
      console++;
      continue;
    }
    const status = str(row.status);
    const out = status !== "received";
    const from = str(row.from).toLowerCase();
    const to = str(row.to).toLowerCase();
    radioKeys.add(out ? from : to);
    const peer = out ? to : from;
    const base = { id: `official:dm:${num(row.id)}`, chat: { contact: peer }, text: str(row.text), ...stamps(row), ...signal(row) };
    if (out) {
      messages.push({
        ...base,
        direction: "out",
        status: STATUS[status] ?? "unconfirmed",
        ...(row.rtt === null || row.rtt === undefined ? {} : { roundTripMs: num(row.rtt) }),
        ...(row.error === null || row.error === undefined ? {} : { error: str(row.error) }),
      });
      continue;
    }
    // A room relays its members' posts signed with the start of the author's key.
    const author = row.room_post_author_pub_key_prefix ? str(row.room_post_author_pub_key_prefix).toLowerCase() : null;
    const key = author ?? peer.slice(0, PUB_KEY_PREFIX_SIZE * 2);
    const name = author ? nameOf(author) : known.get(peer)?.name;
    messages.push({ ...base, direction: "in", from: { key, ...(name ? { name } : {}) }, ...(author ? { roomPost: true } : {}) });
  }

  return { radioKey: radioKeys.size === 1 ? [...radioKeys][0]! : null, body: { channels, contacts: [...contacts, ...heard], messages }, console };
}

const STATUS: Record<string, MessageStatus> = {
  delivered: "delivered",
  failed: "failed",
  // Never acknowledged: the official app kept waiting.
  sending: "sending",
};

/** When a message was sent, by its sender's clock in seconds, and received, by the app's own in ms. */
function stamps(row: Record<string, SqliteValue>): { sentAt: string; receivedAt: string } {
  return { sentAt: iso(num(row.sender_timestamp) * 1000), receivedAt: iso(num(row.timestamp)) };
}

function signal(row: Record<string, SqliteValue>): { snr?: number; hops?: number } {
  const out: { snr?: number; hops?: number } = {};
  if (row.snr !== null && row.snr !== undefined) out.snr = num(row.snr);
  const hops = hopsOf(row.path_len);
  if (hops !== null) out.hops = hops;
  return out;
}

/** The copies of our channel messages that repeaters sent on, one per distinct path. */
function echoesOf(db: SqliteFile): Map<number, HistoryEcho[]> {
  const byMessage = new Map<number, HistoryEcho[]>();
  if (!db.tables.has("channel_message_heard_repeats")) return byMessage;
  const ours = new Set<number>();
  for (const row of db.rows("channel_messages")) if (row.from !== null) ours.add(num(row.id));
  for (const row of db.rows("channel_message_heard_repeats")) {
    const id = num(row.channel_message_id);
    if (!ours.has(id)) continue;
    const bytes = row.path instanceof Uint8Array ? row.path : new Uint8Array();
    // Without the length byte the hashes are taken as one byte each, the firmware's default.
    const pathLen = row.path_len === null || row.path_len === undefined ? bytes.length : num(row.path_len) & 0xff;
    const path = pathHashes(pathLen, bytes);
    const list = byMessage.get(id) ?? [];
    if (!list.some((e) => e.path.join() === path.join())) list.push({ path, snr: num(row.snr) });
    byMessage.set(id, list);
  }
  return byMessage;
}

const KINDS = new Map(Object.entries(KIND_TYPES).map(([kind, type]) => [type, kind as ContactKind]));

function contactOf(row: Record<string, SqliteValue>, on: "radio" | "heard"): HistoryContact {
  const key = hex(row.public_key) ?? "";
  const outPathLen = num(row.out_path_len) & 0xff;
  const custom = row.custom_name === undefined || row.custom_name === null ? "" : str(row.custom_name);
  const out: HistoryContact = { key, name: custom || str(row.adv_name), kind: KINDS.get(num(row.type)) ?? "chat", on };
  const flags = num(row.flags) & 0xff;
  if (flags) out.flags = flags;
  const lat = num(row.adv_lat) / 1e6;
  const lon = num(row.adv_lon) / 1e6;
  if (lat || lon) Object.assign(out, { lat, lon });
  const lastAdvert = num(row.last_advert);
  if (lastAdvert > 0) out.lastAdvert = iso(lastAdvert * 1000);
  out.route = outPathLen === 0xff ? null : pathHashes(outPathLen, hex(row.out_path) ?? "");
  return out;
}

/** The low six bits of the length byte count the hops; 0xff, stored signed as -1, is a message that came direct. */
function hopsOf(value: SqliteValue | undefined): number | null {
  if (value === null || value === undefined) return null;
  const pathLen = num(value) & 0xff;
  return pathLen === 0xff ? null : pathLen & 63;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
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
