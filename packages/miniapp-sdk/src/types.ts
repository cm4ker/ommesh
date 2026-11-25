/**
 * Public contract for isolated Ommesh mini-apps (`@ommesh/miniapp-sdk`).
 *
 * Third-party developers target these types; the Ommesh host enforces every
 * permission, peer grant, rate limit, storage quota and CSP boundary.
 */

export type Locale = "ru" | "en";

export type LocalizedText = string | Partial<Record<Locale, string>>;

export type MiniAppScope = "standalone" | "p2p" | "channel";

export type MiniAppPermission = "peerData" | "storage" | "notifications";

export type ActivityTone = "neutral" | "accent" | "success" | "warning" | "danger";

export interface BackgroundNoticeConfig {
  /** Bitmask applied to `payload[0]` before looking up `labels` (e.g. `0x1f` for 5-bit opcodes). */
  opcodeMask: number;
  fallback: LocalizedText;
  labels: Record<string, LocalizedText>;
}

export interface MiniAppManifest {
  schema: 1;
  /** Reverse-DNS style unique slug, e.g. `"ommesh.chess"`. */
  id: string;
  /**
   * 16-bit MCRS v2 `appId` (`0x0100..0xfeff` for catalog apps, `0xff00..0xffff`
   * for developer sideloading, `0` for standalone utilities without radio traffic).
   */
  appId: number;
  version: string;
  name: LocalizedText;
  description: LocalizedText;
  author: string;
  homepage?: string;
  scope: MiniAppScope;
  /** Minimum MCRS protocol version required when `scope === "p2p"`. */
  minProtocol?: number;
  permissions: MiniAppPermission[];
  limits?: {
    storageKb?: number;
    maxPacketsPerMin?: number;
  };
  backgroundNotices?: BackgroundNoticeConfig;
}

/** A self-contained `.omapp` package stored offline by Ommesh. */
export interface MiniAppPackage {
  format: "omapp-v1";
  manifest: MiniAppManifest;
  /** Monochrome or theme-aware SVG icon markup (`currentColor`). */
  iconSvg: string;
  /** Full HTML body/document for the sandboxed iframe. */
  html: string;
  /** Optional headless worker script handling incoming packets while UI is closed. */
  workerJs?: string;
  /** Optional Ed25519 signature (hex) from the store catalog key. */
  signature?: string;
}

export interface MiniAppPeer {
  /** 12-char hex prefix of the peer's public key. */
  keyPrefix: string;
  name: string;
  /** Whether the peer is known to support MCRS v2 `PEER_DATA`, or null if unknown. */
  supportsPeerData: boolean | null;
}

export interface MiniAppTheme {
  id: string;
  appearance: "light" | "dark";
  /** Optional Ommesh visual look (`"lcd"` for Olive, `"classic"` for Pebble). */
  look?: "lcd" | "classic";
  /** Reader's text size multiplier from Ommesh Appearance settings (default `1`). */
  textScale?: number;
  tokens: Record<string, string>;
}

export interface MiniAppRadioInfo {
  connected: boolean;
  maxPayloadBytes: number;
  supportsPeerData: boolean;
  sf?: number;
  bwHz?: number;
  cr?: number;
}

export interface MiniAppContext {
  appId: number;
  self: { keyPrefix: string; name: string } | null;
  locale: Locale;
  theme: MiniAppTheme;
  radio: MiniAppRadioInfo;
  /** Optional activity id the user tapped to open this app (e.g. `"game:a4f2"`). */
  initialActivityId: string | null;
  /** Peers already granted to this app (either picked earlier or messaged us). */
  grantedPeers: MiniAppPeer[];
}

export interface MiniAppActivity {
  id: string;
  peerKeyPrefix?: string;
  title: string;
  subtitle: string;
  badge?: { text: string; tone: ActivityTone };
  /** Contributes to the unread badge on the Apps tab and appears in "Needs attention". */
  needsAttention: boolean;
  updatedAt: number;
}

export interface IncomingPacket {
  peerPrefix: string;
  peerName: string;
  payload: Uint8Array;
  timestamp: number;
  snr: number;
  hops: number | null;
  mirrored?: boolean;
}

export type DeliveryStatus = "sent" | "retrying" | "delivered" | "unconfirmed" | "failed";

export interface DeliveryUpdate {
  packetId: string;
  peerPrefix: string;
  status: DeliveryStatus;
  attempt: number;
  flood?: boolean;
  rttMs?: number;
  error?: string;
}

export interface SendResult {
  packetId: string;
  flood: boolean;
  estTimeoutMs: number;
}

export interface NotifyOptions {
  title?: string;
  body: string;
  tag?: string;
  peerPrefix?: string;
}

export interface PickPeerOptions {
  /** Hint to highlight MCRS v2 peer-data capable contacts in the host picker. */
  requirePeerData?: boolean;
}

/** Public API available inside a sandboxed mini-app via `connect()` or `window.ommesh`. */
export interface OmmeshApp {
  readonly context: MiniAppContext;
  peers: {
    list(): Promise<MiniAppPeer[]>;
    pick(options?: PickPeerOptions): Promise<MiniAppPeer | null>;
  };
  transport: {
    send(peerPrefix: string, payload: Uint8Array, options?: { retry?: boolean }): Promise<SendResult>;
    onPacket(cb: (packet: IncomingPacket) => void): () => void;
    onDelivery(cb: (update: DeliveryUpdate) => void): () => void;
  };
  storage: {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(): Promise<string[]>;
  };
  ui: {
    setActivities(activities: MiniAppActivity[]): Promise<void>;
    notify(options: NotifyOptions): Promise<void>;
    onThemeChange(cb: (theme: MiniAppTheme) => void): () => void;
    onOpenActivity(cb: (activityId: string) => void): () => void;
    close(): void;
  };
}

/** RPC messages sent from the sandboxed iframe to the Ommesh host over `MessagePort`. */
export type AppRpcRequest =
  | { id: number; method: "peers.list" }
  | { id: number; method: "peers.pick"; options?: PickPeerOptions }
  | { id: number; method: "transport.send"; peerPrefix: string; payload: Uint8Array; retry?: boolean }
  | { id: number; method: "storage.get"; key: string }
  | { id: number; method: "storage.set"; key: string; value: unknown }
  | { id: number; method: "storage.delete"; key: string }
  | { id: number; method: "storage.list" }
  | { id: number; method: "ui.setActivities"; activities: MiniAppActivity[] }
  | { id: number; method: "ui.notify"; options: NotifyOptions }
  | { id: number; method: "ui.close" };

/** Messages sent from the Ommesh host to the sandboxed iframe over `MessagePort`. */
export type HostRpcMessage =
  | { type: "rpc:result"; id: number; result: unknown }
  | { type: "rpc:error"; id: number; message: string }
  | { type: "event:packet"; packet: IncomingPacket }
  | { type: "event:delivery"; update: DeliveryUpdate }
  | { type: "event:theme"; theme: MiniAppTheme }
  | { type: "event:openActivity"; activityId: string }
  | { type: "event:peers"; peers: MiniAppPeer[] };

/** Input handed to a mini-app's ephemeral background worker when UI is closed. */
export interface WorkerInput {
  self: { keyPrefix: string; name: string } | null;
  locale: Locale;
  packet: IncomingPacket;
  storage: Record<string, unknown>;
}

/** Structured side effects returned by a mini-app's ephemeral background worker. */
export interface WorkerOutput {
  storageSet?: Record<string, unknown>;
  storageDelete?: string[];
  activities?: MiniAppActivity[];
  notify?: NotifyOptions | null;
  send?: { peerPrefix: string; payload: number[]; retry?: boolean }[];
}
