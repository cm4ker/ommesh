# `@ommesh/miniapp-sdk`

SDK and package contract for building isolated **Ommesh** mini-apps (`.omapp`) that run across **Desktop (Tauri)**, **Web**, **Android**, and **iOS** — both offline standalone tools and **MCRS v2 LoRa P2P** interactive apps.

- **Full Methods Reference:** [English](../../docs/miniapp-sdk.md) · [Русский](../../docs/miniapp-sdk.ru.md)
- **Interactive Methods Portal & Sandbox:** [docs/miniapp-sdk-portal.html](../../docs/miniapp-sdk-portal.html) *(open directly in any browser — works offline)*
- **Mini-Apps Repository (catalog, templates & CLI):** [cm4ker/ommesh-miniapps](https://github.com/cm4ker/ommesh-miniapps)

---

## Architecture

```text
┌────────────────────────────────────────────────────────────────────┐
│ Ommesh Host (Desktop / Web / Android / iOS)                        │
│  ├─ Permission & Peer-Grant gatekeeper                             │
│  ├─ LoRa rate limiter (burst 5, +1 / 1.5 s)                        │
│  ├─ Isolated per-radio + per-app KV storage (1 MiB)                │
│  └─ Theme, safe-area & mobile soft-keyboard bridge                 │
└───────────┬─────────────────────────────────────────┬──────────────┘
            │ private MessageChannel                  │ Web Worker (2.5 s)
            ▼                                         ▼
┌───────────────────────────────┐        ┌───────────────────────────┐
│ <iframe sandbox="allow-scripts">       │ workerJs (when UI closed) │
│   connect-src 'none' (no net) │        │   self.onPacket(input)    │
│   window.ommeshReady          │        │   -> storageSet/notify/   │
│   or connect() from SDK       │        │      activities/send      │
└───────────────────────────────┘        └───────────────────────────┘
```

Every mini-app is packaged as a single UTF-8 JSON file (`.omapp`, `format: "omapp-v1"`, max **512 KiB**) containing its manifest, monochrome SVG icon, HTML UI, and optional background `workerJs`.

---

## 5-Minute Quickstart (Zero Build)

The Ommesh host automatically injects the SDK bootstrap (`window.ommeshReady`) into every mini-app iframe, so you can build a complete `.omapp` with plain HTML/CSS/JS — no bundler required:

```json
{
  "format": "omapp-v1",
  "manifest": {
    "schema": 1,
    "id": "dev.hello-lora",
    "appId": 0,
    "version": "1.0.0",
    "name": { "en": "Hello Ommesh", "ru": "Привет, Ommesh" },
    "description": { "en": "Minimal standalone mini-app", "ru": "Минимальное мини-приложение" },
    "author": "Your Name",
    "scope": "standalone",
    "permissions": ["storage"]
  },
  "iconSvg": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><circle cx='12' cy='12' r='8'/></svg>",
  "html": "<div style='padding:16px'><h2 id='t'></h2><button id='b'>+1</button></div><script>window.ommeshReady.then(async (app) => { let n = (await app.storage.get('n')) || 0; const draw = () => { t.textContent = 'Clicks: ' + n; }; b.onclick = async () => { n++; await app.storage.set('n', n); draw(); }; draw(); });</script>"
}
```

Save as `hello.omapp` and load it in Ommesh via **Apps → Store → Load .omapp** (even in **Demo mode** without a radio!).

### Using TypeScript / Bundlers

```ts
import { connect, encodeOmapp, decodeOmapp, validateManifest } from "@ommesh/miniapp-sdk";

const app = await connect();
const peer = await app.peers.pick({ requirePeerData: true });
if (peer) {
  await app.transport.send(peer.keyPrefix, new Uint8Array([0x01, 0x2a]), { retry: true });
}
```

---

## API at a Glance

| Namespace | Methods & Events | Permission |
| :--- | :--- | :--- |
| `app.context` | `appId`, `self`, `locale`, `theme`, `radio`, `viewport`, `initialActivityId`, `grantedPeers` | *(always)* |
| `app.peers` | `list()`, `pick(options?)` | `peerData` *(for `pick`)* |
| `app.transport` | `send(peerPrefix, payload, options?)`, `onPacket(cb)`, `onDelivery(cb)` | `peerData` |
| `app.storage` | `get(key)`, `set(key, value)`, `delete(key)`, `list()` | `storage` |
| `app.ui` | `setActivities(list)`, `notify(options)`, `onThemeChange(cb)`, `onViewportChange(cb)`, `onOpenActivity(cb)`, `close()` | `notifications` *(for `notify`)* |
| Background Worker | `self.onPacket(input) => { storageSet, storageDelete, activities, notify, send }` | matches manifest |

For parameter tables, return types, error conditions, and full examples, see [docs/miniapp-sdk.md](../../docs/miniapp-sdk.md) ([Русский](../../docs/miniapp-sdk.ru.md)) or open [docs/miniapp-sdk-portal.html](../../docs/miniapp-sdk-portal.html).

---

## Themes, Mobile & Soft Keyboards

Ommesh automatically injects its active theme tokens and live mobile viewport metrics into `:root`:

- **Theme tokens:** `var(--bg)`, `var(--panel)`, `var(--elevated)`, `var(--chrome)`, `var(--text)`, `var(--text-muted)`, `var(--text-faint)`, `var(--border)`, `var(--border-strong)`, `var(--accent)`, `var(--accent-contrast)`, `var(--hover)`, `var(--selected)`, `var(--success)`, `var(--warning)`, `var(--danger)`, `var(--bubble-in)`, `var(--bubble-out)`, `var(--bubble-text)`, `var(--text-scale)`.
- **Theme attributes:** `:root[data-appearance="light"|"dark"]`, `:root[data-look="lcd"|"classic"]`.
- **Safe areas & soft keyboard:**
  - `var(--safe-bottom)`, `var(--safe-left)`, `var(--safe-right)` — use `padding-bottom: calc(16px + var(--safe-bottom, 0px))` on scrollable root containers.
  - `var(--keyboard-height)` and `:root[data-keyboard="open"|"closed"]` — collapse secondary lists when the soft keyboard opens.
  - `:root[data-mobile="1"|"0"]` and `app.ui.onViewportChange(vp)` — react programmatically to resizes and keyboard state.
  - The host automatically forwards focus inside the iframe to iOS/Android keyboard tracking, scrolls active inputs into view, and enforces a 16 px minimum input font size on touch screens to prevent iOS Safari zoom.

---

## LoRa P2P Design Rules (`scope: "p2p"`)

1. **Keep payloads compact.** Maximum payload is `150` bytes (`app.context.radio.maxPayloadBytes`). MCRS v2 encrypts in 16-byte AES blocks: a payload of **≤ 8 bytes** fits in **1 AES block** (~20 B on air).
2. **Respect duty cycle.** The host enforces a token bucket of **5 burst packets**, refilling **1 packet per 1500 ms**.
3. **Expect retries, duplicates, and offline devices.** Make packet handlers idempotent, handle out-of-order delivery, and check `packet.mirrored === true` (packets sent from your user's other device sharing the same radio via Phone Relay — update state, **never** send replies).
4. **Use `0xFF00..0xFFFF` while developing.** Catalog apps claim an ID in `0x0100..0xFEFF` via [cm4ker/ommesh-miniapps](https://github.com/cm4ker/ommesh-miniapps). Standalone utilities must use `appId: 0`.
