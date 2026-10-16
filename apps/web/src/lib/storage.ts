/**
 * Where history lives: IndexedDB, one record per radio, holding the session's
 * persisted state whole. Messages on a mesh are short and few — thousands, not
 * millions — so one document read at connect and written on a debounce is
 * simpler than a schema, and just as fast.
 *
 * Settings that are not per-radio (the remembered link, the theme) are in
 * `localStorage`, read synchronously before the first paint.
 */

import type { PersistedState, SessionStorage } from "@meshnet/meshcore";
import { t } from "../i18n/index.js";

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

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = op(tx.objectStore(STORE));
    // A successful request can still be rolled back. Installation must wait for the commit.
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error ?? request.error ?? new Error(t("connect.error.dbAborted")));
    tx.onerror = () => reject(tx.error ?? request.error ?? new Error(t("connect.error.dbFailed")));
  });
}

/**
 * One connection, opened when first needed and opened again when it is lost.
 * iOS closes a web view's database connections while the app is in the
 * background; the connection kept from before then fails every request with
 * "Connection to Indexed Database server lost" until the app restarts.
 */
export class IndexedDbStorage implements SessionStorage {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
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
  private async request<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const first = this.open();
    try {
      return await run(await first, mode, op);
    } catch {
      if (this.db === first) this.db = null;
      void first.then((db) => db.close()).catch(() => undefined);
      return run(await this.open(), mode, op);
    }
  }

  /** Null when nothing is stored for the radio; a history that cannot be read rejects, so it is not taken for none. */
  async load(radioKey: string): Promise<PersistedState | null> {
    const value = await this.request<PersistedState | undefined>("readonly", (s) => s.get(radioKey));
    return value ?? null;
  }

  async save(radioKey: string, state: PersistedState): Promise<void> {
    await this.request("readwrite", (s) => s.put(state, radioKey));
  }

  async forget(radioKey: string): Promise<void> {
    await this.request("readwrite", (s) => s.delete(radioKey));
  }

  async listRadios(): Promise<string[]> {
    const keys = await this.request<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
    // Records kept beside a radio's history carry a prefix and a colon; radio keys are hex.
    return keys.map(String).filter((k) => !k.includes(":"));
  }

  /** A record kept beside the histories, under a key of the form `what:radio`; null when there is none. */
  async loadExtra(key: string): Promise<unknown> {
    return (await this.request<unknown>("readonly", (s) => s.get(key))) ?? null;
  }

  async saveExtra(key: string, value: unknown): Promise<void> {
    await this.request("readwrite", (s) => s.put(value, key));
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
