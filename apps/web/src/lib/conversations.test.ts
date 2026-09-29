import { test } from "node:test";
import assert from "node:assert/strict";
import type { MessageRecord, SessionState } from "@meshnet/meshcore";
import { summarize } from "./conversations.js";

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
