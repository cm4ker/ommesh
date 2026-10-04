import { test } from "node:test";
import assert from "node:assert/strict";
import type { MessageRecord, SessionState } from "@meshnet/meshcore";
import { daysIn, messagesIn, shownIn, summarize } from "./conversations.js";

function message(conversation: string, text: string, receivedAt: number, direction: "in" | "out" = "in", sender: string | null = null): MessageRecord {
  return {
    id: `${conversation}-${receivedAt}`,
    conversation,
    direction,
    text,
    sender,
    senderPrefix: null,
    timestamp: Math.floor(receivedAt / 1000),
    receivedAt,
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

const BOB = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

function state(messages: MessageRecord[]): SessionState {
  return {
    status: "ready",
    link: null,
    device: null,
    self: null,
    contacts: {
      [BOB]: {
        key: BOB,
        prefix: BOB.slice(0, 12),
        type: 1,
        flags: 0,
        outPathLen: 0xff,
        outPath: "",
        name: "Bob",
        lastAdvert: 0,
        lat: 0,
        lon: 0,
        lastMod: 0,
        lastHeardAt: null,
        pathSince: null,
      },
    },
    contactsCursor: 0,
    removed: {},
    autoAdd: null,
    repeatFreqs: null,
    contactsFull: false,
    removing: null,
    channels: [
      { index: 0, name: "Public", secret: "00" },
      { index: 1, name: "Friends", secret: "01" },
    ],
    messages,
    unread: { [`c:${BOB}`]: 2 },
    battery: null,
    tuning: null,
    logins: {},
    telemetry: {},
    statuses: {},
    statusHistory: {},
    readingHistory: {},
    batteryHistory: {},
    neighbours: {},
    accessLists: {},
    ownerInfo: {},
    series: {},
    nodeSettings: {},
    consoles: {},
    remote: { active: null, queued: [] },
    routing: { resetAfterMin: null, contacts: {} },
    log: [],
    error: null,
    syncing: false,
    connectStep: null,
  };
}

test("every channel is a row, spoken on or not; contacts only once spoken to", () => {
  const rows = summarize(state([]));
  assert.deepEqual(
    rows.map((r) => r.title),
    ["Public", "Friends"],
  );
});

test("rows are ordered by the last message, quiet channels last by index", () => {
  const rows = summarize(
    state([
      message("ch:1", "hi", 2000, "in", "Alice"),
      message(`c:${BOB}`, "yo", 3000),
      message(`c:${BOB}`, "earlier", 1000),
    ]),
  );
  assert.deepEqual(
    rows.map((r) => r.title),
    ["Bob", "Friends", "Public"],
  );
  assert.equal(rows[0]?.preview, "yo");
  assert.equal(rows[0]?.unread, 2);
  assert.equal(rows[1]?.preview, "Alice: hi");
});

test("an outgoing message previews as yours", () => {
  const rows = summarize(state([message("ch:0", "hello", 1000, "out")]));
  assert.equal(rows[0]?.preview, "You: hello");
});

test("a sender the radio did not name gets a row of its own", () => {
  const rows = summarize(state([message("p:aabbccddeeff", "?", 1000)]));
  assert.equal(rows[0]?.kind, "prefix");
  assert.equal(rows[0]?.title, "Unknown aabbccddeeff");
});

// Local times, so the days fall where the reader's clock puts them.
const at = (h: number, m: number, day = 29) => new Date(2026, 8, day, h, m).getTime();
const stamped = (m: MessageRecord, ms: number): MessageRecord => ({ ...m, timestamp: Math.floor(ms / 1000) });

test("a message stamped years back by a radio that lost its clock stands last and shows when it came", () => {
  const wan = message("ch:0", "Спать надо", at(23, 50, 28), "in", "Wan8");
  const ours = message("ch:0", "600+", at(0, 32), "out");
  const lost = stamped(message("ch:0", "Нажми на волнушки", at(0, 40), "in", "Alksndr"), new Date(2024, 4, 15, 14, 3).getTime());
  const s = state([lost, wan, ours]);
  const chat = messagesIn(s, "ch:0");
  assert.deepEqual(
    chat.map((m) => m.text),
    ["Спать надо", "600+", "Нажми на волнушки"],
  );
  const shown = shownIn(chat).get(lost.id)!;
  assert.equal(shown.at, Math.floor(at(0, 40) / 1000));
  assert.equal(shown.clockOff, true);
  assert.equal(shown.newDay, false);
  assert.equal(summarize(s)[0]?.preview, "Alksndr: Нажми на волнушки");
});

test("messages fetched late keep their senders' stamps, and one clock off among them does not spoil the rest", () => {
  const before = message("ch:0", "evening", at(20, 0, 28), "out");
  // The phone slept; what the radio kept came in at eight in the morning, in the order it was heard.
  const late = stamped(message("ch:0", "late", at(8, 0), "in", "A"), at(22, 10, 28));
  const lost = stamped(message("ch:0", "lost", at(8, 0) + 1, "in", "B"), new Date(2024, 4, 15).getTime());
  const later = stamped(message("ch:0", "later", at(8, 0) + 2, "in", "A"), at(23, 30, 28));
  const shown = shownIn(messagesIn(state([before, late, lost, later]), "ch:0"));
  assert.equal(shown.get(late.id)!.at, Math.floor(at(22, 10, 28) / 1000));
  assert.equal(shown.get(late.id)!.clockOff, false);
  assert.equal(shown.get(lost.id)!.clockOff, true);
  assert.equal(shown.get(later.id)!.at, Math.floor(at(23, 30, 28) / 1000));
  assert.equal(shown.get(later.id)!.clockOff, false);
});

test("a stamp ahead of when the message came shows when it came, and far ahead is a clock off", () => {
  const near = stamped(message("ch:0", "near", at(12, 0), "in", "A"), at(12, 2));
  const far = stamped(message("ch:0", "far", at(12, 5), "in", "B"), at(18, 0));
  const shown = shownIn(messagesIn(state([near, far]), "ch:0"));
  assert.deepEqual(shown.get(near.id), { at: Math.floor(at(12, 0) / 1000), clockOff: false, newDay: true });
  assert.deepEqual(shown.get(far.id), { at: Math.floor(at(12, 5) / 1000), clockOff: true, newDay: false });
});

test("a stamp a little behind the one above it after midnight does not bring yesterday back", () => {
  const ours = message("ch:0", "first", at(0, 1), "out");
  const behind = stamped(message("ch:0", "behind", at(0, 2), "in", "A"), at(23, 58, 28));
  const after = message("ch:0", "after", at(0, 3), "out");
  const shown = shownIn(messagesIn(state([ours, behind, after]), "ch:0"));
  assert.deepEqual(
    [ours, behind, after].map((m) => shown.get(m.id)!.newDay),
    [true, false, false],
  );
  assert.equal(shown.get(behind.id)!.clockOff, false);
});

test("ours sent again goes down to when it went, in the chat and in its row", () => {
  const ours = { ...message("ch:0", "again", at(9, 0), "out"), sentAt: Math.floor(at(9, 20) / 1000) };
  const theirs = message("ch:0", "between", at(9, 10), "in", "A");
  const s = state([ours, theirs]);
  assert.deepEqual(
    messagesIn(s, "ch:0").map((m) => m.text),
    ["between", "again"],
  );
  assert.equal(shownIn(messagesIn(s, "ch:0")).get(ours.id)!.at, Math.floor(at(9, 20) / 1000));
  assert.equal(summarize(s)[0]?.preview, "You: again");
});

test("a chat's days start where its date lines go, each with how many messages it holds", () => {
  const evening = message("ch:0", "evening", at(21, 0, 27), "in", "A");
  const late = message("ch:0", "late", at(23, 50, 27), "out");
  const morning = message("ch:0", "morning", at(8, 0, 29), "in", "A");
  const noon = message("ch:0", "noon", at(12, 0, 29), "out");
  const night = message("ch:0", "night", at(22, 0, 29), "in", "B");
  const chat = messagesIn(state([evening, late, morning, noon, night]), "ch:0");
  assert.deepEqual(
    daysIn(chat, shownIn(chat)).map((d) => [d.id, d.count, d.from]),
    [
      [evening.id, 2, 0],
      [morning.id, 3, 2],
    ],
  );
  assert.deepEqual(daysIn([], new Map()), []);
});
