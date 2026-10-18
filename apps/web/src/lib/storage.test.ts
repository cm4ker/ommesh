import { test } from "node:test";
import assert from "node:assert/strict";
import type { MessageRecord, PersistedState } from "@meshnet/meshcore";
import { IndexedDbStorage } from "./storage.js";

/** A key range as the fake store reads one. */
class FakeRange {
  constructor(
    readonly lower: string,
    readonly upper: string,
    readonly lowerOpen: boolean,
    readonly upperOpen: boolean,
  ) {}
  static bound(lower: string, upper: string, lowerOpen = false, upperOpen = false): FakeRange {
    return new FakeRange(lower, upper, lowerOpen, upperOpen);
  }
  includes(key: string): boolean {
    return (this.lowerOpen ? key > this.lower : key >= this.lower) && (this.upperOpen ? key < this.upper : key <= this.upper);
  }
}

/**
 * A stand-in for IndexedDB over a map. Every transaction is handed to the test to complete or
 * abort, or completes by itself with `auto`; `writes` lists each put and delete, by key.
 */
function fakeIndexedDb(t: { after: (fn: () => void) => void }, records: Record<string, unknown> = {}, auto = false) {
  const transactions: IDBTransaction[] = [];
  const data = new Map<string, unknown>(Object.entries(records));
  const writes: string[] = [];
  let opens = 0;
  const done = <T>(result: T) => ({ result, error: null }) as unknown as IDBRequest<T>;
  const matching = (query: string | FakeRange) => [...data.keys()].sort().filter((k) => (typeof query === "string" ? k === query : query.includes(k)));
  const store = {
    get: (key: string) => done(structuredClone(data.get(key))),
    getAll: (range: FakeRange) => done(matching(range).map((k) => structuredClone(data.get(k)))),
    getAllKeys: () => done([...data.keys()].sort()),
    put: (value: unknown, key: string) => {
      writes.push(`put ${key}`);
      data.set(key, structuredClone(value));
      return done(key);
    },
    delete: (query: string | FakeRange) => {
      writes.push(`delete ${typeof query === "string" ? query : `${query.lower}..`}`);
      for (const key of matching(query)) data.delete(key);
      return done(undefined);
    },
  };
  const db = {
    version: 1,
    objectStoreNames: { contains: () => true },
    close: () => undefined,
    transaction: () => {
      const tx = { error: null, objectStore: () => store } as unknown as IDBTransaction;
      transactions.push(tx);
      if (auto) setImmediate(() => tx.oncomplete?.(new Event("complete")));
      return tx;
    },
  };
  const oldDb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const oldRange = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
  Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: FakeRange });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open: () => {
        opens++;
        const opening = { result: db, onsuccess: () => {} };
        queueMicrotask(() => opening.onsuccess());
        return opening;
      },
    },
  });
  t.after(() => {
    if (oldDb) Object.defineProperty(globalThis, "indexedDB", oldDb);
    else Reflect.deleteProperty(globalThis, "indexedDB");
    if (oldRange) Object.defineProperty(globalThis, "IDBKeyRange", oldRange);
    else Reflect.deleteProperty(globalThis, "IDBKeyRange");
  });
  return { transactions, data, writes, opens: () => opens };
}

/** A history with `count` messages, numbered from 0. */
function history(count: number, from = 0): PersistedState {
  const messages = Array.from({ length: count }, (_, i) => ({ id: `m${from + i}`, text: `text ${from + i}`, receivedAt: from + i }) as unknown as MessageRecord);
  return { contacts: {}, contactsCursor: 0, removed: {}, channels: [], messages, unread: {} };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("history save waits for transaction commit, tries a rolled-back one once more, then rejects", async (t) => {
  const idb = fakeIndexedDb(t);
  const storage = new IndexedDbStorage();
  let saved = false;
  const saving = storage.save("radio", history(1)).then(() => {
    saved = true;
  });
  await settle();
  assert.equal(saved, false);
  idb.transactions.at(-1)!.oncomplete!(new Event("complete"));
  await saving;
  assert.equal(saved, true);

  const rollback = storage.save("radio", history(2));
  const rejected = assert.rejects(rollback, /aborted/);
  await settle();
  idb.transactions.at(-1)!.onabort!(new Event("abort"));
  // The second try goes over a new connection.
  await settle();
  assert.equal(idb.opens(), 2);
  idb.transactions.at(-1)!.onabort!(new Event("abort"));
  await rejected;
});

test("a history that cannot be read rejects, rather than reading as none", async (t) => {
  const idb = fakeIndexedDb(t);
  const storage = new IndexedDbStorage();
  const loading = assert.rejects(storage.load("radio"), /aborted/);
  await settle();
  idb.transactions.at(-1)!.onabort!(new Event("abort"));
  await settle();
  idb.transactions.at(-1)!.onabort!(new Event("abort"));
  await loading;
});

test("a read that fails on a lost connection succeeds on a new one", async (t) => {
  const idb = fakeIndexedDb(t, { radio: { messages: [] } });
  const storage = new IndexedDbStorage();
  const loading = storage.load("radio");
  await settle();
  idb.transactions.at(-1)!.onerror!(new Event("error"));
  await settle();
  idb.transactions.at(-1)!.oncomplete!(new Event("complete"));
  assert.deepEqual(await loading, { messages: [] });
  assert.equal(idb.opens(), 2);
});

test("a history is kept as a head and parts of its messages, and a save writes only what changed", async (t) => {
  const idb = fakeIndexedDb(t, {}, true);
  const storage = new IndexedDbStorage();
  assert.equal(await storage.load("radio"), null);
  const first = history(450);
  await storage.save("radio", first);
  assert.deepEqual(idb.writes.splice(0), ["delete messages:radio:..", "delete radio", "put messages:radio:000000", "put messages:radio:000001", "put messages:radio:000002", "put history:radio"]);

  // One more message: the last part, and nothing else, as the head is the same.
  const next = { ...first, messages: [...first.messages, ...history(1, 450).messages] };
  await storage.save("radio", next);
  assert.deepEqual(idb.writes.splice(0), ["put messages:radio:000002"]);
  // Nothing changed: nothing written, not even a transaction.
  const before = idb.transactions.length;
  await storage.save("radio", { ...next });
  assert.equal(idb.transactions.length, before);
  // A change to the head alone.
  await storage.save("radio", { ...next, unread: { "ch:0": 1 } });
  assert.deepEqual(idb.writes.splice(0), ["put history:radio"]);

  // Read again elsewhere, it comes back whole and in order, and a save of the same writes nothing.
  const again = new IndexedDbStorage();
  const read = await again.load("radio");
  assert.deepEqual(read!.messages.map((m) => m.id), next.messages.map((m) => m.id));
  assert.deepEqual(read!.unread, { "ch:0": 1 });
  assert.equal("parts" in read!, false);
  await again.save("radio", { ...read!, messages: read!.messages.map((m) => ({ ...m })) });
  assert.deepEqual(idb.writes.splice(0), []);

  // Fewer messages: the parts past the last go.
  await again.save("radio", { ...read!, messages: read!.messages.slice(0, 150) });
  assert.deepEqual(idb.writes.splice(0), ["delete messages:radio:000001", "delete messages:radio:000002", "put messages:radio:000000", "put history:radio"]);
  assert.deepEqual(await storage.listRadios(), ["radio"]);
  await storage.forget("radio");
  assert.deepEqual([...idb.data.keys()], []);
});

test("a history kept whole by an older build is read, and the first save replaces it", async (t) => {
  const old = history(3);
  const idb = fakeIndexedDb(t, { radio: old, "log:app": [] }, true);
  const storage = new IndexedDbStorage();
  assert.deepEqual(await storage.listRadios(), ["radio"]);
  const read = await storage.load("radio");
  assert.deepEqual(read, old);
  await storage.save("radio", read!);
  assert.deepEqual([...idb.data.keys()].sort(), ["history:radio", "log:app", "messages:radio:000000"]);
  assert.deepEqual((await new IndexedDbStorage().load("radio"))!.messages, old.messages);
});

test("a part missing from a history is left out, and the next save writes it all afresh", async (t) => {
  const idb = fakeIndexedDb(t, {}, true);
  const storage = new IndexedDbStorage();
  await storage.save("radio", history(450));
  idb.data.delete("messages:radio:000001");
  idb.writes.length = 0;
  const read = await new IndexedDbStorage().load("radio");
  assert.deepEqual(read!.messages.map((m) => m.id), [...history(200).messages, ...history(50, 400).messages].map((m) => m.id));
  const again = new IndexedDbStorage();
  const shown = (await again.load("radio"))!;
  await again.save("radio", shown);
  assert.deepEqual(idb.writes.splice(0), ["delete messages:radio:..", "delete radio", "put messages:radio:000000", "put messages:radio:000001", "put history:radio"]);
});
