import { test } from "node:test";
import assert from "node:assert/strict";
import { ContactFlag, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import { nodeComparator, orderInForce, pinnedFirst } from "./nodeOrder.js";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function contact(n: number, name: string, heardMinAgo: number, patch: Partial<ContactRecord> = {}): ContactRecord {
  const key = n.toString(16).padStart(2, "0").repeat(32);
  return {
    key,
    prefix: key.slice(0, 12),
    type: 1,
    flags: 0,
    outPathLen: 0xff,
    outPath: "",
    name,
    lastAdvert: 0,
    lat: 0,
    lon: 0,
    lastMod: 0,
    lastHeardAt: NOW - heardMinAgo * MIN,
    pathSince: null,
    ...patch,
  };
}

const HERE = { lat: 54.98, lon: 73.37 } as SessionState["self"];
const NOWHERE = { lat: 0, lon: 0 } as SessionState["self"];

const olga = contact(1, "Olga", 5, { lat: 54.95, lon: 73.37, outPathLen: 1 });
const zhenya = contact(2, "Zhenya", 1, { lat: 55.05, lon: 73.37, outPathLen: 2 });
const gleb = contact(3, "Gleb", 30);
const andrey = contact(4, "Andrey", 10, { lat: 54.99, lon: 73.37, outPathLen: 0 });
const all = [olga, zhenya, gleb, andrey];

const names = (rows: ContactRecord[]) => rows.map((c) => c.name);
const sorted = (order: Parameters<typeof nodeComparator>[0], self = HERE) => names([...all].sort(nodeComparator(order, self)));

test("last heard puts the newest first", () => {
  assert.deepEqual(sorted("heard"), ["Zhenya", "Olga", "Andrey", "Gleb"]);
});

test("name goes by the alphabet", () => {
  assert.deepEqual(sorted("name"), ["Andrey", "Gleb", "Olga", "Zhenya"]);
});

test("nearest puts a node without a position last", () => {
  assert.deepEqual(sorted("near"), ["Andrey", "Olga", "Zhenya", "Gleb"]);
});

test("without a position of its own the radio falls back to last heard", () => {
  assert.equal(orderInForce("near", NOWHERE), "heard");
  assert.equal(orderInForce("near", null), "heard");
  assert.deepEqual(sorted("near", NOWHERE), sorted("heard"));
});

test("fewest relays puts direct first and a node with no route last", () => {
  assert.deepEqual(sorted("relays"), ["Andrey", "Olga", "Zhenya", "Gleb"]);
});

test("nodes alike in the order go newest heard first", () => {
  const nate = contact(5, "Nate", 2);
  assert.deepEqual(names([gleb, nate].sort(nodeComparator("relays", HERE))), ["Nate", "Gleb"]);
});

const starred = contact(6, "Lena", 3, { flags: ContactFlag.Favourite });
const kept = contact(7, "Kate", 4, { flags: ContactFlag.Favourite });

test("pinned: favourites, then the rest, each in the order given", () => {
  assert.deepEqual(names(pinnedFirst([zhenya, starred, olga, kept], true)), ["Lena", "Kate", "Zhenya", "Olga"]);
  assert.deepEqual(names(pinnedFirst([olga, zhenya], true)), ["Olga", "Zhenya"]);
});

test("unpinned: the list in the order given", () => {
  const rows = [zhenya, starred, olga];
  assert.deepEqual(pinnedFirst(rows, false), rows);
});
