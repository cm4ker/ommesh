import { test } from "node:test";
import assert from "node:assert/strict";
import { AdvType, type SessionState } from "@meshnet/meshcore";
import { badgePng, badgeText, unreadSplit } from "./tray.js";

const BOB = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const ROOM = "2102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

function state(unread: Record<string, number>): SessionState {
  return { unread, contacts: { [ROOM]: { key: ROOM, type: AdvType.Room } } } as unknown as SessionState;
}

test("people and chats are counted apart", () => {
  assert.deepEqual(unreadSplit(state({ [`c:${BOB}`]: 2, "ch:0": 3, "ch:1": 1, [`c:${ROOM}`]: 4 })), { direct: 2, chats: 8 });
});

test("a sender known only by prefix is a person", () => {
  assert.deepEqual(unreadSplit(state({ "p:0102030405": 1 })), { direct: 1, chats: 0 });
});

test("nothing unread is nothing", () => {
  assert.deepEqual(unreadSplit(state({ "ch:0": 0 })), { direct: 0, chats: 0 });
});

test("the badge reads the count up to two digits", () => {
  assert.equal(badgeText(7), "7");
  assert.equal(badgeText(99), "99");
  assert.equal(badgeText(100), "99+");
});

test("no badge while nothing is unread", () => {
  assert.equal(badgePng({ direct: 0, chats: 0 }), null);
});
