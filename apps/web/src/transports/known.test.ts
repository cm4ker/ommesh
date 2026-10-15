import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { knownList } from "./known.js";
import type { FoundDevice } from "./types.js";

function storage(t: TestContext): void {
  const kept = new Map<string, string>();
  const value = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
  const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value, configurable: true, writable: true });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, "localStorage", before);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });
}

const device = (id: string, name: string): FoundDevice => ({ id, name, detail: null, rssi: null });
const ids = (list: FoundDevice[]) => list.map((d) => d.id);

test("a radio back at a new address lets its old one go", (t) => {
  storage(t);
  const known = knownList("test.known", "ble");
  known.remember(device("E5", "MeshCore-Wan11"));
  known.identify("E5", "aa");
  known.remember(device("AC", "MeshCore-Wan4"));
  known.identify("AC", "bb");
  known.remember(device("CE", "MeshCore-Wan11"));
  known.identify("CE", "aa");
  assert.deepEqual(ids(known.list()), ["CE", "AC"]);
  assert.equal(known.list()[0]!.radioKey, "aa");
});

test("an entry from before keys were kept is matched by its name", (t) => {
  storage(t);
  const known = knownList("test.known", "ble");
  known.remember(device("E5", "MeshCore-Wan11"));
  known.remember(device("C0", "MeshCore-Wan8"));
  known.remember(device("CE", "MeshCore-Wan11"));
  known.identify("CE", "aa");
  assert.deepEqual(ids(known.list()), ["CE", "C0"]);
});

test("a phone sharing the radio stays beside the radio itself", (t) => {
  storage(t);
  const known = knownList("test.known", "ble");
  known.remember(device("P1", "Ommesh Wan11"));
  known.identify("P1", "aa");
  known.remember(device("CE", "MeshCore-Wan11"));
  known.identify("CE", "aa");
  assert.deepEqual(ids(known.list()), ["CE", "P1"]);
});

test("a search's device keeps the radio its address was known as", (t) => {
  storage(t);
  const known = knownList("test.known", "ble");
  known.remember(device("CE", "MeshCore-Wan11"));
  known.identify("CE", "aa");
  known.remember(device("CE", "MeshCore-Wan11"));
  assert.equal(known.list()[0]!.radioKey, "aa");
});

test("forget takes one device off", (t) => {
  storage(t);
  const known = knownList("test.known", "ble");
  known.remember(device("E5", "MeshCore-Wan11"));
  known.remember(device("AC", "MeshCore-Wan4"));
  known.forget("E5");
  assert.deepEqual(ids(known.list()), ["AC"]);
});
