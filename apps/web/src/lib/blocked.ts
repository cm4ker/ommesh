/**
 * Senders kept out of sight (#114). A channel message carries no key, only the
 * name its writer put before the colon, so on channels a name is blocked: every
 * radio that writes under it, letter case and lookalike letters aside. A room
 * signs each post with its author's key, so in rooms the author is blocked by
 * key, under whatever name. Their messages stay in the history, folded away in
 * the chat; they count toward no unread and ring no notice, here or in the
 * phone's radio core (`blocked` in `watch.rs`).
 *
 * The list is the reader's, for every radio: a spammer is the same on each. Two
 * apps sharing a radio keep it alike (`sharedSettings.ts`), or the read marks
 * they tell each other would count different messages.
 */

import { useSyncExternalStore } from "react";
import { parseConversation, TxtType, type MessageRecord } from "@meshnet/meshcore";
import { readSetting, writeSetting } from "./storage.js";
import { toast } from "./toast.js";
import { t } from "../i18n/index.js";

export interface Block {
  /** The name it was blocked under: the channel name, or the room author's name then. */
  name: string;
  /** When, ms. */
  at: number;
}

/** By id: `n:<name as matched>` for a name on channels, `k:<key prefix>` for a room's author. */
export type Blocks = Record<string, Block>;

const KEY = "meshnet.blocked";
let blocks: Blocks = readSetting<Blocks>(KEY, {});
const listeners = new Set<() => void>();

// The few Cyrillic letters drawn just like a Latin one, as small letters: "Ольга" in Latin O and a
// is still Ольга. The radio core matches the same way (`name_key` in watch.rs): change both together.
const TWIN: Record<string, string> = { а: "a", е: "e", ё: "e", о: "o", р: "p", с: "c", х: "x", і: "i", у: "y" };

/** A name as blocks match it: trimmed, in small letters, with a Cyrillic letter that looks Latin read as Latin. */
export function nameKey(name: string): string {
  let out = "";
  for (const ch of name.trim().toLowerCase()) out += TWIN[ch] ?? ch;
  return out;
}

/** The block that would hide a message's sender: their name on a channel, their key in a room; null for ours and a person's. */
export function blockIdOf(m: MessageRecord): string | null {
  if (m.direction !== "in") return null;
  if (parseConversation(m.conversation).kind === "channel") return m.sender ? `n:${nameKey(m.sender)}` : null;
  // Only a room's post is signed by its author.
  return m.txtType === TxtType.SignedPlain && m.senderPrefix ? `k:${m.senderPrefix}` : null;
}

/** Whether a message is from someone blocked. */
export function isHidden(m: MessageRecord): boolean {
  const id = blockIdOf(m);
  return id !== null && id in blocks;
}

/** Whether a reaction on a channel is from a name blocked there. */
export function reactionHidden(by: string | null): boolean {
  return by !== null && `n:${nameKey(by)}` in blocks;
}

export function getBlocks(): Blocks {
  return blocks;
}

/** Blocks or unblocks one id: null unblocks. The shared settings write the other app's change through here too. */
export function setBlock(id: string, block: Block | null): void {
  if (block ? blocks[id]?.at === block.at && blocks[id]?.name === block.name : !(id in blocks)) return;
  const next = { ...blocks };
  if (block) next[id] = block;
  else delete next[id];
  blocks = next;
  writeSetting(KEY, blocks);
  for (const listener of listeners) listener();
}

/** Blocks one id, or unblocks it if blocked, and says so with a way back. */
export function toggleBlock(id: string, name: string): void {
  const was = blocks[id];
  if (was) {
    setBlock(id, null);
    toast(t("chats.blocked.unblocked", { name }), "", { label: t("common.undo"), run: () => setBlock(id, was) });
  } else {
    setBlock(id, { name, at: Date.now() });
    toast(t("chats.blocked.blocked", { name }), "", { label: t("common.undo"), run: () => setBlock(id, null) });
  }
}

export function subscribeBlocks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBlocks(): Blocks {
  return useSyncExternalStore(subscribeBlocks, () => blocks);
}

/** What the phone's radio core needs to leave them unannounced: the names as matched, and the room authors' keys. */
export function blocksForCore(all: Blocks = blocks): { names: string[]; keys: string[] } {
  const names: string[] = [];
  const keys: string[] = [];
  for (const id of Object.keys(all)) {
    if (id.startsWith("n:")) names.push(id.slice(2));
    else if (id.startsWith("k:")) keys.push(id.slice(2));
  }
  return { names, keys };
}

/** How many messages each block hides, by its id. */
export function hiddenCounts(messages: readonly MessageRecord[], all: Blocks = blocks): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of messages) {
    const id = blockIdOf(m);
    if (id !== null && id in all) out[id] = (out[id] ?? 0) + 1;
  }
  return out;
}

/** Hidden messages one after another in a chat, folded under one strip. */
export interface HiddenRun {
  /** The first message of the run: it names the run, and stays first while more come after it. */
  id: string;
  /** The message in sight just above the run, the strip going under it; null at the top of the chat. */
  after: string | null;
  count: number;
  /** Who they are from, each once, in the order they wrote. */
  names: string[];
}

/** A chat as the reader sees it: the messages drawn, the strips among them, and which drawn ones are hidden ones shown. */
export interface ChatSight {
  messages: MessageRecord[];
  runs: HiddenRun[];
  shown: ReadonlySet<string>;
}

/** Folds a chat's hidden messages into runs; those of a run opened (by its id) stay drawn, marked as shown. */
export function inSight(messages: readonly MessageRecord[], hidden: (m: MessageRecord) => boolean, open: ReadonlySet<string>): ChatSight {
  const drawn: MessageRecord[] = [];
  const runs: HiddenRun[] = [];
  const shown = new Set<string>();
  let run: HiddenRun | null = null;
  for (const m of messages) {
    if (!hidden(m)) {
      run = null;
      drawn.push(m);
      continue;
    }
    if (!run) {
      run = { id: m.id, after: drawn.at(-1)?.id ?? null, count: 0, names: [] };
      runs.push(run);
    }
    run.count++;
    const name = m.sender ?? "?";
    if (!run.names.includes(name)) run.names.push(name);
    if (open.has(run.id)) {
      drawn.push(m);
      shown.add(m.id);
    }
  }
  // Nothing hidden: the same list, so what is worked out from it need not be again.
  return { messages: runs.length ? drawn : (messages as MessageRecord[]), runs, shown };
}
