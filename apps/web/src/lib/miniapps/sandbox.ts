/**
 * Sandboxed iframe builder and host-side MessageChannel RPC gatekeeper.
 *
 * Every mini-app runs inside `<iframe sandbox="allow-scripts">` (opaque `null`
 * origin, no `allow-same-origin`, strict `connect-src 'none'` CSP). All access
 * to radio transport, storage, peer picking and notifications passes through
 * the private `MessagePort` created here and is strictly scoped to the app's
 * declared `appId`, `permissions`, Peer Grants, and LoRa rate limit.
 */

import {
  INLINE_SDK_BRIDGE,
  SANDBOX_CSP,
  type AppRpcRequest,
  type DeliveryUpdate,
  type HostRpcMessage,
  type IncomingPacket,
  type MiniAppContext,
  type MiniAppPackage,
  type MiniAppPeer,
  type MiniAppTheme,
  type MiniAppViewport,
  type NotifyOptions,
  type PickPeerOptions,
  type SendResult,
} from "@ommesh/miniapp-sdk";
import {
  deleteAppKv,
  getAppKv,
  grantPeerToApp,
  hasPeerGrant,
  listAppKv,
  setAppActivities,
  setAppKv,
} from "./store.js";

const MAX_PRE_READY_QUEUE = 64;

/** Converts Ommesh camelCase ThemeTokens into CSS custom properties on `:root`. */
function themeCssVars(theme: MiniAppTheme, viewport?: MiniAppViewport): string {
  const lines = Object.entries(theme.tokens).map(
    ([k, v]) => `  --${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}: ${v};`,
  );
  lines.push(`  --text-scale: ${theme.textScale ?? 1};`);
  lines.push(`  --safe-bottom: ${Math.max(0, Math.round(viewport?.safeBottom ?? 0))}px;`);
  lines.push(`  --safe-left: ${Math.max(0, Math.round(viewport?.safeLeft ?? 0))}px;`);
  lines.push(`  --safe-right: ${Math.max(0, Math.round(viewport?.safeRight ?? 0))}px;`);
  lines.push(`  --keyboard-height: ${Math.max(0, Math.round(viewport?.keyboardHeight ?? 0))}px;`);
  return `:root {\n  color-scheme: ${theme.appearance};\n${lines.join("\n")}\n}`;
}

/** Builds a self-contained, CSP-hardened HTML document for `iframe.srcdoc`. */
export function buildSandboxDoc(pkg: MiniAppPackage, theme: MiniAppTheme, viewport?: MiniAppViewport): string {
  const baseStyle = `
${themeCssVars(theme, viewport)}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-ui, "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  font-size: calc(14px * var(--text-scale, 1));
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
  overscroll-behavior: contain;
}
/* Prevent iOS Safari / WKWebView from zooming into inputs smaller than 16px. */
@media (pointer: coarse) {
  input:not([type="checkbox"], [type="radio"], [type="range"]),
  textarea,
  select {
    font-size: max(16px, calc(14px * var(--text-scale, 1))) !important;
  }
}
:root[data-look] *,
:root[data-look] *::before,
:root[data-look] *::after {
  border-radius: 0 !important;
}
:root[data-look="lcd"] {
  --font-ui: ui-monospace, "Cascadia Mono", Consolas, monospace;
}
:root[data-look="lcd"] body::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
  background:
    linear-gradient(color-mix(in srgb, var(--text) 5%, transparent) 1px, transparent 1px) 0 0 / 3px 3px,
    linear-gradient(90deg, color-mix(in srgb, var(--text) 5%, transparent) 1px, transparent 1px) 0 0 / 3px 3px;
}
:root[data-look="classic"] {
  --font-ui: Tahoma, Verdana, "Segoe UI", sans-serif;
}
@media (pointer: fine) {
  ::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }
  ::-webkit-scrollbar-track {
    background: transparent;
  }
  ::-webkit-scrollbar-thumb {
    background: color-mix(in oklab, var(--text) 28%, transparent);
    border-radius: 5px;
    border: 2px solid transparent;
    background-clip: content-box;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: color-mix(in oklab, var(--text) 45%, transparent);
    border: 2px solid transparent;
    background-clip: content-box;
  }
}
`;
  const bridge = `<script>${INLINE_SDK_BRIDGE.replace(/<\/script>/gi, "<\\/script>")}</script>`;
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover,interactive-widget=resizes-content"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"><style>${baseStyle}</style>${bridge}`;
  const lookAttr = theme.look ? ` data-look="${theme.look}"` : "";
  const kbAttr = ` data-keyboard="${viewport?.keyboardOpen ? "open" : "closed"}"`;
  const mobAttr = ` data-mobile="${viewport?.mobile ? "1" : "0"}"`;
  if (/<head[\s>]/i.test(pkg.html)) {
    return pkg.html.replace(/<head([^>]*)>/i, `<head$1>${head}`);
  }
  return `<!doctype html><html data-appearance="${theme.appearance}"${lookAttr}${kbAttr}${mobAttr}><head>${head}</head><body>${pkg.html}</body></html>`;
}

export interface HostBridgeDeps {
  pkg: MiniAppPackage;
  radioKey: () => string;
  getContext: () => MiniAppContext;
  listGrantedPeers: () => MiniAppPeer[];
  pickPeer: (options?: PickPeerOptions) => Promise<MiniAppPeer | null>;
  sendPeerData: (peerPrefix: string, payload: Uint8Array, retry?: boolean) => Promise<SendResult>;
  notify: (options: NotifyOptions) => void;
  onTypingChange?: (typing: boolean) => void;
  onClose: () => void;
}

export interface HostBridge {
  attach(iframe: HTMLIFrameElement): () => void;
  sendPacket(packet: IncomingPacket): void;
  sendDelivery(update: DeliveryUpdate): void;
  sendTheme(theme: MiniAppTheme): void;
  sendViewport(viewport: MiniAppViewport): void;
  sendOpenActivity(activityId: string): void;
  sendPeers(peers: MiniAppPeer[]): void;
  destroy(): void;
}

/**
 * Token-bucket guard preventing a buggy or malicious mini-app from saturating
 * the LoRa duty cycle (burst 5, refills 1 token per 1500 ms).
 */
class RateLimiter {
  private tokens = 5;
  private last = Date.now();
  private readonly max = 5;
  private readonly refillMs = 1500;

  take(): boolean {
    const now = Date.now();
    const gained = (now - this.last) / this.refillMs;
    if (gained > 0) {
      this.tokens = Math.min(this.max, this.tokens + gained);
      this.last = now;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export function createHostBridge(deps: HostBridgeDeps): HostBridge {
  const { manifest } = deps.pkg;
  const perms = new Set(manifest.permissions);
  const limiter = new RateLimiter();
  let port: MessagePort | null = null;
  let destroyed = false;
  // Queue events that arrive after the host view mounts but before the iframe finishes loading and sends `ommesh:ready`.
  const preReadyPackets: IncomingPacket[] = [];
  const preReadyDeliveries: DeliveryUpdate[] = [];
  let preReadyOpenActivity: string | null = null;

  function post(msg: HostRpcMessage): void {
    if (destroyed || !port) return;
    port.postMessage(msg);
  }

  async function handleRpc(req: AppRpcRequest): Promise<unknown> {
    switch (req.method) {
      case "peers.list":
        return deps.listGrantedPeers();

      case "peers.pick": {
        if (!perms.has("peerData")) throw new Error("permission denied: peerData");
        const picked = await deps.pickPeer(req.options);
        if (picked) {
          grantPeerToApp(manifest.id, picked.keyPrefix);
          post({ type: "event:peers", peers: deps.listGrantedPeers() });
        }
        return picked;
      }

      case "transport.send": {
        if (!perms.has("peerData") || manifest.appId === 0) {
          throw new Error("permission denied: peerData");
        }
        const prefix = String(req.peerPrefix ?? "").toLowerCase();
        if (!hasPeerGrant(manifest.id, prefix)) {
          throw new Error("peer not granted to this mini-app; call peers.pick() first");
        }
        if (!limiter.take()) {
          throw new Error("LoRa rate limit exceeded; slow down");
        }
        const bytes = req.payload instanceof Uint8Array ? req.payload : new Uint8Array(req.payload);
        return deps.sendPeerData(prefix, bytes, req.retry);
      }

      case "storage.get": {
        if (!perms.has("storage")) throw new Error("permission denied: storage");
        return getAppKv(deps.radioKey(), manifest.id, String(req.key));
      }

      case "storage.set": {
        if (!perms.has("storage")) throw new Error("permission denied: storage");
        setAppKv(deps.radioKey(), manifest.id, String(req.key), req.value);
        return null;
      }

      case "storage.delete": {
        if (!perms.has("storage")) throw new Error("permission denied: storage");
        deleteAppKv(deps.radioKey(), manifest.id, String(req.key));
        return null;
      }

      case "storage.list": {
        if (!perms.has("storage")) throw new Error("permission denied: storage");
        return listAppKv(deps.radioKey(), manifest.id);
      }

      case "ui.setActivities": {
        setAppActivities(manifest.id, Array.isArray(req.activities) ? req.activities : []);
        return null;
      }

      case "ui.notify": {
        if (!perms.has("notifications")) throw new Error("permission denied: notifications");
        deps.notify(req.options);
        return null;
      }

      case "ui.close": {
        deps.onClose();
        return null;
      }
    }
  }

  return {
    attach(iframe: HTMLIFrameElement): () => void {
      function onMessage(ev: MessageEvent): void {
        if (destroyed || ev.source !== iframe.contentWindow) return;
        if (ev.data?.type === "ommesh:focus") {
          deps.onTypingChange?.(Boolean(ev.data.typing));
          return;
        }
        if (ev.data?.type !== "ommesh:ready") return;
        port?.close();
        const channel = new MessageChannel();
        port = channel.port1;
        port.onmessage = (rpcEv: MessageEvent<AppRpcRequest>) => {
          const req = rpcEv.data;
          if (!req || typeof req.id !== "number") return;
          void handleRpc(req)
            .then((result) => post({ type: "rpc:result", id: req.id, result }))
            .catch((error: unknown) =>
              post({ type: "rpc:error", id: req.id, message: error instanceof Error ? error.message : String(error) }),
            );
        };
        port.start();
        iframe.contentWindow?.postMessage(
          { type: "ommesh:init", context: deps.getContext() },
          "*",
          [channel.port2],
        );
        // Flush any packets or deliveries that arrived while the iframe was still booting.
        for (const pkt of preReadyPackets.splice(0, preReadyPackets.length)) {
          post({ type: "event:packet", packet: pkt });
        }
        for (const upd of preReadyDeliveries.splice(0, preReadyDeliveries.length)) {
          post({ type: "event:delivery", update: upd });
        }
        if (preReadyOpenActivity !== null) {
          const actId = preReadyOpenActivity;
          preReadyOpenActivity = null;
          post({ type: "event:openActivity", activityId: actId });
        }
      }

      window.addEventListener("message", onMessage);
      return () => {
        window.removeEventListener("message", onMessage);
        deps.onTypingChange?.(false);
        port?.close();
        port = null;
      };
    },
    sendPacket(packet) {
      if (destroyed) return;
      if (!port) {
        preReadyPackets.push(packet);
        if (preReadyPackets.length > MAX_PRE_READY_QUEUE) preReadyPackets.shift();
        return;
      }
      post({ type: "event:packet", packet });
    },
    sendDelivery(update) {
      if (destroyed) return;
      if (!port) {
        preReadyDeliveries.push(update);
        if (preReadyDeliveries.length > MAX_PRE_READY_QUEUE) preReadyDeliveries.shift();
        return;
      }
      post({ type: "event:delivery", update });
    },
    sendTheme: (theme) => post({ type: "event:theme", theme }),
    sendViewport: (viewport) => post({ type: "event:viewport", viewport }),
    sendOpenActivity(activityId) {
      if (destroyed) return;
      if (!port) {
        preReadyOpenActivity = activityId;
        return;
      }
      post({ type: "event:openActivity", activityId });
    },
    sendPeers: (peers) => post({ type: "event:peers", peers }),
    destroy() {
      destroyed = true;
      preReadyPackets.length = 0;
      preReadyDeliveries.length = 0;
      preReadyOpenActivity = null;
      deps.onTypingChange?.(false);
      port?.close();
      port = null;
    },
  };
}
