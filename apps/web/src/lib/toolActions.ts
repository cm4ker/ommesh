/**
 * Opening the map's tools from wherever a tap starts one: a route row, a
 * line on the map, a point dragged, a long press. Each goes to the Mesh
 * section so the map is in view, and says what went wrong when it cannot
 * start. A tool opened from another section goes back there when it closes.
 */

import { AdvType, contactRoute, isConversationType, type SessionState } from "@meshnet/meshcore";
import { t } from "../i18n/index.js";
import { relayOf, selfEnd, type MapHandle } from "./mapOverlay.js";
import { getMeshTool, setMeshTool, type LosEnd, type NeighboursTool, type RouteTool, type SurveyTool } from "./meshTool.js";
import { fetchAllNeighbours } from "./neighbourFetch.js";
import { isFiltering, neighbourRows, passes, type NeighbourFilter } from "./neighbours.js";
import { focusOnMap, getNav, goSection, setStack, showOnMap } from "./nav.js";
import { clearPing, getPing, spanKey, stopPing } from "./ping.js";
import { session } from "./session.js";
import { discardSurvey, getSurveys, noteSurveyHold, startSurvey, stopSurvey, surveyById } from "./survey.js";
import { act, toast } from "./toast.js";

/** The route to a contact, in its sheet over the map; opened from a profile over the map, it closes back to the profile. */
export function openRoute(key: string): void {
  const nav = getNav();
  const tool = getMeshTool();
  const stack = nav.stacks.mesh;
  const returnTo =
    nav.section !== "mesh"
      ? { section: nav.section, focus: nav.meshFocus }
      : tool?.kind === "route" && tool.key === key
        ? (tool.returnTo ?? null)
        : stack.length > 0
          ? { section: nav.section, focus: nav.meshFocus, stack }
          : null;
  showOnMap(key);
  setMeshTool({ kind: "route", key, draft: null, returnTo });
}

/** The way from the repeater whose route is open to another, picked next on the map. */
export function openSpan(from: string): void {
  const tool = getMeshTool();
  showOnMap(from);
  setMeshTool({ kind: "span", from, to: null, prev: tool?.kind === "route" ? { ...tool, draft: null } : null });
}

/** A tap on a node while the way between two repeaters is open picks its far end; says whether the tap was taken. */
export function tapInSpan(key: string | null, state: SessionState): boolean {
  const tool = getMeshTool();
  if (tool?.kind !== "span") return false;
  if (!key || key === tool.from || key === tool.to) return true;
  if (state.contacts[key]?.type !== AdvType.Repeater) {
    if (state.contacts[key]) toast(t("tools.pickRepeater"));
    return true;
  }
  if (tool.to) stopPing(spanKey(tool.from, tool.to));
  setMeshTool({ ...tool, to: key });
  return true;
}

/** The line of sight between two ends, over the map; `back` is the node to pick again after, or the route it was opened from. */
export function openLineOfSight(from: LosEnd, to: LosEnd, back: string | null, heard: [number, number | null] | null = null): void {
  const current = getMeshTool();
  const prev = current?.kind === "route" || current?.kind === "span" || current?.kind === "neighbours" ? current : current?.kind === "los" ? (current.prev ?? null) : null;
  if (back) showOnMap(back);
  else focusOnMap(null);
  setMeshTool({ kind: "los", from, to, back, heard, prev });
}

/** A long press on the map: the line of sight from this radio to that spot. */
export function lineOfSightTo(lat: number, lon: number): void {
  const from = selfEnd(session.getState());
  if (!from) {
    toast(t("tools.setPositionFirst"));
    return;
  }
  // Held while a node was picked, Back picks it again.
  const tool = getMeshTool();
  const back = tool?.kind === "los" ? tool.back : getNav().meshFocus;
  openLineOfSight(from, { lat, lon, name: t("tools.thisSpot"), key: null }, back);
}

/**
 * Forgets the route the radio holds for a contact, from its page or its route's menu. Nothing goes
 * on the air, so Undo writes the route back as it was learned. The next message to a chat or a
 * room floods, and so does the next request to a repeater or a sensor.
 */
export async function forgetRoute(key: string): Promise<void> {
  const contact = session.getState().contacts[key];
  const relays = contact ? contactRoute(contact) : null;
  if (!contact || relays === null) return;
  const since = contact.pathSince;
  if (!(await act(() => session.resetPath(key)))) return;
  toast(
    t("tools.route.forgot"),
    "",
    { label: t("common.undo"), run: () => void act(() => session.setRoute(key, relays, { learnedAt: since }), t("tools.route.putBack")) },
    t(isConversationType(contact.type) ? "tools.route.forgotMessage" : "tools.route.forgotRequest"),
  );
}

/** The relays of the route the radio holds for a contact, as contact keys where a hash names one for sure. */
function heldRelays(key: string, state: SessionState): string[] {
  const contact = state.contacts[key];
  return (contact ? (contactRoute(contact) ?? []) : []).map((h) => relayOf(h, state.contacts)?.key ?? h);
}

/** The route to `key` being changed to `draft`, in its sheet. */
function editRoute(key: string, draft: string[]): void {
  const tool = getMeshTool();
  const route: RouteTool = tool?.kind === "route" && tool.key === key ? tool : { kind: "route", key, draft: null, returnTo: null };
  if (getNav().section !== "mesh" || getNav().meshFocus !== key) showOnMap(key);
  setMeshTool({ ...route, draft });
}

/**
 * A point of the route to `key` dropped on a node: a relay dropped on a
 * repeater gives way to it, and the middle of a leg takes it in. A relay
 * dropped on another node of the route, or on either end, leaves the route.
 * What comes of it is a route being changed, to check and to save.
 */
export function dropOnRoute(key: string, handle: MapHandle, onto: string): void {
  const state = session.getState();
  const contact = state.contacts[key];
  if (!contact) return;
  const tool = getMeshTool();
  const relays = tool?.kind === "route" && tool.key === key && tool.draft ? tool.draft : handle.relays.map((h) => state.contacts[h]?.key ?? relayOf(h, state.contacts)?.key ?? h);
  const own = handle.kind === "hop" ? relays[handle.index] : undefined;
  if (onto === own) return;
  const inRoute = onto === "self" || onto === key || relays.includes(onto);
  let next: string[];
  if (handle.kind === "hop") {
    next = inRoute ? relays.filter((_, i) => i !== handle.index) : relays.map((k, i) => (i === handle.index ? onto : k));
  } else {
    if (inRoute) return;
    next = [...relays.slice(0, handle.index), onto, ...relays.slice(handle.index)];
  }
  if (!inRoute && state.contacts[onto]?.type !== AdvType.Repeater) {
    toast(t("tools.onlyRepeaters"));
    return;
  }
  editRoute(key, next);
}

/** A tap on a node while a route is open adds it to the route, or takes it off; says whether the tap was taken. */
export function tapInRoute(key: string | null, state: SessionState): boolean {
  const tool = getMeshTool();
  if (tool?.kind !== "route") return false;
  if (!key || key === tool.key) return true;
  const c = state.contacts[key];
  if (!c || c.type !== AdvType.Repeater) {
    if (c) toast(t("tools.onlyRepeaters"));
    return true;
  }
  const relays = tool.draft ?? heldRelays(tool.key, state);
  setMeshTool({ ...tool, draft: relays.includes(key) ? relays.filter((k) => k !== key) : [...relays, key] });
  return true;
}

/** Leaves a route being changed as it was; what was checked along it goes with it. */
export function cancelRouteEdit(): void {
  const tool = getMeshTool();
  if (tool?.kind !== "route") return;
  if (getPing(tool.key)?.via) clearPing(tool.key);
  setMeshTool({ ...tool, draft: null });
}

/**
 * The repeaters `key` hears direct, on the map, from its neighbours page:
 * the section and screens it was opened from are kept to go back to. The
 * rest of the list is asked for at once.
 */
export function openNeighbours(key: string): void {
  const nav = getNav();
  const returnTo = { section: nav.section, stack: nav.stacks[nav.section], focus: nav.meshFocus };
  showOnMap(key);
  setMeshTool({ kind: "neighbours", key, link: null, returnTo, prev: null });
  void fetchAllNeighbours(key);
}

/** Another repeater's neighbours, from its link in the sheet, sifted as the ones before; Back returns to that link. */
export function openNeighboursOf(key: string): void {
  const tool = getMeshTool();
  if (tool?.kind !== "neighbours") return openNeighbours(key);
  if (tool.link) stopPing(spanKey(tool.key, tool.link));
  showOnMap(key);
  setMeshTool({ kind: "neighbours", key, link: null, returnTo: null, prev: tool, filter: tool.filter ?? null });
  void fetchAllNeighbours(key);
}

/** Which neighbours the map and the list show; a filter that lets everyone through is none. */
export function setNeighbourFilter(filter: NeighbourFilter | null): void {
  const tool = getMeshTool();
  if (tool?.kind !== "neighbours") return;
  setMeshTool({ ...tool, filter: isFiltering(filter) ? filter : null });
}

/** The repeater and the neighbours the filter leaves brought into view, as when a finger lets go of the distance. */
export function fitNeighbours(): void {
  const tool = getMeshTool();
  if (tool?.kind !== "neighbours") return;
  setMeshTool({ ...tool, refit: (tool.refit ?? 0) + 1 });
}

/** The link to one neighbour opened in the sheet, or put away with null. */
export function openNeighbourLink(link: string | null): void {
  const tool = getMeshTool();
  if (tool?.kind !== "neighbours" || tool.link === link) return;
  if (tool.link) stopPing(spanKey(tool.key, tool.link));
  setMeshTool({ ...tool, link });
}

/** A tap on the map while a repeater's neighbours are shown opens the link to the one tapped, or puts the open one away; says whether the tap was taken. */
export function tapInNeighbours(key: string | null, state: SessionState): boolean {
  const tool = getMeshTool();
  if (tool?.kind !== "neighbours") return false;
  const neighbour = key !== null && key !== tool.key && neighbourRows(state, tool.key, Date.now()).some((n) => n.contact?.key === key && passes(n, tool.filter));
  if (neighbour) openNeighbourLink(key);
  else if (tool.link) openNeighbourLink(null);
  return true;
}

/** Back where the neighbours were first opened from: its screens as they stood, or the repeater on the map. */
function leaveNeighbours(tool: NeighboursTool): void {
  let root = tool;
  while (root.prev) root = root.prev;
  if (tool.link) stopPing(spanKey(tool.key, tool.link));
  setMeshTool(null);
  if (root.returnTo) setStack(root.returnTo.section, root.returnTo.stack, { meshFocus: root.returnTo.focus });
  else showOnMap(root.key);
}

/** The "who hears me" sheet, with the last answers; nothing goes on the air until it is asked there. */
export function whoHearsMe(): void {
  focusOnMap(null);
  setMeshTool({ kind: "hears" });
}

/** A coverage survey's sheet over the map: the one running, the list, or one of those kept. */
export function openSurvey(view: SurveyTool["view"], id: string | null = null): void {
  focusOnMap(null);
  setMeshTool({ kind: "survey", view, id, point: null, only: null });
}

/** "Survey on the move": starts one and shows it running. */
export async function beginSurvey(): Promise<void> {
  const id = await startSurvey();
  if (id) openSurvey("run", id);
}

/**
 * A hold on ≋ on the map: a survey at once. The toast that says so takes it
 * back whole, for a hold that was a mistake.
 */
export async function surveyAtOnce(): Promise<void> {
  const id = await startSurvey();
  if (!id) return;
  noteSurveyHold();
  openSurvey("run", id);
  toast(t("tools.survey.started"), "", { label: t("common.undo"), run: () => discardSurvey(id) }, t("tools.survey.startedDetail"));
}

/** Stops the survey running and opens what it found; one with no point is not kept, and says why. */
export function endSurvey(): void {
  const phase = getSurveys().run?.phase;
  const id = stopSurvey();
  if (id) return openSurvey("summary", id);
  setMeshTool(null);
  toast(t("tools.survey.empty"), "", undefined, phase === "gps" ? t("tools.survey.emptyGps") : phase === "offline" ? t("tools.survey.emptyOffline") : undefined);
}

/** Back to the survey running from anywhere, as its strip over the screens does. */
export function openRunningSurvey(): void {
  const run = getSurveys().run;
  if (!run) return;
  goSection("mesh");
  openSurvey("run", run.id);
}

/** A tap on the running survey's number over the map: who answered at its last point, or its card while it has none. */
export function openLastAnswers(): void {
  const run = getSurveys().run;
  if (!run) return;
  const points = surveyById(run.id)?.points.length ?? 0;
  focusOnMap(null);
  setMeshTool({ kind: "survey", view: "run", id: run.id, point: points ? points - 1 : null, only: null });
}

/**
 * Puts the tool away, one step: a line of sight back to the route it was
 * opened from, or to the node picked; a route back to where it was opened,
 * and a check along a change that was not saved goes with it; a link
 * between neighbours back to the list, and the list back to the link it was
 * opened from, or to the screens it was opened from.
 */
export function closeTool(): void {
  const tool = getMeshTool();
  // A survey steps down its ladder: a point or the files to the survey, a survey to the list of them, the list
  // to "who hears me". The one running goes on without its sheet, under the strip that leads back to it.
  if (tool?.kind === "survey" && (tool.point !== null || tool.view === "export")) {
    setMeshTool(tool.point !== null ? { ...tool, point: null } : { ...tool, view: "summary" });
    return;
  }
  if (tool?.kind === "survey" && tool.view === "summary") {
    setMeshTool({ ...tool, view: "list", only: null });
    return;
  }
  if (tool?.kind === "survey" && tool.view === "list") return whoHearsMe();
  if (tool?.kind === "los" && tool.prev) {
    if (tool.prev.kind === "neighbours") showOnMap(tool.prev.key);
    setMeshTool(tool.prev);
    return;
  }
  if (tool?.kind === "neighbours") {
    if (tool.link) openNeighbourLink(null);
    else if (tool.prev) {
      // Back from a neighbour's neighbours, the filter set there stays.
      showOnMap(tool.prev.key);
      setMeshTool({ ...tool.prev, filter: tool.filter ?? null });
    } else leaveNeighbours(tool);
    return;
  }
  if (tool?.kind === "span") {
    if (tool.to) stopPing(spanKey(tool.from, tool.to));
    if (tool.prev) {
      showOnMap(tool.prev.key);
      setMeshTool(tool.prev);
      return;
    }
  }
  setMeshTool(null);
  if (tool?.kind === "los" && tool.back) showOnMap(tool.back);
  else if (tool?.kind === "route") {
    if (getPing(tool.key)?.via) clearPing(tool.key);
    if (tool.returnTo?.stack) {
      setStack(tool.returnTo.section, tool.returnTo.stack, { meshFocus: tool.returnTo.focus });
    } else if (tool.returnTo) {
      focusOnMap(tool.returnTo.focus);
      goSection(tool.returnTo.section);
    } else {
      showOnMap(tool.key);
    }
  }
}

/** Puts every tool away at once, as a close button does. */
export function closeAllTools(): void {
  const tool = getMeshTool();
  const under = tool?.kind === "los" ? tool.prev : tool;
  if (under?.kind === "neighbours") return leaveNeighbours(under);
  if (tool?.kind === "los" && tool.prev) {
    setMeshTool(tool.prev);
    closeTool();
  } else {
    setMeshTool(null);
  }
}
