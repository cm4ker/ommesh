# Сборка, тесты, CI, релизы, соглашения

> Справка для разработчика/агента. Снимок на 2026-09-27 (версия `0.3.0`, коммит `b2485fa`).
> Обзор всего проекта — [README.md](README.md).

## Инструменты

| Что | Версия | Где зафиксировано |
| --- | --- | --- |
| Node | 24 | только в CI (`actions/setup-node@v4`), `.nvmrc` нет |
| pnpm | 10.17.1 | `packageManager` в корневом `package.json` |
| TypeScript | 5.9.x | lockfile |
| Vite | 8.3 (+ `@vitejs/plugin-react` 6) | `apps/web` |
| React | 19 | `apps/web` |
| Tauri CLI | 2.11 | `apps/desktop` |
| Capacitor | 8.5.2 | `apps/mobile`, `apps/web` |
| Rust | stable, не закреплён (нет `rust-toolchain`) | edition 2021 в обоих крейтах |
| Android | cargo-ndk 4.1.2, JDK temurin 21, SDK `android-36`, build-tools 36.0.0 | CI |

- `tsconfig.base.json`: ES2023, NodeNext, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. `packages/meshcore` наследует его; `apps/web/tsconfig.json` самостоятельный (ESNext/bundler, `jsx: react-jsx`, DOM, типы `vite/client`, `web-bluetooth`, `w3c-web-serial`) с теми же строгими флагами.
- Внутренние пакеты по-прежнему называются `@meshnet/*` (корень — `meshnet`); видимое имя приложения — **Ommesh**; Android id — `dev.cm4ker.meshnet`.

## Корневые команды (`package.json`)

| Команда | Что делает |
| --- | --- |
| `pnpm install` | установка (в CI `--frozen-lockfile`) |
| `pnpm web` | Vite dev-сервер на `http://localhost:5180` (демо: `/?demo`) |
| `pnpm typecheck` | `pnpm -r typecheck` |
| `pnpm test` | `node --test scripts/*.test.mjs && pnpm -r test` |
| `pnpm build` | `pnpm -r build` — протокол + веб; оболочки **не** входят |
| `pnpm meshcore` | пересобрать `packages/meshcore` в `dist` |
| `pnpm desktop` / `pnpm desktop:bundle` | Tauri dev / инсталлятор |
| `pnpm mobile:sync` / `pnpm android` / `pnpm android:aab` / `pnpm ios` | Capacitor sync / открыть Android Studio / AAB / Xcode |
| `pnpm icons` / `pnpm sounds` | генерация иконок / звуков |

**Важно:** `@meshnet/meshcore` потребляется через `dist`. Поэтому `pretypecheck`, `pretest`, `preweb` сначала вызывают `pnpm run meshcore`. Правка протокола не видна вебу без пересборки — при запуске Vite напрямую пересобрать вручную.

Десктоп дополнительно: `pnpm --filter @meshnet/desktop desktop:bundle:x64`, `desktop:check` (`cargo check`).

## Тесты

- `packages/meshcore` и `apps/web`: `node --import tsx --test "src/**/*.test.ts"` — встроенный `node:test` + `node:assert/strict`. Jest/Vitest нет. Тесты лежат рядом с кодом (`*.test.ts`): ~10 в meshcore, ~35 в web.
- `apps/web/src/i18n/i18n.test.ts` — у каждого языка все ключи английского, те же плейсхолдеры, правильные CLDR-формы множественного числа.
- `scripts/release.test.mjs` — логика релизов (версии/теги, манифест, публикация, прунинг); `gh` инжектится, сети нет.
- Rust: `cargo test --manifest-path crates/meshcore-core/Cargo.toml` (тесты в `frames.rs`, `mux.rs`, `watch.rs`). У `apps/desktop/src-tauri/src/winble.rs` тоже есть тесты, но CI их не гоняет.
- `apps/mobile`, `apps/desktop` — JS-тестов нет.

Запуск одного пакета: `pnpm --filter @meshnet/web test`, `pnpm --filter @meshnet/meshcore test`.

## CI: `.github/workflows/build.yml` («Build»)

Триггеры: push в `master`, теги `v*`, `pull_request`, `workflow_dispatch`. Concurrency `build-${ref}`, отменяются только PR-прогоны.

1. **`check`** (ubuntu): install → `node scripts/release.mjs prepare` (output `publish`) → `pnpm typecheck` → `pnpm test` → cargo test meshcore-core → `pnpm --filter @meshnet/web build`. Артефакт `meshnet-web`.
2. **`desktop-windows`** (windows-latest), matrix `x64` / `arm64` / `x86` (`x86_64|aarch64|i686-pc-windows-msvc`):
   - `tauri build --config src-tauri/tauri.release.json --target <t> --bundles nsis`;
   - повторный `tauri bundle` с `src-tauri/tauri.offline.json` (`webviewInstallMode: offlineInstaller`, без updater-артефактов) → `*_<arch>-offline-setup.exe` (~+190 МБ, с WebView2 внутри).
   - Артефакт `meshnet-windows-<arch>`: `Ommesh_<ver>_<arch>-setup.exe`, `.sig`, offline-exe.
3. **`android`** (ubuntu): `pnpm --filter @meshnet/mobile android:apk` — debug APK, `ANDROID_VERSION_CODE = github.run_number`. Артефакт `meshnet-android`.
4. **`release`**: после всех, только если `publish == 'true'` (push в master или тег). Собирает `out/` (exe, `Ommesh_android-debug.apk`, `Ommesh_web.zip`) → `release.mjs manifest out` → `release.mjs publish out`.

Секреты (имена): `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (только при публикации), `ANDROID_DEBUG_KEYSTORE_BASE64` (опционально, иначе одноразовый ключ).

iOS в CI нет — сборка на Mac, TestFlight вручную (см. [mobile.md](mobile.md)).

## CI: `.github/workflows/android-play.yml` («Google Play»)

- `pull_request` (пути: `apps/mobile/**`, `apps/web/**`, `packages/meshcore/**`, `package.json`, lockfile, сам workflow) → `check` + `verify-android` (AAB с одноразовым ключом).
- `workflow_dispatch` (inputs: `version_code` — обязательный и неиспользованный в Play, `upload`, `track` internal/alpha/beta/production, `status` draft/completed, `send_for_review`) → `bundle` (подписанный AAB, environment `google-play`) → `upload` (`r0adkll/upload-google-play`, release notes из `docs/google-play/{en-US,ru-RU}/release-notes.txt`).
- Секреты: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
- `apps/mobile/scripts/android.mjs aab` требует `ANDROID_VERSION_CODE` в 1…2100000000 и **неустановленный** `CAP_SERVER_URL`.

## Релизы: `scripts/release.mjs`

CLI: `node scripts/release.mjs prepare|manifest|publish [dir=out]`.

- **prepare** — версия из корневого `package.json` должна быть `X.Y.Z`; тег обязан быть `v<version>`. Тег → `X.Y.Z`, канал `stable`; иначе `X.Y.Z-dev.<run>.<attempt>`, канал `dev`, тег `dev-<version>`. Пишет gitignored `apps/desktop/src-tauri/tauri.release.json`, экспортирует `MESHNET_VERSION`.
- **manifest** — `latest.json` для Tauri updater: ровно один `_<arch>-setup.exe` + непустой `.sig` на каждую из x64/arm64/x86 (`windows-x86_64|aarch64|i686`). Offline-инсталляторы в фид не попадают.
- **publish** — создаёт версионный релиз черновиком, заливает, публикует (stable `--latest`, dev `--prerelease`); для dev зеркалирует ассеты в скользящий релиз `dev` (если сборка новее), `latest.json` заливается последним; хранит 2 последних dev-релиза.
- Фиды: stable `releases/latest/download/latest.json`, dev `releases/download/dev/latest.json`.
- Стабильный релиз: поднять версию в корневом `package.json` → коммит → тег `vX.Y.Z`. После стабильного тега снова поднять версию, чтобы dev-сборки были новее по SemVer. Теги не двигать, версии не переиспользовать.
- Подробно про апдейтер — `docs/desktop-updates.md` (в первой фразе упомянуты только x64 и ARM64, x86 теперь тоже собирается).

## Генераторы ассетов

- `scripts/icons.mjs` (`pnpm icons`) — единственный источник `apps/web/public/icon.svg` (нужны фоновый `<rect fill>` и `<g>` с маркой). Генерирует иконки Tauri (`apps/desktop/src-tauri/icons/*`), Android (mipmaps, adaptive, splash, `ic_stat_meshnet.xml`), web (`icon-192/512`, `apple-touch-icon`, maskable, `notification-badge`), iOS (AppIcon, Splash).
- `scripts/sound-synth.mjs` — чистый JS-синтезатор (работает и в браузере): `RATE=48000`, `SOUNDS` (`chirp` по умолчанию, `roger`, `hop`, `sonar`), `render()`, `wav()`. Используется в `apps/web/src/lib/noticePrefs.ts`.
- `scripts/sounds.mjs` (`pnpm sounds`) — пишет `signal_<id>.wav` в `apps/web/public/sounds/` и `apps/mobile/android/app/src/main/res/raw/`. Сгенерированные файлы коммитятся.

## Прочие docs

- `docs/google-play/{en-US,ru-RU}/` — `title.txt`, `short-description.txt`, `full-description.txt`, `release-notes.txt`; `assets/` — feature graphic и иконка.
- `docs/store-shots/` — скриншоты для Play/App Store; `docs/screenshots/` — для README (демо-режим).
- `README.md` / `README.ru.md` — двуязычная пара.

## Соглашения

### Коммиты
- Conventional Commits: `type(scope): Subject`, subject на английском, с заглавной буквы, без точки, в повелительном наклонении, часто длинный и «поведенческий» (что меняется для пользователя).
- Типы: `feat`, `fix`, `perf`, `docs`, `ci`, `test`, `chore`.
- Скоупы: по фичам — `connect`, `chats`, `chat`, `mesh`, `map`, `nav`, `keyboard`, `readings`, `search`, `notices`, `appearance`, `node`, `ui`, `app`, `sensors`, `history`, `lpp`, `usb`, `winble`, `relay`, `core`, `i18n`, `windows`; старые — по пакетам (`web`, `mobile`, `meshcore`, `desktop`, `android`, `ios`); `docs(changelog)`, `docs(play)`.
- Ссылка на issue — `(#NN)` в конце subject, одинаковая у всех коммитов задачи, включая changelog-коммит.
- Тело — проза: почему, причина, измеренные цифры. Трейлер `Co-Authored-By: ...`.

### CHANGELOG
- `CHANGELOG.md` и `CHANGELOG.ru.md` зеркальны построчно. Сверху `## Unreleased` / `## Не выпущено`; выпуски — `## 0.3.0 — 2026-09-26`.
- Группы `###`: Chats/Чаты, Connecting/Подключение, Mesh and the map/Сеть и карта, Readings/Показания, Settings, Languages, …, Fixes/Исправления — последней.
- Пункт — полное предложение простым пользовательским языком в настоящем времени, без номеров issue. В Fixes — старое поведение и причина, с цифрами. В RU — русский формат чисел (`2,6 с`), «ёлочки» для подписей UI, путь через `›`.
- Каждое видимое пользователю изменение — пункт в обоих файлах (в том же коммите или отдельным `docs(changelog): … (#NN)`).

### Строки UI
- Любая новая строка — сразу в `apps/web/src/i18n/en/*.json` и `ru/*.json` (подробнее — [web-ui.md](web-ui.md#i18n)).

### Чек-лист перед коммитом
1. `pnpm typecheck` и `pnpm test` (Node 24, pnpm 10.17.1).
2. Трогали Rust — `cargo test --manifest-path crates/meshcore-core/Cargo.toml`, для десктопа `pnpm --filter @meshnet/desktop desktop:check`.
3. Новые строки — в `en` и `ru`, с формами множественного числа.
4. Видимое изменение — в оба CHANGELOG.
5. Поменяли `icon.svg` / звук — `pnpm icons` / `pnpm sounds` и закоммитить результат.
6. Не коммитить `tauri.release.json`. Не переименовывать `_<arch>-setup.exe` без правки `makeManifest` в `release.mjs`.
