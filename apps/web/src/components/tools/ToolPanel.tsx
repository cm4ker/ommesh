import type { MeshTool } from "../../lib/meshTool.js";
import { closeAllTools, closeTool } from "../../lib/toolActions.js";
import { LosView } from "./LosView.js";
import { NeighboursSheet } from "./NeighboursSheet.js";
import { RouteSheet } from "./RouteSheet.js";
import { SpanSheet } from "./SpanSheet.js";
import { SurveySheet } from "./Survey.js";
import { WhoHears } from "./WhoHears.js";

/** The tool in use, as the phone's sheet and the desktop's panel show it. */
export function ToolPanel({ tool }: { tool: MeshTool }) {
  if (tool.kind === "los") return <LosView tool={tool} onBack={tool.back || tool.prev ? closeTool : undefined} onClose={closeAllTools} />;
  if (tool.kind === "route") return <RouteSheet tool={tool} onClose={closeTool} />;
  if (tool.kind === "span") return <SpanSheet tool={tool} onClose={closeTool} />;
  if (tool.kind === "neighbours") return <NeighboursSheet tool={tool} />;
  if (tool.kind === "survey") return <SurveySheet tool={tool} />;
  return <WhoHears onClose={closeAllTools} />;
}
