# Ommesh Mini-App SDK — Methods Reference

> **English** · [Русский](miniapp-sdk.ru.md) · [SDK Overview](../packages/miniapp-sdk/README.md) · [Interactive Methods Portal](miniapp-sdk-portal.html) · [Mini-Apps Repository](https://github.com/cm4ker/ommesh-miniapps)

This document describes every runtime method, event, type, manifest field, background worker hook, and CSS token available to Ommesh mini-apps (`@ommesh/miniapp-sdk`).

---

## 1. Entry Points & Bootstrap

### `window.ommeshReady` *(injected automatically)*

Every sandboxed mini-app iframe receives an inline SDK bridge before its scripts execute.

```js
window.ommeshReady.then(async (app) => {
  console.log("Connected as", app.context.self?.name);
});
```

- **Type:** `Promise<OmmeshApp>`
- **Also sets:** `window.ommesh` once resolved.
- **Timeout:** rejects after 6000 ms if opened outside an Ommesh host.

### `connect(timeoutMs?: number): Promise<OmmeshApp>`

For bundled TypeScript/ESM mini-apps importing `@ommesh/miniapp-sdk` directly.

```ts
import { connect } from "@ommesh/miniapp-sdk";
const app = await connect(5000);
```

### Package Helpers (`@ommesh/miniapp-sdk`)

| Function | Signature | Description |
| :--- | :--- | :--- |
| `validateManifest` | `(raw: unknown) => string \| null` | Validates a schema v1 manifest; returns an error message or `null`. |
| `encodeOmapp` | `(pkg: MiniAppPackage) => Uint8Array` | Validates and serializes a package to UTF-8 JSON bytes (≤ 512 KiB). |
| `decodeOmapp` | `(input: Uint8Array \| string) => MiniAppPackage` | Parses and validates `.omapp` bytes or JSON text. |
| `pickText` | `(text: LocalizedText \| undefined, locale: Locale) => string` | Resolves a localized string (`"ru"` / `"en"`) with fallback. |
| `isDevAppId` | `(appId: number) => boolean` | Returns `true` when `appId` is in `0xFF00..0xFFFF`. |

Constants: `MAX_OMAPP_BYTES = 524288` (512 KiB), `DEV_APP_ID_MIN = 0xff00`, `DEV_APP_ID_MAX = 0xffff`, `SANDBOX_CSP`.

---

## 2. `app.context` (Read-Only Snapshot)

Always reflects the latest context (updated automatically on theme, viewport, and peer grant events).

```ts
interface MiniAppContext {
  appId: number;                                 // 0 for standalone, 1..65535 for P2P
  self: { keyPrefix: string; name: string } | null;
  locale: "ru" | "en";
  theme: MiniAppTheme;
  radio: MiniAppRadioInfo;
  viewport?: MiniAppViewport;
  initialActivityId: string | null;              // Set when launched from a notification or "Needs action"
  grantedPeers: MiniAppPeer[];                   // Peers already authorized for this app
}
```

### `MiniAppRadioInfo`

| Field | Type | Description |
| :--- | :--- | :--- |
| `connected` | `boolean` | Whether a companion radio is currently connected and ready. |
| `maxPayloadBytes` | `number` | Max binary P2P payload size (`150` bytes on MCRS v2). |
| `supportsPeerData` | `boolean` | `true` when the connected radio advertises `McrsCap.PeerData`. |
| `sf` | `number?` | Current LoRa Spreading Factor (7..12). |
| `bwHz` | `number?` | Current LoRa Bandwidth in Hz (e.g. `62500`, `125000`). |
| `cr` | `number?` | Current LoRa Coding Rate denominator (5..8 for 4/5..4/8). |

### `MiniAppViewport`

| Field | Type | Description |
| :--- | :--- | :--- |
| `width`, `height` | `number` | Visible mini-app frame size in CSS pixels. |
| `safeBottom`, `safeLeft`, `safeRight` | `number` | Safe-area insets in CSS pixels (`safeBottom` becomes `0` while the soft keyboard is up). |
| `keyboardHeight` | `number` | Soft keyboard height in CSS pixels (`0` when closed). |
| `keyboardOpen` | `boolean` | Whether the mobile soft keyboard is open. |
| `mobile` | `boolean` | `true` on compact phone layouts, `false` on desktop/tablet. |

---

## 3. `app.peers` — Contact Discovery & Peer Grants

Mini-apps **never** receive the user's full contact book. Access is granted per peer only when the user explicitly selects a contact via `peers.pick()` or when that peer sends a packet to your `appId`.

### `app.peers.list(): Promise<MiniAppPeer[]>`

- **Permission:** none
- **Returns:** Array of peers already granted to this mini-app (`{ keyPrefix, name, supportsPeerData }`).

### `app.peers.pick(options?: PickPeerOptions): Promise<MiniAppPeer | null>`

Opens the host-owned contact picker modal.

- **Permission:** `peerData`
- **Parameters:** `options?.requirePeerData?: boolean`
- **Returns:** Selected `MiniAppPeer`, or `null` if the user cancelled. Automatically grants the selected peer to the app.

```js
const peer = await app.peers.pick({ requirePeerData: true });
if (!peer) return;
```

---

## 4. `app.transport` — Reliable Binary LoRa P2P (MCRS v2)

### `app.transport.send(peerPrefix, payload, options?): Promise<SendResult>`

Sends an encrypted, ACK-confirmed binary datagram (`TXT_TYPE_PEER_DATA`) tagged with your manifest's `appId`.

- **Permission:** `peerData` (and `manifest.appId !== 0`)
- **Parameters:**
  - `peerPrefix: string` — 12-char hex public key prefix of a **granted** peer.
  - `payload: Uint8Array` — 1..150 bytes (`MAX_PEER_DATA_LEN`).
  - `options?: { retry?: boolean }` — default `true` (up to 4 attempts with direct→flood fallback on attempt 2).
- **Returns:** `{ packetId: string; flood: boolean; estTimeoutMs: number }`
- **Errors:**
  - `"permission denied: peerData"`
  - `"peer not granted to this mini-app; call peers.pick() first"`
  - `"LoRa rate limit exceeded; slow down"` *(burst 5, refills 1 token / 1500 ms)*
  - `"connected radio does not support MCRS v2 peer data"`
  - `"contact not found"`

### `app.transport.onPacket(cb): () => void`

Subscribes to incoming packets addressed to your `appId`.

- **Buffering:** Packets arriving before the first `onPacket()` subscription (e.g. while awaiting `app.storage.get()`) are queued by both host and SDK bridge and delivered immediately upon subscription.
- **Callback payload (`IncomingPacket`):**

| Field | Type | Description |
| :--- | :--- | :--- |
| `peerPrefix` | `string` | Lowercase 12-char hex prefix of the peer. |
| `peerName` | `string` | Contact display name (or prefix fallback). |
| `payload` | `Uint8Array` | Decrypted binary payload. |
| `timestamp` | `number` | Sender Unix timestamp (seconds). |
| `snr` | `number` | Received SNR in dB (quarter-dB resolution). |
| `hops` | `number \| null` | Flood hop count, or `null` for direct delivery. |
| `mirrored` | `boolean?` | `true` when sent by your user's other device sharing the same radio via Phone Relay. Update local state, **do not** send replies or notifications! |

### `app.transport.onDelivery(cb): () => void`

Subscribes to delivery / ACK status transitions for packets sent via `transport.send()`.

- **Callback payload (`DeliveryUpdate`):**
  - `packetId: string`
  - `peerPrefix: string`
  - `status: "sent" | "retrying" | "delivered" | "unconfirmed" | "failed"`
  - `attempt: number`
  - `flood?: boolean`
  - `rttMs?: number` *(round-trip time in ms when `status === "delivered"`)*
  - `error?: string`

---

## 5. `app.storage` — Isolated Per-Radio KV Store

Data is namespaced by `(radioKey, manifest.id)`, persisted across reloads, and capped at **1 MiB** of serialized JSON per app.

- **Permission:** `storage`

| Method | Signature | Description |
| :--- | :--- | :--- |
| `app.storage.get` | `<T = unknown>(key: string) => Promise<T \| null>` | Reads a JSON-serializable value or `null` if absent. |
| `app.storage.set` | `(key: string, value: unknown) => Promise<void>` | Stores a JSON-serializable value (throws if > 1 MiB quota). |
| `app.storage.delete` | `(key: string) => Promise<void>` | Deletes a key. |
| `app.storage.list` | `() => Promise<string[]>` | Lists all stored keys for this app on the current radio. |

---

## 6. `app.ui` — Hub Activities, Notifications, Theme & Viewport

### `app.ui.setActivities(activities: MiniAppActivity[]): Promise<void>`

Publishes up to 64 active items to the Ommesh **Apps** tab ("Needs your action" list and unread tab badge).

```ts
interface MiniAppActivity {
  id: string;                  // Max 64 chars; passed back via initialActivityId / onOpenActivity
  peerKeyPrefix?: string;
  title: string;               // Max 80 chars
  subtitle: string;            // Max 120 chars
  badge?: { text: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" };
  needsAttention: boolean;     // Increments Apps tab badge when true
  updatedAt: number;           // Unix ms
}
```

### `app.ui.notify(options: NotifyOptions): Promise<void>`

- **Permission:** `notifications`
- **Parameters:** `{ title?: string; body: string; tag?: string; peerPrefix?: string }`
- Respects Ommesh's global Apps notification setting, per-app bell toggle (`all` / `silent` / `off`), and Do Not Disturb quiet hours. Tapping the notification opens your app with `tag` forwarded as `activityId`.

### `app.ui.onThemeChange(cb: (theme: MiniAppTheme) => void): () => void`

Fired whenever the user switches theme, appearance (`light`/`dark`), look (`lcd`/`classic`), or text size. CSS variables on `:root` are already updated automatically before `cb` runs.

### `app.ui.onViewportChange(cb: (viewport: MiniAppViewport) => void): () => void`

Fired whenever the frame resizes, switches between mobile/desktop layout, or the mobile soft keyboard opens/closes. CSS variables (`--safe-bottom`, `--keyboard-height`, `data-keyboard`, `data-mobile`) are updated automatically before `cb` runs.

### `app.ui.onOpenActivity(cb: (activityId: string) => void): () => void`

Fired when the user taps an activity or notification while the app is already mounted.

### `app.ui.close(): void`

Asks the host to navigate back / close the mini-app screen.

---

## 7. Background Worker (`workerJs`)

When a LoRa `PEER_DATA` packet arrives while your mini-app UI is closed, Ommesh runs `pkg.workerJs` inside an isolated ephemeral Web Worker (hard **2500 ms** timeout; `fetch`, `XMLHttpRequest`, and `importScripts` disabled).

Define `self.onPacket(input)`:

```js
self.onPacket = function (input) {
  // input: { self, locale, packet, storage }
  return {
    storageSet: { lastSeen: Date.now() },
    storageDelete: ["tempKey"],
    activities: [/* MiniAppActivity[] */],
    notify: { body: "New move!", tag: "game:0100", peerPrefix: input.packet.peerPrefix },
    send: [/* up to 2 auto-reply packets: { peerPrefix, payload: number[], retry: true } */],
  };
};
```

Packets are processed **strictly sequentially** by the host so consecutive packets never race on `storage`.

### Native Background Notices (`manifest.backgroundNotices`)

On Android and iOS, when the WebView is suspended in the background, Ommesh's native Rust core (`meshcore-core`) reads incoming `PEER_DATA` frames directly off BLE and posts OS notifications using your manifest's `backgroundNotices` lookup table (`payload[0] & opcodeMask` → `labels[opcode]`, falling back to `fallback`).

---

## 8. Manifest & `.omapp` Bundle Schema

```ts
interface MiniAppPackage {
  format: "omapp-v1";
  manifest: {
    schema: 1;
    id: string;                   // /^[a-z0-9][a-z0-9._-]{1,63}$/
    appId: number;                // 0 (standalone), 0x0100..0xFEFF (catalog), 0xFF00..0xFFFF (dev)
    version: string;              // Semver, <= 32 chars
    name: LocalizedText;          // string or { en, ru }
    description: LocalizedText;
    author: string;
    homepage?: string;
    scope: "standalone" | "p2p" | "channel";
    minProtocol?: number;         // 2 for MCRS v2 P2P
    permissions: ("peerData" | "storage" | "notifications")[];
    backgroundNotices?: {
      opcodeMask: number;
      fallback: LocalizedText;
      labels: Record<string, LocalizedText>;
    };
  };
  iconSvg: string;                // Monochrome SVG using currentColor (rendered via CSS mask)
  html: string;                   // HTML body or full document
  workerJs?: string;              // Optional background packet handler
}
```

---

## 9. CSS Custom Properties & Attributes

| Token / Attribute | Description |
| :--- | :--- |
| `--bg`, `--panel`, `--elevated`, `--chrome` | Surface layers (base canvas, side panels, raised cards, headers). |
| `--text`, `--text-muted`, `--text-faint` | Primary, secondary, and muted ink. |
| `--border`, `--border-strong` | Hairline and control borders. |
| `--accent`, `--accent-contrast` | Theme accent and contrasting text color on accent buttons. |
| `--hover`, `--selected` | Interactive row/button states. |
| `--success`, `--warning`, `--danger` | Semantic status colors. |
| `--bubble-in`, `--bubble-out`, `--bubble-text`, `--bubble-text-muted` | Chat bubble tokens for in-app chat UIs. |
| `--text-scale` | User's text scale multiplier from Appearance settings. |
| `--safe-bottom`, `--safe-left`, `--safe-right` | Mobile safe-area insets (automatically `0px` for bottom while keyboard is open). |
| `--keyboard-height` | Soft keyboard height in px (`0px` when hidden). |
| `:root[data-appearance="light" \| "dark"]` | Active theme polarity. |
| `:root[data-look="lcd" \| "classic"]` | Optional retro visual skin (Olive LCD / Pebble Classic). |
| `:root[data-keyboard="open" \| "closed"]` | Live mobile soft-keyboard state. |
| `:root[data-mobile="1" \| "0"]` | Compact phone layout indicator. |

---

## 10. Sandbox & Security Boundaries

- **Iframe isolation:** `<iframe sandbox="allow-scripts">` (opaque `null` origin, no `allow-same-origin`, no cookies/localStorage/DOM access to host).
- **CSP:** `default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none';`
- **No internet access:** mini-apps cannot make HTTP/WebSocket requests; all P2P traffic goes over encrypted LoRa `PEER_DATA` to user-granted peers only.
- **Zero-script icons:** `iconSvg` is rendered by the host via CSS `mask-image`, so SVG scripts can never execute in the host DOM.
