/** The update lifecycle, independent of the native shell so failures can be tested. */
import { errorText } from "../i18n/errors.js";
import { t } from "../i18n/index.js";

export type UpdateChannel = "stable" | "dev";
export type UpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing";
export type Progress = { event: "Started"; data: { contentLength?: number } } | { event: "Progress"; data: { chunkLength: number } } | { event: "Finished" };
export interface UpdateHandle {
  version: string;
  body?: string;
  download(onProgress: (event: Progress) => void, options: { timeout: number }): Promise<void>;
  install(options: { restartAfterInstall: boolean }): Promise<void>;
  close(): Promise<void>;
}
export interface UpdateState {
  channel: UpdateChannel;
  phase: UpdatePhase;
  version: string | null;
  notes: string;
  downloaded: number;
  total: number | null;
  checkedAt: number | null;
  error: string | null;
}
export function updateBusy(phase: UpdatePhase): boolean {
  return phase === "checking" || phase === "downloading" || phase === "installing";
}

export class UpdateController {
  private state: UpdateState;
  private handle: UpdateHandle | null = null;
  private listeners = new Set<() => void>();
  constructor(private readonly checkNative: (channel: UpdateChannel) => Promise<UpdateHandle | null>, channel: UpdateChannel) {
    this.state = { channel, phase: "idle", version: null, notes: "", downloaded: 0, total: null, checkedAt: null, error: null };
  }
  getState = (): UpdateState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  setChannel(channel: UpdateChannel): boolean {
    if (updateBusy(this.state.phase)) return false;
    if (channel === this.state.channel) return true;
    void this.handle?.close().catch(() => undefined);
    this.handle = null;
    this.set({ channel, phase: "idle", version: null, notes: "", error: null, checkedAt: null, downloaded: 0, total: null });
    return true;
  }
  async check(): Promise<void> {
    if (updateBusy(this.state.phase) || this.state.phase === "ready") return;
    this.set({ phase: "checking", error: null });
    const previous = this.handle;
    try {
      const next = await this.checkNative(this.state.channel);
      this.handle = next;
      this.set({ phase: next ? "available" : "current", version: next?.version ?? null, notes: next?.body ?? "", checkedAt: Date.now(), downloaded: 0, total: null });
      await previous?.close().catch(() => undefined);
    } catch (error) {
      this.set({ phase: previous ? "available" : "idle", error: t("app.update.error.check", { reason: errorText(error) }) });
    }
  }
  async download(): Promise<void> {
    if (!this.handle || this.state.phase !== "available") return;
    this.set({ phase: "downloading", downloaded: 0, total: null, error: null });
    // A Dev build's release is deleted once newer builds come out, so an update
    // found hours ago may be gone (#56). The feed is read again first and its
    // newest build is downloaded; when it does not answer, the one found is tried.
    let update = this.handle;
    try {
      const next = await this.checkNative(this.state.channel);
      this.handle = next;
      this.set({ version: next?.version ?? null, notes: next?.body ?? "", checkedAt: Date.now() });
      if (update !== next) await update.close().catch(() => undefined);
      if (!next) {
        this.set({ phase: "current" });
        return;
      }
      update = next;
    } catch {
      // The feed is briefly missing while CI replaces it, or the network is down.
    }
    try {
      await update.download((event) => {
        if (event.event === "Started") this.set({ total: event.data.contentLength ?? null });
        else if (event.event === "Progress") this.set({ downloaded: this.state.downloaded + event.data.chunkLength });
        // Finished means all bytes arrived. The promise must resolve (signature verified) before install is offered.
      }, { timeout: 15 * 60_000 });
      this.set({ phase: "ready" });
    } catch (error) {
      this.set({ phase: "available", error: t("app.update.error.download", { reason: errorText(error) }) });
    }
  }
  async install(prepare: () => Promise<() => Promise<void>>): Promise<void> {
    if (!this.handle || this.state.phase !== "ready") return;
    this.set({ phase: "installing", error: null });
    let recover: (() => Promise<void>) | undefined;
    try {
      recover = await prepare();
      await this.handle.install({ restartAfterInstall: true });
    } catch (error) {
      await recover?.().catch(() => undefined);
      this.set({ phase: "ready", error: t("app.update.error.install", { reason: errorText(error) }) });
    }
  }
}
