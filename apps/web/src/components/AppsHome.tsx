import { McrsCap } from "@meshnet/meshcore";
import { pickText } from "@ommesh/miniapp-sdk";
import { language, t } from "../i18n/index.js";
import { findCatalogByAppId } from "../lib/miniapps/catalog.js";
import { installAndReplay } from "../lib/miniapps/runtime.js";
import { useMiniApps } from "../lib/miniapps/store.js";
import { openMiniApp, openMiniAppStore } from "../lib/nav.js";
import { useSession } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { Button } from "../ui/Button.js";
import { Group } from "../ui/List.js";

/** Renders a mini-app's monochrome SVG icon via CSS mask so it inherits theme ink with zero script execution. */
export function MiniAppIcon({ svg, size = 20 }: { svg: string; size?: number }) {
  const uri = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  return (
    <span
      className="apps-svg-mask"
      style={{ width: size, height: size, maskImage: uri, WebkitMaskImage: uri }}
      aria-hidden="true"
    />
  );
}

/**
 * Root pane of the 4th "Apps" section: active items waiting for user action,
 * incoming invites for uninstalled apps, and the list of installed mini-apps.
 */
export function AppsHome({ selected }: { selected: string | "store" | null }) {
  const miniApps = useMiniApps();
  const state = useSession();
  const loc = language() === "ru" ? "ru" : "en";

  const installedList = Object.values(miniApps.installed).sort((a, b) => a.installedAt - b.installedAt);
  const supportsPeerData = state.status !== "ready" || ((state.mcrs?.caps ?? 0) & McrsCap.PeerData) !== 0;

  const waitingItems = installedList
    .flatMap((entry) =>
      (miniApps.activities[entry.pkg.manifest.id] ?? []).map((activity) => ({
        entry,
        activity,
      })),
    )
    .filter((item) => item.activity.needsAttention)
    .sort((a, b) => b.activity.updatedAt - a.activity.updatedAt);

  const pendingEntries = Object.entries(miniApps.pending)
    .filter(([, pkts]) => pkts.length > 0)
    .map(([appIdStr, pkts]) => ({
      appId: Number(appIdStr),
      pkts,
      catalog: findCatalogByAppId(Number(appIdStr)),
    }));

  const handleInstallPending = async (appId: number) => {
    const entry = findCatalogByAppId(appId);
    if (!entry) {
      openMiniAppStore();
      return;
    }
    try {
      await installAndReplay(entry.pkg, "catalog");
      toast(t("apps.sideloadDone", { name: pickText(entry.pkg.manifest.name, loc) }));
      openMiniApp(entry.pkg.manifest.id);
    } catch (error) {
      toast(t("apps.sideloadFailed", { error: error instanceof Error ? error.message : String(error) }), "error");
    }
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <div className="screen-title">
          <span className="screen-name">{t("apps.title")}</span>
        </div>
        <Button size="sm" variant={selected === "store" ? "primary" : "default"} onClick={openMiniAppStore}>
          {t("apps.storeButton")}
        </Button>
      </header>
      <div className="screen-scroll">
        {!supportsPeerData ? <div className="apps-notice-box">{t("apps.mcrsMissing")}</div> : null}

        {waitingItems.length > 0 || pendingEntries.length > 0 ? (
          <Group title={t("apps.waiting")}>
            {pendingEntries.map(({ appId, pkts, catalog }) => {
              const last = pkts.at(-1)!;
              const name = catalog ? pickText(catalog.pkg.manifest.name, loc) : `App 0x${appId.toString(16)}`;
              return (
                <div key={`pending-${appId}`} className="apps-activity-row">
                  <span className="apps-icon-tile">
                    {catalog ? <MiniAppIcon svg={catalog.pkg.iconSvg} size={18} /> : "?"}
                  </span>
                  <div className="apps-row-body">
                    <div className="apps-row-title">{name}</div>
                    <div className="apps-row-sub">
                      {t("apps.pendingFrom", { peer: last.peerName, count: pkts.length })}
                    </div>
                  </div>
                  <Button size="sm" variant="primary" onClick={() => void handleInstallPending(appId)}>
                    {t("apps.installAndOpen")}
                  </Button>
                </div>
              );
            })}
            {waitingItems.map(({ entry, activity }) => (
              <button
                key={`${entry.pkg.manifest.id}:${activity.id}`}
                type="button"
                className="apps-activity-row apps-clickable"
                onClick={() => openMiniApp(entry.pkg.manifest.id, activity.id)}
              >
                <span className="apps-icon-tile">
                  <MiniAppIcon svg={entry.pkg.iconSvg} size={18} />
                </span>
                <div className="apps-row-body">
                  <div className="apps-row-title">{activity.title}</div>
                  <div className="apps-row-sub">{activity.subtitle}</div>
                </div>
                <span className="apps-attention-dot" />
              </button>
            ))}
          </Group>
        ) : null}

        <Group title={t("apps.installed")}>
          {installedList.length === 0 ? (
            <div className="apps-empty">
              <p className="muted">{t("apps.noApps")}</p>
              <Button variant="primary" onClick={openMiniAppStore}>
                {t("apps.openStore")}
              </Button>
            </div>
          ) : (
            installedList.map((entry) => {
              const m = entry.pkg.manifest;
              const acts = miniApps.activities[m.id] ?? [];
              const attn = acts.filter((a) => a.needsAttention).length;
              const isSelected = selected === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={["apps-list-row", isSelected ? "selected" : ""].filter(Boolean).join(" ")}
                  onClick={() => openMiniApp(m.id)}
                >
                  <span className="apps-icon-tile">
                    <MiniAppIcon svg={entry.pkg.iconSvg} size={18} />
                  </span>
                  <div className="apps-row-body">
                    <div className="apps-row-title">{pickText(m.name, loc)}</div>
                    <div className="apps-row-sub">
                      {acts[0] ? acts[0].subtitle : pickText(m.description, loc)}
                    </div>
                  </div>
                  {attn > 0 ? <span className="apps-pill-badge">{attn}</span> : null}
                </button>
              );
            })
          )}
        </Group>
      </div>
    </div>
  );
}
