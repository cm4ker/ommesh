/**
 * Sends a survey to a community coverage map (maps.ts), each time after the
 * reader has been told, in the survey's sheet, that its points go to that
 * site for everyone to see. The maps answer only their own site's origin,
 * so the app's page cannot post to them itself: the phone app posts through
 * Capacitor's native HTTP, the desktop through its shell (coverage.rs). A
 * browser tab has neither and cannot send.
 */

import { isCapacitor, isTauri } from "../platform.js";
import type { Survey } from "../surveyData.js";
import type { CoverageMap } from "./maps.js";
import { addReplies, batches, readUploadReply, wardriveSamples, type UploadReply } from "./wardrive.js";

/** Whether this app can send to a map at all. */
export function canSendCoverage(): boolean {
  return isCapacitor() || isTauri();
}

export class CoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverageError";
  }
}

async function post(map: CoverageMap, body: string): Promise<{ status: number; data: unknown }> {
  if (isCapacitor()) {
    const { CapacitorHttp } = await import("@capacitor/core");
    const answer = await CapacitorHttp.post({ url: map.uploadUrl, headers: { "Content-Type": "application/json" }, data: JSON.parse(body), connectTimeout: 30_000, readTimeout: 60_000 });
    return { status: answer.status, data: answer.data };
  }
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const answer = await invoke<{ status: number; body: string }>("coverage_upload", { url: map.uploadUrl, body });
    return { status: answer.status, data: answer.body };
  }
  throw new CoverageError("no native link");
}

/** Sends every point of a survey, a hundred at a time; what the map says it took. */
export async function sendSurvey(map: CoverageMap, survey: Survey, name: (key: string) => string): Promise<UploadReply> {
  let total: UploadReply = { received: 0, processed: 0, deduped: 0, cellsCreated: 0, cellsUpdated: 0 };
  for (const batch of batches(wardriveSamples(survey, name, __APP_VERSION__))) {
    const { status, data } = await post(map, JSON.stringify({ samples: batch }));
    if (status < 200 || status >= 300) throw new CoverageError(`HTTP ${status}`);
    total = addReplies(total, readUploadReply(data));
  }
  return total;
}
