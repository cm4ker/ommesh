import { test } from "node:test";
import assert from "node:assert/strict";
import type { MessageRecord } from "@meshnet/meshcore";
import { ALL_SETS, asCyrillic, packLookalikes, TWINS } from "./lookalikes.js";
import { findMessages, fold, matchRanges, messagesFrom, searchInChat, searchMessagePage, searchTerm, snippet, warmMessageIndex } from "./messageSearch.js";

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

test("Russian sent with every set MCO Advanced has is found too, т, п and и in Latin", () => {
  const packed = [message("a", "3uмa блuзкo, чepeз mpu дня nepeвaл 3aкpoюm", 1)];
  for (const query of ["зима", "три дня", "перевал", "закроют"]) assert.deepEqual(findMessages(packed, query).map((m) => m.id), ["a"], query);
  assert.deepEqual(findMessages([message("b", "тост", 1)], "мост"), []);
  assert.deepEqual(matchRanges("чepeз mpu дня", "три"), [[6, 9]]);
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

test("fast fold matches character-by-character folding across the entire BMP and emoji", () => {
  const same: Record<string, string> = { ё: "e" };
  for (const [cyrillic, latin] of Object.entries(TWINS)) same[cyrillic.toLowerCase()] = latin.toLowerCase();
  const reference = (text: string) => {
    let out = "";
    for (const ch of asCyrillic(text)) {
      const low = ch.toLowerCase();
      out += low.length === ch.length ? (same[low] ?? low) : ch;
    }
    return out;
  };
  // Check every single BMP code unit (skipping lone surrogates).
  for (let c = 0; c <= 0xffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const s = String.fromCharCode(c);
    assert.equal(fold(s), reference(s), `U+${c.toString(16)}`);
  }
  const samples = [
    "Привет мир! Ёлка у МОСТА, İstanbul, 👍🔥, 3uмa блuзкo чepeз mpu дня",
    packLookalikes("Ретранслятор на крыше снова работает, ждём сигнал 868 МГц", ALL_SETS),
    packLookalikes("ДРУЗЬЯ 3BE3ДA 3дecь xoлoднo, ждите 3aвmpa 3км 3A", { on: true, near: true, cursive: false }),
    "@[Костя] смотри https://example.com/test и $$E=mc^2$$",
    "Bот Mоcт Pетpанcлятop на xолме cнова pаботает",
  ];
  for (const s of samples) assert.equal(fold(s), reference(s));
  // Fuzz 300 mixed lookalike/Russian/English strings across every packLookalikes preset.
  const pool = ["Зима", "близко", "через", "три", "дня", "перевал", "закроют", "ДРУЗЬЯ", "ЗВЕЗДА", "мост", "тост", "3км", "Tesla", "companion", "ёжик", "ОК", "👍"];
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 300; i++) {
    const raw = Array.from({ length: 5 }, () => pool[Math.floor(rand() * pool.length)]!).join(" ");
    const modes = [
      raw,
      packLookalikes(raw, { on: true, near: false, cursive: false }),
      packLookalikes(raw, { on: true, near: true, cursive: false }),
      packLookalikes(raw, ALL_SETS),
    ];
    for (const s of modes) assert.equal(fold(s), reference(s), s);
  }
});

test("indexed search over large histories matches brute-force exactly across queries, incremental updates, deletes and blocks", () => {
  const words = ["мост", "ретранслятор", "антенна", "ещё", "зима", "три дня", "heltec", "868", "👍"];
  const list: MessageRecord[] = [];
  for (let i = 0; i < 1200; i++) {
    const conv = i % 5 < 3 ? "ch:0" : i % 5 === 3 ? "ch:1" : `c:${i % 15}`;
    let text = `${words[i % words.length]} ${words[(i * 7 + 3) % words.length]} #${i}`;
    if (i % 4 === 0) text = packLookalikes(text, ALL_SETS);
    if (i === 173) text += " уникальноеслово99";
    // Include equal timestamps to verify tie-break order.
    const ts = 10000 + Math.floor(i / 2) * 10;
    list.push({
      ...message(`id-${i}`, text, ts, conv),
      direction: i % 9 === 0 ? "out" : "in",
      sender: conv.startsWith("ch:") ? `Node_${i % 12}` : null,
    });
  }

  const brute = (arr: readonly MessageRecord[], q: string) => {
    const term = searchTerm(q);
    if (!term) return [];
    return arr.filter((m) => fold(m.text).includes(term)).sort((a, b) => b.receivedAt - a.receivedAt);
  };

  const queries = ["мо", "мост", "рет", "ретранслятор", "еще", "зима", "три дня", "уникальноеслово99", "👍", "868", "отсутствует"];
  for (const q of queries) {
    const expected = brute(list, q);
    const got = findMessages(list, q);
    assert.deepEqual(
      got.map((m) => m.id),
      expected.map((m) => m.id),
      `findMessages(${q})`,
    );
    const page = searchMessagePage(list, q, 25);
    assert.equal(page.total, expected.length, `page.total(${q})`);
    assert.deepEqual(
      page.items.map((m) => m.id),
      expected.slice(0, 25).map((m) => m.id),
      `page.items(${q})`,
    );
  }

  // Excluding blocked senders stays exact for both total and page items.
  const exclude = (m: MessageRecord) => m.sender === "Node_0" || m.sender === "Node_3";
  const filterKey = {};
  for (const q of ["мо", "рет", "ретранслятор"]) {
    const expected = brute(list, q).filter((m) => !exclude(m));
    const page = searchMessagePage(list, q, 20, exclude, filterKey);
    assert.equal(page.total, expected.length);
    assert.deepEqual(
      page.items.map((m) => m.id),
      expected.slice(0, 20).map((m) => m.id),
    );
  }

  // In-chat SearchMatches (text and sender-scoped) matches brute-force and supports O(log M) indexOf.
  const ch0 = list.filter((m) => m.conversation === "ch:0");
  const chatRes = searchInChat(list, "ch:0", ch0, "ретранслятор", null);
  const expectedCh0 = brute(ch0, "ретранслятор");
  assert.equal(chatRes.length, expectedCh0.length);
  assert.equal(chatRes.at(0)?.id, expectedCh0[0]?.id);
  assert.equal(chatRes.at(chatRes.length - 1)?.id, expectedCh0.at(-1)?.id);
  assert.equal(chatRes.indexOf(expectedCh0[10]!.id), 10);
  assert.equal(chatRes.has(expectedCh0[10]!), true);

  const bySender = searchInChat(list, "ch:0", ch0, "мост", { name: "Node_1", mine: false });
  const expectedSender = expectedCh0.length >= 0 ? messagesFrom(ch0, { name: "Node_1", mine: false }, "мост") : [];
  assert.equal(bySender.length, expectedSender.length);
  for (let i = 0; i < bySender.length; i++) assert.equal(bySender.at(i)?.id, expectedSender[i]?.id);

  // Incremental append (including an out-of-order older message), in-place reaction update, and small delete.
  const extraNew: MessageRecord = { ...message("id-new", "свежий маяк 77", 999999, "ch:0"), sender: "Node_1" };
  const extraOld: MessageRecord = { ...message("id-old", "старый маяк 77", 5000, "ch:0"), sender: "Node_2" };
  const appended = [...list, extraNew, extraOld];
  assert.deepEqual(
    findMessages(appended, "маяк 77").map((m) => m.id),
    ["id-new", "id-old"],
  );

  // In-place update (status change) returns the updated MessageRecord object.
  const updated = appended.slice();
  updated[updated.length - 2] = { ...extraNew, status: "delivered" };
  const afterUpdate = findMessages(updated, "свежий маяк");
  assert.equal(afterUpdate.length, 1);
  assert.equal(afterUpdate[0]?.status, "delivered");

  // Small deletion removes the message from results.
  const deleted = updated.filter((m) => m.id !== "id-new");
  assert.deepEqual(
    findMessages(deleted, "маяк 77").map((m) => m.id),
    ["id-old"],
  );

  // Idle warmer can be started and cancelled cleanly.
  const cancel = warmMessageIndex(deleted);
  cancel();
});
