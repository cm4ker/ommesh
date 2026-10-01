import { AdvertLocPolicy, TelemMode } from "@meshnet/meshcore";

/** What the radio holds about who may learn what; the fields of `self` the privacy page reads. */
export interface PrivacyPrefs {
  telemetryModeBase: number;
  telemetryModeLocation: number;
  telemetryModeEnvironment: number;
  advertLocPolicy: number;
}

/**
 * Who in fact gets one kind of reading. The radio answers a request only when
 * the asker may read the battery, so no kind reaches further than that: the
 * modes go Deny < AllowFlags < AllowAll, and the narrower of the two wins.
 */
export function reach(mode: number, base: number): number {
  return Math.min(mode, base);
}

/**
 * The modes to send when who may ask is changed: position and sensors are
 * narrowed with it, so none of them reads wider on the page than it reaches.
 * Widening it widens nothing else; each is opened again by its own choice.
 */
export function withBase(prefs: PrivacyPrefs, base: number): Pick<PrivacyPrefs, "telemetryModeBase" | "telemetryModeLocation" | "telemetryModeEnvironment"> {
  return {
    telemetryModeBase: base,
    telemetryModeLocation: reach(prefs.telemetryModeLocation, base),
    telemetryModeEnvironment: reach(prefs.telemetryModeEnvironment, base),
  };
}

/**
 * Whether anyone who hears the radio can learn where it is: from its adverts,
 * or, for a radio with its own GPS on, by asking (the firmware puts a position
 * in the answer only then).
 */
export function placeOpen(prefs: PrivacyPrefs, gps: boolean | null): boolean {
  if (prefs.advertLocPolicy !== AdvertLocPolicy.None) return true;
  return gps === true && reach(prefs.telemetryModeLocation, prefs.telemetryModeBase) === TelemMode.AllowAll;
}

/** Whether any kind the asker could get is open to trusted contacts, so the list of them matters. */
export function trustUsed(prefs: PrivacyPrefs, gps: boolean | null): boolean {
  const base = prefs.telemetryModeBase;
  if (base === TelemMode.Deny) return false;
  const kinds = [base, reach(prefs.telemetryModeEnvironment, base)];
  if (gps === true) kinds.push(reach(prefs.telemetryModeLocation, base));
  return kinds.includes(TelemMode.AllowFlags);
}
