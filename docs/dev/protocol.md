# `packages/meshcore` — протокол MeshCore Companion и сессия

> Справка для разработчика/агента. Снимок на 2026-09-27. Обзор — [README.md](README.md).

## Факты о пакете

- `@meshnet/meshcore`, ESM, **без runtime-зависимостей**. Использует только глобальные `TextEncoder`/`TextDecoder` и WebCrypto (`crypto.subtle`, `getRandomValues`, `randomUUID`). Платформенного кода нет: транспорты передаёт оболочка.
- **Потребляется через `dist/`.** Изменение не видно в `apps/web` без `pnpm meshcore` (корневые `pretest`/`pretypecheck`/`preweb` делают это сами).
- Скрипты: `build` (`tsc -p tsconfig.build.json`, без тестов), `typecheck`, `test` (`node --import tsx --test "src/**/*.test.ts"`).
- Из-за строгих флагов (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`, NodeNext) в коде есть `!` после индексного чтения и суффиксы `.js` в импортах.
- Эталон протокола — прошивка `examples/companion_radio/MyMesh.cpp`, **v1.17.1, protocol version 13**. В `codes.ts` она названа «единственной спецификацией, которая не может устареть», а вики отстаёт.
- Клиент объявляет `APP_PROTOCOL_VERSION = 3`: в v3 кадры сообщений получили байт SNR, более высокая версия ничего не меняет.

## Публичный API (`src/index.ts`)

| Модуль | Экспорт |
| --- | --- |
| `protocol/codes` | `Cmd`, `Resp`, `Push`, `ErrCode`, `TxtType`, `AdvType`, `ReqType`, `AclRole`, `BLE`, лимиты… |
| `protocol/bytes` | `ByteReader`, `ByteWriter`, hex/utf8-хелперы |
| `protocol/commands` | namespace `commands` (билдеры кадров) + типы `ContactRecordInput`, `RadioParams`, `OtherParams` |
| `protocol/frames` | `decodeFrame`, union'ы кадров, парсеры `read*` |
| `protocol/lpp` | `decodeLpp`, `LppReading`, `lppTypeName`, `LPP_CHANNEL_SELF` |
| `protocol/packet` | `parseRawPacket`, `RouteType`, `PayloadType`, `RawPacket` |
| `protocol/group` | `channelHash`, `groupPayload`, `groupTextPayload`, `heardGroupTextPayload` |
| `protocol/airtime` | `loraAirtimeMs`, `traceBudgetMs` |
| `framing` | `frameForStream`, `StreamFrameDecoder` |
| `transport` | `Transport`, `TransportKind`, `BaseTransport` |
| `client` | `MeshCoreClient`, `MeshCoreError`, `TransportClosedError`, `TimeoutError` |
| `session` | `MeshSession`, типы состояния, `NoReplyError`, `ResyncError`, `NodeCommandError`, `RESYNC_STEPS` |

Слои: `Transport` (байты) → `MeshCoreClient` (типизированные запросы и ответы) → `MeshSession` (состояние UI и логика).

## Файлы

| Файл | Строк | Что делает |
| --- | --- | --- |
| `framing.ts` | 88 | Фрейминг потока serial/TCP |
| `transport.ts` | 83 | Контракт транспорта |
| `client.ts` | 521 | Очередь команд по одной и обёртки для всех команд |
| `session.ts` | **3284** | Всё состояние приложения, подробнее ниже |
| `protocol/codes.ts` | 289 | Все числовые константы |
| `protocol/bytes.ts` | 238 | `ByteReader`/`ByteWriter`, подробнее ниже |
| `protocol/commands.ts` | 454 | Чистые билдеры кадров (раскладка — `handleCmdFrame` прошивки) |
| `protocol/frames.ts` | 777 | Декодер ответов и push-кадров, парсеры тел ответов удалённых узлов |
| `protocol/packet.ts` | 79 | Разбор эфирного пакета из `LogRxData` |
| `protocol/group.ts` | 93 | Шифротекст канала для сопоставления эхо |
| `protocol/lpp.ts` | 217 | Cayenne LPP |
| `protocol/airtime.ts` | 36 | Время в эфире LoRa и бюджет трассировки |

`bytes.ts`:
- `ByteReader` читает little-endian `u8…i32`; `take(n)` **копирует**, поэтому транспорт может переиспользовать буферы. Короткий кадр → `RangeError`.
- `ByteWriter.fixedString` обрезает строку и дополняет её NUL.
- `pathByteLength(pathLen) = (pathLen & 63) * ((pathLen >> 6) + 1)`.

Тесты: `framing`, `client`, `session` (~95 тестов, 1934 строки), `protocol/{airtime,commands,frames,group,lpp,nodes,packet}`. Файла `nodes.ts` нет: `nodes.test.ts` проверяет билдеры и парсеры запросов к узлам.

## Фрейминг

- **Serial / TCP**:
  - приложение → радио: `'<'` (0x3c), u16 LE длина, payload;
  - радио → приложение: `'>'` (0x3e), та же раскладка;
  - `MAX_FRAME_SIZE = 176`, `SERIAL_BAUD = 115200`.
- **`StreamFrameDecoder.push(chunk, now)`** — автомат `idle → len1 → len2 → body`, повторяет `checkRecvFrame` прошивки:
  - байты до `'>'` выбрасываются (загрузочный баннер, оборванный кадр), `'<'` началом кадра не считается;
  - длина 0 или больше 176 значит, что это маркер внутри лога, и начинается ресинхронизация;
  - есть обработка наложенного заголовка;
  - частичный кадр, по которому нет байтов 1 с (`PARTIAL_FRAME_TIMEOUT_MS`), сбрасывается: целый кадр на 115200 идёт меньше 16 мс.
- **BLE** — фрейминга нет: одна запись или notify — один кадр. Nordic UART: service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`, `rx` (запись) `…0002…`, `tx` (notify) `…0003…`, префикс имени `MeshCore-`.

## Коды (`codes.ts`)

Лимиты:
- `PUB_KEY_SIZE = 32`; `PUB_KEY_PREFIX_SIZE = 6` — в кадрах контакт указывается 6-байтным префиксом ключа;
- `MAX_PATH_SIZE = 64`, `OUT_PATH_UNKNOWN = 0xff`;
- `MAX_TEXT_LEN = 160` (10 блоков шифра); в канале сюда входит префикс `name: `;
- `MAX_PASSWORD_LEN = 15`.

**`Cmd`** (приложение → радио):

| Группа | Команды |
| --- | --- |
| Сессия и время | AppStart 1, GetDeviceTime 5, SetDeviceTime 6, DeviceQuery 22 |
| Сообщения | SendTxtMsg 2, SendChannelTxtMsg 3, SyncNextMessage 10 |
| Контакты | GetContacts 4, AddUpdateContact 9, ResetPath 13, RemoveContact 15, Share/Export/ImportContact 16–18, GetContactByKey 30, GetAdvertPath 42 |
| Своё радио | SendSelfAdvert 7, SetAdvertName 8, SetRadioParams 11, SetRadioTxPower 12, SetAdvertLatLon 14, Reboot 19, GetBattAndStorage 20, SetTuningParams 21, Export/ImportPrivateKey 23/24, SetDevicePin 37, SetOtherParams 38, Get/SetCustomVar 40/41, GetTuningParams 43, FactoryReset 51 |
| Каналы | GetChannel 31, SetChannel 32 |
| Удалённые узлы | SendLogin 26, SendStatusReq 27, HasConnection 28, Logout 29, SendTelemetryReq 39, SendBinaryReq 50, SendAnonReq 57 |
| Маршруты и диагностика | SendTracePath 36, SendPathDiscoveryReq 52, SendControlData 55, GetStats 56 |
| Прочее | SendRawData 25, Sign* 33–35, SetFloodScopeKey 54, Set/GetAutoAddConfig 58/59, GetAllowedRepeatFreq 60, SetPathHashMode 61, SendChannelData 62, Set/GetDefaultFloodScope 63/64, SendRawPacket 65 |

**`Resp`** (всегда < 0x80):
- Ok 0, Err 1;
- ContactsStart 2 / Contact 3 / EndOfContacts 4;
- SelfInfo 5, Sent 6, CurrTime 9, NoMoreMessages 10, BattAndStorage 12, DeviceInfo 13;
- ContactMsgRecv 7 / V3 16, ChannelMsgRecv 8 / V3 17;
- ChannelInfo 18, CustomVars 21, AdvertPath 22, TuningParams 23, Stats 24, AutoAddConfig 25, ChannelDataRecv 27, DefaultFloodScope 28.

**`Push`** (≥ 0x80, `isPushCode`):
- Advert 0x80, PathUpdated 0x81, SendConfirmed 0x82, MsgWaiting 0x83, RawData 0x84;
- LoginSuccess 0x85 / LoginFail 0x86, StatusResponse 0x87;
- LogRxData 0x88, TraceData 0x89, NewAdvert 0x8a;
- TelemetryResponse 0x8b, BinaryResponse 0x8c, PathDiscoveryResponse 0x8d;
- ControlData 0x8e, ContactDeleted 0x8f, ContactsFull 0x90;
- **`Mirror 0xf0` — не код прошивки.** Его шлёт нативный relay телефона ([rust-core.md](rust-core.md), `mux.rs`), когда второй клиент того же радио отправил текст. Раскладка: `0xf0, cmdLen, cmd, answer`.

Прочие перечисления:
- `ErrCode`: UnsupportedCmd 1, NotFound 2, TableFull 3, BadState 4, FileIoError 5, IllegalArg 6.
- `AdvType`: None/Chat/Repeater/Room/Sensor = 0–4. `TxtType`: Plain 0, CliData 1, SignedPlain 2.
- `ReqType` (первый байт binary-запроса): GetStatus 1, KeepAlive 2, GetTelemetryData 3, GetAvgMinMax 4, GetAccessList 5, GetNeighbours 6, GetOwnerInfo 7 (firmware level ≥ 2).
- `AclRole` (младшие 2 бита): Guest 0, ReadOnly 1, ReadWrite 2, Admin 3.
- `ContactFlag.Favourite = 0x01`; биты прав на телеметрию сдвинуты на 1 вверх.
- Биты `AutoAdd`: OverwriteOldest 0x01, Chat 0x02, Repeater 0x04, Room 0x08, Sensor 0x10.

## Кодек

**`commands.ts`**:
- `assertTextFits` **бросает исключение**, а не отдаёт радио молча обрезать текст.
- `sendLogin` отказывает при пароле длиннее 15 байт.
- `setChannel` требует 16-байтный секрет (только 128-битные ключи).
- `sendChannelTextMessage(idx, text, {senderName})`: `senderName` нужен только для резерва `len+2` байт, префикс ставит прошивка.
- `neighboursRequest` добавляет 4 случайных байта, чтобы два одинаковых запроса не выглядели одним пакетом.

**`frames.ts`**:
- `decodeFrame` **никогда не бросает**: неизвестный код или слишком короткий кадр → `{kind:"unknown", code, raw}` («новая прошивка — не ошибка»).
- SNR — i8 в четвертях дБ.
- `pathLen 0xff` означает direct (`null`), иначе хопов `pathLen & 63`.
- `DeviceInfo.maxContacts` — сырой байт ×2; `repeatEnabled` появляется с v9, `pathHashMode` с v10.
- `StatusResponse` читают через `readNodeStats(raw, "repeater"|"room")`: хвост у репитера и комнаты разный и неразличим по байтам, решает тип контакта.
- `readAccessList`, `readAvgMinMax`, LPP останавливаются на нулях, потому что ответы расшифровываются целыми 16-байтными блоками и в хвосте остаются нули.

**`packet.ts`**:
- В заголовке: биты 0–1 — `RouteType` (TransportFlood/Flood/Direct/TransportDirect), 2–5 — `PayloadType` (Req, Response, TxtMsg, Ack, Advert, GroupText, GroupData, AnonReq, Path, Trace, Multipart, Control, RawCustom 15), 6–7 — версия.
- В `path_len` старшие 2 бита — размер хеша минус 1 (прошивка v1.11+), младшие 6 — число хешей.

**`group.ts`** воспроизводит шифрование канала прошивки, **только чтобы узнавать эхо и копии** (шифрует само радио):
- AES-128-ECB, эмулируется через AES-CBC с нулевым IV поблочно;
- MAC — HMAC-SHA256, обрезанный до 2 байт;
- хеш канала — первый байт SHA-256 секрета;
- nonce нет, поэтому одинаковое сообщение всегда даёт одинаковые байты — на этом и держится сопоставление.

**`lpp.ts`**:
- Значения big-endian.
- `channel=0, type=0` — паддинг, на нём разбор заканчивается.
- Напряжение (0x74) и ток (0x75) знаковые, как в CayenneLPP 1.6.1.
- `LPP_CHANNEL_SELF = 1`.

**`airtime.ts`**:
- `loraAirtimeMs` — формула Semtech с преамбулой MeshCore: 32 символа при SF ≤ 8, иначе 16.
- `traceBudgetMs = 1500 + (hops+1)·(3·airtime + 80)`.

## `MeshCoreClient` (`client.ts`)

Прошивка обрабатывает одну команду за раз и отвечает по порядку, push-кадры приходят в любой момент.

- FIFO-очередь и один `inFlight`. Таймер (по умолчанию 8 с) взводится **после** того, как `transport.send` зарезолвился.
- Любой не-push ответ относится к `inFlight`. Предикат `Completion` возвращает `"more"` или `"done"`: `getContacts` возвращает `"more"` до `EndOfContacts`, таймер перевзводится на каждом кадре.
- `err` → `MeshCoreError(code, name)`.
- Неизвестный код ответа отклоняет `inFlight`; неизвестный push игнорируется; ответ без `inFlight` (опоздал после таймаута) отбрасывается.
- Fire-and-forget: `reboot` (1,5 с), `factoryReset` (3 с), телеметрия своего радио (0,3 с) — их таймаут означает успех.
- При закрытии транспорта: `TransportClosedError` для `inFlight` и очереди, затем `onClose`.
- `getContacts(since)` — таймаут 20 с; `syncNextMessage()` возвращает `null` на `NoMoreMessages`.

## `MeshSession` (`session.ts`) — стор приложения

**Состояние:**
- `getState()` отдаёт иммутабельный `SessionState`, `set(patch)` уведомляет подписчиков `subscribe`.
- Сохраняемые ключи: `contacts`, `contactsCursor`, `removed`, `channels`, `messages`, `unread`, `logins`, `statusHistory`, `batteryHistory`, `routing`. Их изменение → **debounce 400 мс** → `SessionStorage.save(radioKeyHex, PersistedState)`.
- Сохранения идут цепочкой (`saveChain`); `flush()` сохраняет строго и бросает при ошибке.
- История, которая не загрузилась (`unreadHistory`), **никогда не перезаписывается**.

**События:**
- `onReceived` — только сообщения из очереди радио, не восстановленная история;
- `onDiscovered` — впервые увиденный узел (`NewAdvert`);
- `onHeard` — каждый `LogRxData`, в состояние не попадает;
- лог — `state.log`, до 400 записей.

**`connect(transport, onReady)`:**
1. Старый клиент отключается, отложенное сохранение сбрасывается.
2. История того же радио откладывается в `held`: WebView на iOS может потерять БД в фоне, и без этого чаты опустели бы.
3. `status:"connecting"`, `connectStep:"hello"`.
4. `deviceQuery(3)`, затем `appStart(appName)` (в вебе `appName = "Ommesh"`).
5. `connectStep:"history"`, восстановление истории (`restored()` мигрирует старые сохранения).
6. `syncClock`: время радио выставляется, если оно отстаёт больше чем на 30 с; назад радио часы не переводит.
7. **`status:"ready"`, `onReady()`.** Запускаются sweep маршрутов (30 с) и sweep повторов (5 с), `resumeRetryPlans`.
8. `syncMessages()` → `flushQueue()` → `refreshContacts()` → `refreshChannels()` → `readAutoAdd` → `refreshBattery`.

`ready` ставится раньше чтения контактов, потому что BLE отдаёт кадр раз в ≥ 60 мс: 100 контактов — 7–10 с, 40 слотов каналов — ещё ~8 с.

Другие точки входа:
- `resume(self, device)` показывает сохранённые чаты до того, как появился линк.
- `resync(onStep)` проходит `RESYNC_STEPS` (device, self, clock, contacts, channels, autoAdd, messages, battery) и бросает `ResyncError(step)` на первом сбое.

**Синхронизация сообщений:**
- `syncMessages` крутит `syncNextMessage` до `null`; повторный вызов во время синхронизации ставит `syncQueued`.
- На **serial** `TimeoutError` повторяется до 2 раз с паузой 1 с, чтобы декодер успел выбросить оборванный кадр.
- `MsgWaiting` запускает синхронизацию.
- CliData уходит в консоль.
- Сообщение от отправителя не из контактов попадает под `p:<prefix>`, потом `rebindOrphans()` его перепривязывает.
- Дубли личных сообщений (тот же timestamp, отправитель и текст) отбрасываются.
- Подписанный пост комнаты называется по подписанту.

**Контакты:**
- `refreshContacts` — инкрементально от `contactsCursor` (lastMod).
- Если `total` радио меньше числа сохранённых, запускается `reconcileContacts` (полная выборка), пропавшие переходят в `removed` (хранится 90 дней).
- Узлы из `NewAdvert`, которых радио не сохранило (`unsaved`), отбрасываются при чтении истории из хранилища, если их не слышно дольше `SessionOptions.unsavedKeepMs(radioKey)`; `null` (и отсутствие опции) хранит всех. Веб отдаёт срок правила уборки (`unsavedKeepMs` в `lib/tidy.ts`): уборка выключена — хранятся бессрочно.
- `NewAdvert` приходит только для узлов, которые радио *не* сохранило; сохранённые приходят обычным `Advert`.
- `ContactDeleted` значит, что радио переполнено и перезаписало самый старый контакт.

**Исходящие** (подробно — [web-core.md](web-core.md#отправка-сообщения)):
- Статусы: `queued | sending | sent | delivered | unheard | unconfirmed | failed`.
- DM:
  - ждёт ack `max(estTimeout, 4000)·1.5`, иначе `unconfirmed` и автоповторы;
  - `DIRECT_LADDER_MS = [0, 0, 45s, 120s, 300s, 720s]` ±20%, вторая попытка сразу и флудом;
  - `SendConfirmed` засчитывается и по старым `pastAckTags`.
- Канал:
  - `watchEchoes` заранее считает hex payload, затем `sent`;
  - если за 20 с нет эхо от репитера, статус `unheard`;
  - `RETRY_LADDER_MS = [0, 45s, 120s, 300s, 720s]`;
  - при повторе нужен **свежий timestamp**: репитеры отбрасывают пакет, который уже пересылали. Повтор DM timestamp сохраняет.
- Длинные DM: после 4-й попытки прошивка прячет номер попытки в 2 байта после текста. Тексту длиннее 158 байт места не хватает, и `attempt & 3`.
- Эхо: flood-пакеты GroupText/TxtMsg хранятся 30 с (не больше 64); канал сопоставляется по точному hex payload.

**Маршруты:**
- Радио хранит выученный маршрут вечно, поэтому сессия сама его старит: `RoutingSettings.resetAfterMin` плюс `RoutePolicy {flood, resetAfterMin, manual}` на контакт, `ResetPath` для устаревших.
- `setRoute` пишет ручной маршрут через `AddUpdateContact`, ручной маршрут не стареет.
- Discovery маршрут не сохраняет, поэтому сессия пишет найденный out-path сама, если flood не закреплён.

**Удалённые узлы** (репитер, комната, сенсор):
- Радио держит только один ожидающий удалённый запрос, поэтому сессия ставит их в очередь `remoteQueue`, видимую как `state.remote`.
- Запросы: `login`, `requestStatus`, `requestTelemetry`, `discoverPath`, `requestNeighbours`/`AccessList`/`OwnerInfo`/`Series` (binary, сопоставляются `sent.ackTag == binaryResponse.tag`), `runCli`.
- Ожидание — `clamp(6s, est·1.25 + 1.5s + extra, 60s)`. Если по маршруту тишина, маршрут сбрасывается и запрос уходит флудом ещё раз, **кроме CLI** (`floodOnSilence:false`, команда не должна выполниться дважды).
- У CLI тег `"XX|cmd"`; поздний ответ всё равно попадает в свою запись консоли, пароли в ответах маскируются.
- Комната отвечает `adminFlag 2` даже без прав, роль берётся из `permissions & 3`.

**Диагностика:**
- `traceRoute(hashes)` — размер хеша 1/2/4 байта, ожидание `min(оценка радио, traceBudgetMs)`.
- `discoverRepeaters(listenMs)` — ControlData NodeDiscoverReq.
- `coreStats`, `radioStats`, `customVars`.

## Контракт транспорта (`transport.ts`)

```ts
type TransportKind = "ble" | "serial" | "tcp";
interface Transport {
  readonly kind: TransportKind; readonly label: string;
  send(frame: Uint8Array): Promise<void>;               // один «голый» кадр
  onFrame(l: (frame: Uint8Array) => void): () => void;   // целые декодированные кадры
  onClose(l: (reason: Error | null) => void): () => void;
  close(): Promise<void>;
}
```

`BaseTransport` — абстрактный класс. Подкласс реализует `send` и `protected shutdown()` и вызывает `emitFrame`/`emitClose`.
- `emitClose` срабатывает один раз.
- `close()` = `shutdown()` + `emitClose(null)`.
- Исключения слушателей перехватываются.
- **Serial и TCP обязаны сами применять `frameForStream` и `StreamFrameDecoder`**, BLE передаёт кадры как есть.

## Тесты

- `client.test.ts` — `FakeRadio extends BaseTransport`: скрипт «код команды → кадры ответа».
- `session.test.ts` — `ScriptedRadio`, полноценная фейковая прошивка (`v1.17.1`, maxContacts 100, 2 канала, контакт «Bob»), плюс `MemoryStorage` и хелперы `contactFrame`, `dmFrame`, `channelFrame`, `tick`.
- Запуск: `pnpm --filter @meshnet/meshcore test`.

## Версии прошивки, которые встречаются в коде

| Что | С какой версии |
| --- | --- |
| Размер хеша в `path_len` | v1.11 |
| AutoAdd config (до 1.10 → `null`) | 1.10 |
| `SetRadioParams.repeat`, `DeviceInfo.repeatEnabled` | 9 |
| `pathHashMode` | 10 |
| `multiAcks` в SelfInfo | 7 |
| Режимы телеметрии | 5 |
| `GetOwnerInfo` | firmware level ≥ 2 |
