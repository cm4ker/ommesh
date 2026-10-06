import { test } from "node:test";
import assert from "node:assert/strict";
import { AdvType, ContactFlag, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import { memoryTight, memoryUse, tidyPlan } from "./tidy.js";

const NOW = 1_700_000_000_000;
const DAY = 24 * 3600 * 1000;

function contact(n: number, name: string, heardDaysAgo: number, patch: Partial<ContactRecord> = {}): ContactRecord {
  const key = n.toString(16).padStart(2, "0").repeat(32);
  const at = Math.floor((NOW - heardDaysAgo * DAY) / 1000);
  return {
    key,
    prefix: key.slice(0, 12),
    type: AdvType.Chat,
    flags: 0,
    outPathLen: 0xff,
    outPath: "",
    name,
    lastAdvert: at,
    lat: 0,
    lon: 0,
    lastMod: at,
    lastHeardAt: null,
    pathSince: null,
    ...patch,
  };
}

function state(contacts: ContactRecord[], patch: Partial<SessionState> = {}): SessionState {
  return {
    contacts: Object.fromEntries(contacts.map((c) => [c.key, c])),
    messages: [],
    logins: {},
    statusHistory: {},
    readingHistory: {},
    device: null,
    contactsFull: false,
    ...patch,
  } as unknown as SessionState;
}

test("a clean-up takes the nodes not heard for its days, the longest quiet first", () => {
  const s = state([contact(1, "fresh", 2), contact(2, "old", 40), contact(3, "older", 95)]);
  const plan = tidyPlan(s, [], 30, NOW);
  assert.deepEqual(
    plan.remove.map((c) => c.name),
    ["older", "old"],
  );
  assert.deepEqual(plan.kept, []);
});

test("a favourite, a node of yours, and one you write to are kept, and say why", () => {
  const fav = contact(1, "fav", 60, { flags: ContactFlag.Favourite });
  const rpt = contact(2, "rpt", 60, { type: AdvType.Repeater });
  const pwd = contact(3, "pwd", 60, { type: AdvType.Room });
  const pal = contact(4, "pal", 60);
  const s = state([fav, rpt, pwd, pal], {
    logins: { [rpt.key]: { ok: true, role: 3, serverTime: null, firmwareLevel: null, at: NOW } },
    messages: [{ conversation: `c:${pal.key}` }] as SessionState["messages"],
  });
  const plan = tidyPlan(s, [pwd.key], 30, NOW);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(
    plan.kept.map((k) => [k.contact.name, k.reason]),
    [
      ["fav", "favourite"],
      ["rpt", "yours"],
      ["pwd", "yours"],
      ["pal", "chat"],
    ],
  );
});

test("a node whose clock runs ahead is judged by when the radio stored its advert", () => {
  // Its advert claims tomorrow, but the radio stored it 50 days ago.
  const ahead = contact(1, "ahead", 50, { lastAdvert: Math.floor((NOW + DAY) / 1000) });
  assert.deepEqual(
    tidyPlan(state([ahead]), [], 30, NOW).remove.map((c) => c.name),
    ["ahead"],
  );
});

test("a clean-up of every node takes even one heard just now, and still keeps a favourite", () => {
  // Stamped a minute ahead of us, by a radio clock that runs fast.
  const now = contact(1, "now", -1 / 1440);
  const fav = contact(2, "fav", 3, { flags: ContactFlag.Favourite });
  const plan = tidyPlan(state([contact(3, "old", 40), now, fav, contact(4, "heard", 60, { unsaved: true })]), [], 0, NOW);
  assert.deepEqual(
    plan.remove.map((c) => c.name),
    ["old", "now"],
  );
  assert.deepEqual(
    plan.kept.map((k) => k.contact.name),
    ["fav"],
  );
});

test("a node the radio never kept is not counted and not taken", () => {
  const s = state([contact(1, "heard", 60, { unsaved: true }), contact(2, "kept", 60)], { device: { maxContacts: 2 } as SessionState["device"] });
  assert.deepEqual(
    tidyPlan(s, [], 30, NOW).remove.map((c) => c.name),
    ["kept"],
  );
  assert.deepEqual(memoryUse(s), { used: 1, max: 2 });
});

test("the memory is tight from nine tenths, or once the radio said it is full", () => {
  const ten = Array.from({ length: 10 }, (_, i) => contact(i + 1, `n${i}`, 1));
  const device = { maxContacts: 10 } as SessionState["device"];
  assert.equal(memoryTight(state(ten.slice(0, 8), { device })), false);
  assert.equal(memoryTight(state(ten.slice(0, 9), { device })), true);
  assert.equal(memoryTight(state(ten.slice(0, 2), { device, contactsFull: true })), true);
  assert.equal(memoryTight(state(ten, { device: null })), false);
});
