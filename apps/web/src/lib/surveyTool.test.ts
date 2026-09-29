import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { asksLeft, hearsListening } from "./hears.js";
import { getMeshTool, setMeshTool } from "./meshTool.js";
import { closeAllTools, closeTool, openSurvey, whoHearsMe } from "./toolActions.js";

beforeEach(() => setMeshTool(null));

test("opening who hears me sends nothing", () => {
  whoHearsMe();
  assert.deepEqual(getMeshTool(), { kind: "hears" });
  assert.equal(hearsListening(), false);
  assert.equal(asksLeft().left, 4);
});

test("back steps down from a point to the survey, to the list of them, to who hears me, to the map", () => {
  openSurvey("summary", "s1");
  setMeshTool({ kind: "survey", view: "summary", id: "s1", point: 3, only: null });
  closeTool();
  assert.deepEqual(getMeshTool(), { kind: "survey", view: "summary", id: "s1", point: null, only: null });
  closeTool();
  assert.equal((getMeshTool() as { view: string }).view, "list");
  closeTool();
  assert.deepEqual(getMeshTool(), { kind: "hears" });
  closeTool();
  assert.equal(getMeshTool(), null);
});

test("the files go back to their survey, and the cross closes it all", () => {
  openSurvey("export", "s1");
  closeTool();
  assert.equal((getMeshTool() as { view: string }).view, "summary");
  closeAllTools();
  assert.equal(getMeshTool(), null);
});

test("the survey running is put away, not ended", () => {
  openSurvey("run", "s1");
  closeTool();
  assert.equal(getMeshTool(), null);
});
