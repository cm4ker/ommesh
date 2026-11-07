import { test } from "node:test";
import assert from "node:assert/strict";
import { AdvType, ContactFlag, type ContactRecord, type MessageRecord } from "@meshnet/meshcore";
import { findNames, findWriters, mentionable, writersIn } from "./writers.js";

let seq = 0;
function message(sender: string | null, receivedAt: number, direction: "in" | "out" = "in", hops: number | null = null): MessageRecord {
  return {
    id: `m${seq++}`,
    conversation: "ch:0",
    direction,
    text: "hi",
    sender,
    senderPrefix: null,
    timestamp: 0,
    receivedAt,
    snr: null,
    hops,
    txtType: 0,
    status: null,
    ackTag: null,
    roundTripMs: null,
    flood: null,
    attempt: 0,
    error: null,
    echoes: [],
    route: null,
    retryPlan: null,
  };
}

function contact(name: string, lastHeardAt: number | null, type: number = AdvType.Chat, flags = 0): ContactRecord {
  const key = String(seq++).padStart(64, "0");
  return { key, prefix: key.slice(0, 12), type, flags, outPathLen: 0xff, outPath: "", name, lastAdvert: 0, lat: 0, lon: 0, lastMod: 0, lastHeardAt, pathSince: null };
}

test("one row per name, counted, the latest to write first", () => {
  const writers = writersIn([message("Kite", 1_000, "in", 3), message("Fox 🦊", 2_000), message("Kite", 3_000, "in", 1), message("Ridge", 2_500)]);
  assert.deepEqual(
    writers.map((w) => [w.name, w.count, w.lastAt]),
    [
      ["Kite", 2, 3_000],
      ["Ridge", 1, 2_500],
      ["Fox 🦊", 1, 2_000],
    ],
  );
  // How far the latest came, not the first.
  assert.equal(writers[0]!.last.hops, 1);
});

test("ours are a row of their own, apart from someone else heard under our name; unnamed ones are left out", () => {
  const writers = writersIn([message("Me", 1_000, "out"), message("Me", 2_000), message(null, 3_000), message("Kite", 4_000), message("Me", 5_000, "out")]);
  assert.deepEqual(
    writers.map((w) => [w.name, w.mine, w.count]),
    [
      ["Me", true, 2],
      ["Kite", false, 1],
      ["Me", false, 1],
    ],
  );
});

test("a message filed out of order does not take the place of a later one", () => {
  const [kite] = writersIn([message("Kite", 5_000, "in", 2), message("Kite", 4_000, "in", 6)]);
  assert.equal(kite!.lastAt, 5_000);
  assert.equal(kite!.last.hops, 2);
});

test("found by name, case and lookalike letters aside", () => {
  const writers = writersIn([message("Kolya ⛺", 1_000), message("Марина", 2_000), message("Bob (bike)", 3_000)]);
  assert.deepEqual(
    findWriters(writers, "kol").map((w) => w.name),
    ["Kolya ⛺"],
  );
  assert.deepEqual(
    findWriters(writers, "  ").map((w) => w.name),
    ["Bob (bike)", "Марина", "Kolya ⛺"],
  );
  // A Cyrillic "о" typed for the Latin one still finds it.
  assert.deepEqual(
    findWriters(writers, "Bоb").map((w) => w.name),
    ["Bob (bike)"],
  );
});

test("those who wrote are offered first, then people among the contacts, favourites ahead", () => {
  const messages = [message("Kite", 1_000), message("Me", 2_000, "out"), message("Ridge", 3_000)];
  const contacts = [
    contact("Owl", 9_000),
    contact("Kite", 8_000),
    contact("Hill repeater", 7_000, AdvType.Repeater),
    contact("Lynx", 1_000, AdvType.Chat, ContactFlag.Favourite),
    contact("Me", 6_000),
    contact("Moth", null),
  ];
  assert.deepEqual(mentionable(messages, contacts, "Me"), ["Ridge", "Kite", "Lynx", "Owl", "Moth"]);
});

test("a name is found by what is typed after @, lookalike letters aside", () => {
  const names = ["Kolya ⛺", "Марина", "Bob (bike)"];
  assert.deepEqual(findNames(names, "kol"), ["Kolya ⛺"]);
  assert.deepEqual(findNames(names, ""), names);
  assert.deepEqual(findNames(names, "Bоb"), ["Bob (bike)"]);
});
