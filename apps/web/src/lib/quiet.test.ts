import { test } from "node:test";
import assert from "node:assert/strict";
import { AdvType, ContactFlag, type MessageRecord, type SessionState } from "@meshnet/meshcore";
import { DEFAULT_PREFS, DEFAULT_QUIET, messageWanted, type QuietPrefs } from "./noticePrefs.js";
import { FOREVER, hourMore, morning, nextTurn, quietAt, quietEnds, quietSpans, ringsThrough, turnedOff, turnedOn } from "./quiet.js";

/** A moment of the local clock: the rules go by the reader's own nights. */
function at(day: number, hour: number, minute = 0): number {
  return new Date(2026, 9, day, hour, minute).getTime();
}

function quiet(patch: Partial<QuietPrefs>): QuietPrefs {
  return { ...DEFAULT_QUIET, ...patch };
}

const nightly = quiet({ nightly: true });

test("a scheduled night is quiet from 23:00 to 07:00 the next day", () => {
  assert.equal(quietAt(nightly, at(25, 22, 40)), false);
  assert.equal(quietEnds(nightly, at(25, 23, 30)), at(26, 7));
  assert.equal(quietEnds(nightly, at(26, 6)), at(26, 7));
  assert.equal(quietAt(nightly, at(26, 7)), false);
  assert.equal(quietAt(quiet({ nightly: false }), at(25, 23, 30)), false);
});

test("a night belongs to the day it starts on", () => {
  // 2026-10-23 is a Friday: Friday's night only.
  const fridays = quiet({ nightly: true, days: [5] });
  assert.equal(quietAt(fridays, at(23, 23, 30)), true);
  assert.equal(quietAt(fridays, at(24, 2)), true, "Saturday's small hours are Friday's night");
  assert.equal(quietAt(fridays, at(24, 23, 30)), false);
});

test("a night that does not cross midnight ends the same day", () => {
  const afternoon = quiet({ nightly: true, from: 13 * 60, to: 15 * 60 });
  assert.equal(quietEnds(afternoon, at(25, 14)), at(25, 15));
  assert.equal(quietAt(afternoon, at(25, 16)), false);
});

test("by hand: an hour, till morning, or until turned off", () => {
  const now = at(25, 22, 40);
  const hour = quiet(turnedOn(DEFAULT_QUIET, "hour", now));
  assert.equal(quietEnds(hour, now), at(25, 23, 40));
  assert.equal(quietAt(hour, at(25, 23, 41)), false);
  const tillMorning = quiet(turnedOn(DEFAULT_QUIET, "morning", now));
  assert.equal(quietEnds(tillMorning, now), at(26, 7));
  const always = quiet(turnedOn(DEFAULT_QUIET, "always", now));
  assert.equal(quietEnds(always, at(30, 12)), FOREVER);
  assert.equal(nextTurn(always, now), null);
});

test("morning is the schedule's end: later today, or tomorrow", () => {
  assert.equal(morning(DEFAULT_QUIET, at(26, 2)), at(26, 7));
  assert.equal(morning(DEFAULT_QUIET, at(25, 22)), at(26, 7));
  assert.equal(morning(quiet({ to: 6 * 60 + 30 }), at(25, 22)), at(26, 6, 30));
});

test("an hour by hand that runs into the night lasts as long as the night", () => {
  const q = quiet({ ...turnedOn(nightly, "hour", at(25, 22, 40)), nightly: true });
  assert.equal(quietEnds(q, at(25, 22, 50)), at(26, 7));
});

test("turned off in the night, the rest of it is set aside, and the next night is quiet again", () => {
  const now = at(26, 2);
  const off = quiet({ ...nightly, ...turnedOff(nightly, now) });
  assert.equal(quietAt(off, now), false);
  assert.equal(quietAt(off, at(26, 6)), false);
  assert.equal(quietAt(off, at(26, 23, 30)), true);
  assert.equal(nextTurn(off, now), at(26, 23));
});

test("an hour more goes on from where the quiet would end", () => {
  assert.equal(quietEnds(quiet({ ...nightly, ...hourMore(nightly, at(26, 2)) }), at(26, 2)), at(26, 8));
  assert.deepEqual(hourMore(quiet({ hand: "always" }), at(26, 2)), {});
  const now = at(25, 12);
  assert.equal(quietEnds(quiet(hourMore(DEFAULT_QUIET, now)), now), at(25, 13));
});

test("the radio core gets two weeks of nights, the one on now among them", () => {
  const now = at(26, 2);
  const spans = quietSpans(nightly, now);
  assert.equal(spans.length, 15);
  assert.deepEqual(spans[0], [at(25, 23), at(26, 7)]);
  assert.deepEqual(spans[1], [at(26, 23), at(27, 7)]);
  assert.deepEqual(quietSpans(quiet({ hand: "always" }), now), [[now, FOREVER]]);
});

const BOB = "b0".repeat(32);
const ANN = "a0".repeat(32);
const state = {
  self: { name: "Me" },
  contacts: {
    [BOB]: { key: BOB, type: AdvType.Chat, name: "Bob", flags: ContactFlag.Favourite },
    [ANN]: { key: ANN, type: AdvType.Chat, name: "Ann", flags: 0 },
  },
} as unknown as SessionState;

function said(conversation: string, text: string): MessageRecord {
  return { conversation, text } as MessageRecord;
}

test("a favourite's direct message rings through; a channel's never does by its writer", () => {
  assert.equal(ringsThrough(DEFAULT_QUIET, state, said(`c:${BOB}`, "up?")), true);
  assert.equal(ringsThrough(DEFAULT_QUIET, state, said(`c:${ANN}`, "up?")), false);
  assert.equal(ringsThrough(quiet({ favourites: false }), state, said(`c:${BOB}`, "up?")), false);
  assert.equal(ringsThrough(DEFAULT_QUIET, state, said("ch:0", "Bob: up?")), false);
});

test("a mention rings through only when the reader asked for it", () => {
  assert.equal(ringsThrough(DEFAULT_QUIET, state, said("ch:0", "@[Me] up?")), false);
  assert.equal(ringsThrough(quiet({ mentions: true }), state, said("ch:0", "@[Me] up?")), true);
});

test("a chat silenced for a while rings again once the while is over", () => {
  const p = { ...DEFAULT_PREFS, chat: { [`c:${ANN}`]: "off" as const }, chatUntil: { [`c:${ANN}`]: at(25, 23) } };
  assert.equal(messageWanted(p, state, said(`c:${ANN}`, "hi"), at(25, 22)), false);
  assert.equal(messageWanted(p, state, said(`c:${ANN}`, "hi"), at(25, 23)), true);
});
