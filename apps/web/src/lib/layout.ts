import { useSyncExternalStore } from "react";

/** Wide enough for the list and the reader side by side. */
const WIDE = "(min-width: 840px)";
const LANDSCAPE = "(orientation: landscape)";

/** A tablet's shorter side starts here, as Android counts it (600 dp); a phone's is shorter. */
const TABLET_SIDE = 600;

/** The column a phone held sideways keeps on the right for the Mesh list and a node's profile (styles/sideways.css). */
export const SIDE_PANEL = 340;

export interface ScreenShape {
  /** Whether a finger is the main pointer. */
  coarse: boolean;
  width: number;
  height: number;
  /** `screen.orientation.type`, where the browser has it. */
  orientation: string | undefined;
  /** Whether the window is wider than tall, for a browser without `screen.orientation`. */
  landscape: boolean;
}

/**
 * A phone held sideways: a touch screen shorter than a tablet's, turned on
 * its side. The screen is asked rather than the window, so a keyboard that
 * leaves a phone's upright window wider than it is tall does not turn it.
 */
export function sidewaysShape(shape: ScreenShape): boolean {
  if (!shape.coarse || Math.min(shape.width, shape.height) >= TABLET_SIDE) return false;
  return shape.orientation ? shape.orientation.startsWith("landscape") : shape.landscape;
}

export function isSideways(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return sidewaysShape({
    coarse: window.matchMedia("(pointer: coarse)").matches,
    width: screen.width,
    height: screen.height,
    orientation: screen.orientation?.type,
    landscape: window.matchMedia(LANDSCAPE).matches,
  });
}

export function subscribeSideways(listener: () => void): () => void {
  const media = window.matchMedia(LANDSCAPE);
  media.addEventListener("change", listener);
  screen.orientation?.addEventListener("change", listener);
  return () => {
    media.removeEventListener("change", listener);
    screen.orientation?.removeEventListener("change", listener);
  };
}

export function useSideways(): boolean {
  return useSyncExternalStore(subscribeSideways, isSideways);
}

/** A phone held sideways keeps the phone's layout, one screen at a time, however wide it is. */
export function isWide(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(WIDE).matches && !isSideways();
}

export function subscribeWide(listener: () => void): () => void {
  const media = window.matchMedia(WIDE);
  media.addEventListener("change", listener);
  const stopSideways = subscribeSideways(listener);
  return () => {
    media.removeEventListener("change", listener);
    stopSideways();
  };
}

export function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, isWide);
}
