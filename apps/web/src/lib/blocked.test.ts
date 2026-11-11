import { test } from "node:test";
import assert from "node:assert/strict";
import { TxtType, type MessageRecord } from "@meshnet/meshcore";
import { blockIdOf, blocksForCore, getBlocks, hiddenCounts, inSight, isHidden, nameKey, reactionHidden, setBlock } from "./blocked.js";

function message(id: string, conversation: string, sender: string | null, over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id,
    conversation,
    direction: "in",
    text: id,
    sender,
    senderPrefix: null,
    timestamp: 0,
    receivedAt: 0,
    snr: null,
    hops: null,
    txtType: TxtType.Plain,
    status: null,
    ackTag: null,
    roundTripMs: null,
    flood: null,
    attempt: 0,
    error: null,
    echoes: [],
    route: null,
    retryPlan: null,
    ...over,
  };
}

const ROOM = "c:b1b2b3b4b5b6000000000000000000000000000000000000000000000000000000";

test("a name is matched whatever its letter case and its Latin lookalikes", () => {
  assert.equal(nameKey(" ЭхоБот "), nameKey("эxобот"));
  assert.equal(nameKey("Ольга"), nameKey("Oльгa"));
  assert.notEqual(nameKey("Ольга"), nameKey("Олег"));
  assert.equal(nameKey("Ёж"), "eж");
});

test("on a channel the name is blocked; in a room the author's key; never ours or a person's", () => {
  assert.equal(blockIdOf(message("1", "ch:0", "Spam")), `n:${nameKey("Spam")}`);
  assert.equal(blockIdOf(message("2", "ch:0", null)), null, "a channel message without a name");
  assert.equal(blockIdOf(message("3", ROOM, "deadbeef", { txtType: TxtType.SignedPlain, senderPrefix: "deadbeef" })), "k:deadbeef");
  assert.equal(blockIdOf(message("4", ROOM, "Bob", { senderPrefix: "b1b2b3b4b5b6" })), null, "a direct message");
  assert.equal(blockIdOf(message("5", "ch:0", "Me", { direction: "out" })), null);
});

test("blocking hides every message under the name, and their emoji on the channel", () => {
  setBlock("n:spam", { name: "Spam", at: 1 });
  try {
    assert.equal(isHidden(message("1", "ch:0", "SPAM")), true);
    assert.equal(isHidden(message("2", "ch:1", "spam")), true, "on every channel");
    assert.equal(isHidden(message("3", "ch:0", "Alice")), false);
    assert.equal(reactionHidden("Spam"), true);
    assert.equal(reactionHidden(null), false);
    assert.deepEqual(blocksForCore(), { names: ["spam"], keys: [] });
    assert.deepEqual(hiddenCounts([message("1", "ch:0", "Spam"), message("2", "ch:0", "Spam"), message("3", "ch:0", "Alice")]), { "n:spam": 2 });
  } finally {
    setBlock("n:spam", null);
  }
  assert.deepEqual(getBlocks(), {});
});

test("hidden messages one after another fold into one strip under the message above them", () => {
  const all = [message("a", "ch:0", "Alice"), message("s1", "ch:0", "Spam"), message("s2", "ch:0", "Bot"), message("b", "ch:0", "Bob"), message("s3", "ch:0", "Spam")];
  const spam = (m: MessageRecord) => m.sender === "Spam" || m.sender === "Bot";
  const folded = inSight(all, spam, new Set());
  assert.deepEqual(
    folded.messages.map((m) => m.id),
    ["a", "b"],
  );
  assert.deepEqual(folded.runs, [
    { id: "s1", after: "a", count: 2, names: ["Spam", "Bot"] },
    { id: "s3", after: "b", count: 1, names: ["Spam"] },
  ]);
  const opened = inSight(all, spam, new Set(["s1"]));
  assert.deepEqual(
    opened.messages.map((m) => m.id),
    ["a", "s1", "s2", "b"],
  );
  assert.deepEqual([...opened.shown], ["s1", "s2"]);
  const top = inSight([message("s0", "ch:0", "Spam"), message("a", "ch:0", "Alice")], spam, new Set());
  assert.equal(top.runs[0]?.after, null, "a run at the top of the chat");
  const none = inSight(all, () => false, new Set());
  assert.equal(none.messages, all, "nothing hidden, the same list");
});
