/**
 * Ephemeral sandboxed Web Worker runner for closed mini-apps.
 *
 * When a LoRa `PEER_DATA` packet arrives while the app's UI iframe is closed,
 * the host runs the bundle's `workerJs` in a short-lived worker with a hard
 * 300 ms timeout and zero network/DOM access. The worker returns structured KV
 * patches, updated hub activities, an optional notification, and optional
 * auto-reply packets (such as chess `SYNC_MOVES`).
 */

import type { MiniAppPackage, WorkerInput, WorkerOutput } from "@ommesh/miniapp-sdk";

const WORKER_TIMEOUT_MS = 350;

/**
 * Wraps the app's `workerJs` inside a tiny isolated harness that blocks `fetch`
 * and `XMLHttpRequest` and expects the worker to define `self.onPacket(input)`.
 */
function buildWorkerSource(workerJs: string): string {
  return `
"use strict";
self.fetch = function () { return Promise.reject(new Error("network disabled in mini-app sandbox")); };
self.XMLHttpRequest = function () { throw new Error("network disabled in mini-app sandbox"); };
self.importScripts = function () { throw new Error("importScripts disabled in mini-app sandbox"); };
${workerJs}
self.onmessage = async function (ev) {
  try {
    if (typeof self.onPacket !== "function") {
      self.postMessage({ ok: true, output: {} });
      return;
    }
    const output = await self.onPacket(ev.data);
    self.postMessage({ ok: true, output: output || {} });
  } catch (err) {
    self.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
`;
}

export async function runMiniAppWorker(pkg: MiniAppPackage, input: WorkerInput): Promise<WorkerOutput | null> {
  if (!pkg.workerJs || typeof Worker === "undefined" || typeof Blob === "undefined") {
    return null;
  }
  const blob = new Blob([buildWorkerSource(pkg.workerJs)], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  return new Promise<WorkerOutput | null>((resolve) => {
    let settled = false;
    const finish = (result: WorkerOutput | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const timer = setTimeout(() => {
      console.warn(`mini-app worker timed out: ${pkg.manifest.id}`);
      finish(null);
    }, WORKER_TIMEOUT_MS);
    worker.onmessage = (ev: MessageEvent<{ ok: boolean; output?: WorkerOutput; error?: string }>) => {
      if (ev.data?.ok) finish(ev.data.output ?? {});
      else {
        console.warn(`mini-app worker failed (${pkg.manifest.id}):`, ev.data?.error);
        finish(null);
      }
    };
    worker.onerror = (err) => {
      console.warn(`mini-app worker error (${pkg.manifest.id}):`, err.message);
      finish(null);
    };
    worker.postMessage(input);
  });
}
