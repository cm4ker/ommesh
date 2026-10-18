/**
 * Where history lives: IndexedDB, in one store of records by key. A radio's
 * history is a head (`history:<radio>`) and its messages in parts
 * (`messages:<radio>:<n>`), so a save writes only what changed (see
 * `historyParts.ts`). Builds before that kept it whole under the radio's key;
 * such a record is read as it is and replaced by the first save.
 *
 * Settings that are not per-radio (the remembered link, the theme) are in
 * `localStorage`, read synchronously before the first paint.
 */

import type { MessageRecord, PersistedState, SessionStorage } from "@meshnet/meshcore";
import { t } from "../i18n/index.js";
import { assemble, planSave, type Head, type Layout } from "./historyParts.js";
import { isCapacitor } from "./platform.js";

const DB_NAME = "meshnet";
const STORE = "radios";

/**
 * Opened at whatever version it is (1 when new), so an older build reads it as
 * well. A database without the store, as one opened by some other code at 1
 * would be, is opened once more a version up to add it.
 */
function openDb(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(STORE)) return resolve(db);
      const next = db.version + 1;
      db.close();
      resolve(openDb(next));
    };
    request.onerror = () => reject(request.error ?? new Error(t("connect.error.dbOpen")));
  });
}

/**
 * One transaction: `op` puts its requests on the store, all at once, and `read`
 * takes their results once it has committed. A successful request can still be
 * rolled back, so nothing is taken before the commit.
 */
function run<R, T>(db: IDBDatabase, mode: IDBTransactionMode, op: (store: IDBObjectStore) => R, read: (requests: R) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const requests = op(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(read(requests));
    tx.onabort = () => reject(tx.error ?? new Error(t("connect.error.dbAborted")));
    tx.onerror = () => reject(tx.error ?? new Error(t("connect.error.dbFailed")));
  });
}

const headKey = (radio: string) => `history:${radio}`;
/** A part's number is padded, so the parts sort in order. */
const partKey = (radio: string, n: number) => `messages:${radio}:${String(n).padStart(6, "0")}`;
/** Every part of a radio's messages: their keys run up to the same radio's with ";", the next character after ":". */
const allParts = (radio: string) => IDBKeyRange.bound(`messages:${radio}:`, `messages:${radio};`, false, true);

let keepAsked = false;

/**
 * Asks the web view to keep the history through a shortage of space, when WebKit
 * clears the storage of the sites least used. Only in the phone shell: a browser
 * may put the question to its user.
 */
function askToKeep(): void {
  if (keepAsked || typeof window === "undefined" || !isCapacitor()) return;
  keepAsked = true;
  void navigator.storage?.persist?.().catch(() => false);
}

/**
 * One connection, opened when first needed and opened again when it is lost.
 * iOS closes a web view's database connections while the app is in the
 * background; the connection kept from before then fails every request with
 * "Connection to Indexed Database server lost" until the app restarts.
 */
export class IndexedDbStorage implements SessionStorage {
  private db: Promise<IDBDatabase> | null = null;
  /** What is stored for each radio, as last read or written here; a radio not in it is written afresh. */
  private layouts = new Map<string, Layout>();

  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    askToKeep();
    const opening = openDb().then((db) => {
      const lost = () => {
        if (this.db === opening) this.db = null;
      };
      db.onclose = lost;
      db.onversionchange = () => {
        db.close();
        lost();
      };
      return db;
    });
    opening.catch(() => {
      if (this.db === opening) this.db = null;
    });
    this.db = opening;
    return opening;
  }

  /** Once on the connection held, and once more on a new one if that fails. */
  private async request<R, T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => R, read: (requests: R) => T): Promise<T> {
    const first = this.open();
    try {
      return await run(await first, mode, op, read);
    } catch {
      if (this.db === first) this.db = null;
      void first.then((db) => db.close()).catch(() => undefined);
      return run(await this.open(), mode, op, read);
    }
  }

  /** Null when nothing is stored for the radio; a history that cannot be read rejects, so it is not taken for none. */
  async load(radioKey: string): Promise<PersistedState | null> {
    this.layouts.delete(radioKey);
    for (let attempt = 0; ; attempt++) {
      const [head, whole] = await this.request(
        "readonly",
        (s) => [s.get(headKey(radioKey)), s.get(radioKey)] as const,
        ([head, whole]) => [head.result as Head | undefined, whole.result as PersistedState | undefined] as const,
      );
      if (!head) return whole ?? null;
      // Part by part, each its own answer: all in one would be the whole history at once again.
      const parts = await this.request(
        "readonly",
        (s) => Array.from({ length: head.parts }, (_, n) => s.get(partKey(radioKey, n))),
        (requests) => requests.map((r) => r.result as MessageRecord[] | undefined),
      );
      const found = parts.filter((part): part is MessageRecord[] => part !== undefined);
      // A save between the two reads can leave a part missing: read again. Missing still,
      // what is there is shown, and the next save writes the whole history afresh.
      if (found.length < parts.length && attempt === 0) continue;
      const { history, layout } = assemble({ ...head, parts: found.length }, found);
      if (found.length === parts.length) this.layouts.set(radioKey, layout);
      return history;
    }
  }

  async save(radioKey: string, state: PersistedState): Promise<void> {
    const plan = planSave(this.layouts.get(radioKey) ?? null, state);
    if (!plan.head && plan.parts.size === 0 && plan.drop !== "all" && plan.drop.length === 0) return;
    // Not known until it commits: a save that fails leaves the next one to write everything.
    this.layouts.delete(radioKey);
    await this.request(
      "readwrite",
      (s) => {
        if (plan.drop === "all") {
          s.delete(allParts(radioKey));
          s.delete(radioKey);
        } else {
          for (const n of plan.drop) s.delete(partKey(radioKey, n));
        }
        for (const [n, part] of plan.parts) s.put(part, partKey(radioKey, n));
        if (plan.head) s.put(plan.head, headKey(radioKey));
      },
      () => undefined,
    );
    this.layouts.set(radioKey, plan.layout);
  }

  async forget(radioKey: string): Promise<void> {
    this.layouts.delete(radioKey);
    await this.request(
      "readwrite",
      (s) => {
        s.delete(allParts(radioKey));
        s.delete(headKey(radioKey));
        s.delete(radioKey);
      },
      () => undefined,
    );
  }

  async listRadios(): Promise<string[]> {
    const keys = await this.request("readonly", (s) => s.getAllKeys(), (r) => r.result);
    // A history's head is `history:<radio>`; one kept whole by an older build is under the radio's key,
    // which is hex. Other records kept beside the histories carry a prefix and a colon.
    const radios = new Set<string>();
    for (const key of keys.map(String)) {
      if (key.startsWith("history:")) radios.add(key.slice("history:".length));
      else if (!key.includes(":")) radios.add(key);
    }
    return [...radios];
  }

  /** A record kept beside the histories, under a key of the form `what:radio`; null when there is none. */
  async loadExtra(key: string): Promise<unknown> {
    return (await this.request("readonly", (s) => s.get(key), (r) => r.result as unknown)) ?? null;
  }

  async saveExtra(key: string, value: unknown): Promise<void> {
    await this.request("readwrite", (s) => s.put(value, key), () => undefined);
  }
}

const writtenListeners = new Set<() => void>();

/** Told after every setting written, for what follows them all: the settings shared with another app (`sharedSettings.ts`). */
export function onSettingWritten(listener: () => void): () => void {
  writtenListeners.add(listener);
  return () => writtenListeners.delete(listener);
}

/** For a store that writes its `localStorage` slot itself rather than through `writeSetting`. */
export function settingWritten(): void {
  for (const listener of writtenListeners) listener();
}

/** A `localStorage` slot with a JSON value, tolerant of private windows. */
export function readSetting<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeSetting<T>(key: string, value: T | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private window: the setting lives for this page only.
  }
  settingWritten();
}
