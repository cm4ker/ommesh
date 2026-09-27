# Ommesh — документация для разработчика

> Снимок на 2026-09-27: версия `0.3.0`, коммит `b2485fa`. Документы написаны по коду; если код и документ расходятся, прав код. Такое место в документе стоит поправить.

**Ommesh** — альтернативный клиент (companion app) для LoRa-радио [MeshCore](https://github.com/meshcore-dev/MeshCore). Он подключается к радио с companion-прошивкой по BLE, USB serial или Wi-Fi/TCP и работает как мессенджер (личные сообщения, каналы, комнаты), карта сети и пульт управления своим радио и удалёнными узлами (репитерами, комнатами, сенсорами). Один React-клиент работает в браузере, на десктопе (Tauri 2) и на телефоне (Capacitor 8).

Внутреннее имя проекта — **meshnet**: пакеты `@meshnet/*`, id `dev.cm4ker.meshnet`, ключи `meshnet.*`. Не переименовывать — от этого зависят обновления, данные и сторы.

## Документы

| Файл | О чём |
| --- | --- |
| [protocol.md](protocol.md) | `packages/meshcore`: фрейминг, коды команд, кодек, `MeshCoreClient`, `MeshSession` (всё состояние и бизнес-логика) |
| [web-core.md](web-core.md) | `apps/web` без UI: транспорты по платформам, старт и переподключение, IndexedDB и localStorage, отправка сообщений, уведомления, апдейтер |
| [web-ui.md](web-ui.md) | `apps/web` UI: карта экранов, навигация и Back, карта и LOS, инструменты сети, удалённое управление, темы, i18n |
| [desktop.md](desktop.md) | `apps/desktop/src-tauri`: команды Tauri ↔ веб, свой BLE на Windows, TCP, тосты и угловое окно, трей, keyring, updater, NSIS |
| [mobile.md](mobile.md) | `apps/mobile`: свои Capacitor-плагины, **relay** (нативный BLE-линк и раздача радио компьютеру), уведомления, разрешения, сборка APK/AAB/TestFlight |
| [rust-core.md](rust-core.md) | `crates/meshcore-core`: нативное ядро радио для телефона (mux нескольких клиентов и watch-уведомления в фоне), uniffi |
| [build-release.md](build-release.md) | Команды, тесты, CI, релизы и фиды обновлений, генерация иконок и звуков, **соглашения по коммитам, CHANGELOG, i18n** |

Документы проекта: `README.md`/`README.ru.md` (для пользователя), `apps/mobile/README.md`, `docs/desktop-updates.md`, `apps/web/src/i18n/README.md`, `apps/web/src/i18n/ru/GLOSSARY.md`.

## Структура монорепо

```
packages/meshcore        TS: протокол MeshCore Companion + MeshSession. Без зависимостей и платформенного кода. Потребляется через dist/
apps/web                 React 19 + Vite 8: весь UI и клиентская логика; транспорты выбираются в рантайме
apps/desktop/src-tauri   Rust, Tauri 2: оболочка Windows/macOS/Linux (BLE WinRT, serial, TCP, тосты, трей, keyring, updater)
apps/mobile              Capacitor 8: android/ (Java) и ios/ (Swift) со своими плагинами MeshRelay/MeshTcp/Notices/MeshWatch/SystemText
crates/meshcore-core     Rust + uniffi: ядро радио без I/O для телефона (JNI/Kotlin на Android, XCFramework на iOS)
scripts/                 release.mjs (CI-релизы), icons.mjs, sounds.mjs, sound-synth.mjs
docs/                    скриншоты, метаданные Google Play, desktop-updates.md, dev/ (эти документы)
.github/workflows/       build.yml (всё, кроме iOS), android-play.yml (Google Play)
```

## Архитектура в одной картинке

```
            ┌──────────────────── apps/web (один бандл) ─────────────────────┐
            │  UI (components/, ui/, theme/, i18n/)                          │
            │     ▲ useSyncExternalStore                                     │
            │  MeshSession (packages/meshcore) + модульные сторы (lib/*)     │
            │     ▲                                                          │
            │  MeshCoreClient ◄── Transport (transports/*)                   │
            └───────────────────────┬────────────────────────────────────────┘
      browser: Web Bluetooth / Web Serial
      Tauri:   winble.rs (Windows) | plugin-blec | serialplugin | tcp.rs
      Capacitor: BLE-плагин (connect/pair) + MeshRelay (кадры) → meshcore-core (Rust) | MeshTcp
                                        │
                                   LoRa-радио (companion firmware, Nordic UART / '<' '>' stream)
```

Ключевые идеи:
1. **Прошивка отвечает на одну команду за раз**, и в ответе не сказано, на какую. Поэтому везде очередь с одной командой в полёте: `MeshCoreClient` в вебе и `mux.rs` на телефоне.
2. **Состояние — один `MeshSession`** с иммутабельными снапшотами. Сохраняется в IndexedDB целым документом на радио (ключ — hex публичного ключа радио) с debounce 400 мс. История сообщений живёт на клиенте, радио хранит только непрочитанное.
3. **UI готов раньше полной синхронизации**: `ready` ставится после hello, истории и часов, а контакты и каналы по BLE дочитываются ещё 10–20 с.
4. **Телефон усыпляет JS**, поэтому BLE-линк, очередь сообщений и уведомления в фоне держит нативный relay с Rust-ядром. Страница подключается к нему как клиент. Тот же relay может раздавать радио компьютеру.
5. **Windows BLE — свой WinRT-код** (`winble.rs`): UART прошивки требует шифрования с MITM и PIN-бонда, btleplug на этом виснет.
6. **Протокол продублирован** в TS (`packages/meshcore/src/protocol`) и в Rust (`crates/meshcore-core/src/{codes,frames}.rs`). Менять синхронно.

## Библиотеки

| Где | Библиотека | Зачем |
| --- | --- | --- |
| web | `react` 19, `react-dom` | UI |
| web | `vite` 8, `@vitejs/plugin-react` | сборка и dev-сервер (порт 5180) |
| web | `leaflet` 1.9.4 | карта (тайлы OSM со своим кешем, узлы на своём canvas) |
| web | `@tauri-apps/api`, `@tauri-apps/plugin-updater` | мост к Tauri, обновления |
| web | `@mnlphlp/plugin-blec` | BLE в Tauri на macOS/Linux (btleplug) |
| web | `tauri-plugin-serialplugin-api` | USB serial в Tauri |
| web/mobile | `@capacitor/core` 8.5.2, `@capacitor-community/bluetooth-le`, `@capacitor/local-notifications`, `@capacitor/geolocation`, `@capacitor/keyboard`, `capacitor-secure-storage-plugin` | телефон |
| meshcore | — | ничего, только WebCrypto и TextEncoder |
| dev | `typescript` 5.9, `tsx`, `node:test` | типы и тесты (Jest/Vitest нет) |
| desktop | `tauri` 2, плагины `blec`, `serialplugin`, `opener`, `notification`, `updater`, `autostart`, `single-instance`, `window-state`; `keyring`, `socket2`, `reqwest[socks]`, `windows` 0.61 | см. [desktop.md](desktop.md) |
| core | `uniffi` 0.32, `serde`, `serde_json` | FFI для Kotlin и Swift |
| android | JNA 5.17, cargo-ndk 4.1.2 | загрузка Rust-ядра |
| внешние данные | тайлы OSM; рельеф Terrarium `s3.amazonaws.com/elevation-tiles-prod` | карта, прямая видимость |

## Где что менять

| Задача | Куда смотреть |
| --- | --- |
| Новая команда или кадр протокола | `packages/meshcore/src/protocol/{codes,commands,frames}.ts` + тест; для телефона — `crates/meshcore-core/src/{codes,frames}.rs`; затем метод в `client.ts` и логика в `session.ts` |
| Логика сообщений, ack, повторы, маршруты | `packages/meshcore/src/session.ts` (+ `session.test.ts`) |
| Новый транспорт или правка подключения | `apps/web/src/transports/*`, `index.ts` (`connectors()`), автомат — `apps/web/src/lib/link.ts` |
| Новый экран или раздел | `apps/web/src/lib/nav.ts` (тип `Screen`/`RadioPage`) → `ScreenView` в `components/Workspace.tsx` → компонент |
| Страница «Радио» | `components/RadioPages.tsx` (`RADIO_TITLES`, `RADIO_PARENTS`) |
| Инструмент на карте | `lib/meshTool.ts`, `lib/toolActions.ts`, `lib/mapOverlay.ts`, `components/tools/*` |
| Страницы удалённого узла | `components/node/*`, `lib/nodes.ts`, `lib/cli.ts` |
| Текст UI | `apps/web/src/i18n/{en,ru}/<area>.json` — оба сразу |
| Тема или цвета | `apps/web/src/theme/themes.ts`, `styles.css` (только переменные) |
| Уведомления | `lib/announce.ts` (что показывать), `lib/notify.ts` (как), нативное: `announce.rs`/`notices.rs`, `NoticesPlugin.java`, `MeshWatch.swift`, фон — `crates/meshcore-core/src/watch.rs` + `lib/coreWatch.ts` |
| Команда Tauri | `apps/desktop/src-tauri/src/*.rs` + `generate_handler!` в `lib.rs` + `capabilities/default.json` при использовании плагинов |
| Capacitor-плагин | Java в `apps/mobile/android/.../meshnet/` + регистрация в `MainActivity`; Swift в `ios/App/App/` + `MeshViewController`; JS-обёртка в `apps/web/src/lib/*` |
| Иконка или звук | `apps/web/public/icon.svg` → `pnpm icons`; `scripts/sound-synth.mjs` → `pnpm sounds` |
| Видимое пользователю изменение | + пункт в `CHANGELOG.md` и `CHANGELOG.ru.md` |

## Быстрый старт

```
pnpm install
pnpm web                 # http://localhost:5180 ; без радио — /?demo, коннектор Demo → MeshCore-demo
pnpm typecheck
pnpm test
```
Node 24, pnpm 10.17.1. Подробнее — [build-release.md](build-release.md).
