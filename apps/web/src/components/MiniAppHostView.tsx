import { useEffect, useMemo, useRef, useState } from "react";
import { AdvType, MAX_PEER_DATA_LEN, McrsCap } from "@meshnet/meshcore";
import {
  pickText,
  type MiniAppPeer,
  type MiniAppPermission,
  type MiniAppTheme,
  type MiniAppViewport,
  type PickPeerOptions,
} from "@ommesh/miniapp-sdk";
import { language, t, type Key } from "../i18n/index.js";
import { getKeyboardState, setIframeTyping, subscribeKeyboard } from "../lib/keyboard.js";
import { isWide, subscribeWide } from "../lib/layout.js";
import { registerActiveMiniApp, showMiniAppNotice } from "../lib/miniapps/runtime.js";
import { buildSandboxDoc, createHostBridge, type HostBridge } from "../lib/miniapps/sandbox.js";
import { getMiniAppsState, uninstallMiniApp, useMiniApps } from "../lib/miniapps/store.js";
import { openMiniAppStore } from "../lib/nav.js";
import { appNoticeAllowed, setAppLevel, useNoticePrefs, type AppNoticeLevel } from "../lib/noticePrefs.js";
import { session, useSession } from "../lib/session.js";
import { toast } from "../lib/toast.js";
import { getActiveTheme, subscribeTheme } from "../theme/store.js";
import { getTextScale, subscribeTextSize } from "../theme/textSize.js";
import { Button, IconButton } from "../ui/Button.js";
import { Confirm, Dialog } from "../ui/Dialog.js";
import { SearchField } from "../ui/Field.js";
import { showMenu } from "../ui/Menu.js";
import { MiniAppIcon } from "./AppsHome.js";
import { Avatar } from "./Avatar.js";
import { BellIcon, BellOffIcon, InfoIcon, MoreIcon, TrashIcon } from "./Icons.js";
import { ScreenHead, type Chrome } from "./ScreenHead.js";

const PERM_LABEL: Record<MiniAppPermission, Key> = {
  peerData: "apps.perm.peerData",
  storage: "apps.perm.storage",
  notifications: "apps.perm.notifications",
};

function currentMiniAppTheme(): MiniAppTheme {
  const theme = getActiveTheme();
  const tokens: Record<string, string> = { ...theme.tokens };
  if (theme.bubble) {
    tokens["bubbleText"] = theme.bubble.text;
    tokens["bubbleTextMuted"] = theme.bubble.textMuted;
  }
  return {
    id: theme.id,
    appearance: theme.appearance,
    ...(theme.look ? { look: theme.look } : {}),
    textScale: getTextScale(),
    tokens,
  };
}

function readCssPx(name: string): number {
  if (typeof window === "undefined") return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function currentMiniAppViewport(iframe: HTMLIFrameElement | null): MiniAppViewport {
  const kb = getKeyboardState();
  const rect = iframe?.getBoundingClientRect();
  return {
    width: Math.round(rect?.width || (typeof window !== "undefined" ? window.innerWidth : 0)),
    height: Math.round(rect?.height || (typeof window !== "undefined" ? window.innerHeight : 0)),
    safeBottom: kb.open ? 0 : readCssPx("--safe-bottom"),
    safeLeft: readCssPx("--safe-left"),
    safeRight: readCssPx("--safe-right"),
    keyboardHeight: kb.height,
    keyboardOpen: kb.open,
    mobile: !isWide(),
  };
}

function sameViewport(a: MiniAppViewport | null, b: MiniAppViewport): boolean {
  return (
    !!a &&
    a.width === b.width &&
    a.height === b.height &&
    a.safeBottom === b.safeBottom &&
    a.safeLeft === b.safeLeft &&
    a.safeRight === b.safeRight &&
    a.keyboardHeight === b.keyboardHeight &&
    a.keyboardOpen === b.keyboardOpen &&
    a.mobile === b.mobile
  );
}

interface PickerRequest {
  options?: PickPeerOptions | undefined;
  resolve: (peer: MiniAppPeer | null) => void;
}

/**
 * Isolated mini-app host screen: renders a host-owned top bar (title, quick
 * per-app notification toggle, menu), mounts `<iframe sandbox="allow-scripts">`,
 * bridges `MessageChannel` RPCs and viewport/keyboard updates, and renders the
 * host-owned contact picker modal.
 */
export function MiniAppHostView({
  appSlug,
  activityId,
  chrome,
}: {
  appSlug: string;
  activityId?: string | undefined;
  chrome: Chrome;
}) {
  const miniApps = useMiniApps();
  const noticePrefs = useNoticePrefs();
  const state = useSession();
  const loc = language() === "ru" ? "ru" : "en";
  const radioKey = state.self?.key ?? "local";

  const entry = miniApps.installed[appSlug];
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<HostBridge | null>(null);
  const activityIdRef = useRef(activityId);
  activityIdRef.current = activityId;

  const [picker, setPicker] = useState<PickerRequest | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  const initialTheme = useMemo(() => currentMiniAppTheme(), [appSlug]);
  const initialViewport = useMemo(() => currentMiniAppViewport(null), [appSlug]);
  const srcDoc = useMemo(
    () => (entry ? buildSandboxDoc(entry.pkg, initialTheme, initialViewport) : ""),
    [entry, initialTheme, initialViewport],
  );

  // Mount isolated bridge, active app registration, and live theme/viewport/keyboard sync.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!entry || !iframe) return;
    const { manifest } = entry.pkg;

    const listGrantedPeers = (): MiniAppPeer[] => {
      const granted = new Set(getMiniAppsState().grants[manifest.id] ?? []);
      const contacts = Object.values(session.getState().contacts);
      const out: MiniAppPeer[] = [];
      for (const prefix of granted) {
        const found = contacts.find((c) => c.prefix.toLowerCase() === prefix);
        out.push({
          keyPrefix: prefix,
          name: found?.name || prefix.slice(0, 8),
          supportsPeerData: null,
        });
      }
      return out;
    };

    const bridge = createHostBridge({
      pkg: entry.pkg,
      radioKey: () => session.getState().self?.key ?? "local",
      getContext: () => {
        const s = session.getState();
        const self = s.self;
        const supportsPeerData = s.status === "ready" && ((s.mcrs?.caps ?? 0) & McrsCap.PeerData) !== 0;
        return {
          appId: manifest.appId,
          self: self ? { keyPrefix: self.prefix, name: self.name } : null,
          locale: language() === "ru" ? "ru" : "en",
          theme: currentMiniAppTheme(),
          viewport: currentMiniAppViewport(iframe),
          radio: {
            connected: s.status === "ready",
            maxPayloadBytes: MAX_PEER_DATA_LEN,
            supportsPeerData,
            ...(self ? { sf: self.spreadingFactor, bwHz: self.bandwidthHz, cr: self.codingRate } : {}),
          },
          initialActivityId: activityIdRef.current ?? null,
          grantedPeers: listGrantedPeers(),
        };
      },
      listGrantedPeers,
      pickPeer: (options) =>
        new Promise<MiniAppPeer | null>((resolve) => {
          setPickerQuery("");
          setPicker({ options, resolve });
        }),
      sendPeerData: async (peerPrefix, payload, retry) => {
        const contact = Object.values(session.getState().contacts).find(
          (c) => c.prefix.toLowerCase() === peerPrefix.toLowerCase(),
        );
        if (!contact) throw new Error("contact not found");
        const handle = await session.sendPeerData(contact.key, manifest.appId, payload, { retry: retry ?? true });
        return { packetId: handle.packetId, flood: handle.flood, estTimeoutMs: handle.estTimeoutMs };
      },
      notify: (options) => {
        showMiniAppNotice(manifest.appId, pickText(manifest.name, language() === "ru" ? "ru" : "en"), options);
      },
      onTypingChange: (typing) => setIframeTyping(typing),
      onClose: () => {
        if (chrome.onBack) chrome.onBack();
        else openMiniAppStore();
      },
    });

    bridgeRef.current = bridge;
    const detach = bridge.attach(iframe);
    const unregister = registerActiveMiniApp(manifest.id, manifest.appId, bridge);
    const stopTheme = subscribeTheme(() => bridge.sendTheme(currentMiniAppTheme()));
    const stopText = subscribeTextSize(() => bridge.sendTheme(currentMiniAppTheme()));

    let lastVp: MiniAppViewport | null = null;
    const pushViewport = () => {
      const next = currentMiniAppViewport(iframe);
      if (sameViewport(lastVp, next)) return;
      lastVp = next;
      bridge.sendViewport(next);
    };
    const stopKeyboard = subscribeKeyboard(pushViewport);
    const stopWide = subscribeWide(pushViewport);
    window.addEventListener("resize", pushViewport);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", pushViewport);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(pushViewport) : null;
    ro?.observe(iframe);

    return () => {
      ro?.disconnect();
      vv?.removeEventListener("resize", pushViewport);
      window.removeEventListener("resize", pushViewport);
      stopWide();
      stopKeyboard();
      stopText();
      stopTheme();
      unregister();
      detach();
      bridge.destroy();
      setIframeTyping(false);
      if (bridgeRef.current === bridge) bridgeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.pkg.manifest.id, entry?.pkg.manifest.version, entry?.sizeBytes, radioKey]);

  // Forward activityId changes to an already-mounted app iframe.
  useEffect(() => {
    if (activityId && bridgeRef.current) {
      bridgeRef.current.sendOpenActivity(activityId);
    }
  }, [activityId]);

  if (!entry) {
    return (
      <div className="screen">
        <ScreenHead chrome={chrome}>
          <span className="screen-name">{t("apps.title")}</span>
        </ScreenHead>
        <div className="apps-empty">
          <p className="muted">{t("apps.notInstalled")}</p>
          <Button variant="primary" onClick={openMiniAppStore}>
            {t("apps.openInStore")}
          </Button>
        </div>
      </div>
    );
  }

  const m = entry.pkg.manifest;
  const appName = pickText(m.name, loc);
  const canNotify = m.appId !== 0 && m.permissions.includes("notifications");
  const effectiveNotice: AppNoticeLevel = canNotify ? appNoticeAllowed(noticePrefs, m.appId) : "off";

  const cycleNotice = () => {
    const next: AppNoticeLevel = effectiveNotice === "all" ? "silent" : effectiveNotice === "silent" ? "off" : "all";
    setAppLevel(m.appId, next);
    const key: Key =
      next === "all"
        ? "apps.noticeLevel.toastAll"
        : next === "silent"
          ? "apps.noticeLevel.toastSilent"
          : "apps.noticeLevel.toastOff";
    toast(t(key, { name: appName }));
  };

  const openMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    showMenu(
      [
        { label: t("apps.infoTitle"), icon: <InfoIcon size={16} />, onSelect: () => setInfoOpen(true) },
        { label: t("apps.uninstall"), icon: <TrashIcon size={16} />, danger: true, onSelect: () => setRemoveOpen(true) },
      ],
      { at: { x: rect.right, y: rect.bottom } },
    );
  };

  const contacts = Object.values(state.contacts)
    .filter((c) => !c.unsaved && c.type === AdvType.Chat)
    .filter((c) => {
      const q = pickerQuery.trim().toLowerCase();
      if (!q) return true;
      return (c.name || "").toLowerCase().includes(q) || c.prefix.toLowerCase().includes(q);
    })
    .sort((a, b) => (a.name || a.prefix).localeCompare(b.name || b.prefix));

  const finishPick = (peer: MiniAppPeer | null) => {
    const req = picker;
    setPicker(null);
    req?.resolve(peer);
  };

  return (
    <div className="screen">
      <ScreenHead
        chrome={chrome}
        actions={
          <div className="apps-host-actions">
            {canNotify ? (
              <IconButton
                label={t(
                  effectiveNotice === "all"
                    ? "apps.noticeLevel.all"
                    : effectiveNotice === "silent"
                      ? "apps.noticeLevel.silent"
                      : "apps.noticeLevel.off",
                )}
                onClick={cycleNotice}
              >
                {effectiveNotice === "off" ? <BellOffIcon size={18} /> : <BellIcon size={18} />}
              </IconButton>
            ) : null}
            <IconButton label={t("apps.infoTitle")} onClick={openMenu}>
              <MoreIcon size={18} />
            </IconButton>
          </div>
        }
      >
        <span className="screen-name apps-host-title">
          <MiniAppIcon svg={entry.pkg.iconSvg} size={18} />
          <span>{appName}</span>
        </span>
      </ScreenHead>

      <iframe
        key={`${m.id}:${m.version}:${entry.sizeBytes}:${radioKey}`}
        ref={iframeRef}
        className="apps-iframe"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        title={appName}
      />

      <Dialog
        open={picker !== null}
        title={t("apps.pickerTitle")}
        onClose={() => finishPick(null)}
        footer={<Button onClick={() => finishPick(null)}>{t("apps.pickerCancel")}</Button>}
      >
        <p className="apps-picker-hint">{t("apps.pickerHint", { app: appName })}</p>
        <SearchField
          value={pickerQuery}
          onValue={setPickerQuery}
          placeholder={t("apps.pickerSearch")}
          aria-label={t("apps.pickerSearch")}
        />
        <div className="apps-picker-list">
          {contacts.length === 0 ? (
            <p className="muted">{t("apps.pickerEmpty")}</p>
          ) : (
            contacts.map((c) => {
              const display = c.name || c.prefix;
              return (
                <button
                  key={c.key}
                  type="button"
                  className="apps-picker-row"
                  onClick={() =>
                    finishPick({ keyPrefix: c.prefix.toLowerCase(), name: display, supportsPeerData: null })
                  }
                >
                  <Avatar name={display} type={c.type} size={28} />
                  <div className="apps-row-body">
                    <div className="apps-row-title">{display}</div>
                    <div className="apps-row-sub mono">{c.prefix}</div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </Dialog>

      <Dialog
        open={infoOpen}
        title={appName}
        onClose={() => setInfoOpen(false)}
        footer={<Button onClick={() => setInfoOpen(false)}>{t("common.close")}</Button>}
      >
        <p className="apps-store-desc">{pickText(m.description, loc)}</p>
        <dl className="apps-info-dl">
          <dt>{t("apps.versionLabel")}</dt>
          <dd>{m.version}</dd>
          <dt>{t("apps.authorLabel")}</dt>
          <dd>{m.author}</dd>
          <dt>{t("apps.appIdLabel")}</dt>
          <dd className="mono">{m.appId === 0 ? "—" : `0x${m.appId.toString(16).padStart(4, "0")}`}</dd>
          <dt>{t("apps.permissionsLabel")}</dt>
          <dd>
            {m.permissions.length === 0 ? (
              t("apps.noPermissions")
            ) : (
              <div className="apps-perm-row">
                {m.permissions.map((p) => (
                  <span key={p} className="apps-perm-chip">
                    {t(PERM_LABEL[p])}
                  </span>
                ))}
              </div>
            )}
          </dd>
        </dl>
      </Dialog>

      <Confirm
        open={removeOpen}
        title={t("apps.removeConfirmTitle", { name: appName })}
        body={<p>{t("apps.removeConfirmBody")}</p>}
        confirmLabel={t("apps.uninstall")}
        danger
        onCancel={() => setRemoveOpen(false)}
        onConfirm={() => {
          uninstallMiniApp(m.id);
          toast(t("apps.removed", { name: appName }));
          setRemoveOpen(false);
          openMiniAppStore();
        }}
      />
    </div>
  );
}
