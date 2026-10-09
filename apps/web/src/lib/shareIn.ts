/**
 * Text another app shares to Ommesh (#88): a link from a browser, a line from
 * a note. The phone's share sheet hands it to the shell (the SEND intent on
 * Android, the share extension on iOS), and a browser that installed the page
 * hands it in the address (the manifest's share target). Shared to one of the
 * chats the sheet offers by name, it opens that chat; shared to the app, it
 * waits over the chat list until a chat is opened. Either way it goes into the
 * chat's message field, to be read over and sent there: nothing goes on the
 * air by itself.
 */

import { useSyncExternalStore } from "react";
import { chatAccess } from "./channels.js";
import { askChat } from "./chatAsk.js";
import { getPins, subscribePins } from "./chatPins.js";
import { summarize } from "./conversations.js";
import { isWide } from "./layout.js";
import { getNav, openConversation, setStack, shownConversation, subscribeNav } from "./nav.js";
import { isCapacitor } from "./platform.js";
import { session } from "./session.js";
import { shareTargets } from "./shareTargets.js";

/** What a share carries: apps fill in different parts, a browser the page's title and its address. */
export interface Shared {
  title?: string | null;
  text?: string | null;
  url?: string | null;
  /** The chat it was shared to, when the sheet offered it by name. */
  chat?: string | null;
}

/**
 * The message a share makes: what was written, and the address after it when
 * the text does not hold it already; the title only when there is nothing
 * else, since a mesh message has room for little.
 */
export function sharedText(shared: Shared): string {
  const text = shared.text?.trim() ?? "";
  const url = shared.url?.trim() ?? "";
  const both = url && !text.includes(url) ? [text, url].filter(Boolean).join(" ") : text;
  return both || shared.title?.trim() || "";
}

let pending: string | null = null;
const listeners = new Set<() => void>();

function set(next: string | null): void {
  pending = next;
  for (const listener of listeners) listener();
}

/** A chat of this radio that can be opened: one offered for another radio may not be. */
function known(chat: string | null | undefined): chat is string {
  return !!chat && summarize(session.getState()).some((row) => row.id === chat);
}

/**
 * A share has come: the chat it was shared to opens, or the chat list comes
 * up, a phone's over whatever chat was open, for a chat to be picked. A chat
 * the phone offers outside a share (Android's app shortcuts) only opens.
 */
export function receiveShared(shared: Shared): void {
  const text = sharedText(shared);
  const chat = known(shared.chat) ? shared.chat : null;
  if (!text && !chat) return;
  setStack("chats", []);
  if (text) set(text);
  if (chat) openConversation(chat);
}

export function dropShared(): void {
  set(null);
}

export function useShared(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pending,
  );
}

/** The parts of the address a browser puts a share in (manifest.webmanifest). */
const PARAMS = { title: "share-title", text: "share-text", url: "share-url" } as const;

interface OfferedChat {
  id: string;
  title: string;
  /** A PNG, base64. */
  icon: string;
}

interface ShareInPlugin {
  take(): Promise<Shared>;
  offer(options: { chats: OfferedChat[] }): Promise<void>;
  addListener(event: "shared", listener: () => void): Promise<unknown>;
}

/**
 * Listens for shares, once, as the app starts. A chat opened while one waits,
 * whichever way it was opened, takes it. The shell keeps a share that came
 * before the page was ready until the page takes it.
 */
export function startShareIn(): () => void {
  const stop = subscribeNav(() => {
    if (pending === null) return;
    const conversation = shownConversation(getNav(), isWide());
    if (!conversation) return;
    const text = pending;
    set(null);
    askChat({ conversation, kind: "share", text });
  });

  const params = new URLSearchParams(location.search);
  if (Object.values(PARAMS).some((p) => params.has(p))) {
    const shared = { title: params.get(PARAMS.title), text: params.get(PARAMS.text), url: params.get(PARAMS.url) };
    for (const p of Object.values(PARAMS)) params.delete(p);
    // Off the address, so a reload does not share it again. A bare flag such as ?demo stays bare, not ?demo=.
    const query = params.toString().replace(/=(?=&|$)/g, "");
    history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
    receiveShared(shared);
  }

  if (isCapacitor()) void listenNative();
  return stop;
}

let listening = false;

async function listenNative(): Promise<void> {
  if (listening) return;
  listening = true;
  const { registerPlugin } = await import("@capacitor/core");
  const plugin = registerPlugin<ShareInPlugin>("ShareIn");
  const take = () =>
    plugin
      .take()
      .then((shared) => receiveShared(shared))
      .catch(() => undefined);
  await plugin.addListener("shared", () => void take()).catch(() => undefined);
  await take();
  offerChats(plugin);
}

/** How long the chats offered wait after a change: a burst of messages makes one offer. */
const OFFER_WAIT = 2000;

/**
 * Tells the shell which chats the share sheet offers by name, each time they
 * change: Android makes them sharing shortcuts, iOS conversations it suggests.
 */
function offerChats(plugin: ShareInPlugin): void {
  let offered = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const offer = async () => {
    timer = null;
    const state = session.getState();
    const radio = state.self?.key;
    if (!radio) return;
    const targets = shareTargets(summarize(state), getPins(radio, state.channels), state.messages);
    const seen = `${radio}|${targets.map((row) => `${row.id}=${row.title}`).join("|")}`;
    if (seen === offered) return;
    offered = seen;
    const { avatarImage } = await import("./avatarImage.js");
    const chats = await Promise.all(
      targets.map(async (row) => ({
        id: row.id,
        title: row.title,
        icon: await avatarImage({ name: row.title, type: row.contact?.type, channel: row.kind === "channel" ? chatAccess(row.id, row.channel) : undefined }),
      })),
    );
    await plugin.offer({ chats });
  };
  const later = () => {
    timer ??= setTimeout(() => void offer().catch(() => (offered = "")), OFFER_WAIT);
  };
  session.subscribe(later);
  subscribePins(later);
  later();
}
