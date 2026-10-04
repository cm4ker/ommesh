import { useEffect } from "react";
import { locale, t } from "../i18n/index.js";
import { isTauri } from "../lib/platform.js";
import { updateBusy } from "../lib/updateController.js";
import { chooseUpdateChannel, closeUpdates, initializeUpdates, installUpdate, openUpdates, setAutomaticChecks, updates, useDesktopUpdateInfo, useUpdates } from "../lib/updates.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Group, InfoRow, SelectRow, SwitchRow } from "../ui/List.js";
import { RefreshIcon } from "./Icons.js";
import { ReleaseNews } from "./News.js";

export function UpdateButton({ compact = false }: { compact?: boolean }) {
  const state = useUpdates();
  const info = useDesktopUpdateInfo();
  if (!isTauri() || (info.ready && !info.supported && !info.error)) return null;
  const available = state.version !== null;
  return (
    <button type="button" className={compact ? "rail-update" : "update-link"} onClick={openUpdates} title={available ? t("app.update.available", { version: state.version! }) : t("app.update.title")} aria-label={available ? t("app.update.availableAria", { version: state.version! }) : t("app.update.title")}>
      <RefreshIcon size={compact ? 18 : 15} />
      <span>{compact ? t("app.update.short") : available ? t("app.update.available", { version: state.version! }) : t("app.update.title")}</span>
      {available ? <span className="update-dot" aria-hidden="true" /> : null}
    </button>
  );
}

export function UpdatesDialog() {
  const info = useDesktopUpdateInfo();
  const state = useUpdates();
  useEffect(() => { void initializeUpdates(); }, []);
  if (!isTauri()) return null;
  const busy = updateBusy(state.phase);
  const percent = state.total && state.total > 0 ? Math.min(100, Math.round(state.downloaded / state.total * 100)) : null;
  return (
    <Dialog open={info.open} title={t("app.update.title")} onClose={closeUpdates} dismissible={state.phase !== "installing"} footer={<>
      <Button onClick={closeUpdates} disabled={state.phase === "installing"}>{t("app.update.later")}</Button>
      {state.phase === "ready" ? <Button variant="primary" onClick={() => void installUpdate()}>{t("app.update.install")}</Button>
        : state.phase === "available" ? <Button variant="primary" onClick={() => void updates.download()}>{t("app.update.download")}</Button>
        : state.phase === "downloading" ? <Button busy>{t("app.update.downloadingBusy")}</Button>
        : state.phase === "installing" ? <Button busy>{t("app.update.installingBusy")}</Button>
        : <Button variant="primary" busy={state.phase === "checking"} disabled={!info.supported || busy} onClick={() => void updates.check()}>{t("app.update.check")}</Button>}
    </>}>
      <Group>
        <InfoRow label={t("app.update.installed")}>{info.version}</InfoRow>
        <SelectRow label={t("app.update.channel")} value={state.channel} options={[{ value: "stable", label: t("app.update.stable") }, { value: "dev", label: t("app.update.dev") }]} onChange={chooseUpdateChannel} disabled={busy} />
        <SwitchRow label={t("app.update.auto")} checked={info.auto} onChange={setAutomaticChecks} disabled={state.phase === "installing"} />
      </Group>
      <p className="muted small">{state.channel === "dev" ? t("app.update.devNote") : t("app.update.stableNote")}</p>
      <div className="update-status" role="status" aria-live="polite">
        {!info.ready ? t("app.update.loading") : state.phase === "checking" ? t("app.update.checking")
          : state.phase === "current" ? t("app.update.current")
          : state.phase === "downloading" ? (percent === null
            ? t("app.update.downloadingSize", { size: (state.downloaded / 1_048_576).toFixed(1) })
            : t("app.update.downloadingPercent", { percent, size: (state.downloaded / 1_048_576).toFixed(1) }))
          : state.phase === "ready" ? t("app.update.ready")
          : state.phase === "installing" ? t("app.update.installing")
          : state.version ? t("app.update.versionAvailable", { version: state.version }) : t("app.update.offline")}
      </div>
      {state.phase === "downloading" ? <progress className="update-progress" aria-label={t("app.update.progress")} max={100} value={percent ?? undefined} /> : null}
      {/* What the version brings, in the reader's language, when its feed says; a feed from before 0.7.0 has only its notes. */}
      {/* A Dev build carries the news of the version it leads to, so its own number is said apart. */}
      {state.version && state.version !== state.news?.version ? <p><strong>{t("app.update.version", { version: state.version })}</strong></p> : null}
      {state.news ? <ReleaseNews release={state.news} actions={false} /> : state.notes ? <div className="update-notes">{state.notes}</div> : null}
      {state.phase === "ready" ? <p className="muted small">{t("app.update.restartNote")}</p> : null}
      {state.error || info.error ? <p className="connect-error" role="alert">{state.error ?? info.error}</p> : null}
      {state.checkedAt ? <p className="muted small">{t("app.update.lastChecked", { time: new Date(state.checkedAt).toLocaleString(locale()) })}</p> : null}
    </Dialog>
  );
}
