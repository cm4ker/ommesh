import { test } from "node:test";
import assert from "node:assert/strict";
import type { MessageRecord } from "@meshnet/meshcore";
import { replyHead, sourceOf } from "./replySource.js";

let clock = 1_800_000_000;

function said(sender: string | null, text: string, more: Partial<MessageRecord> = {}): MessageRecord {
  clock += 60;
  return {
    id: `m${clock}`,
    conversation: "ch:1",
    direction: "in",
    text,
    sender,
    senderPrefix: null,
    timestamp: clock,
    receivedAt: clock * 1000,
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
    ...more,
  };
}

test("a reply opens with a mention and a quote, on one line or two, or with the mention alone", () => {
  assert.deepEqual(replyHead("@[Bob (bike)] >Поднял антенну...\nКакая высота?"), { name: "Bob (bike)", gap: " ", quote: "Поднял антенну...", length: "@[Bob (bike)] >Поднял антенну...\n".length });
  assert.deepEqual(replyHead("@[Bob]\n>Поднял ант..\nКакая высота?"), { name: "Bob", gap: "\n", quote: "Поднял ант..", length: "@[Bob]\n>Поднял ант..\n".length });
  assert.deepEqual(replyHead("@[Bob] Какая высота?"), { name: "Bob", gap: " ", quote: null, length: "@[Bob] ".length });
  // MeshMonitor's colon.
  assert.deepEqual(replyHead("@[Bob]: ok"), { name: "Bob", gap: ": ", quote: null, length: "@[Bob]: ".length });
  assert.equal(replyHead("Привет @[Bob]"), null);
  assert.equal(replyHead("@[Bob]"), null);
});

test("a quote leads to the latest message of its sender that starts with it", () => {
  const first = said("Bob", "Поднял антенну на мачту, теперь бьёт до города");
  const other = said("Alice", "Поднял антенну на крышу");
  const second = said("Bob", "Поднял антенну ещё на метр");
  const reply = said("Kolya", "@[Bob] >Поднял антенну н...\nКакая высота?");
  const messages = [first, other, second, reply];
  assert.deepEqual(sourceOf(messages, reply, "Me"), { kind: "found", id: first.id });
  // Cut short enough to fit both, the later one is taken.
  const loose = said("Kolya", "@[Bob] >Поднял антенну...\nНу как?");
  assert.deepEqual(sourceOf([...messages, loose], loose, "Me"), { kind: "found", id: second.id });
});

test("each client's quote is read: MCO Advanced's, MeshCore One's, and Ommesh's of before", () => {
  const source = said("Bob", "Public channel works too");
  const later = said("Bob", "Anyone on the hill?");
  const mco = said("Kolya", "@[Bob] >Public channel wor...\nYes");
  const one = said("Kolya", "@[Bob]\n>Public cha..\nYes");
  const before = said("Kolya", "@[Bob] >Public channel…\nYes");
  for (const reply of [mco, one, before]) assert.deepEqual(sourceOf([source, later, reply], reply, "Me"), { kind: "found", id: source.id });
});

test("a quote with no dots is a whole message, and only a shortened one starts another", () => {
  const ok = said("Bob", "Ок");
  const more = said("Bob", "Ок, понял, выезжаю");
  const whole = said("Kolya", "@[Bob] >Ок\nХорошо");
  assert.deepEqual(sourceOf([ok, more, whole], whole, "Me"), { kind: "found", id: ok.id });
  // Shortened by hand, with no dots: nothing is all of it, so it is taken as a start.
  const shortened = said("Kolya", "@[Bob] >Ок, по\nХорошо");
  assert.deepEqual(sourceOf([ok, more, shortened], shortened, "Me"), { kind: "found", id: more.id });
});

test("a quote matches Russian sent in lookalike letters, and in Latin transliteration", () => {
  const source = said("Bob", "Проверка связи с холма");
  // As packLookalikes sends it: о, р, е, а, с in Latin.
  const packed = said("Kolya", "@[Bob] >Пpoвepкa cвязи...\nСлышу");
  const latin = said("Kolya", "@[Bob] >Proverka svyazi...\nSlyshu");
  for (const reply of [packed, latin]) assert.deepEqual(sourceOf([source, reply], reply, "Me"), { kind: "found", id: source.id });
});

test("a mention alone is a guess at the sender's latest message before the reply", () => {
  const first = said("Bob", "Поднял антенну");
  const second = said("Bob", "Ещё на метр");
  const reply = said("Alice", "@[Bob] Отлично, слышу с моста");
  const after = said("Bob", "Спасибо");
  assert.deepEqual(sourceOf([first, second, reply, after], reply, "Me"), { kind: "guess", id: second.id, name: "Bob", mine: false });
});

test("a reply to us leads to ours", () => {
  const ours = said("Me", "Кто слышит Tower?", { direction: "out" });
  const theirs = said("Bob", "Кто слышит Tower?");
  const reply = said("Bob", "@[Me] >Кто слышит Tower?\nЯ слышу");
  assert.deepEqual(sourceOf([ours, theirs, reply], reply, "Me"), { kind: "found", id: ours.id });
});

test("our own reply goes straight to what it answered", () => {
  const first = said("Bob", "Ок");
  const second = said("Bob", "Ок");
  const reply = said("Me", "@[Bob] >Ок\nХорошо", { direction: "out", replyTo: first.id });
  assert.deepEqual(sourceOf([first, second, reply], reply, "Me"), { kind: "found", id: first.id });
});

test("nothing of theirs that fits is missing, and says whether they have other messages here", () => {
  const theirs = said("Bob", "Совсем другое");
  const reply = said("Kolya", "@[Bob] >Поднял антенну...\nКакая высота?");
  assert.deepEqual(sourceOf([theirs, reply], reply, "Me"), { kind: "missing", name: "Bob", mine: false, theirs: true });
  const stranger = said("Kolya", "@[Mira] >Кто на холме?\nЯ");
  assert.deepEqual(sourceOf([theirs, stranger], stranger, "Me"), { kind: "missing", name: "Mira", mine: false, theirs: false });
  assert.equal(sourceOf([theirs], said("Kolya", "Просто текст"), "Me"), null);
});
