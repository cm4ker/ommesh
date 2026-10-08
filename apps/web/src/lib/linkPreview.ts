/**
 * Link previews: what a link in a message leads to, shown as a card under the
 * text. The app fetches it, not the sender's, and nothing of it goes on air,
 * so each reader decides: never (the default), on a tap of the mark after the
 * link, or at once for every link that comes on screen. The last tells a site
 * the reader's address and that they are reading now, and is chosen by hand.
 *
 * A preview once made is kept on the device for a week (IndexedDB), so the
 * same link in another message, or after a restart, shows without asking the
 * site again. Fetches go one at a time; those made by themselves at most
 * twenty a minute, only over HTTPS, and only for links still on screen, so a
 * channel flooded with links costs little and makes the readers no crowd.
 */

import { useSyncExternalStore } from "react";
import { t } from "../i18n/index.js";
import { linkFetch, linkFetchAvailable, Refused } from "./linkFetch.js";
import { autoAllowed, decodePage, fileOf, isPage, isPicture, linkAllowed, mimeOf, pictureFits, pictureSize, type Preview, readHead, shownHost } from "./linkPreviewParse.js";
import { readSetting, writeSetting } from "./storage.js";
import { toast } from "./toast.js";

export type PreviewMode = "off" | "tap" | "auto";

/** Where a link's preview stands. */
export type Entry =
  | { state: "loading" }
  | { state: "shown"; preview: Preview; picture: string | null }
  /** The address answered with nothing to show. */
  | { state: "none" }
  | { state: "failed"; reason: string };

const MODE_KEY = "meshnet.linkPreview";
const AUTO_PER_MINUTE = 20;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DB_NAME = "meshnet-previews";
const STORE = "previews";
const LIMIT = 500;

let mode: PreviewMode | null = null;
const modeListeners = new Set<() => void>();

const entries = new Map<string, Entry>();
/** Previews folded away by a tap, by message and link: a fold is the reader's, for that message only. */
const folded = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
/** How many marks of each link are on screen, for the fetches made by themselves. */
const visible = new Map<string, number>();
const peeked = new Set<string>();

export function previewMode(): PreviewMode {
  mode ??= linkFetchAvailable() ? readSetting<PreviewMode>(MODE_KEY, "off") : "off";
  return mode;
}

export function setPreviewMode(next: PreviewMode): void {
  mode = next;
  writeSetting(MODE_KEY, next);
  if (next !== "auto") queue.splice(0, queue.length, ...queue.filter((job) => job.manual));
  for (const listener of modeListeners) listener();
}

export function usePreviewMode(): PreviewMode {
  return useSyncExternalStore(
    (listener) => {
      modeListeners.add(listener);
      return () => modeListeners.delete(listener);
    },
    previewMode,
  );
}

function notify(href: string): void {
  for (const listener of listeners.get(href) ?? []) listener();
}

function subscribe(href: string, listener: () => void): () => void {
  let set = listeners.get(href);
  if (!set) listeners.set(href, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(href);
  };
}

const foldKey = (message: string, href: string) => `${message}\n${href}`;

/** The link's preview, and whether this message has it folded away. */
export function useLinkPreview(href: string, message: string): { entry: Entry | undefined; folded: boolean } {
  const entry = useSyncExternalStore(
    (listener) => subscribe(href, listener),
    () => entries.get(href),
  );
  const isFolded = useSyncExternalStore(
    (listener) => subscribe(href, listener),
    () => folded.has(foldKey(message, href)),
  );
  return { entry, folded: isFolded };
}

/** The mark after a link was tapped: shows the preview, folds it away, or tries again. */
export function tapLink(href: string, message: string): void {
  const entry = entries.get(href);
  const key = foldKey(message, href);
  if (entry?.state === "shown") {
    if (folded.has(key)) folded.delete(key);
    else folded.add(key);
    notify(href);
    return;
  }
  if (entry?.state === "loading") return;
  if (entry?.state === "none") {
    toast(t("chats.preview.none"));
    return;
  }
  folded.delete(key);
  void request(href, true);
}

/**
 * A mark came on screen or left it. On screen, a preview kept on the device
 * shows at once; with previews at once, a missing one is asked for.
 */
export function markSeen(href: string, on: boolean): void {
  const count = (visible.get(href) ?? 0) + (on ? 1 : -1);
  if (count > 0) visible.set(href, count);
  else visible.delete(href);
  if (!on) return;
  if (previewMode() === "auto" && autoAllowed(href)) void request(href, false);
  else peek(href);
}

/** Shows a preview this device already has, without asking the site. */
function peek(href: string): void {
  if (peeked.has(href) || entries.has(href)) return;
  peeked.add(href);
  void readCache(href).then((stored) => {
    if (stored && !entries.has(href)) {
      entries.set(href, fromStored(stored));
      notify(href);
    }
  });
}

async function request(href: string, manual: boolean): Promise<void> {
  if (!linkAllowed(href)) return;
  const entry = entries.get(href);
  if (entry && (entry.state !== "failed" || !manual)) return;
  entries.set(href, { state: "loading" });
  notify(href);
  const stored = await readCache(href);
  if (stored) {
    entries.set(href, fromStored(stored));
    notify(href);
    return;
  }
  queue[manual ? "unshift" : "push"]({ href, manual });
  void pump();
}

const queue: { href: string; manual: boolean }[] = [];
const autoTimes: number[] = [];
let running = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      // A tap goes first and at once; the rest within their allowance a minute.
      const tapped = queue.findIndex((job) => job.manual);
      let job: { href: string; manual: boolean };
      if (tapped >= 0) {
        job = queue.splice(tapped, 1)[0]!;
      } else {
        while (autoTimes.length && Date.now() - autoTimes[0]! > 60_000) autoTimes.shift();
        if (autoTimes.length >= AUTO_PER_MINUTE) {
          await sleep(1000);
          continue;
        }
        job = queue.shift()!;
        // Scrolled away while it waited, or previews were turned down: not asked after all.
        if (!visible.has(job.href) || previewMode() !== "auto") {
          entries.delete(job.href);
          notify(job.href);
          continue;
        }
        autoTimes.push(Date.now());
      }
      await load(job.href, job.manual);
    }
  } finally {
    running = false;
  }
}

async function load(href: string, manual: boolean): Promise<void> {
  try {
    const made = await build(href);
    void writeCache({ key: href, at: Date.now(), preview: made?.preview ?? null, picture: made?.picture ?? null }).catch(() => undefined);
    entries.set(href, made ? { state: "shown", preview: made.preview, picture: made.picture ? pictureUrl(made.picture) : null } : { state: "none" });
    if (!made && manual) toast(t("chats.preview.none"));
  } catch (error) {
    const reason = error instanceof Refused ? error.reason : "network";
    entries.set(href, { state: "failed", reason });
    if (manual) toast(refusalText(reason), "error");
  }
  notify(href);
}

interface Picture {
  type: string;
  bytes: ArrayBuffer;
}

function pictureUrl(picture: Picture): string {
  return URL.createObjectURL(new Blob([picture.bytes], { type: picture.type }));
}

/** A picture's own bytes, if they are a picture small enough to decode; its kind from the bytes, never from what the site says. */
function pictureOf(body: Uint8Array): Picture | null {
  const size = body.length ? pictureSize(body) : null;
  if (!size || !pictureFits(size)) return null;
  return { type: size.type, bytes: body.slice().buffer };
}

async function build(href: string): Promise<{ preview: Preview; picture: Picture | null } | null> {
  const page = await linkFetch(href, false);
  const mime = mimeOf(page.contentType);
  const host = shownHost(page.url);
  const blank = { host, title: "", description: "", image: null, large: false, video: false, duration: null, file: null };
  if (isPicture(mime)) {
    const picture = page.cut ? null : pictureOf(page.body);
    if (picture) return { preview: { ...blank, kind: "picture" }, picture };
    return { preview: { ...blank, kind: "file", file: fileOf(page.url, page.disposition, page.contentType, page.length) }, picture: null };
  }
  if (!isPage(mime)) return { preview: { ...blank, kind: "file", file: fileOf(page.url, page.disposition, page.contentType, page.length) }, picture: null };
  const head = readHead(decodePage(page.body, page.contentType), page.url);
  if (!head.title && !head.description) return null;
  let picture: Picture | null = null;
  if (head.image && linkAllowed(head.image)) {
    try {
      picture = pictureOf((await linkFetch(head.image, true)).body);
    } catch {
      // A page whose picture does not come is shown without it.
    }
  }
  return { preview: { ...blank, kind: "page", ...head }, picture };
}

/** What a refusal says to the reader who tapped. */
export function refusalText(reason: string): string {
  if (reason === "address") return t("chats.preview.address");
  if (reason === "redirects") return t("chats.preview.redirects");
  if (reason === "timeout") return t("chats.preview.timeout");
  const status = /^status (\d+)/.exec(reason);
  if (status) return t("chats.preview.status", { code: status[1]! });
  return t("chats.preview.network");
}

interface Stored {
  key: string;
  at: number;
  preview: Preview | null;
  picture: Picture | null;
}

function fromStored(stored: Stored): Entry {
  return stored.preview ? { state: "shown", preview: stored.preview, picture: stored.picture ? pictureUrl(stored.picture) : null } : { state: "none" };
}

let database: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("at", "at");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readCache(href: string): Promise<Stored | null> {
  try {
    const db = await open();
    const stored = await done(db.transaction(STORE).objectStore(STORE).get(href) as IDBRequest<Stored | undefined>);
    return stored && Date.now() - stored.at < MAX_AGE_MS ? stored : null;
  } catch {
    return null;
  }
}

let writes = 0;

async function writeCache(stored: Stored): Promise<void> {
  const db = await open();
  await done(db.transaction(STORE, "readwrite").objectStore(STORE).put(stored));
  if (++writes % 50 === 0) await prune(db);
}

/** Drops the previews made longest ago once there are more than the limit. */
async function prune(db: IDBDatabase): Promise<void> {
  const store = db.transaction(STORE, "readwrite").objectStore(STORE);
  const count = await done(store.count());
  let excess = count - Math.floor(LIMIT * 0.9);
  if (count <= LIMIT || excess <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const cursor = store.index("at").openCursor();
    cursor.onsuccess = () => {
      const at = cursor.result;
      if (!at || excess-- <= 0) return resolve();
      at.delete();
      at.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
}
