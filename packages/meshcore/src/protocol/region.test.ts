import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readRegionList, regionKey, regionName, regionsRequest } from "./region.js";
import { sendAnonReq, setDefaultFloodScope, setFloodScope, setFloodUnscoped } from "./commands.js";
import { Cmd } from "./codes.js";

function halfSha(text: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(text).digest()).slice(0, 16);
}

test("a region's name is kept the way repeaters keep them", () => {
  assert.equal(regionName("  #MSK "), "msk");
  assert.equal(regionName("msk-sao"), "msk-sao");
  assert.equal(regionName("ru mow"), null);
  assert.equal(regionName("москва"), null);
  assert.equal(regionName("$secret"), null);
  assert.equal(regionName(""), null);
  assert.equal(regionName("a".repeat(30)), "a".repeat(30));
  assert.equal(regionName("a".repeat(31)), null);
});

test("a region's key is the first half of SHA-256 of its name with a hash in front", async () => {
  assert.deepEqual(await regionKey("msk"), halfSha("#msk"));
  assert.deepEqual(await regionKey("#msk"), halfSha("#msk"));
});

test("a repeater's list of regions is read past its clock, the wildcard kept", () => {
  const answer = new Uint8Array([1, 2, 3, 4, ...new TextEncoder().encode("*,msk,mow,msk-sao,bad name,msk\0junk")]);
  assert.deepEqual(readRegionList(answer), ["*", "msk", "mow", "msk-sao"]);
  assert.deepEqual(readRegionList(new Uint8Array([1, 2, 3, 4])), []);
});

test("the region commands are laid out as the firmware reads them", async () => {
  const key = await regionKey("msk");
  assert.deepEqual([...setFloodScope(key)], [Cmd.SetFloodScopeKey, 0, ...key]);
  assert.deepEqual([...setFloodScope(null)], [Cmd.SetFloodScopeKey, 0]);
  assert.deepEqual([...setFloodUnscoped()], [Cmd.SetFloodScopeKey, 1]);
  const kept = setDefaultFloodScope({ name: "msk", key });
  assert.equal(kept.length, 1 + 31 + 16);
  assert.deepEqual([...kept.subarray(1, 5)], [0x6d, 0x73, 0x6b, 0]);
  assert.deepEqual([...kept.subarray(32)], [...key]);
  assert.deepEqual([...setDefaultFloodScope(null)], [Cmd.SetDefaultFloodScope]);
  assert.throws(() => setDefaultFloodScope({ name: "a".repeat(31), key }));
  const asked = sendAnonReq(new Uint8Array(32).fill(7), regionsRequest());
  assert.deepEqual([...asked.subarray(33)], [0x01, 0x00]);
});
