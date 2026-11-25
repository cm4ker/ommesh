import { useEffect, useState } from "react";
import { McrsCap } from "@meshnet/meshcore";
import { pickText } from "@ommesh/miniapp-sdk";
import { language, t } from "../i18n/index.js";
import {
  countCatalogUpdates,
  findMergedCatalogByAppId,
  installFromCatalog,
  refreshRemoteCatalog,
  useStoreCatalog,
} from "../lib/miniapps/remoteCatalog.js";
import { useMiniApps } from "../lib/miniapps/store.js";
import { openMiniApp, openMiniAppStore } from "../lib/nav.js";
import { useSession } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { Button, IconButton } from "../ui/Button.js";
import { Group, LinkRow } from "../ui/List.js";
import { Avatar } from "./Avatar.js";
import { AppsIcon, ChevronRightIcon, PlusIcon } from "./Icons.js";

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
 * Root pane of the 4th "Apps" section: uses the same `list-pane` + `list-head`
 * + grouped `.line` rows grammar as Chats and Settings.
 */
export function AppsHome({ selected }: { selected: string | "store" | null }) {
  const miniApps = useMiniApps();
  const catalog = useStoreCatalog();
  const state = useSession();
  const [busyAppId, setBusyAppId] = useState<number | null>(null);
  const loc = language() === "ru" ? "ru" : "en";

  const installedList = Object.values(miniApps.installed).sort((a, b) => a.installedAt - b.installedAt);
  const supportsPeerData = state.status !== "ready" || ((state.mcrs?.caps ?? 0) & McrsCap.PeerData) !== 0;
  const updateCount = countCatalogUpdates(miniApps.installed, catalog.items);

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
      catalog: findMergedCatalogByAppId(Number(appIdStr)),
    }));

  // If a peer invited us to an unknown appId, check the remote catalog quietly.
  const hasUnknownPending = pendingEntries.some((p) => !p.catalog);
  useEffect(() => {
    if (hasUnknownPending) void refreshRemoteCatalog();
  }, [hasUnknownPending]);

  const handleInstallPending = async (appId: number) => {
    const entry = findMergedCatalogByAppId(appId);
    if (!entry) {
      openMiniAppStore();
      return;
    }
    setBusyAppId(appId);
    try {
      const pkg = await installFromCatalog(entry);
      toast(t("apps.sideloadDone", { name: pickText(pkg.manifest.name, loc) }));
      openMiniApp(pkg.manifest.id);
    } catch (error) {
      toast(t("apps.sideloadFailed", { error: error instanceof Error ? error.message : String(error) }), "error");
    } finally {
      setBusyAppId(null);
    }
  };

  return (
    <div className="list-pane">
      <header className="list-head">
        <h1>{t("apps.title")}</h1>
        <IconButton
          label={t("apps.storeTitle")}
          className={selected === "store" ? "on" : undefined}
          onClick={openMiniAppStore}
        >
          <PlusIcon size={20} />
        </IconButton>
      </header>
      <div className="screen-scroll">
        {!supportsPeerData ? (
          <div className="memory-strip warn" role="status">
            <span className="grow">{t("apps.mcrsMissing")}</span>
          </div>
        ) : null}

        {waitingItems.length > 0 || pendingEntries.length > 0 ? (
          <Group title={t("apps.waiting")}>
            {pendingEntries.map(({ appId, pkts, catalog: catItem }) => {
              const last = pkts.at(-1)!;
              const name = catItem ? pickText(catItem.name, loc) : `App 0x${appId.toString(16)}`;
              const isBusy = busyAppId === appId;
              return (
                <div key={`pending-${appId}`} className="line">
                  <Avatar
                    name={catItem ? catItem.id : String(appId)}
                    size={36}
                    icon={catItem ? <MiniAppIcon svg={catItem.iconSvg} size={19} /> : "?"}
                  />
                  <span className="line-text">
                    <span className="apps-clip">{name}</span>
                    <small className="apps-clip">
                      {t("apps.pendingFrom", { peer: last.peerName, count: pkts.length })}
                    </small>
                  </span>
                  <Button size="sm" variant="primary" disabled={isBusy} onClick={() => void handleInstallPending(appId)}>
                    {isBusy ? t("apps.installing") : t("apps.installAndOpen")}
                  </Button>
                </div>
              );
            })}
            {waitingItems.map(({ entry, activity }) => (
              <button
                key={`${entry.pkg.manifest.id}:${activity.id}`}
                type="button"
                className="line line-link"
                onClick={() => openMiniApp(entry.pkg.manifest.id, activity.id)}
              >
                <Avatar
                  name={entry.pkg.manifest.id}
                  size={36}
                  icon={<MiniAppIcon svg={entry.pkg.iconSvg} size={19} />}
                />
                <span className="line-text">
                  <span className="apps-clip">{activity.title}</span>
                  <small className="apps-clip">{activity.subtitle}</small>
                </span>
                <span className="apps-attention-dot" />
                <ChevronRightIcon size={14} className="line-chev" />
              </button>
            ))}
          </Group>
        ) : null}

        <Group title={t("apps.installed")} note={installedList.length === 0 ? t("apps.noApps") : undefined}>
          {installedList.map((entry) => {
            const m = entry.pkg.manifest;
            const acts = miniApps.activities[m.id] ?? [];
            const attn = acts.filter((a) => a.needsAttention).length;
            const isSelected = selected === m.id;
            return (
              <button
                key={m.id}
                type="button"
                className={["line", "line-link", isSelected ? "selected" : ""].filter(Boolean).join(" ")}
                aria-current={isSelected ? "page" : undefined}
                onClick={() => openMiniApp(m.id)}
              >
                <Avatar name={m.id} size={36} icon={<MiniAppIcon svg={entry.pkg.iconSvg} size={19} />} />
                <span className="line-text">
                  <span className="apps-clip">{pickText(m.name, loc)}</span>
                  <small className="apps-clip">
                    {acts[0] ? acts[0].subtitle : pickText(m.description, loc)}
                  </small>
                </span>
                {attn > 0 ? <span className="badge">{attn}</span> : null}
                <ChevronRightIcon size={14} className="line-chev" />
              </button>
            );
          })}
          {installedList.length === 0 ? (
            <LinkRow
              icon={<AppsIcon size={17} />}
              label={t("apps.openStore")}
              selected={selected === "store"}
              onClick={openMiniAppStore}
            />
          ) : null}
        </Group>

        {installedList.length > 0 ? (
          <Group>
            <LinkRow
              icon={<AppsIcon size={17} />}
              label={t("apps.storeTitle")}
              value={updateCount > 0 ? <span className="badge">{updateCount}</span> : undefined}
              selected={selected === "store"}
              onClick={openMiniAppStore}
            />
          </Group>
        ) : null}
      </div>
    </div>
  );
}
