import { test } from "node:test";
import assert from "node:assert/strict";
import type { MessageRecord } from "@meshnet/meshcore";
import {
  ABOVE,
  expandNewer,
  expandOlder,
  FIRST_DRAWN,
  initialWindow,
  latestWindow,
  MORE_DRAWN,
  resolveWindow,
  WINDOW_AFTER,
  WINDOW_BEFORE,
} from "./chatWindow.js";

function makeList(n: number): { messages: MessageRecord[]; indexById: Map<string, number> } {
  const messages: MessageRecord[] = [];
  const indexById = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const id = `m-${i}`;
    messages.push({
      id,
      conversation: "ch:0",
      direction: "in",
      text: `msg ${i}`,
      sender: "User",
      senderPrefix: null,
      timestamp: 1000 + i,
      receivedAt: (1000 + i) * 1000,
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
    });
    indexById.set(id, i);
  }
  return { messages, indexById };
}

test("initialWindow opens at the latest messages when there is no jump", () => {
  const { messages, indexById } = makeList(2000);
  const win = initialWindow(messages, indexById);
  assert.equal(win.from, `m-${2000 - FIRST_DRAWN}`);
  assert.equal(win.to, null);
});

test("initialWindow centers a bounded slice around a distant search result instead of drawing to the end", () => {
  const { messages, indexById } = makeList(20000);
  const win = initialWindow(messages, indexById, { jumpId: "m-2000" });
  assert.equal(win.from, `m-${2000 - WINDOW_BEFORE}`);
  assert.equal(win.to, `m-${2000 + WINDOW_AFTER}`);
  const { range } = resolveWindow(messages, indexById, win, "m-2000");
  assert.equal(range.end - range.start, WINDOW_BEFORE + WINDOW_AFTER + 1);
  assert.equal(range.atBottom, false);
});

test("resolveWindow re-centers on a far jump and snaps to live bottom when jumping back near the latest", () => {
  const { messages, indexById } = makeList(15000);
  const startWin = initialWindow(messages, indexById);
  const far = resolveWindow(messages, indexById, startWin, "m-500");
  assert.equal(far.changed, true);
  assert.equal(far.range.start, 500 - WINDOW_BEFORE);
  assert.equal(far.range.end, 500 + WINDOW_AFTER + 1);
  assert.equal(far.range.atBottom, false);

  // Stepping to a nearby match expands smoothly rather than dropping context.
  const near = resolveWindow(messages, indexById, far.next, "m-450");
  assert.equal(near.range.start, 450 - ABOVE);
  assert.equal(near.range.end, far.range.end);

  // Jumping far forward near the latest snaps back to live bottom (`to === null`).
  const back = resolveWindow(messages, indexById, near.next, "m-14990");
  assert.equal(back.range.atBottom, true);
  assert.equal(back.next.to, null);
  assert.ok(back.range.end - back.range.start <= WINDOW_BEFORE + WINDOW_AFTER + ABOVE + 1);
});

test("expandOlder and expandNewer walk the history in bounded steps and release `to` at the bottom", () => {
  const { messages, indexById } = makeList(1000);
  const win = initialWindow(messages, indexById, { jumpId: "m-850" });
  const r1 = resolveWindow(messages, indexById, win, null);

  const up = expandOlder(messages, r1.range, win);
  const rUp = resolveWindow(messages, indexById, up, null);
  assert.equal(rUp.range.start, Math.max(0, r1.range.start - MORE_DRAWN));
  assert.equal(rUp.range.end, r1.range.end);

  // First downward step advances by MORE_DRAWN (still bounded), second crosses the end and releases `to`.
  const down1 = expandNewer(messages, rUp.range, up);
  const rDown1 = resolveWindow(messages, indexById, down1, null);
  assert.equal(rDown1.range.end, rUp.range.end + MORE_DRAWN);
  assert.equal(rDown1.range.atBottom, false);

  const down2 = expandNewer(messages, rDown1.range, down1);
  const rDown2 = resolveWindow(messages, indexById, down2, null);
  assert.equal(rDown2.range.atBottom, true);
  assert.equal(down2.to, null);

  const latest = latestWindow(messages);
  assert.equal(latest.from, `m-${1000 - FIRST_DRAWN}`);
  assert.equal(latest.to, null);
});
