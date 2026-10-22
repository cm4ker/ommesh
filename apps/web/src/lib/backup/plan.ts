/**
 * What writing a copy onto the connected radio would do, worked out before
 * anything is written, so the reader sees it part by part and can leave a
 * part out. The radio's own contacts and channels stay: the copy's are added
 * to them. When the radio has less room than the copy has contacts, the
 * favourites go first, then those written with, then the rest by their last
 * advert; the others stay in this app's Removed list.
 */

import { ContactFlag, fromHex, type ChannelRecord, type ContactRecord, type RadioCopy } from "@meshnet/meshcore";
import { contactRecord } from "../history/plan.js";
import type { BackupFile } from "./format.js";

export type RestorePart = "key" | "settings" | "channels" | "contacts" | "chats" | "app";

export const RESTORE_PARTS: readonly RestorePart[] = ["key", "settings", "channels", "contacts", "chats", "app"];

export interface RestoreTarget {
  self: { key: string };
  device: { maxContacts: number } | null;
  contacts: Record<string, ContactRecord>;
  channels: ChannelRecord[];
  now: number;
}

export interface RestorePlan {
  file: BackupFile;
  /** When the copy was saved, ms. */
  saved: number;
  /** The radio is the copy's already: it holds the copy's key. */
  same: boolean;
  /** The contacts the copy's radio held and this one does not, in the order they go. */
  contacts: ContactRecord[];
  /** How many more contacts the radio has room for; null when it does not say. */
  room: number | null;
  /** The copy's channels this radio does not have yet. */
  channels: number;
  messages: number;
  chats: number;
}

export function planRestore(file: BackupFile, target: RestoreTarget): RestorePlan {
  const written = new Map<string, number>();
  for (const m of file.history.messages) {
    if ("contact" in m.chat) written.set(m.chat.contact, (written.get(m.chat.contact) ?? 0) + 1);
  }
  const contacts = file.history.contacts
    .filter((c) => (c.on ?? "radio") === "radio")
    .map((c) => contactRecord(c, target.now))
    .filter((c) => !target.contacts[c.key] || target.contacts[c.key]!.unsaved)
    .sort((a, b) => {
      const favourite = Number(isFavourite(b)) - Number(isFavourite(a));
      if (favourite) return favourite;
      const talked = (written.get(b.key) ?? 0) - (written.get(a.key) ?? 0);
      return talked || b.lastAdvert - a.lastAdvert;
    });
  const held = Object.values(target.contacts).filter((c) => !c.unsaved).length;
  const secrets = new Set(target.channels.map((c) => c.secret));
  return {
    file,
    saved: Date.parse(file.saved),
    same: target.self.key === file.radio.publicKey,
    contacts,
    room: target.device ? Math.max(0, target.device.maxContacts - held) : null,
    channels: file.radio.channels.filter((c) => !secrets.has(c.secret)).length,
    messages: file.history.messages.length,
    chats: new Set(file.history.messages.map((m) => JSON.stringify(m.chat))).size,
  };
}

function isFavourite(c: ContactRecord): boolean {
  return (c.flags & ContactFlag.Favourite) !== 0;
}

/**
 * The parts a plan can bring at all: the key only from a copy that has one,
 * onto a radio that is not that one already; the chats only when the radio
 * will hold the copy's key, as they are that key's.
 */
export function partsAvailable(plan: RestorePlan, chosen: ReadonlySet<RestorePart>): Set<RestorePart> {
  const parts = new Set<RestorePart>(["settings", "app"]);
  const key = plan.file.key !== null && !plan.same;
  if (key) parts.add("key");
  if (plan.file.radio.channels.length) parts.add("channels");
  if (plan.contacts.length) parts.add("contacts");
  if (plan.messages > 0 && (plan.same || (key && chosen.has("key")))) parts.add("chats");
  return parts;
}

/** What goes onto the radio for the parts chosen; the name goes with the key, as the node they make, or with the settings on the copy's own radio. */
export function copyOf(plan: RestorePlan, chosen: ReadonlySet<RestorePart>): RadioCopy {
  const { file } = plan;
  const parts = partsAvailable(plan, chosen);
  const on = (part: RestorePart) => parts.has(part) && chosen.has(part);
  const copy: RadioCopy = {};
  if (on("key") && file.key) {
    copy.privateKey = fromHex(file.key.privateKey);
    copy.name = file.radio.name;
  } else if (plan.same && on("settings")) copy.name = file.radio.name;
  if (on("settings")) copy.settings = file.radio.settings;
  if (on("channels")) copy.channels = file.radio.channels.map((c) => ({ index: c.slot, name: c.name, secret: c.secret }));
  if (on("contacts")) copy.contacts = plan.contacts;
  return copy;
}

/** How many of the copy's contacts the radio would not have room for. */
export function overflow(plan: RestorePlan): number {
  return plan.room === null ? 0 : Math.max(0, plan.contacts.length - plan.room);
}

/** A conversation of the copy's radio as this one has it, its channel moved to the slot it went to. */
export function movedConversation(conversation: string, slots: Readonly<Record<number, number>>): string | null {
  const channel = /^ch:(\d+)$/.exec(conversation);
  if (!channel) return conversation;
  const slot = slots[Number(channel[1])];
  return slot === undefined ? null : `ch:${slot}`;
}

/**
 * The copy's app settings with every chat named as this radio has it: a
 * channel's settings follow it to the slot it went to, and those of a channel
 * that found no slot are left out.
 */
export function movedSettings(settings: Record<string, unknown>, slots: Readonly<Record<number, number>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(settings)) {
    // A chat's setting is `<key>:<chat>`, a pin `pin:<radio>/<chat>`.
    const match = /^([^:]+:(?:[0-9a-f]+\/)?)(ch:\d+)$/.exec(name);
    if (!match) {
      out[name] = value;
      continue;
    }
    const moved = movedConversation(match[2]!, slots);
    if (moved) out[match[1] + moved] = value;
  }
  return out;
}
