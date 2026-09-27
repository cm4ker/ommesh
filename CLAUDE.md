# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Ommesh is a companion client for MeshCore LoRa radios: one React client that runs in a browser, in a Tauri desktop shell and in a Capacitor phone shell. The README covers features, platforms, pairing and release channels; this file covers what you need to change the code.

## Commands

Node 24 and pnpm 10.17.1 (pinned in `package.json`).

```sh
pnpm install
pnpm web            # dev server at http://localhost:5180
pnpm typecheck      # every package
pnpm test           # scripts/*.test.mjs, then every package's tests
pnpm build          # protocol package + web bundle
cargo test --manifest-path crates/meshcore-core/Cargo.toml   # the Rust radio core (CI runs it)
pnpm --filter @meshnet/desktop desktop:check                 # cargo check of the Tauri shell
```

Tests use `node:test` through `tsx`, one `*.test.ts` beside the file it tests. One file, or one test by name:

```sh
cd apps/web && node --import tsx --test src/lib/los.test.ts
cd packages/meshcore && node --import tsx --test --test-name-pattern "trace" src/session.test.ts
```

`@meshnet/meshcore` is consumed through its `dist`. `pnpm web`, `pnpm typecheck` and `pnpm test` rebuild it first, but a running dev server does not: after editing `packages/meshcore`, run `pnpm meshcore`.

Shell builds (`pnpm desktop`, `pnpm desktop:bundle`, `pnpm android`, `pnpm ios`) need Rust, the Android SDK or Xcode, and are not part of `pnpm build`. CI (`.github/workflows/build.yml`) builds the Windows installers and the Android APK.

## Trying a change without a radio

Open `http://localhost:5180/?demo`, choose **Demo**, connect to **MeshCore-demo**. The demo transport (`apps/web/src/transports/demo.ts`) fakes a radio with contacts, repeaters, messages, traces and telemetry. Check phone layouts at a phone-sized viewport; the phone and desktop layouts are different code paths.

## Architecture

**`packages/meshcore`** is the protocol, with no platform code. Layers, bottom up:
- `protocol/`: opcodes (`codes.ts`), command encoders (`commands.ts`), frame decoders (`frames.ts`), raw on-air packets (`packet.ts`), Cayenne LPP telemetry, airtime.
- `framing.ts`: the `<` / `>` + little-endian length framing for serial and TCP. BLE carries one frame per write or notification.
- `client.ts`: `MeshCoreClient`, request and response over a `Transport`.
- `session.ts`: `MeshSession`, the app's whole radio state (contacts, channels, messages and their delivery, routes, the one-at-a-time queue of remote requests) persisted through a `Storage` interface. Most protocol behaviour lives here.

**`apps/web`** is the client every shell bundles.
- `src/lib/session.ts` holds the single `MeshSession` (with `IndexedDbStorage`) and the `useSession` / `useSelector` hooks.
- `src/lib/*` is feature logic, mostly small stores read with `useSyncExternalStore`, plus pure helpers with tests. `components/` are screens, `ui/` the primitives.
- `src/transports/` has one `Connector` per link. `connectors()` picks them at runtime from `shell()`: Tauri (BLE, with a Windows-specific GATT path in `tauriWinBle.ts`; serial; TCP), Capacitor (BLE, TCP) or browser (Web Bluetooth, Web Serial).
- `src/lib/nav.ts` is navigation: three sections (chats, mesh, radio; the radio section is labelled Settings), each a stack of screens. The phone shows the top of the stack; the desktop lays the same stack out side by side. Back handling is in `back.ts`.
- Map tools (ping, route, line of sight, who hears me, neighbours) are one `MeshTool` at a time (`lib/meshTool.ts`); a sheet on the phone or a panel on the desktop shows it, and the map draws it. Nodes are painted on one canvas (`lib/nodeCanvas.ts`).

**`apps/desktop`** is the Tauri 2 shell (`src-tauri/`): BLE, serial, updater, tray, single instance, window state. See `docs/desktop-updates.md` for update channels and signing.

**`apps/mobile`** is the Capacitor 8 shell. Phones put the page's JavaScript to sleep in the background while the Bluetooth link stays up, so native code (`MeshRelay` on Android and iOS, an Android foreground service) holds the link. Read `apps/mobile/README.md` before touching it.

**`crates/meshcore-core`** is the Rust core the phone shells run through UniFFI while the page sleeps. `mux` shares one radio between several clients and keeps each client's messages; `watch` raises notices for what stays unread. It is pure logic (no Bluetooth, clock or threads); the native owner performs the `Effect`s each call returns, so its rules are covered by `cargo test`.

## Protocol source of truth

The spec is MeshCore firmware source, not other clients: `examples/companion_radio/MyMesh.cpp` at v1.17.1 (protocol version 13) for the companion commands and pushes, and `examples/simple_repeater/MyMesh.cpp` for how repeaters answer. Ommesh supports MeshCore only, never Meshtastic.

Anything sent over the air to test a change goes to the `#test` channel, never Public.

## Conventions

- **Every visible word is translated.** Strings live in `apps/web/src/i18n/<lang>/*.json` and are read with `t()`. Add each key to both `en` and `ru`. `pnpm --filter @meshnet/web test` fails on a missing key or a wrong plural form. Russian terms and style are in `i18n/ru/GLOSSARY.md`.
- **Plain words in the UI.** Name things the way a radio user would, not by protocol terms. The existing strings set the tone.
- **Lean UI first.** The maintainer has pushed back on overloaded screens more than once. Start with the smallest version and put details behind a tap.
- **Comments** are full sentences that explain why and what the reader cannot see from the code, as in the existing files. Match the surrounding style.
- **Names.** The product is called Ommesh, but package names (`@meshnet/*`), app identifiers (`dev.cm4ker.meshnet`) and storage names stay `meshnet`. Renaming them would cut installed apps off from their updates and stored history.
- **Artwork.** The only source is `apps/web/public/icon.svg`; run `pnpm icons` after changing it.
- **Commits** read `type(scope): What changes for the user (#issue)`, for example `feat(search): Put a clearing cross in every search field (#44)`. Types are `feat`, `fix`, `perf`, `docs`, `ci`.
- **Changelog.** Each user-visible change gets a line in both `CHANGELOG.md` and `CHANGELOG.ru.md` under `## Unreleased`, in the matching area heading, written for users. Commit it separately as `docs(changelog): …`.
- **Releases.** Every push to `master` publishes a Dev release that installed apps on the Dev channel update to. A `vX.Y.Z` tag that matches the root `package.json` version makes a stable release. Work on a branch and open a pull request unless the maintainer says otherwise.
- **Issues** are tracked on GitHub (`cm4ker/ommesh`). Reference the issue number in commits.


# Ommesh — agent cheat sheet

Ommesh is an alternative client (companion app) for MeshCore LoRa radios. One React client runs in a browser, in Tauri 2 (desktop) and in Capacitor 8 (Android/iOS). The internal name is `meshnet` (`@meshnet/*`, `dev.cm4ker.meshnet`, `meshnet.*` keys); do not rename it.

**Before reading the code, open `docs/dev/README.md`.** It has the repository map, the architecture, the libraries and a "where to change what" table. Documents by area:

- `docs/dev/protocol.md` — `packages/meshcore`: the protocol, `MeshCoreClient`, `MeshSession` (all state and logic);
- `docs/dev/web-core.md` — transports, connecting, storage, sending, notifications, the updater;
- `docs/dev/web-ui.md` — screens, navigation, the map, tools, themes, i18n;
- `docs/dev/desktop.md` — Tauri, commands ↔ web, WinRT BLE;
- `docs/dev/mobile.md` — Capacitor plugins, the relay, phone builds;
- `docs/dev/rust-core.md` — `crates/meshcore-core`;
- `docs/dev/build-release.md` — commands, CI, releases, conventions.

## Commands

```
pnpm install
pnpm web          # dev server at http://localhost:5180 (demo without a radio: /?demo)
pnpm typecheck
pnpm test         # node:test + tsx; rebuilds packages/meshcore first
cargo test --manifest-path crates/meshcore-core/Cargo.toml
pnpm --filter @meshnet/desktop desktop:check
```

## Rules that are easy to break

- `@meshnet/meshcore` is consumed through `dist/`. After editing the protocol, run `pnpm meshcore`, or the web app will not see the change.
- The protocol is duplicated in TS (`packages/meshcore/src/protocol/`) and Rust (`crates/meshcore-core/src/{codes,frames}.rs`); change them together.
- Every UI string goes into both languages: `apps/web/src/i18n/en/*.json` and `ru/*.json`, with plural forms. Do not call `t()` at module top level. Show errors through `errorText()`.
- CSS: colours come only from theme variables.
- A user-visible change gets an entry in both `CHANGELOG.md` and `CHANGELOG.ru.md`.
- Commit format: `type(scope): Capitalized imperative subject (#NN)`, in English, with prose in the body.
- Line endings: LF in the index, CRLF in the working copy (`core.autocrlf=true`). Edit through Edit; do not rewrite whole files. Shell scripts for Mac are shipped with LF (`git -c core.autocrlf=false archive`).
- Generated files are not edited by hand: icons (`pnpm icons` from `apps/web/public/icon.svg`), sounds (`pnpm sounds`), `apps/mobile/ios/App/CapApp-SPM/Package.swift`, `apps/desktop/src-tauri/tauri.release.json`.