import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, getNewBuild, heard, hideStrip, stripShown, type NewBuildState } from "./newBuild.js";

test("builds are ordered as SemVer orders them, a Dev build's run by its number", () => {
  assert.equal(compareVersions("0.4.0-dev.140.1", "0.4.0-dev.99.2"), 1);
  assert.equal(compareVersions("0.4.0-dev.135.2", "0.4.0-dev.135.1"), 1);
  assert.equal(compareVersions("0.4.0-dev.135.1", "0.4.0-dev.135.1"), 0);
  // A release follows its own Dev builds, and a later release's Dev builds follow it.
  assert.equal(compareVersions("0.4.0", "0.4.0-dev.140.1"), 1);
  assert.equal(compareVersions("0.4.1-dev.1.1", "0.4.0"), 1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.4.0-dev.2", "0.4.0-dev.2.1"), -1);
  assert.equal(compareVersions("0.4.0-dev.2+abc", "0.4.0-dev.2"), 0);
});

const empty: NewBuildState = { latest: null, news: null, checkedAt: 0, checking: false, hiddenUntil: 0 };
const noon = Date.UTC(2026, 8, 28, 12);

test("only a later build puts the strip up, and a closed strip stays away until its day is out", () => {
  assert.equal(stripShown(empty, noon), false);
  assert.equal(stripShown({ ...empty, latest: "0.4.0-dev.140.1" }, noon), true);
  assert.equal(stripShown({ ...empty, latest: "0.4.0-dev.140.1", hiddenUntil: noon + 1 }, noon), false);
  assert.equal(stripShown({ ...empty, latest: "0.4.0-dev.140.1", hiddenUntil: noon }, noon), true);
});

test("the feed's version counts only when it is later than this build's", () => {
  heard("0.4.0-dev.140.1", "0.4.0-dev.134.1", noon);
  assert.equal(getNewBuild().latest, "0.4.0-dev.140.1");
  assert.equal(getNewBuild().checkedAt, noon);
  // Updated meanwhile: the build the feed names is this one.
  heard("0.4.0-dev.140.1", "0.4.0-dev.140.1", noon);
  assert.equal(getNewBuild().latest, null);
  heard({ version: 140 }, "0.4.0-dev.134.1", noon);
  assert.equal(getNewBuild().latest, null);
});

test("a closed strip is closed for a day", () => {
  hideStrip(noon);
  heard("0.4.0-dev.140.1", "0.4.0-dev.134.1", noon);
  assert.equal(stripShown(getNewBuild(), noon + 23 * 60 * 60_000), false);
  assert.equal(stripShown(getNewBuild(), noon + 24 * 60 * 60_000), true);
});
