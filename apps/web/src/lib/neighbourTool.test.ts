import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { ContactRecord, SessionState } from "@meshnet/meshcore";
import { getMeshTool, setMeshTool, type NeighboursTool } from "./meshTool.js";
import { getNav, goSection, push, setStack } from "./nav.js";
import { NO_FILTER } from "./neighbours.js";
import { closeAllTools, closeTool, openLineOfSight, openNeighbourLink, openNeighbours, openNeighboursOf, setNeighbourFilter, tapInNeighbours } from "./toolActions.js";

const HILL = "aa".repeat(32);
const TOWER = "bb".repeat(32);
const STRANGER = "dd".repeat(32);
const contact = (key: string) => ({ key, name: key.slice(0, 4), prefix: key.slice(0, 12), type: 2, lat: 55, lon: 73 }) as unknown as ContactRecord;
const state = {
  contacts: { [HILL]: contact(HILL), [TOWER]: contact(TOWER), [STRANGER]: contact(STRANGER) },
  neighbours: { [HILL]: { total: 1, order: 0, at: Date.now(), neighbours: [{ prefix: TOWER.slice(0, 12), heardSecsAgo: 60, snr: 3 }] } },
} as unknown as SessionState;

/** Hill's neighbours page, reached from its profile in Mesh, as a person gets there. */
function onNeighboursPage(): void {
  setStack("mesh", [], { meshFocus: null });
  goSection("mesh");
  push({ kind: "profile", key: HILL });
  push({ kind: "node", key: HILL, page: "neighbours" });
}

beforeEach(() => {
  setMeshTool(null);
  for (const s of ["chats", "mesh", "radio"] as const) setStack(s, [], { meshFocus: null });
  goSection("chats");
});

test("the map takes the place of the page, with the repeater picked", () => {
  onNeighboursPage();
  openNeighbours(HILL);
  assert.equal(getMeshTool()?.kind, "neighbours");
  assert.deepEqual(getNav().stacks.mesh, []);
  assert.equal(getNav().meshFocus, HILL);
});

test("back steps from a link to the list, then to the page as it was", () => {
  onNeighboursPage();
  openNeighbours(HILL);
  openNeighbourLink(TOWER);
  closeTool();
  assert.deepEqual(getMeshTool(), { kind: "neighbours", key: HILL, link: null, returnTo: { section: "mesh", stack: [{ kind: "profile", key: HILL }, { kind: "node", key: HILL, page: "neighbours" }], focus: null }, prev: null });
  closeTool();
  assert.equal(getMeshTool(), null);
  assert.equal(getNav().section, "mesh");
  assert.deepEqual(getNav().stacks.mesh.map((s) => s.kind), ["profile", "node"]);
});

test("closing from a link goes straight back to the page", () => {
  onNeighboursPage();
  openNeighbours(HILL);
  openNeighbourLink(TOWER);
  closeAllTools();
  assert.equal(getMeshTool(), null);
  assert.deepEqual(getNav().stacks.mesh.map((s) => s.kind), ["profile", "node"]);
});

test("opened from a chat's profile, it goes back to the chats", () => {
  goSection("chats");
  push({ kind: "chat", conversation: `c:${HILL}` });
  push({ kind: "node", key: HILL, page: "neighbours" });
  openNeighbours(HILL);
  assert.equal(getNav().section, "mesh");
  closeTool();
  assert.equal(getNav().section, "chats");
  assert.deepEqual(getNav().stacks.chats.map((s) => s.kind), ["chat", "node"]);
});

test("a neighbour's own neighbours go back to the link they were opened from, and closing leaves for the first page", () => {
  onNeighboursPage();
  openNeighbours(HILL);
  openNeighbourLink(TOWER);
  openNeighboursOf(TOWER);
  assert.equal(getNav().meshFocus, TOWER);
  closeTool();
  const back = getMeshTool();
  assert.equal(back?.kind === "neighbours" && back.key, HILL);
  assert.equal(back?.kind === "neighbours" && back.link, TOWER);
  openNeighboursOf(TOWER);
  closeAllTools();
  assert.equal(getMeshTool(), null);
  assert.deepEqual(getNav().stacks.mesh.map((s) => s.kind), ["profile", "node"]);
});

test("a line of sight opened from a link goes back to the link", () => {
  onNeighboursPage();
  openNeighbours(HILL);
  openNeighbourLink(TOWER);
  const end = (key: string) => ({ lat: 55, lon: 73, name: key.slice(0, 4), key });
  openLineOfSight(end(HILL), end(TOWER), null);
  closeTool();
  const tool = getMeshTool();
  assert.equal(tool?.kind === "neighbours" && tool.link, TOWER);
  assert.equal(getNav().meshFocus, HILL);
});

test("the filter goes along to a neighbour's neighbours and back, and closing the map drops it", () => {
  onNeighboursPage();
  openNeighbours(HILL);
  setNeighbourFilter({ ...NO_FILTER, minSnr: -5 });
  openNeighbourLink(TOWER);
  openNeighboursOf(TOWER);
  const filterOf = () => (getMeshTool() as NeighboursTool).filter;
  assert.equal(filterOf()?.minSnr, -5);
  setNeighbourFilter({ ...NO_FILTER, toKm: 10 });
  closeTool();
  assert.equal((getMeshTool() as NeighboursTool).key, HILL);
  assert.deepEqual(filterOf(), { ...NO_FILTER, toKm: 10 });
  // A filter that lets everyone through is no filter.
  setNeighbourFilter(NO_FILTER);
  assert.equal(filterOf(), null);
  setNeighbourFilter({ ...NO_FILTER, recent: true });
  closeAllTools();
  openNeighbours(HILL);
  assert.equal(filterOf(), undefined);
});

test("a neighbour the filter hides does not open from the map", () => {
  onNeighboursPage();
  openNeighbours(HILL);
  setNeighbourFilter({ ...NO_FILTER, minSnr: 5 });
  tapInNeighbours(TOWER, state);
  assert.equal((getMeshTool() as NeighboursTool).link, null);
});

test("on the map, a neighbour opens its link, and the empty map or anyone else puts it away", () => {
  onNeighboursPage();
  openNeighbours(HILL);
  assert.equal(tapInNeighbours(TOWER, state), true);
  assert.equal(getMeshTool()?.kind === "neighbours" && (getMeshTool() as { link: string | null }).link, TOWER);
  assert.equal(tapInNeighbours(null, state), true);
  assert.equal((getMeshTool() as { link: string | null }).link, null);
  openNeighbourLink(TOWER);
  assert.equal(tapInNeighbours(STRANGER, state), true);
  assert.equal((getMeshTool() as { link: string | null }).link, null);
  assert.equal(getMeshTool()?.kind, "neighbours");
});
