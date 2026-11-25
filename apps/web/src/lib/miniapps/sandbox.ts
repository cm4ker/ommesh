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

/** Converts Ommesh camelCase ThemeTokens into CSS custom properties on `:root`. */
function themeCssVars(theme: MiniAppTheme): string {
  const lines = Object.entries(theme.tokens).map(
    ([k, v]) => `  --${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}: ${v};`,
  );
  lines.push(`  --text-scale: ${theme.textScale ?? 1};`);
  return `:root {\n  color-scheme: ${theme.appearance};\n${lines.join("\n")}\n}`;
}

/** Builds a self-contained, CSP-hardened HTML document for `iframe.srcdoc`. */
export function buildSandboxDoc(pkg: MiniAppPackage, theme: MiniAppTheme): string {
  const baseStyle = `
${themeCssVars(theme)}
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
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"><style>${baseStyle}</style>${bridge}`;
  const lookAttr = theme.look ? ` data-look="${theme.look}"` : "";
  if (/<head[\s>]/i.test(pkg.html)) {
    return pkg.html.replace(/<head([^>]*)>/i, `<head$1>${head}`);
  }
  return `<!doctype html><html data-appearance="${theme.appearance}"${lookAttr}><head>${head}</head><body>${pkg.html}</body></html>`;
}

export interface HostBridgeDeps {
  pkg: MiniAppPackage;
  radioKey: () => string;
  getContext: () => MiniAppContext;
  listGrantedPeers: () => MiniAppPeer[];
  pickPeer: (options?: PickPeerOptions) => Promise<MiniAppPeer | null>;
  sendPeerData: (peerPrefix: string, payload: Uint8Array, retry?: boolean) => Promise<SendResult>;
  notify: (options: NotifyOptions) => void;
  onClose: () => void;
}

export interface HostBridge {
  attach(iframe: HTMLIFrameElement): () => void;
  sendPacket(packet: IncomingPacket): void;
  sendDelivery(update: DeliveryUpdate): void;
  sendTheme(theme: MiniAppTheme): void;
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
      }

      window.addEventListener("message", onMessage);
      return () => {
        window.removeEventListener("message", onMessage);
        port?.close();
        port = null;
      };
    },
    sendPacket: (packet) => post({ type: "event:packet", packet }),
    sendDelivery: (update) => post({ type: "event:delivery", update }),
    sendTheme: (theme) => post({ type: "event:theme", theme }),
    sendOpenActivity: (activityId) => post({ type: "event:openActivity", activityId }),
    sendPeers: (peers) => post({ type: "event:peers", peers }),
    destroy() {
      destroyed = true;
      port?.close();
      port = null;
    },
  };
}
