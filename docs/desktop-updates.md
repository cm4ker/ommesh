# Desktop updates

Windows x64 and ARM64 use the [official Tauri updater](https://v2.tauri.app/plugin/updater/). Open **App updates** on the connection screen, **Update** in the desktop sidebar, or **Radio → About**. A radio connection is not required. Browser and mobile builds do not show this control; macOS/Linux packages currently need a manual upgrade.

The app checks at startup and every six hours while running, including when returning to the foreground after that interval. Automatic checking can be disabled. Checking never opens a modal or downloads a package. An update already found is looked for again on the same schedule, so the version shown stays the newest. **Download update** reads the feed once more and downloads its newest build, or the one found when the feed does not answer, and shows progress; **Install and restart** becomes available only after signature verification. Closing the dialog keeps the download running. A downloaded update is kept for the current app session.

Before installation, the app waits up to 45 seconds for message acknowledgements, synchronization and queued remote requests, flushes drafts, disconnects the radio and waits for history to commit to IndexedDB. A failed save prevents installation. If the installer cannot be started, Ommesh attempts to restore the radio connection. The installer preserves the app's data directory and preferences. Reconnecting after a successful restart follows **Reconnect at launch**.

## Channels and versions

`package.json` at the repository root is the source of the app version. Both Vite and Tauri use it. The release script supplies the same generated version to both in CI; Cargo's package version is not the displayed app version.

| Build | Version | Feed |
| --- | --- | --- |
| Tag `v0.2.0`, matching the root version | `0.2.0` | `releases/latest/download/latest.json` |
| Push to `master` with root `0.2.0` | `0.2.0-dev.<run>.<attempt>` | `releases/download/dev/latest.json` |

Every package starts on Stable, a Dev build too: Ommesh comes out once a week, and Dev, with every change, is for whoever picks it. An explicit choice persists. Until 0.7.0 a prerelease package started on Dev; one that never had its channel picked moves to Stable with its next update. The updater installs only a newer SemVer version: switching Dev → Stable waits for a newer stable release. After tagging a stable release, bump the root version to the next release before publishing more Dev builds, so users on that stable version can upgrade to Dev. Do not move published version tags or reuse a version for different bytes.

Each Dev build has its own release tag, such as `dev-0.2.0-dev.42.1`. Its signed installers stay there, unchanged. Only the two newest Dev builds keep their releases: each publication deletes older ones, tags too. The one before the newest stays for clients that read the previous feed. The rolling `dev` page links to the newest full release, mirrors its files for manual download and hosts `latest.json`. Old manual download copies are removed from the rolling page; clients download from the versioned release.

## Signing and CI

The public updater key is in `apps/desktop/src-tauri/tauri.conf.json`. The private key must be kept outside the repository and backed up securely. CI needs repository secret **`TAURI_SIGNING_PRIVATE_KEY`**, containing the complete generated key file. An encrypted key also needs **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`**. Losing or changing this key breaks updates for clients that trust the old public key. These signatures authenticate updates; they are separate from Windows Authenticode certificates and SmartScreen reputation.

`scripts/release.mjs prepare` generates the ignored `tauri.release.json` and exports `MESHNET_VERSION` in GitHub Actions. Signed updater artifacts are enabled only for publishing pushes. PRs, manual workflow runs and ordinary local builds do not need the private key and are not published.

The workflow builds every Windows architecture and its `.exe.sig` sidecar, then validates the complete manifest. Each architecture also gets an unsigned `…-offline-setup.exe` bundled from the same binary with `tauri.offline.json` (WebView2's offline installer inside); the manifest never points to it, so the updater keeps downloading the small installer. Publication uploads a draft release first and makes it public only when all files exist. Dev manifests refer to those versioned files, never to replaceable installer assets. Only the current `master` commit can promote the Dev feed. Publication jobs are serialized, and publishing runs are not cancelled mid-upload.

For a stable release, write `apps/web/src/news/X.Y.Z.json` (see below), update the root version, commit it, and push its matching `vX.Y.Z` tag. `prepare` refuses a tag without its news, before any build starts. The workflow publishes it as GitHub's latest stable release. Keep stable tags increasing. No extra update server is required.

## What a version brings

Each stable version has a news file, `apps/web/src/news/X.Y.Z.json`: up to five new things, each a title and a sentence or two, and the fixes, a line each, in English and Russian. A new thing may name a `show`: `chats`, `mesh` or `radio/<page>`, where its Show button leads. `scripts/news.mjs` checks the files (`node --test scripts/news.test.mjs`, part of `pnpm test`) and makes everything else from them. CHANGELOG.md stays the full account.

- The app carries the files. After an update it puts one strip over the chats, "Ommesh is updated to X.Y.Z · What's new", until it is opened or closed; **Settings → About → What's new** keeps every version. A version with fixes only, and a first install, put up no strip.
- `latest.json` carries the version's news under `news`, which the update dialog shows in the reader's language before the download. Its `notes` list the new things in both languages for clients from before 0.7.0. A Dev build carries the news of the version it leads to once the file is written.
- The stable release's page on GitHub is the news in both languages.
- An APK from GitHub reads the feed of its own channel (a Dev APK the Dev one, a stable APK the stable one) and offers What's new with Download.
- Google Play's "What's new" comes from the file of the root version: run the Google Play workflow from the version's tag. It stops before the build when the file is missing or Play's 500 characters are exceeded.
- `pnpm news [X.Y.Z]` prints the App Store and TestFlight texts and a post for Telegram.

The week: changes land on `master` through the week, each with its CHANGELOG line, and every push still makes a Dev build. On Wednesday the Unreleased section is cut down to the news file; on Thursday the version is tagged, so Google Play and the App Store pass review before the weekend. An urgent fix goes out as X.Y.Z+1 with a news file of fixes only.

If publication fails, inspect the Actions log and the draft before retrying. A full Dev rerun gets a new attempt version. A stable draft can be removed and the run repeated only if it was never published. Never replace the installers of an already published release: clients may already hold its signed manifest. GitHub replaces the rolling `latest.json` asset by deleting and uploading it, so checks can briefly fail during promotion or until a failed promotion is retried. An update found on the Dev feed stays downloadable until two newer builds are published; Download update reads the feed again, so a client that found one hours ago downloads the newest instead.

## Verification and first rollout

`pnpm typecheck` and `pnpm test` cover the update lifecycle, download failure, signature rejection, repeated clicks, recovery after installer failure, storage commits, draft persistence, serialization of history writes and incomplete release manifests. `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` checks the native integration. Windows ARM64 builds need the Visual Studio developer environment with the Windows SDK available to Clang.

For an end-to-end release check, install signed build A in a disposable Windows account/VM, create a draft and some history, publish newer build B to the same channel, then check, download and install it. Confirm restart, displayed version, persisted data and radio reconnection. Also try checking offline and a manifest with a damaged signature. Repeat on x64 and ARM64. This requires real releases and is separate from the mocked UI and unit tests.

Existing versions without the updater require one manual installation of the first updater-enabled build. Subsequent versions can update in the app. Before that first feed is published, checks can report that no release feed is available.
