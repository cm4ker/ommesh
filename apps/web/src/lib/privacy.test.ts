import { test } from "node:test";
import assert from "node:assert/strict";
import { AdvertLocPolicy, TelemMode } from "@meshnet/meshcore";
import { placeOpen, reach, trustUsed, withBase, type PrivacyPrefs } from "./privacy.js";

const open: PrivacyPrefs = {
  telemetryModeBase: TelemMode.AllowAll,
  telemetryModeLocation: TelemMode.AllowAll,
  telemetryModeEnvironment: TelemMode.AllowFlags,
  advertLocPolicy: AdvertLocPolicy.None,
};

test("a kind reaches no further than who may ask", () => {
  assert.equal(reach(TelemMode.AllowAll, TelemMode.AllowFlags), TelemMode.AllowFlags);
  assert.equal(reach(TelemMode.AllowFlags, TelemMode.Deny), TelemMode.Deny);
  assert.equal(reach(TelemMode.Deny, TelemMode.AllowAll), TelemMode.Deny);
});

test("narrowing who may ask narrows position and sensors with it, widening it opens neither", () => {
  assert.deepEqual(withBase(open, TelemMode.Deny), { telemetryModeBase: TelemMode.Deny, telemetryModeLocation: TelemMode.Deny, telemetryModeEnvironment: TelemMode.Deny });
  assert.deepEqual(withBase(open, TelemMode.AllowFlags), { telemetryModeBase: TelemMode.AllowFlags, telemetryModeLocation: TelemMode.AllowFlags, telemetryModeEnvironment: TelemMode.AllowFlags });
  const closed = { ...open, telemetryModeBase: TelemMode.Deny, telemetryModeLocation: TelemMode.Deny, telemetryModeEnvironment: TelemMode.Deny };
  assert.deepEqual(withBase(closed, TelemMode.AllowAll), { telemetryModeBase: TelemMode.AllowAll, telemetryModeLocation: TelemMode.Deny, telemetryModeEnvironment: TelemMode.Deny });
});

test("the place is open through adverts, or by asking only on a radio with its own GPS", () => {
  assert.ok(placeOpen({ ...open, advertLocPolicy: AdvertLocPolicy.Share }, null));
  assert.ok(!placeOpen(open, false));
  assert.ok(!placeOpen(open, null));
  assert.ok(placeOpen(open, true));
  assert.ok(!placeOpen({ ...open, telemetryModeBase: TelemMode.AllowFlags }, true));
});

test("the trusted list matters only when something that can be asked is open to trusted contacts", () => {
  assert.ok(trustUsed(open, false));
  assert.ok(!trustUsed({ ...open, telemetryModeEnvironment: TelemMode.AllowAll }, false));
  assert.ok(!trustUsed({ ...open, telemetryModeBase: TelemMode.Deny }, false));
  const gpsOnly = { ...open, telemetryModeLocation: TelemMode.AllowFlags, telemetryModeEnvironment: TelemMode.AllowAll };
  assert.ok(trustUsed(gpsOnly, true));
  assert.ok(!trustUsed(gpsOnly, false));
});
