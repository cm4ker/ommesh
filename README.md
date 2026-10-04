<div align="center">
  <img src="apps/web/public/icon.svg" width="88" height="88" alt="Ommesh logo" />
  <h1>Ommesh</h1>
  <p><strong>Your mesh, in one place.</strong></p>
  <p>Chat, explore nearby nodes and manage your MeshCore radios.<br />On your desktop, in your browser and on your phone.</p>
  <p>
    <a href="https://play.google.com/store/apps/details?id=dev.cm4ker.meshnet"><img src="docs/badges/google-play-en.png" height="56" alt="Get it on Google Play" /></a>
    &nbsp;
    <a href="https://github.com/cm4ker/ommesh/releases/latest/download/Ommesh-setup-x64.exe"><img src="docs/badges/windows-en.svg" height="56" alt="Download for Windows" /></a>
  </p>
  <p><sub>Windows on <a href="https://github.com/cm4ker/ommesh/releases/latest/download/Ommesh-setup-arm64.exe">ARM</a> · <a href="https://github.com/cm4ker/ommesh/releases/latest/download/Ommesh-setup-x86.exe">32-bit Windows</a> · <a href="#install">other ways to install</a> · iPhone: coming to the App Store</sub></p>
  <p><strong>English</strong> · <a href="README.ru.md">Русский</a></p>
  <p>
    <a href="https://github.com/cm4ker/ommesh/actions/workflows/build.yml"><img src="https://github.com/cm4ker/ommesh/actions/workflows/build.yml/badge.svg" alt="Build status" /></a>
    <a href="https://github.com/meshcore-dev/MeshCore"><img src="https://img.shields.io/badge/MeshCore-companion-74ade8" alt="MeshCore companion" /></a>
  </p>
  <p><a href="#install">Install</a> · <a href="#features">Features</a> · <a href="#screenshots">Screenshots</a> · <a href="#development">Development</a> · <a href="#people">People</a></p>
</div>

![Ommesh desktop: mesh map, nearby nodes and repeater status](docs/screenshots/desktop-mesh.png)

**Ommesh** is a companion client for [MeshCore](https://github.com/meshcore-dev/MeshCore) LoRa radios. Connect a compatible radio over **Bluetooth, USB or Wi-Fi** and exchange messages through the mesh without an internet connection for messaging. Conversations stay on your device; the radio carries them over the air.

## Install

| Device | Get Ommesh |
| :--- | :--- |
| **Android** | [Google Play](https://play.google.com/store/apps/details?id=dev.cm4ker.meshnet). Updates come through the store. |
| **Windows 10 and 11** | Installer for [x64](https://github.com/cm4ker/ommesh/releases/latest/download/Ommesh-setup-x64.exe), [ARM](https://github.com/cm4ker/ommesh/releases/latest/download/Ommesh-setup-arm64.exe) or [32-bit](https://github.com/cm4ker/ommesh/releases/latest/download/Ommesh-setup-x86.exe). The app offers each new version itself. |
| **iPhone** | Coming to the App Store. |
| **macOS and Linux** | Build the desktop app from source; see [Development](#development). |
| **Browser** | Chrome or Edge can reach a radio over Bluetooth or USB. Run the web client from source; see [Development](#development). |

Ommesh comes out once a week. The Windows installers are the newest version, and the app itself offers the next (**Settings → About**, or **App updates** on the connection screen); after an update, **What's new** says what it brought. Testers who want every change as it lands can pick the **Dev** channel in **App updates**. A PC with neither WebView2 nor internet access (Windows 10 LTSC, a fresh image) needs the offline installer from the [latest release page](https://github.com/cm4ker/ommesh/releases/latest); it carries WebView2 and is about 190 MB larger. Windows 11 already has WebView2. Testers can also take the [Dev Android APK](https://github.com/cm4ker/ommesh/releases/download/dev/Ommesh_android-debug.apk); it is signed with a different key, so remove the Google Play version first. See [update channels and signing](docs/desktop-updates.md).

### Connect a radio

1. The radio runs **MeshCore companion firmware**. For USB on nRF52 boards (T-Echo, RAK4631, Heltec T114), flash the `_usb` build.
2. Open Ommesh, choose **Bluetooth**, **USB** or **Wi-Fi** and pick the radio. For Bluetooth, enter the PIN from the radio's screen, or `123456` on a radio without one. Wi-Fi radios listen on TCP port `5000`.
3. Ommesh reads the radio's contacts, channels and waiting messages. **Chats** is for talking, **Mesh** for the map and nodes, **Settings** for the radio and the app.

| | Bluetooth | USB | Wi-Fi |
| :--- | :---: | :---: | :---: |
| Windows, macOS, Linux | ✓ | ✓ | ✓ |
| Android, iPhone | ✓ | — | ✓ |
| Browser | ✓¹ | ✓¹ | — |

¹ Chrome or Edge, where the system offers Web Bluetooth and Web Serial. Pair the radio in the system's Bluetooth settings first.

**No radio yet?** On a phone, choose **Demo** on the connection screen. In a browser, run the web client and open [localhost:5180/?demo](http://localhost:5180/?demo).

## Features

| Chats | Mesh | Settings |
| :--- | :--- | :--- |
| Direct messages, channels and rooms | People, repeaters and sensors on a map | Connection, radio settings and app preferences |
| Delivery status and message routes | Node profiles, telemetry and remote management | Frequency presets, notifications and diagnostics |

### Messages you can follow

- **Direct messages and channels.** Create or join channels with a name and a 128-bit key, talk in rooms and keep favourite contacts close.
- **Delivery feedback.** See sent, acknowledged, unconfirmed and failed messages, including acknowledgement round-trip time. Retry an unconfirmed message; a retry after an unacknowledged learned route uses a flood.
- **Message routes.** Inspect known relays, received copies and signal quality. Relay hashes resolve to contact names when the match is unambiguous.
- **Route controls.** Pin a contact to flood mode or set an expiry for learned routes, globally and per contact, so the next message can find a fresh path.
- **Local history.** Conversations are stored in IndexedDB, separately for each radio. Optional Cyrillic lookalike substitution saves bytes by replacing selected letters with visually identical Latin characters.

### See and manage the mesh

- **An interactive map.** Find nodes that share a position, see their distance and bearing, and follow known routes through located relays. Markers distinguish node types and fade as adverts age; nearby markers cluster together.
- **Cached maps.** OpenStreetMap tiles are saved as you view them, so previously viewed areas remain available without a network connection.
- **Ping on the map.** Tap a repeater and ping it: five traces along its route and back give the round-trip time, how many came back, and the signal of every leg in both directions, drawn on the map. When nothing comes back, the app checks one hop further at a time to find where the route breaks.
- **Routes by hand.** Change the route to a contact by tapping repeaters on the map in order; legs the terrain blocks are flagged before you save.
- **Line of sight.** Tap a leg, or hold anywhere on the map, for the elevation profile between two points: terrain, Earth curvature and the Fresnel zone at your radio's frequency, with adjustable antenna heights. Elevation tiles are cached like map tiles.
- **Who hears me.** One zero-hop packet asks the repeaters in direct range how well they hear you.
- **One profile per node.** Open it from a chat, the list or the map to view its route, read telemetry, rename it, add it to favourites or share it over the air.
- **Remote administration.** Sign in to repeaters, rooms and sensors through your radio. View status, a week's battery and noise-floor trends, repeater neighbours, access roles, settings and the console. Sensor history includes minimum, maximum and mean readings.
- **Visible radio traffic.** Remote requests run through a visible queue, one at a time. Actions that transmit are marked with an antenna; status refreshes are requested by you.

### At home on every screen

- **Desktop workspace.** Conversation list, chat and details side by side, with a command palette and keyboard shortcuts.
- **Windows updates.** Stable/Dev channels, optional automatic checks, signed downloads and installation on demand. Available even before connecting a radio; history and drafts are saved before restart.
- **Phone navigation.** Bottom tabs, a sliding node list over the map, long-press menus and swipe-back navigation.
- **Light and dark themes.** One Light, One Dark, system theme selection and adjustable text size.
- **English and Russian.** The app follows the system's language or the one picked under Appearance, notifications included.
- **Radio controls.** Name, position, frequency, bandwidth, spreading factor, coding rate, transmit power, contact and telemetry policies, clock, adverts and advanced tuning. Frequency changes have a separate Apply step; remote radio changes support a timed trial.
- **Notifications and diagnostics.** Message notifications, one per chat and withdrawn once it is read, newly discovered node notifications, an event log and optional raw frame inspection in hex. **On the air** lists every packet the radio hears, with the noise floor and channel load, without transmitting.
- **Demo mode.** Explore the interface with simulated contacts, messages and nodes, without hardware.

## Screenshots

Actual captures of the web client in **demo mode**, at desktop and phone viewport sizes. Names, messages and readings are sample data; the phone captures show the responsive interface, without native system chrome.

<table>
  <tr>
    <td width="50%"><a href="docs/screenshots/desktop-chat.png"><img src="docs/screenshots/desktop-chat.png" alt="Desktop chat with delivery status, contact profile and telemetry" /></a></td>
    <td width="50%"><a href="docs/screenshots/desktop-node.png"><img src="docs/screenshots/desktop-node.png" alt="Remote repeater management with neighbour signal levels" /></a></td>
  </tr>
  <tr>
    <td align="center"><strong>Conversations and telemetry</strong><br />Messages, delivery feedback and contact details.</td>
    <td align="center"><strong>Remote node management</strong><br />Repeater neighbours and signal quality.</td>
  </tr>
</table>

<table>
  <tr>
    <td align="center" width="33%"><a href="docs/screenshots/mobile-chat.png"><img src="docs/screenshots/mobile-chat.png" width="240" alt="Phone layout: direct conversation in the dark theme" /></a></td>
    <td align="center" width="33%"><a href="docs/screenshots/mobile-mesh.png"><img src="docs/screenshots/mobile-mesh.png" width="240" alt="Phone layout: mesh map and sliding node list" /></a></td>
    <td align="center" width="33%"><a href="docs/screenshots/mobile-radio.png"><img src="docs/screenshots/mobile-radio.png" width="240" alt="Phone layout: radio settings in the light theme" /></a></td>
  </tr>
  <tr>
    <td align="center"><strong>Chat on the go</strong></td>
    <td align="center"><strong>Explore the mesh</strong></td>
    <td align="center"><strong>Control your radio</strong></td>
  </tr>
</table>

## Development

Use **Node.js 24** (the version used in CI) and **pnpm 10.17.1** (pinned in `package.json`).

```sh
pnpm install
pnpm web
```

The client runs at **http://localhost:5180**. The protocol package is rebuilt automatically before the dev server starts.

| Command | Purpose |
| :--- | :--- |
| `pnpm typecheck` | Check TypeScript across the workspace |
| `pnpm test` | Run protocol, client and session tests without hardware |
| `pnpm build` | Build the shared protocol package and web client |
| `pnpm desktop` | Start the Tauri desktop app in development mode |
| `pnpm desktop:bundle` | Build a desktop installer |
| `pnpm android` | Build and sync the client, then open Android Studio |
| `pnpm ios` | Build and sync the client, then open Xcode on macOS |

Desktop builds need a Rust toolchain and the platform's native build tools. Installers are written under `apps/desktop/src-tauri/target/release/bundle`. Mobile builds need Android Studio / Android SDK or Xcode; see the [mobile guide](apps/mobile/README.md).

<details>
<summary><strong>Point a mobile development build at your local server</strong></summary>

Run `pnpm web`, then set `CAP_SERVER_URL` to your computer's LAN address when syncing the mobile shell.

```sh
# macOS / Linux
CAP_SERVER_URL="http://<your-lan-ip>:5180" pnpm mobile:sync
```

```powershell
# PowerShell
$env:CAP_SERVER_URL = "http://<your-lan-ip>:5180"
pnpm mobile:sync
Remove-Item Env:CAP_SERVER_URL
```

Omit this variable and sync again to bundle the client for use without a development server.

</details>

### Project structure

```text
packages/meshcore   Companion Radio Protocol, framing and sessions; no platform code
apps/web           Shared React + TypeScript client, built with Vite
apps/desktop       Tauri 2 shell for Windows, macOS and Linux
apps/mobile        Capacitor 8 shell for Android and iOS
docs/screenshots   Demo captures used by both README translations
```

The client selects its transport at runtime. Desktop and mobile shells bundle the same web client and provide native connections, notifications and credential storage.

Every word the app shows lives in `apps/web/src/i18n/<language>/*.json`. A new language is a copy of the `en` folder, translated; see `apps/web/src/i18n/README.md`.

App artwork has one source: `apps/web/public/icon.svg`. After changing it, run `pnpm icons` to regenerate the browser, desktop and mobile icons, notification marks and launch images. The interface uses the same SVG directly.

### Keyboard shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Ctrl+K` | Open the command palette |
| `Alt+1` / `Alt+2` / `Alt+3` | Switch sections in the browser |
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | Switch sections in the desktop shell |
| `Alt+↑` / `Alt+↓` | Move between chats |
| `Ctrl+I` | Toggle the details panel |
| `Esc` | Close a panel or go back |

## Protocol and hardware notes

<details>
<summary><strong>Protocol compatibility and local storage</strong></summary>

- Protocol opcodes and frame layouts follow MeshCore firmware's `examples/companion_radio/MyMesh.cpp`, **v1.17.1, protocol version 13**. The client announces protocol version **3**, which adds SNR to message frames. Unknown frames are logged rather than treated as fatal errors.
- Serial and TCP use `'<'` / `'>'` framing, a little-endian length and a payload. BLE sends one frame per write or notification over the Nordic UART service.
- Message history lives on the client, per radio. The radio retains only messages that have not yet been read.
- Remembered node passwords use the system credential store on desktop, secure storage on mobile and browser storage in the web client.

</details>

<details>
<summary><strong>Bluetooth pairing and USB firmware</strong></summary>

- **Windows:** the radio only lets a paired computer use its UART service. With no pairing, the app asks for the PIN — shown on the radio's screen, or `123456` on a radio without one unless changed — pairs, and connects again. It also replaces a stale bond after a radio reset or reflash. Its native GATT implementation reads the Windows characteristic cache after pairing.
- **Windows, if no PIN prompt appears:** open **Settings → Bluetooth & devices → Add device → Bluetooth**, pick the radio and enter the same PIN, then connect in Ommesh. After a radio reset or reflash, remove it there first. In a browser (Web Bluetooth), pair the radio in the system beforehand.
- **nRF52 USB:** boards such as T-Echo, RAK4631 and Heltec T114 need the **`_usb` firmware build** for a USB connection. The `_ble` build's serial port does not carry the companion protocol.
- **Android:** the BLE plugin requests an MTU of 512 bytes; companion frames can be up to 176 bytes. The system pairing prompt handles the PIN.
- **iOS:** the shell enables `bluetooth-central` background mode to support the connection while switching apps.

</details>

## People

Ommesh is made by the people who write its code and the people who take it out on real radios and report what they find. Thank you all.

<!-- people:start -->
<table>
  <tr>
    <td align="center" valign="top" width="120"><img src="https://avatars.githubusercontent.com/u/5909124?v=4&s=128" width="64" height="64" alt="" /><br /><b>cm4ker</b></td>
    <td align="center" valign="top" width="120"><img src="https://avatars.githubusercontent.com/u/149152329?v=4&s=128" width="64" height="64" alt="" /><br /><b>DyGygg</b></td>
    <td align="center" valign="top" width="120"><img src="https://avatars.githubusercontent.com/u/320853239?v=4&s=128" width="64" height="64" alt="" /><br /><b>Wandering79</b></td>
    <td align="center" valign="top" width="120"><img src="https://avatars.githubusercontent.com/u/333634127?v=4&s=128" width="64" height="64" alt="" /><br /><b>Alksndr55</b></td>
    <td align="center" valign="top" width="120"><img src="https://avatars.githubusercontent.com/u/9005584?v=4&s=128" width="64" height="64" alt="" /><br /><b>deNoi5e</b></td>
    <td align="center" valign="top" width="120"><img src="https://avatars.githubusercontent.com/u/177604026?v=4&s=128" width="64" height="64" alt="" /><br /><b>Scripton55</b></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="120"><img src="https://avatars.githubusercontent.com/u/265543021?v=4&s=128" width="64" height="64" alt="" /><br /><b>vadyamba46</b></td>
    <td align="center" valign="top" width="120"><img src="https://avatars.githubusercontent.com/u/119757495?v=4&s=128" width="64" height="64" alt="" /><br /><b>LekSPS</b></td>
    <td align="center" valign="top" width="120"><img src="https://avatars.githubusercontent.com/u/54049270?v=4&s=128" width="64" height="64" alt="" /><br /><b>Vladimir-ve</b></td>
  </tr>
</table>
<!-- people:end -->

<sub>The list follows the repository's commits and issues by itself. Opened an issue or sent a change? You are in it.</sub>
