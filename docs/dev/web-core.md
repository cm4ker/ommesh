# `apps/web` — ядро клиента: транспорты, сессия, хранилище, уведомления

> Справка для разработчика/агента. Снимок на 2026-09-27. Обзор — [README.md](README.md). UI — [web-ui.md](web-ui.md).

Один бандл React 19 + Vite 8 работает в трёх местах: вкладка браузера (Web Bluetooth/Web Serial — Chrome или Edge), Tauri и Capacitor. Какой линк использовать, решается в рантайме.

## Управление состоянием

**Ни Redux, ни Zustand, ни Context нет.** Всё состояние держат:

1. **Один экземпляр `MeshSession`** из `packages/meshcore` ([protocol.md](protocol.md#meshsession-sessionts--стор-приложения)). Его создаёт `src/lib/session.ts`:
   ```ts
   storage = new IndexedDbStorage();
   session = new MeshSession({ appName: "Ommesh", storage, trace: pushTrace });
   ```
   Читается через `useSession()` (без перерисовки, если поменялся только `log`) и `useSelector(select)`.
2. **Модульные сторы** по одному шаблону: `let state` + `Set` слушателей + хук `useX()` поверх `useSyncExternalStore`. Это `link`, `relay`, `resync`, `ping`, `discovery`, `air`, `trace`, `followPhone`, `noticePrefs`, `sendTries`, `lookalikes`, `drafts`, `secrets`, `cleanUp`, `updates`, `nav`, `meshTool`, `banner`, `toast`, `theme`.

`App.tsx` подписан только на `status` и `self !== null`: перерисовка корня перерисовала бы все экраны.

## Поток данных

```
Radio ──BLE/USB/TCP──► Transport (BaseTransport)
      ──► MeshCoreClient (очередь команд, push)
      ──► MeshSession (SessionState)
      ──► React (useSession/useSelector) + модульные сторы
      ──► IndexedDbStorage (debounce-сохранение целого документа на радио)
```

`lib/link.ts` стоит между коннекторами и сессией:
- `reach()` открывает транспорт с таймаутом 45 с (`OPEN_TIMEOUT_MS`) → `session.connect(transport, onReady)` → в `onReady` вызывается `rememberLink({connectorId, device, radioName, radio:{self, device}})`, PIN при этом обнуляется.
- Счётчик `generation` отбрасывает устаревшие попытки. Транспорт, открывшийся после таймаута, закрывается.

### Старт — «открыться на чатах последнего радио»

1. `main.tsx`:
   - выставляет `window.meshnet = {session, getLink, connectWith, disconnect, connectors, back, linkBook, getPing}` (для консоли и тестовых стендов; Android вызывает `meshnet.back`);
   - `startLinks()`, `initSendTries()`, `initTheme()`, `initTextSize()`, `await initLanguage()`;
   - на Capacitor отключает pinch-zoom, запускает клавиатурные хуки;
   - **`await Promise.race([autoConnect(), 400ms])`**, затем `<App/>` в StrictMode.
2. `autoConnect`:
   - `lastLink()`, коннектор и запомненное устройство;
   - `session.resume(self, device)` — история из IDB при `status: idle`;
   - `reach(..., dropped=true)` без `await`.
3. `App` показывает `Workspace`, если `status==="ready" || (link.dropped && known && link.phase!=="idle")`. Поэтому при упавшем линке чаты остаются на экране.

### Переподключение

- При неожиданном `status==="closed"` запускается `scheduleRetry()` с задержкой `min(30s, 1s·2^(n-1))`.
- Picker-коннекторы (браузер) без клика переподключиться не могут, для них `failed` + `dropped`.
- `needsPairing` останавливает повторы: иначе на телефоне каждая попытка снова показывала бы системный запрос PIN.
- Когда страница становится видимой или приходит `onRelayUp`, сразу вызывается `reconnectNow()`.
- Для устройств, выбранных вручную, `CONNECT_TRIES = 3`.
- Когда страница уходит в фон, вызывается `session.flush()`. Когда возвращается — `session.syncMessages()`: push «message waiting» мог потеряться, пока страница спала.

## Транспорты (`src/transports/`)

Выбор — `connectors()` в `index.ts` по `platform.shell()`. Tauri определяется по `window.__TAURI_INTERNALS__`, Capacitor — по `Capacitor.isNativePlatform()`, иначе это `browser`.

| Оболочка | id | Файл | Библиотека | Режим |
| --- | --- | --- | --- | --- |
| Tauri + Windows UA | `tauri-winble` | `tauriWinBle.ts` | свой `winble.rs` (WinRT) через `invoke` + `Channel` | scan |
| Tauri (macOS/Linux) | `tauri-ble` | `tauriBle.ts` | `@mnlphlp/plugin-blec` (btleplug) | scan |
| Tauri | `tauri-serial` | `tauriSerial.ts` | `tauri-plugin-serialplugin-api` | scan |
| Tauri | `tauri-tcp` | `tauriTcp.ts` + `tcp.ts` | свой `tcp.rs` | address |
| Capacitor | `cap-ble` | `capacitorBle.ts` | `@capacitor-community/bluetooth-le` для connect и pair; **кадры идут через нативный `MeshRelay`** | scan |
| Capacitor | `cap-tcp` | `capacitorTcp.ts` + `tcp.ts` | свой плагин `MeshTcp` | address |
| Браузер с `navigator.bluetooth` | `web-ble` | `webBluetooth.ts` | Web Bluetooth | picker |
| Браузер с `navigator.serial` | `web-serial` | `webSerial.ts` | Web Serial | picker |
| Capacitor всегда; везде при `DEV` или `?demo` | `demo` | `demo.ts` | `DemoRadio` | scan |

Режимы: `picker` — системный выбор устройства браузером; `scan` — устройства перечисляет само приложение; `address` — адрес `host[:port]` вводится руками.

Особенности транспортов:

- **`types.ts`**:
  - `Connector {id, kind, title, description, mode, scan?, remembered(), connect(device), pair?}`;
  - `FoundDevice`, `DeviceRole = radio|phone|port`, `RememberedLink`;
  - `NeedsPairingError` и `needsPairing(err)` (срабатывает на `NEEDS_PAIRING|insufficient auth|ProtocolError`).
- **`index.ts`**: `lastLink`/`rememberLink` (`meshnet.link.last`), `autoConnectWanted` (`meshnet.link.auto`, по умолчанию true).
- **`role.ts`**: `MeshCore-<node>` — радио; `Ommesh <node>` — iPhone, который раздаёт своё радио; остальное в BLE-списке — телефон.
- **`webBluetooth.ts`**: `writeValueWithoutResponse`, при `NotSupportedError` откат на with-response.
- **`webSerial.ts`**: записи сериализуются цепочкой промисов.
- **`tauriBle.ts`**:
  - запись **with response**: UART-характеристики прошивки требуют шифрования с MITM, а запись без подтверждения по нешифрованному линку молча теряется;
  - перед connect 6 с сканирования `ensureSeen`, потому что плагин подключается только к тому, что видел адаптер.
- **`tauriWinBle.ts`**:
  - btleplug на Windows клинит на шифрованном UART, поэтому используется свой `winble.rs`;
  - разрыв приходит событием `winble:closed`;
  - известные устройства в `meshnet.winble.known` (до 8);
  - телефон, раздающий радио, спаривается автоматически без PIN; радио бросает `NeedsPairingError`, и UI спрашивает PIN.
- **`tauriSerial.ts`**:
  - опрос портов раз в 2 с;
  - после open поднимаются **DTR и RTS**: платы nRF52/TinyUSB (T-Echo, RAK) на Windows молчат, пока хост не поднимет DTR;
  - `fail()` освобождает порт.
- **`tcp.ts`**: порт по умолчанию 5000, таймаут 10 с, разбор IPv6 в скобках, известные адреса в `meshnet.tcp.known`.
- **`capacitorBle.ts`**:
  - `pairFirst` на Android: бонд до первой записи (`PAIR_MS = 40s`), иначе ввод PIN гонится с таймаутом;
  - перехват живого линка через `takeOver()`/`relayHolds()` и гонка с `relayComesUp()` — [mobile.md](mobile.md#перехват-живого-линка);
  - на iOS `getConnectedDevices` находит подключённые, но не рекламирующиеся радио;
  - известные устройства в `meshnet.ble.known`;
  - **на shutdown не вызывать `stopNotifications`**.
- **`demo.ts`**:
  - `DemoRadio extends BaseTransport` — скриптовая прошивка;
  - болтовня каждые 25 с, «услышанные» пакеты каждые 3,5 с;
  - фейковый город `TOWN`/`LINKS` с мёртвым линком для проверки поиска маршрутов;
  - «Kolya» недостижим;
  - `?demo&crowd=N` добавляет до 3000 узлов;
  - `Cmd.Reboot` закрывает линк;
  - на Capacitor демо есть всегда, для ревьюеров сторов.

## Хранилище (`lib/storage.ts`)

- **IndexedDB `"meshnet"`**, один object store **`"radios"`**, ключи вне значений.
  - **Одна запись на радио, ключ — hex публичного ключа радио**, значение — весь `PersistedState` (`contacts`, `contactsCursor`, `removed`, `channels`, `messages`, `unread`, `logins`, `statusHistory`, `batteryHistory`, `routing`). Логика: сообщений тысячи, а не миллионы, поэтому один документ проще схемы.
  - Побочные записи — ключи `what:radio` (`loadExtra`/`saveExtra`); `listRadios()` пропускает ключи с `:`.
  - БД открывается на текущей версии; если store нет, переоткрывается с version+1.
  - Соединение ленивое, переоткрывается на `onclose`/`onversionchange`. Каждый запрос повторяется один раз на свежем соединении: iOS закрывает IDB в фоне.
  - `run()` резолвится на `tx.oncomplete`, а не на успехе запроса: успешный запрос ещё может откатиться.
- **Тайлы карты** — отдельная БД `meshnet-tiles` ([web-ui.md](web-ui.md#карта-и-гео)).
- **localStorage** (`readSetting`/`writeSetting`, JSON, переживают приватный режим) — всё с префиксом `meshnet.`:

| Группа | Ключи |
| --- | --- |
| Подключение | `link.last`, `link.auto`, `ble.known`, `winble.known`, `tcp.known`, `relay.on` |
| Сообщения | `drafts` (ключ `radio/conversation`), `sendTries`, `lookalikes` |
| Уведомления | `notices` (старые `notify` и `notify.nodes` мигрируют) |
| Пароли | `passwords` (индекс), `secret.*` (только браузер) |
| Настройки на радио | `followPhone`, `tidy.<radioKey>` |
| Обновления | `updates.channel`, `updates.auto` |
| Вид | `theme`, `theme.ground` (цвет boot-экрана, читает `index.html`), `textSize`, `language`, `nav`, `map.grouping` |

## Файлы `src/lib/` (ядро)

| Файл | Что делает |
| --- | --- |
| `session.ts` | Синглтон `session`, `useSession`, `useSelector` |
| `storage.ts` | `IndexedDbStorage`, `readSetting`/`writeSetting` |
| `link.ts` | Автомат подключения: `useLink`, `connectWith`, `reach`, `pairLink`, `disconnect`, `cancelConnect`, `pauseForUpdate`, `reconnectNow`, `autoConnect` |
| `conversations.ts` | Чистая логика списка чатов: `summarize`, `messagesIn`, `titleOf`, `totalUnread`. Id чатов: `ch:<index>`, `c:<key>`, либо id по префиксу. |
| `channels.ts` | `freeChannelIndex`, `randomSecret`, `parseSecret`, `hashtagSecret` (первые 16 байт SHA-256 от `#name`, как в MeshCore) |
| `nodes.ts` | Логика репитеров, комнат и сенсоров: `nodeTabs`, `isAdmin`, `heardAt` (время advert ограничено `lastMod`, потому что у некоторых узлов часы спешат), таблицы настроек `RADIO_FIELDS`, `settingGroups`, `readCommand`/`writeCommand` |
| `drafts.ts` | Черновики с debounce 400 мс, сброс на `pagehide`, `flushDrafts` (синхронный, для апдейтера) |
| `resync.ts` | Обёртка `session.resync` с прогрессом |
| `relay.ts` | Мост к нативному `MeshRelay` ([mobile.md](mobile.md#relay-зачем-и-как-работает)) |
| `coreWatch.ts` | JSON `WatchConfig` и слова для Rust-ядра; отправляется, только когда меняются имена, настройки или язык |
| `secrets.ts` | Пароли узлов: Tauri keyring, Capacitor secure storage или localStorage |
| `platform.ts` | `shell()`, `isTauri`, `isCapacitor`, `nativePlatform()`, `hasWebBluetooth`, `hasWebSerial`, `canHover`, `touchFirst` |
| `notify.ts`, `nativeNotices.ts`, `noticePrefs.ts`, `announce.ts`, `chime.ts` | Уведомления, подробнее ниже |
| `sendTries.ts` | Число попыток DM: по умолчанию 5, максимум 8 |
| `echoes.ts` | Анализ эхо от репитеров: `relaysOf`, `spreadOf`, `nameOfHash` |
| `routes.ts` | Тексты о маршрутах, `ROUTE_LIMITS [null,5,15,30,60]` мин |
| `trace.ts` | Лог сырых кадров (последние 300), вне сессии, потому что меняется на каждом байте |
| `ping.ts` | Проверка маршрута: 5 трассировок; при тишине — бисекция места обрыва и поиск обхода через `linkGraph`. Найденный путь пишется маршрутом, старый можно вернуть. |
| `discovery.ts` | Path discovery флудом |
| `followPhone.ts`, `phonePosition.ts` | «Следовать за телефоном»: запись позиции в радио только при сдвиге больше 50 м, не чаще раза в 5 мин и при точности ≤ 100 м (каждая запись идёт во flash); радио с включённым GPS пропускается |
| `updates.ts`, `updateController.ts`, `updateSafety.ts` | Апдейтер десктопа, подробнее ниже |
| `tray.ts`, `autostart.ts` | Трей и автозапуск в Tauri |
| `cleanUp.ts`, `tidy.ts` | Массовая и автоматическая чистка контактов. Никогда не удаляются избранные, «свои» узлы и контакты с чатом. Правило: через 5 с после ready, затем каждый час (не чаще раза в 24 ч) и сразу при `contactsFull`. |
| `air.ts` | Экран «В эфире»: 500 пакетов, `radioStats` раз в 10 с для noise floor |
| `senders.ts` | Кандидаты в авторы сообщения |
| `lookalikes.ts` | Замена кириллицы на одинаковую на вид латиницу: 1 байт вместо 2, примерно на 20% больше русского текста |

## Отправка сообщения

1. `components/Composer.tsx` `send()`: `mention + packLookalikes(body)` → `session.sendText(conv, out, {original, flood?})`. `sendSplit()` режет длинный текст. `quickReply.ts` — то же для ответа из карточки уведомления.
2. `sendText` создаёт `MessageRecord`: `sending` или `queued`, если офлайн. `flushQueue()` при подключении отправляет очередь **с новым timestamp**.
3. `transmit`:
   - **канал**: `watchEchoes` → `sendChannelTextMessage` → `sent` → `armSilence` (20 с без эхо → `unheard`). У каналов нет ack, единственное подтверждение — эхо от репитера;
   - **DM**: маршрут сбрасывается, если просят flood, повтор идёт после неподтверждённой попытки, flood закреплён или маршрут устарел → `sendTextMessage` → `armAck`.
4. `SendConfirmed` (в том числе по `pastAckTags`) → `delivered` + `roundTripMs`. Для flood к сообщению цепляется маршрут из `PathUpdated`, пришедшего за ≤ 5 с до этого.
5. Нет ack → `unconfirmed`, затем `tryAgainOnItsOwn()` → `retryPlan` → `sweepRetries` каждые 5 с по `DIRECT_LADDER_MS`. Повтор после `unconfirmed` идёт флудом (`retryFloods`).
6. Канал: `keepTrying` по `RETRY_LADDER_MS` до первого эхо, всегда со свежим timestamp.
7. При разрыве линка `holdRetryPlans`, после подключения `resumeRetryPlans`. Действия в UI (`ChatView.tsx`): `sendAgain`, `keepTrying`, `stopTrying`, `discardQueued`, `discardFailed`.
8. `Mirror` от relay записывает то, что отправил второй клиент того же радио.

## Уведомления

- **Кто решает, что показывать** (`App.tsx`):
  - `session.onReceived` → `createAnnouncer` (`announce.ts`): одно уведомление на чат, заменяется новыми и снимается при прочтении; пачка из очереди объявляется один раз после `syncing`; больше 3 чатов сворачиваются в одно «все чаты»;
  - `session.onDiscovered` → `nodeWanted` → уведомление о новом узле с расстоянием и азимутом.
- **Прочитанным считается** чат на экране: `session.focus(conv)`, только при `pageOnScreen()` (видимость, на десктопе ещё и `hasFocus`).
- **`notify()`**:
  - `shownBy === "app"`:
    - Tauri → `notice_card` (угловое окно);
    - телефон или вкладка на экране → `showBanner` + `chime`.
  - Системные:
    - **Tauri** → `invoke("announce")`, свой тост из `announce.rs`. Клик приходит событием `notification-opened`, действия карточек — `notice-action`.
    - **Capacitor** → `NativeNotice` с тредом и аватарами: iOS `MeshWatch.post`, Android `Notices.post`. Затем `coreAnnounced(tag)`, чтобы снять уведомление-заглушку Rust-ядра. Тапы приходят через `localNotificationActionPerformed`. Разрешение `LocalNotifications` спрашивается один раз при первом ready.
    - **Браузер** → `new Notification`. Разрешение спрашивается только по переключателю: браузеры блокируют запросы «из ниоткуда».
- **Фон на телефоне**: уведомления показывает Rust-ядро по конфигу из `coreWatch.ts`.
- **Теги**: `c:<conv>`, `c:` (все чаты), `n:<contactKey>`. `noticeId` — FNV-1a (положительный int для Android), совпадает с `watch.rs`.
- `noticePrefs`:
  - `direct`;
  - `chats`: `all|mentions|off`;
  - `nodes`: `people|all|off`;
  - override на чат, `shownBy: system|app`, `corner`, `signal`.

  Настройки хранятся на устройство, а не на радио. Упоминание — `@[name]`.
- `tellChannels()` пересоздаёт Android-каналы при смене звука: звук канала фиксируется при создании.

## Обновления (только Tauri на Windows)

- `initializeUpdates()` → `desktop_update_info`, затем автопроверка каждые 6 ч и при возврате на страницу.
- `UpdateController`: idle → checking → current / available → downloading (таймаут 15 мин, подпись проверяется) → ready → installing.
- `installUpdate`:
  1. Ждёт до 45 с, пока `session.hasPendingCommands`, `radioBusyForUpdate(state)` (идёт синхронизация, удалённые задачи, `sending`/`sent` с ожидающим ack) или идёт подключение.
  2. `flushDrafts()`.
  3. `session.flush()`.
  4. `pauseForUpdate()`.
  5. Снова `flush()`.
  6. `install()`.

  При неудаче `resume()` переподключает тот же линк. Правило из комментария: никогда не заменять несохранённые данные в памяти более старой копией.
- Канал по умолчанию — `dev`, если в `__APP_VERSION__` есть `-`.

## Конфиг

- `vite.config.ts`:
  - `base: "./"` — одна сборка для http, `tauri://localhost` и `capacitor://localhost`;
  - два входа: `main` и `notices`;
  - `__APP_VERSION__` из `MESHNET_VERSION` или из корневого `package.json`;
  - dev на порту 5180 (`strictPort`, `host: true` для телефона по LAN).
- `index.html` — inline-скрипт ставит `--boot-ground` из `meshnet.theme.ground`, чтобы первый кадр был уже в цветах темы.
- `notices.html` + `src/notices/main.tsx` — угловое окно Tauri: без радио и истории, карточка живёт 6 с, одновременно не больше 3.

## Грабли

- **Прокси Capacitor-плагина нельзя возвращать из Promise** (он «thenable», и промис виснет). Поэтому колбэки `withRelay`/`withWatch`/`withNotices`.
- `useSession` не перерисовывает UI на изменения `log`: лог растёт почти с каждым услышанным пакетом.
- `t()` нельзя вызывать на верхнем уровне модуля, поэтому в `nodes.ts` метки сделаны геттерами.
