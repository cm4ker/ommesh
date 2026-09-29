import { test } from "node:test";
import assert from "node:assert/strict";
import { AdvType, type NodeLogin } from "@meshnet/meshcore";
import { isAdmin, nodeClock, nodeTabs, parseRadio, settingGroups, validate, writeCommand } from "./nodes.js";

function login(patch: Partial<NodeLogin>): NodeLogin {
  return { ok: true, role: 3, serverTime: null, firmwareLevel: 2, at: 1_700_000_100_000, ...patch };
}

test("each kind of node has the screens its firmware can answer", () => {
  assert.deepEqual(nodeTabs(AdvType.Repeater), ["overview", "neighbours", "settings", "access", "console"]);
  assert.deepEqual(nodeTabs(AdvType.Room), ["overview", "settings", "access", "console"]);
  assert.deepEqual(nodeTabs(AdvType.Sensor), ["overview", "history", "settings", "access", "console"]);
  assert.deepEqual(
    settingGroups(AdvType.Sensor).map((g) => g.id),
    ["identity", "radio", "power"],
  );
});

test("admin is the admin role, or a legacy sign-in that named none", () => {
  assert.equal(isAdmin(login({ role: 3 })), true);
  assert.equal(isAdmin(login({ role: null })), true);
  assert.equal(isAdmin(login({ role: 2 })), false);
  assert.equal(isAdmin(login({ ok: false })), false);
  assert.equal(isAdmin(undefined), false);
});

test("the node's clock is ours at sign-in less its own, until a console reply reads it again", () => {
  assert.deepEqual(nodeClock(login({ serverTime: 1_700_000_053 })), { drift: 47, at: 1_700_000_100_000, from: "login" });
  assert.equal(nodeClock(login({ serverTime: null })), null);
  assert.equal(nodeClock(login({ ok: false, serverTime: 1_700_000_053 })), null);
  assert.deepEqual(nodeClock(login({ serverTime: 1_700_000_053, clock: { drift: -300, at: 1_700_000_200_000 } })), { drift: -300, at: 1_700_000_200_000, from: "reply" });
  assert.deepEqual(nodeClock(login({ serverTime: null, clock: { drift: 9_000_000, at: 1_700_000_200_000, reset: true } }))?.from, "reset");
});

test("get radio's answer splits into four fields, numbers trimmed", () => {
  assert.deepEqual(parseRadio("869.618,62.500,8,8"), { freq: "869.618", bw: "62.5", sf: "8", cr: "8" });
  // As a repeater on 869.161 answers it: the float, printed whole.
  assert.deepEqual(parseRadio("869.1610107,62.5,7,7"), { freq: "869.161", bw: "62.5", sf: "7", cr: "7" });
  assert.equal(parseRadio("nonsense"), null);
});

test("writes use the console's own forms", () => {
  assert.equal(writeCommand("tx", "20"), "set tx 20");
  assert.equal(writeCommand("powersaving", "on"), "powersaving on");
  assert.equal(writeCommand("owner.info", "North group\nask on #test"), "set owner.info North group|ask on #test");
});

test("values the node would refuse are caught before they go out", () => {
  const interval = settingGroups(AdvType.Repeater)
    .flatMap((g) => g.fields)
    .find((f) => f.name === "advert.interval")!;
  assert.equal(validate(interval, "0"), null);
  assert.equal(validate(interval, "30"), "At least 60.");
  assert.equal(validate(interval, "300"), "At most 240.");
  assert.equal(validate(interval, "1.5"), "A whole number.");
});
