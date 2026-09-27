# `crates/meshcore-core` — нативное ядро радио (Rust, uniffi)

> Справка для разработчика/агента. Снимок на 2026-09-27. Обзор — [README.md](README.md).

## Зачем

Телефон усыпляет JS страницы вскоре после ухода приложения с экрана (Android примерно через минуту, iOS ещё быстрее). BLE-линк при этом жив и радио продолжает слать кадры, поэтому всё, что должно работать фоном, живёт в нативном коде. Крейт — «сторона радио», написанная один раз для всех оболочек.

**Кто использует сейчас: только мобильные оболочки** (Android через JNI/Kotlin, iOS через XCFramework/Swift). Десктоп (`apps/desktop/src-tauri`) от крейта **не зависит**, хотя комментарии говорят «shared with iOS and the desktop». Веб-код Rust напрямую не трогает, он только передаёт конфиг через плагин `MeshRelay`.

## Модель

«No Bluetooth, no clock, no threads». Владелец (нативный код оболочки) подаёт кадры и события. Каждый вызов возвращает `Vec<Effect>`, владелец их выполняет и сам заводит запрошенные таймеры. Всё однопоточно, логика тестируется `cargo test`.

`Effect`:
- `ToRadio{frame}` — отправить кадр в радио;
- `ToClient{client,frame}` — отдать кадр клиенту;
- `Written{write}` — подтверждение, что кадр ушёл;
- `Wait{timer,millis}` — завести таймер;
- `InboxesChanged` — сохранить инбоксы;
- `Post{notice}` / `Withdraw{tag,id}` — показать / снять уведомление;
- `Log{line}`.

`Client { Page, Computer }`. `Computer` — это компьютер, которому телефон раздаёт радио по BLE (GATT-сервер телефона).

## Файлы

| Файл | Что внутри |
| --- | --- |
| `Cargo.toml` | `crate-type = ["lib","cdylib","staticlib"]` (cdylib для Android, staticlib для iOS). Зависимости: `serde`, `serde_json`, `uniffi 0.32`. Feature `bindgen` включает бинарь `uniffi-bindgen`. Release-профиль: `opt-level="s"`, LTO, **без strip**, потому что биндинги читаются из символов. |
| `uniffi.toml` | Kotlin-пакет `dev.cm4ker.meshnet.core`, `android_cleaner = true` (JVM Cleaner есть только с API 33, иначе падает release lint). Swift-модуль `MeshcoreCore`. |
| `uniffi-bindgen.rs` | `uniffi::uniffi_bindgen_main()` |
| `src/lib.rs` | `setup_scaffolding!`. Типы `Client`, `Timer {Command{flight}, Grace{generation}}`, `Inbox {client, frames}`, `Effect`. `Core { mux, watch }`: `from_radio` передаёт `PUSH_NEW_ADVERT` в `watch.heard`, `settle()` сводит эффекты и события mux (`Kept`/`Taken`) в watch. |
| `src/ffi.rs` | FFI-объект `Radio { core: Mutex<Core> }`, методы перечислены ниже. Отравленный mutex восстанавливается через `into_inner`. |
| `src/codes.rs` | Константы протокола из прошивки (`examples/companion_radio/MyMesh.cpp`), зеркало `packages/meshcore/src/protocol/codes.ts`. Свой код приложения `PUSH_MIRROR = 0xf0` несёт то, что отправил *другой* клиент. Хелперы `is_push` (≥0x80), `is_message`. |
| `src/frames.rs` | Разбор `read_message` (контакт/канал, V3, подписанные посты комнат) и NEW_ADVERT (`Heard`). Раскладка совпадает с `frames.ts`. |
| `src/mux.rs` | Одно радио на несколько клиентов, подробнее ниже. |
| `src/watch.rs` | Уведомления о сообщениях, которые спящая страница не прочитала, подробнее ниже. |

Методы `Radio`: `new(inboxes)`, `inboxes()`, `attach(client)`, `detach(client)`, `from_client(client, frame, write: Option<i64>)`, `radio_up()`, `radio_down()`, `from_radio(frame)`, `timeout(timer)`, `configure(json)`, `set_background(bool)`, `announced(tag)`. Если JSON в `configure` не разобрался, возвращается `Effect::Log`.

### `mux.rs`

Одно радио на несколько клиентов, заменяет прежние `RelayMux.java` / `MeshRelayMux.swift`.

- Прошивка отвечает на одну команду за раз, и ответ не говорит, к какой команде он относится. Поэтому команды идут через очередь, а ответ достаётся тому, чья команда сейчас в полёте.
- Push-кадры рассылаются всем клиентам.
- Очередь сообщений радио mux вычитывает сам, в инбоксы по клиентам (`INBOX_LIMIT = 500`).
- Тексты, отправленные одним клиентом, зеркалятся остальным (`mirror()`).
- Таймауты по командам (`patience()`): REBOOT 1,5 с, FACTORY_RESET 3 с, GET_CONTACTS 20 с, остальные 8 с.
- Потоковый ответ только один — список контактов (`is_complete()`).

### `watch.rs`

- `GRACE_MS = 5000`.
- Типы: `WatchConfig` (JSON от страницы), `Words` (шаблоны i18n и формы множественного числа), `Notice`, `ChatLevel`, `NodeLevel`.
- `notice_id` — FNV-1a по UTF-16, как `noticeId` на странице. Теги `c:<conv>` / `n:<key>` (`ALL_CHATS = "c:"`), поэтому уведомление страницы заменяет уведомление ядра.

## Сборка и интеграция

- **Android** (`apps/mobile/android/app/build.gradle`):
  - `buildRustCore`: `cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 --platform 24 build --release --locked`.
  - `bindRustCore`: `uniffi-bindgen generate --library …/arm64-v8a/libmeshcore_core.so --language kotlin`.
  - `preBuild` зависит от `bindRustCore`. Результат лежит в `build/rust/{jniLibs,kotlin}`. Нужны JNA и `cargo install cargo-ndk`.
  - Потребитель — `MeshRelay.java`.
- **iOS** (`apps/mobile/scripts/core-ios.sh`, вызывается из `ios.sh`):
  - cargo для `aarch64-apple-ios`, `aarch64-apple-ios-sim`, `x86_64-apple-ios`;
  - генерация Swift-биндингов;
  - `lipo` склеивает две библиотеки симулятора, `xcodebuild -create-xcframework` собирает `ios/MeshcoreCore/build/MeshcoreCoreFFI.xcframework`;
  - подключение как локальный SPM-пакет `ios/MeshcoreCore/Package.swift`, потребитель — `MeshRelay.swift`.
- **Веб**: `apps/web/src/lib/coreWatch.ts` собирает `WatchConfig` (`coreConfig(state)`) и `words()` (там же Android-строки для `Words.java`). Отправка — `configureCore(json, sound)` в `lib/relay.ts` через `MeshRelay.configure`, `coreAnnounced(tag)` через `announced`.
- Результаты сборки не коммитятся (`build/`).
- Тесты: `cargo test --manifest-path crates/meshcore-core/Cargo.toml` (гоняется в CI).

## Если меняешь протокол

Коды и раскладка кадров продублированы в трёх местах, при изменении протокола их нужно держать синхронными:

- `packages/meshcore/src/protocol/codes.ts` и `frames.ts`;
- `crates/meshcore-core/src/codes.rs` и `frames.rs`.

Формула `notice_id` в `watch.rs` должна совпадать с `noticeId` на странице, иначе уведомление страницы не заменит уведомление ядра.
