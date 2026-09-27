# `apps/desktop` — оболочка Tauri 2 (Windows / macOS / Linux)

> Справка для разработчика/агента. Снимок на 2026-09-27. Обзор — [README.md](README.md).

Оболочка отдаёт `apps/web/dist` в webview и даёт нативное: BLE, serial, TCP, трей, уведомления, хранилище секретов, автозапуск, обновления. Крейт `meshcore-core` сюда **не подключён**.

## Конфигурация

- `src-tauri/Cargo.toml`: пакет `meshnet-desktop`, lib `meshnet_desktop_lib`. Release: strip, LTO, `codegen-units=1`, `panic=abort`.
- `src-tauri/tauri.conf.json`:
  - `productName` `Ommesh`, `identifier` `dev.cm4ker.meshnet`;
  - версия берётся из корневого `package.json` (не из Cargo);
  - `frontendDist` `../../web/dist`, `devUrl` `http://localhost:5180`; before-команды собирают `@meshnet/meshcore`, затем `@meshnet/web`;
  - `withGlobalTauri: false`, `csp: null`;
  - окно `main` 1080×720 (минимум 360×480);
  - updater: minisign `pubkey`, endpoint stable, `installMode: passive`;
  - NSIS `currentUser`, `installerHooks: windows/hooks.nsh`, `createUpdaterArtifacts: false` (CI включает через генерируемый `tauri.release.json`).
- `src-tauri/tauri.offline.json` — оверлей для `…-offline-setup.exe`: `webviewInstallMode: offlineInstaller`. Такой инсталлятор не подписан и в фид не попадает.
- `capabilities/default.json` (окно `main`):
  - `core`, events, `blec`, `serialplugin`;
  - `opener` плюс `allow-open-url` только для `ms-settings:notifications`;
  - `updater:allow-download|install` без `check`: фид выбирается нативно в `desktop_check_update`;
  - `autostart`.
- `capabilities/notices.json` (окно `notices`) — только listen/unlisten.

### Зависимости (Rust)

| Крейт | Зачем |
| --- | --- |
| `tauri 2` (`tray-icon`, `image-png`) | ядро |
| `tauri-plugin-blec 0.14` (btleplug) | BLE на macOS/Linux: в WebView2/WebKit нет Web Bluetooth |
| `tauri-plugin-serialplugin 3` | USB serial: в webview нет Web Serial |
| `tauri-plugin-opener`, `-notification`, `-updater`, `-autostart`, `-single-instance`, `-window-state` | стандартные |
| `keyring 3` (`windows-native`, `apple-native`) | пароли нод в хранилище ОС |
| `reqwest 0.13` (`socks`) | напрямую не вызывается, только включает SOCKS в reqwest апдейтера (иначе `HTTPS_PROXY=socks5://…` падает) |
| `socket2 0.6` | TCP keepalive |
| `windows 0.61`, `windows-future`, `windows-sys 0.59` | WinRT BLE, тосты, реестр, звук |

## Исходники `src-tauri/src/`

| Файл | Что делает |
| --- | --- |
| `main.rs` | `windows_subsystem = "windows"` в release, вызывает `run()` |
| `lib.rs` | Порядок плагинов (подробнее ниже), managed state `tcp::Tcp`, `notices::Notices`, `winble::WinBle` (только Windows), два `generate_handler!` (Windows-список добавляет `winble_*`) |
| `announce.rs` | Системные тосты. На Windows рисуются напрямую через WinRT `ToastNotification`, на macOS/Linux идут через плагин, там `withdraw` ничего не делает. Подробнее ниже. |
| `notices.rs` | Собственные карточки уведомлений в стиле Telegram, подробнее ниже |
| `secrets.rs` | `keyring::Entry::new("meshnet", id)`, id вида `node-<key>`. Отсутствующая запись → `None`, удаление отсутствующей → `Ok`. |
| `tcp.rs` | Wi-Fi-мост, подробнее ниже |
| `tray.rs` | Закрытие окна прячет его в трей (радио остаётся подключённым), подробнее ниже |
| `updates.rs` | `desktop_update_info` → `{version, supported: cfg!(windows), channel}` (канал `dev`, если версия prerelease). `desktop_check_update(channel)` строит updater с одним из двух разрешённых endpoint'ов, таймаут 15 с, `on_before_exit` сохраняет окно. Возвращает `UpdateMetadata{rid,…}`, `rid` потом использует JS-класс `Update` из `@tauri-apps/plugin-updater`. |
| `winble.rs` | Нативный BLE для Windows, подробнее ниже |

Порядок в `lib.rs`:
1. `single_instance` — должен быть первым, повторный запуск возвращает окно (`tray::bring_back`);
2. `window_state` — `notices` в denylist;
3. `autostart` — `app_name("Meshnet")` (старое имя, чтобы старые записи продолжали работать), аргумент `--minimized` → окно сразу в трей;
4. остальные плагины.

`announce.rs`, почему свои тосты: вне установленной сборки плагин не ставит AppUserModelID, и тосты подписаны «Windows PowerShell». Кроме того, у плагина нет тегов, а без них тост нельзя заменить или снять.
- Тег — хеш FNV-1a (тег тоста ≤ 64 символов), группа `meshnet`.
- Аватар выводится через `appLogoOverride hint-crop="circle"` и кешируется в `avatars/<fnv>.png`.
- `register()` пишет `HKCU\Software\Classes\AppUserModelId\<id>`.
- Звук тоста выключен, звук играет `notices::play`, если Windows не в `quiet()`.

`notices.rs`:
- Второе окно `notices` грузит `notices.html` (отдельный Vite-entry `apps/web/src/notices/main.tsx`). Окно без рамки, прозрачное, поверх всех, не на панели задач, без фокуса.
- Создаётся лениво из **async**-команды: создание окна из sync-команды на Windows даёт дедлок.
- Карточки копятся, пока страница окна не вызовет `notice_ready`. `notice_layout` ставит окно в угол рабочей области монитора, на котором главное окно.
- Alt+F4 окно только прячет.
- Звуки `chirp`/`roger`/`hop`/`sonar` вшиты через `include_bytes!` из `apps/web/public/sounds/*.wav` и играются `PlaySoundW`.
- `quiet()` проверяет `SHQueryUserNotificationState` и «Не беспокоить» через недокументированный WNF-state.

`tcp.rs`:
- Прошивка с Wi-Fi (ESP32) слушает TCP 5000 тем же потоком, что и USB serial. Оболочка — просто сокет, фрейминг делает клиент.
- `nodelay`, write-timeout 10 с, read-timeout 1 с (Windows не будит заблокированный read при локальном shutdown, поэтому читатель опрашивает), keepalive 10 с / 2 с — пропавшее радио видно примерно за 30 с.
- Данные идут в `Channel<Vec<u8>>`, причина закрытия — в `Channel<String>`.
- Прошивка обслуживает одного клиента, новый вытесняет старого.

`tray.rs`: без трея (Linux без области индикаторов) закрытие окна — обычный выход. `tray_unread` рисует точку: красную для личных, янтарную для чатов. `tray_words` локализует меню.

## `winble.rs` — почему свой BLE на Windows

- Прошивка защищает UART-характеристики (NUS `6e400001/2/3-b5a3-f393-e0a9-e50e24dcca9e`) режимом `SECMODE_ENC_WITH_MITM`: они работают только по связанному через PIN шифрованному линку.
- Discovery такого сервиса через btleplug на Windows зависает и клинит плагин. WinRT сам поднимает шифрование на первой защищённой операции.
- Discovery из MTA-потока пула зависает, из STA отвечает сразу. Поэтому вся работа с WinRT идёт на одном выделенном STA-потоке (`RoInitialize(RO_INIT_SINGLETHREADED)`) с `PeekMessage`-помпой, работа передаётся замыканиями (`on_worker`).
- Каждая async-операция ограничена 20 с (`GATT_DEADLINE`).
- Признак `NEEDS_PAIRING` ставится только для ATT 0x05/0x08/0x0F (facility 0x8065) или не спаренного устройства, чтобы не сносить бонд из-за простой недоступности.
- Сервис и характеристики сначала берутся из кеша: некешированный запрос к связанному шифрованному сервису не возвращается (`find_service_with`, есть unit-тесты).
- Скан: активный `BluetoothLEAdvertisementWatcher`, фильтр по UUID сервиса или префиксу имени `MeshCore-`, +300 мс на scan response.
- Pair: удаляется старый бонд, затем `PairWithProtectionLevelAsync(EncryptionAndAuthentication)`.
- Линки нумеруются, поэтому поздний disconnect не убивает более новый линк.
- Известная проблема: realme/ColorOS `com.heytap.accessory` не отвечает на discovery (см. `apps/mobile/README.md`).

## Команды Tauri ↔ веб

| Команда | Rust | Кто вызывает в вебе |
| --- | --- | --- |
| `desktop_update_info`, `desktop_check_update` | `updates.rs` | `apps/web/src/lib/updates.ts` |
| `winble_scan`, `winble_stop_scan`, `winble_pair`, `winble_connect` (Channel `onFrame`), `winble_send`, `winble_disconnect` | `winble.rs` | `transports/tauriWinBle.ts` |
| `tcp_open` (Channels `onData`, `onClosed`), `tcp_write`, `tcp_close` | `tcp.rs` | `transports/tauriTcp.ts` |
| `announce`, `withdraw` | `announce.rs` | `lib/notify.ts` |
| `notice_card`, `notice_withdraw` | `notices.rs` | `lib/notify.ts` |
| `notice_ready`, `notice_layout`, `notice_open`, `notice_act` | `notices.rs` | `apps/web/src/notices/main.tsx` |
| `chime` | `notices.rs` | `lib/chime.ts` |
| `tray_unread`, `tray_words` | `tray.rs` | `lib/tray.ts` |
| `secret_get`, `secret_set`, `secret_delete` | `secrets.rs` | `lib/secrets.ts` |
| `plugin:autostart\|is_enabled/enable/disable` | плагин | `lib/autostart.ts` |
| `plugin:opener\|open_url` | плагин | `lib/notify.ts` |

JS плагинов напрямую: `@mnlphlp/plugin-blec` вызывается в `transports/tauriBle.ts` (не-Windows), `tauri-plugin-serialplugin-api` — в `transports/tauriSerial.ts`.

События Rust → страница:

| Событие | Кто шлёт | Окно | Кто слушает |
| --- | --- | --- | --- |
| `notification-opened {tag}` | `announce.rs` | `main` | `lib/notify.ts` |
| `notice-action` | `notices.rs::notice_act` | `main` | `lib/notify.ts` |
| `notice-card {card, corner}`, `notice-withdraw` | `notices.rs` | `notices` | `notices/main.tsx` |
| `winble:closed` | `winble.rs` | broadcast | `transports/tauriWinBle.ts` |

Потоковые данные ходят через `tauri::ipc::Channel`, а не события.

Tauri определяется по `__TAURI_INTERNALS__` (`lib/platform.ts`). Выбор транспорта: на Windows `tauriWinBle`, иначе `tauriBle`, дальше serial и TCP (`transports/index.ts`).

## Инсталлятор: `windows/hooks.nsh` (миграция со старого имени Meshnet)

- `PREINSTALL`: при первой установке Ommesh ставится в старую папку Meshnet, чтобы сохранились закрепления на панели задач и автозапуск.
- `POSTINSTALL`: ярлыки `Meshnet.lnk` переименовываются или удаляются, удаляется ключ `Software\Meshnet\Meshnet`.
- `POSTUNINSTALL`: вне режима обновления удаляется Run-значение `Meshnet`.
- Данные приложения сохраняются, потому что identifier не менялся.

## Обновления

Только Windows. Проверка при старте и каждые 6 ч (`PERIOD` в `lib/updates.ts`), сама не качает и не показывает модалок. Перед установкой клиент до 45 с ждёт подтверждений, синхронизации и очереди запросов, сбрасывает черновики, отключает радио и ждёт коммита IndexedDB (`lib/updateSafety.ts`, `lib/updateController.ts`). Канал хранится в `meshnet.updates.channel`. Подробнее — `docs/desktop-updates.md` и [build-release.md](build-release.md#релизы-scriptsreleasemjs).

## Команды

```
pnpm desktop                                   # tauri dev (поднимет vite)
pnpm desktop:bundle                            # инсталлятор под хост
pnpm --filter @meshnet/desktop desktop:bundle:x64
pnpm --filter @meshnet/desktop desktop:check   # cargo check
```
Инсталляторы появляются в `apps/desktop/src-tauri/target/release/bundle`. Логи Rust — через `RUST_LOG` (`env_logger`).
