import { test } from "node:test";
import assert from "node:assert/strict";
import type { MessageRecord } from "@meshnet/meshcore";
import { findWriters, writersIn } from "./writers.js";

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
