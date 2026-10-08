import { isCapacitor } from "./platform.js";

// Held here, and never handed to a Promise: the plugin is a proxy, and a Promise
// resolved with it calls the native side for "then" and never settles.
let haptics: { impact: (options: { style: "LIGHT" }) => Promise<void> } | null = null;

/**
 * A light tap of the phone's motor, for the moment a gesture has gone far
 * enough to act on letting go: a long press opening its menu, a pull that will
 * answer or open the next chat. The iPhone's web view has no `vibrate`, so the
 * phone shells ask Capacitor's Haptics plugin, which gives iOS its own light
 * impact; a shell built before the plugin falls back to `vibrate`.
 */
export function haptic(): void {
  if (!isCapacitor()) {
    navigator.vibrate?.(8);
    return;
  }
  void import("@capacitor/core")
    .then(({ registerPlugin }) => {
      haptics ??= registerPlugin<NonNullable<typeof haptics>>("Haptics");
      return haptics.impact({ style: "LIGHT" });
    })
    .catch(() => navigator.vibrate?.(8));
}
