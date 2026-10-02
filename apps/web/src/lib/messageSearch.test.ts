import { test } from "node:test";
import assert from "node:assert/strict";
import type { MessageRecord } from "@meshnet/meshcore";
import { findMessages, fold, matchRanges, messagesFrom, searchTerm, snippet } from "./messageSearch.js";

function message(id: string, text: string, timestamp: number, conversation = "ch:0"): MessageRecord {
  return {
    id,
    conversation,
    direction: "in",
    text,
    sender: null,
    senderPrefix: null,
    timestamp,
    receivedAt: timestamp * 1000,
    snr: null,
    hops: null,
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

test("folding lowers case, reads ё as е and a lookalike as its twin, keeping every place", () => {
  assert.equal(fold("Ёлка у МОСТА"), fold("елка у моста"));
  assert.equal(fold("ёж"), fold("еж"));
  assert.equal(fold("İstanbul").length, "İstanbul".length);
  assert.equal(fold("👍 Ok"), "👍 ok");
  assert.equal(fold("Мост").length, 4);
});

test("Russian sent with Latin twins is found by its Cyrillic words, and back", () => {
  // As packLookalikes sends them: а е о р с х and the capitals В К М Н Т go out Latin.
  const packed = [message("a", "Pетpанcлятop на xолме cнова pаботает", 2), message("b", "Bот Mоcт", 1)];
  assert.deepEqual(findMessages(packed, "ретранслятор").map((m) => m.id), ["a"]);
  assert.deepEqual(findMessages(packed, "вот мост").map((m) => m.id), ["b"]);
  assert.deepEqual(findMessages([message("c", "ретранслятор", 1)], "Pетpанcлятop").map((m) => m.id), ["c"]);
  assert.deepEqual(matchRanges("У Pетpанcлятоpа", "ретранслятор"), [[2, 14]]);
});

test("a query of one letter is not searched; one emoji is", () => {
  assert.equal(searchTerm(" м "), null);
  assert.equal(searchTerm("мо"), fold("мо"));
  assert.equal(searchTerm("👍"), "👍");
});

test("messages are found across chats whatever the case, the newest first", () => {
  const found = findMessages(
    [message("a", "завтра сбор у Моста", 100, "ch:2"), message("b", "привет", 200), message("c", "на мосту ловит", 300, "c:ab"), message("d", "МОСТ", 50)],
    "мост",
  );
  assert.deepEqual(
    found.map((m) => m.id),
    ["c", "a", "d"],
  );
});

test("ё in a query finds е in the text and back", () => {
  const all = [message("a", "ещё раз", 1), message("b", "еще раз", 2)];
  assert.deepEqual(findMessages(all, "ЕЩЁ").map((m) => m.id), ["b", "a"]);
  assert.deepEqual(findMessages(all, "еще").map((m) => m.id), ["b", "a"]);
});

test("every place the query stands is marked, none overlapping", () => {
  assert.deepEqual(matchRanges("Roof-2 и roof-3", "roof"), [
    [0, 4],
    [9, 13],
  ]);
  assert.deepEqual(matchRanges("аааа", "аа"), [
    [0, 2],
    [2, 4],
  ]);
  assert.deepEqual(matchRanges("мост", "м"), []);
});

test("a match far into a long message starts its line a word or two before it", () => {
  const text = "вчера вечером поставил на крышу новую антенну 868";
  const cut = snippet(text, "антенн");
  assert.ok(cut.startsWith("…"));
  assert.ok(cut.includes("антенну 868"));
  assert.ok(cut.length < text.length);
  assert.equal(snippet("новая антенна", "антенн"), "новая антенна");
});

test("a line is never cut inside an emoji", () => {
  const text = "😀".repeat(20) + " антенна";
  const cut = snippet(text, "антенна");
  const first = cut.charCodeAt(1);
  assert.ok(first < 0xdc00 || first > 0xdfff);
});

test("one sender's messages, the newest first, narrowed by a query once it is long enough", () => {
  const said = (id: string, sender: string, text: string, at: number): MessageRecord => ({ ...message(id, text, at), sender });
  const ours: MessageRecord = { ...said("o", "Kite", "kite here too", 5), direction: "out" };
  const all = [said("a", "Kite", "on the ridge", 1), said("b", "Fox", "on the ridge too", 2), said("c", "Kite", "back home", 3), ours];
  assert.deepEqual(
    messagesFrom(all, { name: "Kite", mine: false }, "").map((m) => m.id),
    ["c", "a"],
  );
  assert.deepEqual(
    messagesFrom(all, { name: "Kite", mine: false }, "ridge").map((m) => m.id),
    ["a"],
  );
  assert.deepEqual(
    messagesFrom(all, { name: "Kite", mine: false }, "r").map((m) => m.id),
    ["c", "a"],
  );
  // Ours, under the name we wrote them with.
  assert.deepEqual(
    messagesFrom(all, { name: "Kite", mine: true }, "").map((m) => m.id),
    ["o"],
  );
});
