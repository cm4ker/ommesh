import { test } from "node:test";
import assert from "node:assert/strict";
import { AdvType, type ContactRecord } from "@meshnet/meshcore";
import { t } from "../i18n/index.js";
import { lostInARow, newestWay, routeShort, tookText, wayChoices } from "./pingWays.js";

const node = (type: number) => ({ type }) as ContactRecord;
const open = (choices: ReturnType<typeof wayChoices>) => choices.filter((c) => !c.disabled).map((c) => c.way);

test("a repeater is pinged along its route, by itself, or by flood once signed in", () => {
  assert.deepEqual(open(wayChoices(node(AdvType.Repeater), ["Tower", "Town"], true)), ["route", "direct", "flood"]);
  const outside = wayChoices(node(AdvType.Repeater), ["Tower", "Town"], false);
  assert.deepEqual(open(outside), ["route", "direct"]);
  assert.equal(outside.find((c) => c.way === "flood")?.hint, t("tools.quick.hint.floodSignIn"));
  assert.equal(outside[0]?.hint, t("tools.quick.hint.routeVia", { count: 2 }));
});

test("a person is pinged up to their last relay, by flood, or by a message; never by themselves", () => {
  const choices = wayChoices(node(AdvType.Chat), ["Tower"], false);
  assert.deepEqual(open(choices), ["route", "flood", "message"]);
  assert.equal(choices[0]?.hint, t("tools.quick.hint.routeUpTo", { name: "Tower" }));
  assert.equal(choices.find((c) => c.way === "direct")?.hint, t("tools.quick.hint.directPerson"));
});

test("with nobody between, a person has nothing to trace; with no route known, the route is still tried", () => {
  assert.deepEqual(open(wayChoices(node(AdvType.Chat), [], false)), ["flood", "message"]);
  assert.deepEqual(open(wayChoices(node(AdvType.Chat), null, false)), ["route", "flood", "message"]);
  assert.deepEqual(open(wayChoices(node(AdvType.Repeater), [], false)), ["route", "direct"]);
});

test("a room is never sent a message to check, as everyone in it would read it", () => {
  assert.deepEqual(open(wayChoices(node(AdvType.Room), ["Tower"], true)), ["route", "flood"]);
  assert.deepEqual(open(wayChoices(node(AdvType.Sensor), ["Tower"], false)), ["route", "flood"]);
});

test("a route reads as its relays counted, straight, or the whole mesh", () => {
  assert.equal(routeShort(2, false), t("tools.quick.short.relays", { count: 2 }));
  assert.equal(routeShort(0, false), t("tools.quick.short.direct"));
  assert.equal(routeShort(null, false), t("tools.quick.short.flood"));
  assert.equal(routeShort(2, true), t("tools.quick.short.flood"));
});

test("the answer shown is the one asked last", () => {
  assert.equal(newestWay({}), null);
  assert.equal(newestWay({ route: 10, direct: null }), "route");
  assert.equal(newestWay({ route: 10, direct: 30, flood: 20, message: 5 }), "direct");
  assert.equal(newestWay({ route: 10, message: 11 }), "message");
});

test("silent pings are counted from the end of the row", () => {
  assert.equal(lostInARow([]), 0);
  assert.equal(lostInARow([{ ok: false }, { ok: true }]), 0);
  assert.equal(lostInARow([{ ok: true }, { ok: false }, { ok: false }]), 2);
});

test("a time reads in milliseconds under a second, in seconds after", () => {
  assert.equal(tookText(377.4), t("tools.unit.ms", { value: 377 }));
  assert.equal(tookText(2100), t("tools.unit.s", { value: "2.1" }));
});
