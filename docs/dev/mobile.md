# `apps/mobile` — оболочка Capacitor 8 (Android / iOS)

> Справка для разработчика/агента. Снимок на 2026-09-27. Обзор — [README.md](README.md). Пользовательская инструкция по сборке — `apps/mobile/README.md`.

## Основное

- App id — `dev.cm4ker.meshnet` везде: Capacitor, Android namespace/applicationId, iOS bundle id, Play. Отображаемое имя — **Ommesh**. Внутренние имена «Meshnet App Store» (профиль) и «Meshnet» (App ID) оставлены намеренно.
- `capacitor.config.ts`:
  - `webDir: ../web/dist` — клиент вшит в приложение («у радио в поле нет сети»);
  - `CAP_SERVER_URL` грузит клиент с LAN dev-сервера (`cleartext`, отладка webview);
  - `appendUserAgent: "Ommesh (+https://github.com/cm4ker/ommesh)"` — требование tile policy OSM;
  - iOS `contentInset: never` — safe areas считает страница;
  - `Keyboard.resize: none` — страница двигается сама (`lib/keyboard.ts`);
  - иконка уведомлений `ic_stat_meshnet`, цвет `#74ade8`.
- Android: minSdk 24, compile/target 36, JVM 21, JNA 5.17 (`android/variables.gradle`). iOS 15.0, team `8CNDTQVA32`.
- Зависимости: `@capacitor-community/bluetooth-le`, `@capacitor/{geolocation,keyboard,local-notifications}`, `capacitor-secure-storage-plugin` (пароли нод).
- Скриптов build/typecheck/test нет намеренно: `pnpm -r` запускается и там, где нет SDK.

## Файлы

### Android (`android/app/src/main/java/dev/cm4ker/meshnet/`)

| Файл | Что делает |
| --- | --- |
| `MainActivity.java` | Регистрирует 4 локальных плагина до `super.onCreate`, подробнее ниже |
| `MeshRelay.java` | Синглтон: собственный BLE-линк к радио, GATT-сервер для раздачи компьютеру, управляет Rust `Radio` ([rust-core.md](rust-core.md)) |
| `MeshRelayPlugin.java` | Capacitor-мост к `MeshRelay` |
| `MeshRelayService.java` | Foreground service `connectedDevice` с постоянным уведомлением |
| `MeshTcpPlugin.java` | Сырой TCP для Wi-Fi-прошивки (порт 5000): пул читателей и один поток записи |
| `NoticesPlugin.java` | Рисование уведомлений, подробнее ниже |
| `SystemTextPlugin.java` | `scale()` → `fontScale` |
| `AppExits.java` | `ApplicationExitInfo` (API 30+) и записи о потере страницы в prefs `meshnet.exits`, хранятся 5 последних, показываются в «О приложении» |
| `Words.java` | Локализованные нативные строки из `words` в сохранённом watch-JSON, fallback — английский |

Что делает `MainActivity.java`:
- edge-to-edge, `setTextZoom(100)`;
- рендерер webview с приоритетом `IMPORTANT`;
- `onRenderProcessGone` пересоздаёт activity, но не чаще раза в 10 с;
- при нехватке памяти отпускает страницу (`releasePage`): опрос каждые 30 с, пока приложение не на экране, плюс `onTrimMemory`;
- `preferFastestRefresh` — обход 60 Гц на ColorOS;
- Back передаёт в `window.meshnet.back()`;
- `onStart`/`onStop` вызывают `MeshRelay.setBackground`.

Прочее в Android:
- `AndroidManifest.xml`: `MainActivity` singleTask, portrait, в `configChanges` есть `fontScale` (смена размера текста не перезагружает страницу и не рвёт радио); FileProvider; `MeshRelayService` с `foregroundServiceType="connectedDevice"`.
- `res/xml/backup_rules.xml`, `data_extraction_rules.xml` и `allowBackup=false` — бэкап и перенос данных выключены.
- `res/raw/signal_*.wav` генерирует `pnpm sounds`.

### iOS (`ios/App/App/`)

| Файл | Что делает |
| --- | --- |
| `AppDelegate.swift`, `SceneDelegate.swift` | Окно с `MeshViewController` |
| `MeshViewController.swift` | Подкласс `CAPBridgeViewController`, регистрирует `MeshTcpPlugin`, `MeshWatchPlugin`, `MeshRelayPlugin`, вызывает `MeshWatch.installSounds()` |
| `MeshRelay.swift` | Аналог `MeshRelay.java` на CoreBluetooth, подробнее ниже |
| `MeshWatch.swift` | Уведомления (`UNUserNotificationCenter`, опционально communication notices через `INSendMessageIntent`), `chime`, копирование звуков в `Library/Sounds` |
| `MeshTcpPlugin.swift` | TCP через Network.framework `NWConnection` на одной serial-очереди |
| `Info.plist`, `ru.lproj/InfoPlist.strings` | Строки разрешений EN/RU |

Прочее в iOS:
- `ios/MeshcoreCore/Package.swift` — локальный SPM-пакет с XCFramework Rust-ядра.
- `ios/App/CapApp-SPM/Package.swift` — генерирует Capacitor, руками не править. Пути в нём ведут в `node_modules/.pnpm`, закоммичена Windows-версия путей.
- `export-testflight.plist`, `debug.xcconfig`.

### Скрипты (`apps/mobile/scripts/`)

| Скрипт | Что делает |
| --- | --- |
| `android.mjs apk\|aab` | Собирает meshcore → web → `cap sync android` (только android, чтобы не переписать iOS SPM-пути на Windows) → gradle. Для `aab` отказывает, если задан `CAP_SERVER_URL`, требует `ANDROID_VERSION_CODE`, выставляет `MESHNET_VERSION`, запускает `bundleRelease lintRelease`. |
| `apple.mjs` | Клиент App Store Connect API (JWT ES256 собирается вручную): `bundle`, `profile`, `app` |
| `core-ios.sh` | Сборка Rust-ядра в XCFramework |
| `ios.sh simulator\|archive\|testflight` | Запускается на Mac |

## Самописные Capacitor-плагины

| JS-имя | Платформы | Методы | События | Натив | Кто вызывает в вебе |
| --- | --- | --- | --- | --- | --- |
| `MeshRelay` | Android, iOS | `start({deviceId,name,share})`, `share({on})`, `stop()`, `state()`, `attach()`, `detach()`, `send({data})` (резолвится, когда кадр ушёл), `configure({json,sound})`, `announced({tag})`, `exits()` (только Android) | `state {linked, radio, up, on, computer}` (iOS шлёт только `{linked,on,computer}`), `frame {data}` | `MeshRelayPlugin.java` + `MeshRelay.java`; `MeshRelay.swift` | `lib/relay.ts` (`withRelay`), через него `transports/capacitorBle.ts`, `lib/link.ts`, `lib/coreWatch.ts`, `lib/notify.ts`, `components/RadioPages.tsx` |
| `MeshTcp` | Android, iOS | `open({host,port,timeout})` → `{id}`, `write`, `close` | `data {id,data}`, `closed {id,error}` | `MeshTcpPlugin.java`, `.swift` | `transports/capacitorTcp.ts` (фрейминг в `tcp.ts`) |
| `Notices` | только Android | `openSettings`, `channels({sound})`, `post`, `cancel`, `chime` | — | `NoticesPlugin.java` | `lib/nativeNotices.ts` (`withNotices`), `lib/notify.ts`, `lib/chime.ts` |
| `MeshWatch` | только iOS | `openSettings`, `post`, `chime` | — | `MeshWatch.swift` | `lib/nativeNotices.ts` (`withWatch`), `lib/notify.ts`, `lib/chime.ts` |
| `SystemText` | только Android | `scale()` | — | `SystemTextPlugin.java` | `theme/textSize.ts` (на iOS страница меряет `-apple-system-body`) |

Регистрация плагинов: на Android — `registerPlugin` в `MainActivity.onCreate` до `super`, на iOS — `bridge?.registerPluginInstance` в `capacitorDidLoad`. Моки плагинов — в `apps/web/src/lib/notify.test.ts`.

**Грабли.** Нельзя резолвить Promise *прокси-объектом* Capacitor-плагина: прокси отвечает на `then`, и промис виснет. Поэтому плагины раздаются через колбэки `withRelay` / `withWatch` / `withNotices`.

## Relay: зачем и как работает

На телефоне страница **всегда** ходит к BLE-радио через нативный `MeshRelay`. Плагин `@capacitor-community/bluetooth-le` по-прежнему подключается, спаривается и подписывается и держит соединение, чтобы страница узнала об обрыве. Но кадры страницы идут через `MeshRelay.send` и события `frame` (`CapacitorBleTransport.useRelay`). Причина — сон JS в фоне. Relay продолжает читать радио, кормит Rust-ядро и показывает уведомления о том, чего страница не видела.

### Android (`MeshRelay.java`)

- Свой `BluetoothGatt` через `connectGatt(autoConnect=true, TRANSPORT_LE)` на том же линке, что открыл плагин: Android делит один линк между клиентами. `autoConnect` сам поднимает линк, когда радио возвращается.
- Порядок: `requestMtu(512)` (таймаут 2 с) → `discoverServices` (до 5 попыток) → запись CCCD на TX → `radioReady` → `core.radioUp()`.
- Флаг `mtuAsked`: присоединившийся линк сообщает MTU до запроса, а вторая GATT-операция на занятом линке молча теряется.
- Подписка без ответа за 6 с → `remakeRadio`, не больше 3 раз; пока идёт бондинг, таймер продлевается.
- Запись с ответом, по одной GATT-операции, до 50 повторов через 20 мс.
- `quicken()`: `CONNECTION_PRIORITY_HIGH`, пока идут кадры, и `LOW_POWER` через 15 с тишины (`BRISK_MS`). Команда ~270 мс → ~60 мс, 40 слотов каналов 7,7 с → 2,6 с.
- `watchAdapter` следит за включением и выключением Bluetooth.
- Инбоксы хранятся в SharedPreferences `meshnet.relay` (`inboxes`, `watch`, `sound`): копия сообщения в радио пропадает, как только ядро её прочитало.

`MeshRelayService`:
- `FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE`, `START_NOT_STICKY`, состояния не держит.
- Канал `link`, IMPORTANCE_LOW, id `0x4d52`, тексты берёт из `Words`.
- `startForegroundService` на Android 12+ может быть отклонён, если вызван из фона.

### Раздача радио компьютеру

- Телефон поднимает `BluetoothGattServer` с Nordic UART (`6E400001…`, RX/TX с шифрованными правами), так что компьютер должен спариться с телефоном.
- Реклама идёт, только пока компьютер не подключён; компьютер одновременно только один.
- Между `Client.PAGE` и `Client.COMPUTER` арбитрирует ядро.
- Нужно разрешение `BLUETOOTH_ADVERTISE`.

### Перехват живого линка

Когда Android освобождает страницу (`releasePage`, `pageGone`), service и `MeshRelay` продолжают жить. `MeshRelayPlugin.handleOnDestroy` → `detachPage()`, ядро копит сообщения в инбокс страницы и показывает уведомления.

Когда страница создаётся заново:
1. `capacitorBleConnector.connect` вызывает `relayHolds(deviceId)`: `state()` должен вернуть `linked && up && radio == deviceId`.
2. Если так — `takeOver`: `CapacitorBleTransport(client=null)` + `openRelay(..., held=true)`. Шаги `start()` и плагин пропускаются, выполняется только `attach()`.
3. При `held` событие `state` с `up:false` становится сигналом разрыва для страницы.
4. `relayComesUp(deviceId)` гонится с connect плагина, побеждает тот, кто ответит первым.
5. `lib/link.ts` по `onRelayUp` делает `reconnectNow()`.

### iOS (`MeshRelay.swift`)

- Свой `CBCentralManager` (`retrieveConnectedPeripherals`/`retrievePeripherals`, затем `connect`). После разрыва снова `connect`, iOS держит запрос в ожидании.
- `CBPeripheralManager` для раздачи, имя в рекламе `"Ommesh <name>"` (≤ 20 символов).
- Таймеры ядра берут `beginBackgroundTask`.
- Инбоксы хранятся в `UserDefaults` (`meshnet.relay.*`).
- Foreground service нет, фон держат `UIBackgroundModes` `bluetooth-central` и `bluetooth-peripheral`.
- В `state` нет `radio`/`up`, поэтому `relayHolds` и перехват живого линка фактически работают только на Android.

### Отключение

`openRelay().close()` вызывает `detach()`, а затем `stop()`, если раздача не включена. Настройка на стороне веба — `meshnet.relay.on` (`relayWanted`).

### Грабли relay

- При shutdown BLE-транспорта страницы **нельзя** вызывать `stopNotifications`: подписка общая с relay, и компьютер оглохнет (`capacitorBle.ts`).
- Discovery и CCCD нужно запускать только после ответа MTU для своего клиента (иначе «already has a pending command»).

## Уведомления

**Android (`NoticesPlugin`)** заменяет LocalNotifications для показа уведомлений; сам плагин LocalNotifications остаётся для тапов.
- Каналы `<kind>.<sound|quiet>`, где kind — `direct`, `chats` или `nodes`.
- При смене звука каналы пересоздаются под новыми id.
- `MessagingStyle` + `pushDynamicShortcut` помещают уведомление в раздел «Разговоры».
- Тап использует extras LocalNotifications (включая опечатку `LocalNotficationObject`), поэтому `localNotificationActionPerformed` на странице открывает чат, даже при холодном старте.
- Уведомления ядра идут через статический `NoticesPlugin.show()` с теми же id и тегами.

**iOS (`MeshWatch.show`)**:
- `threadIdentifier=tag`.
- Communication notices включаются флагом `MeshnetCommunicationNotices` в Info.plist, сейчас он `false`: нужна capability из портала и `App.entitlements`.
- `Withdraw` снимает уведомления по id.

## Разрешения

- **Android**:
  - `INTERNET`;
  - `BLUETOOTH_SCAN` (`neverForLocation`), `BLUETOOTH_CONNECT`, `BLUETOOTH_ADVERTISE`;
  - `FOREGROUND_SERVICE` и `FOREGROUND_SERVICE_CONNECTED_DEVICE`;
  - `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION` — по запросу, только для карты и позиции радио;
  - `VIBRATE`;
  - `SCHEDULE_EXACT_ALARM` явно удалён.
  - `POST_NOTIFICATIONS`, по всей видимости, приходит из merge-манифеста LocalNotifications (не проверено).
- **iOS**:
  - `NSBluetoothAlways/PeripheralUsageDescription`;
  - `NSLocalNetworkUsageDescription` (TCP);
  - `NSLocationWhenInUse…`;
  - `UIBackgroundModes` `bluetooth-central` и `bluetooth-peripheral`;
  - `ITSAppUsesNonExemptEncryption=false` — только WebCrypto AES/SHA-256, чтобы узнавать свои эхо в каналах.

## Сборка и подпись

- **Debug APK**: `pnpm --filter @meshnet/mobile android:apk` → `android/app/build/outputs/apk/debug/app-debug.apk`. В CI подписывается ключом из `ANDROID_DEBUG_KEYSTORE_BASE64`, чтобы сборки ставились поверх друг друга.
- **Версии Android**: `versionName` = `MESHNET_VERSION` или версия из корневого `package.json`; `versionCode` = `ANDROID_VERSION_CODE` (1…2100000000).
- **Release AAB**: `pnpm android:aab`. Ключ берётся из env `ANDROID_KEYSTORE_PATH/_PASSWORD`, `ANDROID_KEY_ALIAS/_PASSWORD` или из `android/keystore.properties` (шаблон `keystore.properties.example`, сам файл gitignored). Проверки `validatePlayRelease` и `verifyReleaseAssets` запрещают `server.url`, `cleartext`, отладку webview и mixed content, а также требуют `privacy.html`.
- **Google Play** — workflow `android-play.yml`, см. [build-release.md](build-release.md).
- **iOS / TestFlight** (всё на Mac `server.lan`):
  1. Дерево передаётся через `git -c core.autocrlf=false archive … | ssh …`, чтобы sh-скрипты сохранили LF.
  2. `BUILD_NUMBER=$(git rev-list --count HEAD)` — номер сборки должен только расти.
  3. `bash apps/mobile/scripts/ios.sh testflight`: env `~/.appstoreconnect/owlmail.env` → `apple.mjs bundle/profile/app` → `xcodebuild archive` → `-exportArchive` с загрузкой.
  4. `REVIEW=1` делает сборку доступной для App Review и внешних тестеров.

  Приложение в App Store Connect создаётся один раз вручную.

## Прочие грабли

- `CapApp-SPM/Package.swift`: pnpm сокращает имена каталогов на Windows, а на Mac нет. Поэтому `ios.sh` всегда сначала делает sync. В закоммиченном файле нет geolocation и keyboard — видимо, он устарел, на Mac перегенерируется.
- В симуляторе iOS нет BLE; сам симулятор занимает около 2 ГБ.
- realme 15T / Android 16: `com.heytap.accessory` не отвечает на GATT discovery, и десктоп упирается в таймаут. Обход — `adb shell pm disable-user --user 0 com.heytap.accessory`.
