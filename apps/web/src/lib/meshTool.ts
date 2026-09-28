/**
 * What the map is being used for besides picking a node: a line of sight
 * between two points, the route to a contact, the way between two
 * repeaters, the answers to "who hears me", or the repeaters one repeater
 * hears. One at a time; the sheet on a phone and the panel on a desktop show
 * it, and the map draws it. It lives only while the app runs, like the map's
 * own view.
 */

import { useSyncExternalStore } from "react";
import type { Screen, Section } from "./nav.js";

/** One end of a line of sight: a node, this radio, or a spot on the map. */
export interface LosEnd {
  lat: number;
  lon: number;
  name: string;
  /** A contact's key, "self" for this radio, null for a spot. */
  key: string | null;
}

export type MeshTool =
  | {
      kind: "los";
      from: LosEnd;
      to: LosEnd;
      /** The node picked when it was opened, to go back to. */
      back: string | null;
      /** How the leg sounded when last pinged, out and back, dB; back is null when the trace came home another way. */
      heard?: [number, number | null] | null;
      /** The route, the way between two repeaters, or the link between neighbours it was opened from, to go back to. */
      prev?: RouteTool | SpanTool | NeighboursTool | null;
    }
  | RouteTool
  | SpanTool
  | NeighboursTool
  | { kind: "hears" }
  | SurveyTool;

/**
 * A coverage survey (lib/survey.ts): the one running, the surveys kept, one
 * of them with the repeaters that answered, or its files. `point` is the
 * point opened on the map, by its place in the survey; `only` the repeater
 * whose points alone are coloured.
 */
export interface SurveyTool {
  kind: "survey";
  view: "run" | "list" | "summary" | "export";
  id: string | null;
  point: number | null;
  only: string | null;
}

/**
 * The route to a contact. `draft` is a route being changed, contact keys (or
 * hashes naming nobody for sure) in order from this radio; null while the
 * one the radio holds is shown. `returnTo` is the section it was opened
 * from, the node the map had picked then, and the screens that were open
 * over the map, such as the profile on a phone, to go back to when it closes.
 */
export interface RouteTool {
  kind: "route";
  key: string;
  draft: string[] | null;
  returnTo?: { section: Section; focus: string | null; stack?: Screen[] } | null;
}

/**
 * The way between two repeaters, checked from this radio: `from` is the one
 * whose route it was opened from, `to` the one tapped on the map, null until
 * then. `prev` is that route, to go back to.
 */
export interface SpanTool {
  kind: "span";
  from: string;
  to: string | null;
  prev: RouteTool | null;
}

/**
 * The repeaters `key` hears direct, each drawn from it on the map. `link` is
 * the neighbour whose link is open in the sheet. `returnTo` is where it was
 * opened from, a section with its screens as they stood, put back when it
 * closes; `prev` is another repeater's neighbours, with the link it was
 * opened from, to go back to instead.
 */
export interface NeighboursTool {
  kind: "neighbours";
  key: string;
  link: string | null;
  returnTo: { section: Section; stack: Screen[]; focus: string | null } | null;
  prev: NeighboursTool | null;
}

let tool: MeshTool | null = null;
const listeners = new Set<() => void>();

export function setMeshTool(next: MeshTool | null): void {
  tool = next;
  for (const listener of listeners) listener();
}

export function getMeshTool(): MeshTool | null {
  return tool;
}

export function useMeshTool(): MeshTool | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => tool,
  );
}
