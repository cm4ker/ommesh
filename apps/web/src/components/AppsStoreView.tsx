import { useEffect, useRef, useState } from "react";
import { decodeOmapp, pickText, type MiniAppPermission, type MiniAppScope } from "@ommesh/miniapp-sdk";
import { language, t, type Key } from "../i18n/index.js";
import {
  hasCatalogUpdate,
  installFromCatalog,
  refreshRemoteCatalog,
  useStoreCatalog,
  type StoreCatalogItem,
} from "../lib/miniapps/remoteCatalog.js";
import { installAndReplay } from "../lib/miniapps/runtime.js";
import { uninstallMiniApp, useMiniApps } from "../lib/miniapps/store.js";
import { openMiniApp } from "../lib/nav.js";
import { toast } from "../lib/toast.js";
import { Button } from "../ui/Button.js";
import { Confirm } from "../ui/Dialog.js";
import { MiniAppIcon } from "./AppsHome.js";
import { ScreenHead, type Chrome } from "./ScreenHead.js";

const PERM_LABEL: Record<MiniAppPermission, Key> = {
  peerData: "apps.perm.peerData",
  storage: "apps.perm.storage",
  notifications: "apps.perm.notifications",
};

type Filter = "all" | "p2p" | "standalone";

function matchesFilter(scope: MiniAppScope, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "standalone") return scope === "standalone";
  return scope !== "standalone";
}

function formatKb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function AppsStoreView({ chrome }: { chrome: Chrome }) {
  const miniApps = useMiniApps();
  const catalog = useStoreCatalog();
  const [filter, setFilter] = useState<Filter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const loc = language() === "ru" ? "ru" : "en";

  // Refresh remote catalog manifest quietly on Store open (respecting cooldown, falling back to offline bundle).
  useEffect(() => {
    void refreshRemoteCatalog();
  }, []);

  const catalogIds = new Set(catalog.items.map((e) => e.id));
  const sideloaded = Object.values(miniApps.installed).filter((e) => !catalogIds.has(e.pkg.manifest.id));
  const visibleCatalog = catalog.items.filter((e) => matchesFilter(e.scope, filter));

  const handleRefresh = async () => {
    const ok = await refreshRemoteCatalog({ force: true });
    toast(t(ok ? "apps.catalogUpToDate" : "apps.catalogOffline"));
  };

  const handleInstallOrUpdate = async (item: StoreCatalogItem, isUpdate: boolean) => {
    setBusyId(item.id);
    try {
      const pkg = await installFromCatalog(item);
      const name = pickText(pkg.manifest.name, loc);
      if (isUpdate) {
        toast(t("apps.updatedDone", { name, version: pkg.manifest.version }));
      } else {
        toast(t("apps.sideloadDone", { name }));
        openMiniApp(pkg.manifest.id);
      }
    } catch (error) {
      toast(t("apps.sideloadFailed", { error: error instanceof Error ? error.message : String(error) }), "error");
    } finally {
      setBusyId(null);
    }
  };

  const handleSideloadFile = async (file: File) => {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const pkg = decodeOmapp(buf);
      await installAndReplay(pkg, "sideload");
      const name = pickText(pkg.manifest.name, loc);
      toast(t("apps.sideloadDone", { name }));
      openMiniApp(pkg.manifest.id);
    } catch (error) {
      toast(t("apps.sideloadFailed", { error: error instanceof Error ? error.message : String(error) }), "error");
    }
  };

  return (
    <div className="screen">
      <ScreenHead
        chrome={chrome}
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".omapp,.json"
              className="apps-hidden-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void handleSideloadFile(f);
              }}
            />
            <Button size="sm" onClick={() => fileInput.current?.click()}>
              {t("apps.sideloadButton")}
            </Button>
          </>
        }
      >
        <span className="screen-name">{t("apps.storeTitle")}</span>
      </ScreenHead>

      <div className="screen-scroll">
        <div className="apps-store-wrap">
          <div className="apps-store-bar">
            <div className="preset-chips">
              {(
                [
                  ["all", "apps.filterAll"],
                  ["p2p", "apps.peerTag"],
                  ["standalone", "apps.standaloneTag"],
                ] as const
              ).map(([id, key]) => (
                <button
                  key={id}
                  type="button"
                  className={["chip", filter === id ? "on" : ""].filter(Boolean).join(" ")}
                  onClick={() => setFilter(id)}
                >
                  {t(key)}
                </button>
              ))}
            </div>
            <Button size="sm" variant="ghost" disabled={catalog.loading} onClick={() => void handleRefresh()}>
              {catalog.loading ? t("apps.refreshingCatalog") : t("apps.refreshCatalog")}
            </Button>
          </div>

          <div className="apps-store-grid">
            {visibleCatalog.map((item) => {
              const installed = miniApps.installed[item.id];
              const updateAvail = hasCatalogUpdate(installed, item);
              const isBusy = busyId === item.id;
              const name = pickText(item.name, loc);
              const verText = installed && updateAvail
                ? `v${installed.pkg.manifest.version} → v${item.version}`
                : `v${installed ? installed.pkg.manifest.version : item.version}`;
              return (
                <article key={item.id} className="apps-store-card">
                  <div className="apps-store-head">
                    <span className="apps-icon-tile apps-icon-lg">
                      <MiniAppIcon svg={item.iconSvg} size={24} />
                    </span>
                    <div className="apps-store-meta">
                      <div className="apps-store-title-line">
                        <strong className="apps-store-name">{name}</strong>
                        {updateAvail ? (
                          <span className="apps-tag-update">{t("apps.updateBadge", { version: item.version })}</span>
                        ) : item.verified ? (
                          <span className="apps-tag-ok">{t("apps.verifiedBadge")}</span>
                        ) : null}
                      </div>
                      <div className="apps-row-sub">
                        {verText} · {formatKb(item.sizeBytes)} · {item.scope === "standalone" ? t("apps.standaloneTag") : t("apps.peerTag")}
                      </div>
                    </div>
                  </div>
                  <p className="apps-store-desc">{pickText(item.description, loc)}</p>
                  <div className="apps-perm-row">
                    {item.permissions.length === 0 ? (
                      <span className="apps-perm-chip">{t("apps.noPermissions")}</span>
                    ) : (
                      item.permissions.map((p) => (
                        <span key={p} className="apps-perm-chip">
                          {t(PERM_LABEL[p])}
                        </span>
                      ))
                    )}
                  </div>
                  <div className="apps-store-actions">
                    {installed && updateAvail ? (
                      <>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={isBusy}
                          onClick={() => void handleInstallOrUpdate(item, true)}
                        >
                          {isBusy ? t("apps.updating") : t("apps.update")}
                        </Button>
                        <Button size="sm" onClick={() => openMiniApp(item.id)}>
                          {t("apps.open")}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRemoving({ id: item.id, name })}>
                          {t("apps.uninstall")}
                        </Button>
                      </>
                    ) : installed ? (
                      <>
                        <Button size="sm" variant="primary" onClick={() => openMiniApp(item.id)}>
                          {t("apps.open")}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRemoving({ id: item.id, name })}>
                          {t("apps.uninstall")}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={isBusy}
                        onClick={() => void handleInstallOrUpdate(item, false)}
                      >
                        {isBusy ? t("apps.installing") : t("apps.install")}
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}

            {sideloaded
              .filter((e) => matchesFilter(e.pkg.manifest.scope, filter))
              .map((entry) => {
                const m = entry.pkg.manifest;
                const name = pickText(m.name, loc);
                return (
                  <article key={m.id} className="apps-store-card">
                    <div className="apps-store-head">
                      <span className="apps-icon-tile apps-icon-lg">
                        <MiniAppIcon svg={entry.pkg.iconSvg} size={24} />
                      </span>
                      <div className="apps-store-meta">
                        <div className="apps-store-title-line">
                          <strong className="apps-store-name">{name}</strong>
                          <span className="apps-perm-chip">{t("apps.sideloadBadge")}</span>
                        </div>
                        <div className="apps-row-sub">
                          v{m.version} · {formatKb(entry.sizeBytes)} · {m.author}
                        </div>
                      </div>
                    </div>
                    <p className="apps-store-desc">{pickText(m.description, loc)}</p>
                    <div className="apps-store-actions">
                      <Button size="sm" variant="primary" onClick={() => openMiniApp(m.id)}>
                        {t("apps.open")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRemoving({ id: m.id, name })}>
                        {t("apps.uninstall")}
                      </Button>
                    </div>
                  </article>
                );
              })}
          </div>
        </div>
      </div>

      <Confirm
        open={removing !== null}
        title={t("apps.removeConfirmTitle", { name: removing?.name ?? "" })}
        body={<p>{t("apps.removeConfirmBody")}</p>}
        confirmLabel={t("apps.uninstall")}
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) {
            uninstallMiniApp(removing.id);
            toast(t("apps.removed", { name: removing.name }));
          }
          setRemoving(null);
        }}
      />
    </div>
  );
}
