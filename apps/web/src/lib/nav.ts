/**
 * Where the client is: which of the three sections, and the screens stacked
 * in each over its root (the chat list, the map, the radio). The phone shows
 * the top of the current stack; the desktop lays the same stack out side by
 * side, the conversation in the middle and whatever was opened from it in
 * the panel on the right. One small store, so the tab bar, the rail,
 * notifications and the back gesture all read the same thing. What a Back
 * button does with it is in back.ts.
 */

import { useSyncExternalStore } from "react";
import { readSetting, writeSetting } from "./storage.js";

export type Section = "chats" | "mesh" | "radio";

/** A repeater's, room's or sensor's own screens, past its profile. */
export type NodePage = "neighbours" | "history" | "settings" | "access" | "console";

/** The radio section's pages. */
export type RadioPage = "name" | "frequency" | "readings" | "privacy" | "trusted" | "contacts" | "removed" | "advanced" | "notifications" | "sound" | "soundDirect" | "soundChats" | "soundNodes" | "messages" | "history" | "appearance" | "connection" | "air" | "log" | "power" | "about" | "people";

export type Screen =
  | { kind: "chat"; conversation: string }
  /** How one message travelled: a sheet over its chat on the phone, the panel on the desktop. */
  | { kind: "message"; conversation: string; id: string }
  | { kind: "channel"; index: number }
  /** Who has written in a channel, opened from its page. */
  | { kind: "writers"; index: number }
  /** A place from a message on a map of its own: the message's text, who sent it (null for us) and when. */
  | { kind: "place"; text: string; from: string | null; at: number }
  /** A point put on the map by hand, for the place in a conversation's message field. */
  | { kind: "pickPlace"; conversation: string }
  | { kind: "profile"; key: string }
  | { kind: "node"; key: string; page: NodePage }
  | { kind: "radio"; page: RadioPage };

export interface Nav {
  section: Section;
  stacks: Record<Section, Screen[]>;
  /** The node picked on the map: ringed with its route, and on a desktop its profile beside the map. */
  meshFocus: string | null;
}

const KEY = "meshnet.nav";
const SECTIONS: Section[] = ["chats", "mesh", "radio"];
const EMPTY: Nav = { section: "chats", stacks: { chats: [], mesh: [], radio: [] }, meshFocus: null };

/** What an earlier version saved: one section of seven and one open item in three of them. */
interface OldNav {
  section?: string;
  conversation?: string | null;
  contact?: string | null;
  node?: string | null;
}

function restore(saved: unknown): Nav {
  if (!saved || typeof saved !== "object") return EMPTY;
  const value = saved as Partial<Nav>;
  if (value.stacks && SECTIONS.includes(value.section as Section)) {
    const stacks = { ...EMPTY.stacks };
    // A route was a screen of its own before it moved to the map, and the radio's position became a part of
    // Privacy, which lies under it on the stack; Battery and Sensors became Readings.
    for (const s of SECTIONS)
      if (Array.isArray(value.stacks[s]))
        stacks[s] = value.stacks[s]
          .filter((x) => x && typeof x === "object" && "kind" in x && (x as { kind: string }).kind !== "route" && !(x.kind === "radio" && (x.page as string) === "position"))
          .map((x) => (x.kind === "radio" && ((x.page as string) === "battery" || (x.page as string) === "sensors") ? { kind: "radio", page: "readings" } : x));
    return { section: value.section as Section, stacks, meshFocus: typeof value.meshFocus === "string" ? value.meshFocus : null };
  }
  // Seven sections became three: Contacts, Map and Nodes are Mesh; Settings and Log are Radio.
  const old = saved as OldNav;
  const chats: Screen[] = old.conversation ? [{ kind: "chat", conversation: old.conversation }] : [];
  const mesh: Screen[] = old.section === "nodes" && old.node ? [{ kind: "profile", key: old.node }] : old.section === "contacts" && old.contact ? [{ kind: "profile", key: old.contact }] : [];
  const radio: Screen[] = old.section === "log" ? [{ kind: "radio", page: "log" }] : [];
  const section: Section = old.section === "chats" || old.section === undefined ? "chats" : old.section === "radio" || old.section === "settings" || old.section === "log" ? "radio" : "mesh";
  return { section, stacks: { chats, mesh, radio }, meshFocus: null };
}

let nav: Nav = restore(readSetting<unknown>(KEY, null));
const listeners = new Set<() => void>();

function set(next: Nav): void {
  nav = next;
  writeSetting(KEY, nav);
  for (const listener of listeners) listener();
}

function same(a: Screen | undefined, b: Screen): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

// ---- reading ----

export function getNav(): Nav {
  return nav;
}

export function subscribeNav(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNav(): Nav {
  return useSyncExternalStore(subscribeNav, () => nav);
}

export function topOf(state: Nav, section: Section = state.section): Screen | null {
  return state.stacks[section].at(-1) ?? null;
}

/**
 * The conversation whose messages are on screen: on the phone the chat on
 * top, or under the sheet of one of its messages; on the desktop the chat in
 * the middle, whatever the panel shows.
 */
export function shownConversation(state: Nav, wide: boolean): string | null {
  if (state.section !== "chats") return null;
  const stack = state.stacks.chats;
  if (wide) return stack.find((s): s is Extract<Screen, { kind: "chat" }> => s.kind === "chat")?.conversation ?? null;
  const top = stack.at(-1);
  if (top?.kind === "chat" || top?.kind === "message") return top.conversation;
  return null;
}

// ---- moving ----

/** To a section as it was left; `reset` goes back to its root, as a second tap on its tab does. */
export function goSection(section: Section, reset = false): void {
  set({ ...nav, section, stacks: reset ? { ...nav.stacks, [section]: [] } : nav.stacks, meshFocus: reset && section === "mesh" ? null : nav.meshFocus });
}

/** A screen over the current one, in the current section. */
export function push(screen: Screen): void {
  const stack = nav.stacks[nav.section];
  if (same(stack.at(-1), screen)) return;
  // One message's sheet at a time.
  const base = screen.kind === "message" && stack.at(-1)?.kind === "message" ? stack.slice(0, -1) : stack;
  set({ ...nav, stacks: { ...nav.stacks, [nav.section]: [...base, screen] } });
}

/** Back one screen, if there is one to leave. */
export function back(): void {
  const stack = nav.stacks[nav.section];
  if (stack.length === 0) return;
  set({ ...nav, stacks: { ...nav.stacks, [nav.section]: stack.slice(0, -1) } });
}

/** Everything over the root of a section, replaced. */
export function setStack(section: Section, stack: Screen[], extra: Partial<Nav> = {}): void {
  set({ ...nav, ...extra, section, stacks: { ...nav.stacks, [section]: stack } });
}

export function openConversation(conversation: string | null): void {
  setStack("chats", conversation ? [{ kind: "chat", conversation }] : []);
}

/** A node's profile over wherever this is; a notification or the palette opens it in Mesh. */
export function openProfile(key: string, inMesh = false): void {
  if (inMesh || nav.section === "radio") setStack("mesh", [{ kind: "profile", key }], { meshFocus: key });
  else push({ kind: "profile", key });
}

export function openChannel(index: number): void {
  push({ kind: "channel", index });
}

export function openWriters(index: number): void {
  push({ kind: "writers", index });
}

export function openMessage(conversation: string, id: string): void {
  push({ kind: "message", conversation, id });
}

export function openPlace(text: string, from: string | null, at: number): void {
  push({ kind: "place", text, from, at });
}

export function pickPlace(conversation: string): void {
  push({ kind: "pickPlace", conversation });
}

export function openNodePage(key: string, page: NodePage): void {
  const stack = nav.stacks[nav.section];
  const top = stack.at(-1);
  // A second page replaces the first, so the desktop's tabs do not stack up.
  if (top?.kind === "node" && top.key === key) setStack(nav.section, [...stack.slice(0, -1), { kind: "node", key, page }]);
  else push({ kind: "node", key, page });
}

export function openRadioPage(page: RadioPage): void {
  setStack("radio", [{ kind: "radio", page }]);
}

let listLowered = false;

/** The map, with this node picked on it; `lower` asks a phone's list down, so the map has the room. */
export function showOnMap(key: string, lower = false): void {
  listLowered = lower;
  setStack("mesh", [], { meshFocus: key });
}

/** Whether the list was asked down since last asked; asking clears it. */
export function takeListLowered(): boolean {
  const lowered = listLowered;
  listLowered = false;
  return lowered;
}

export function focusOnMap(key: string | null): void {
  set({ ...nav, meshFocus: key, stacks: key === null ? { ...nav.stacks, mesh: [] } : nav.stacks });
}
