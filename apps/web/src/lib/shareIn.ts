/**
 * Text another app shares to Ommesh (#88): a link from a browser, a line from
 * a note. The phone's share sheet hands it to the shell (the SEND intent on
 * Android, the share extension on iOS), and a browser that installed the page
 * hands it in the address (the manifest's share target). It waits over the
 * chat list until a chat is opened, then goes into that chat's message field,
 * to be read over and sent there: nothing goes on the air by itself.
 */

import { useSyncExternalStore } from "react";
import { askChat } from "./chatAsk.js";
import { isWide } from "./layout.js";
import { getNav, setStack, shownConversation, subscribeNav } from "./nav.js";
import { isCapacitor } from "./platform.js";

/** What a share carries: apps fill in different parts, a browser the page's title and its address. */
export interface Shared {
  title?: string | null;
  text?: string | null;
  url?: string | null;
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

/** A share has come: the chat list comes up, a phone's over whatever chat was open, for a chat to be picked. */
export function receiveShared(shared: Shared): void {
  const text = sharedText(shared);
  if (!text) return;
  setStack("chats", []);
  set(text);
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

interface ShareInPlugin {
  take(): Promise<Shared>;
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
    // Off the address, so a reload does not share it again.
    // A bare flag such as ?demo stays bare, not ?demo=.
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
}
