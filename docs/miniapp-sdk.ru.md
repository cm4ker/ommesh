# Ommesh Mini-App SDK — Справочник методов

> [English](miniapp-sdk.md) · **Русский** · [Обзор SDK](../packages/miniapp-sdk/README.md) · [Интерактивный портал методов](miniapp-sdk-portal.html) · [Репозиторий мини-приложений](https://github.com/cm4ker/ommesh-miniapps)

Полное описание методов, событий, типов, манифеста, фонового воркера и CSS-переменных для разработки мини-приложений Ommesh (`@ommesh/miniapp-sdk`).

---

## 1. Точки входа и инициализация

### `window.ommeshReady` *(встраивается хостом автоматически)*

Хост Ommesh автоматически подключает встроенный мост SDK до запуска скриптов мини-приложения — можно писать однофайловые `.omapp` без сборщика.

```js
window.ommeshReady.then(async (app) => {
  console.log("Подключено радио:", app.context.self?.name);
});
```

- **Тип:** `Promise<OmmeshApp>`
- **Дополнительно:** после инициализации выставляет `window.ommesh`.
- **Таймаут:** 6000 мс (если открыть HTML вне Ommesh).

### `connect(timeoutMs?: number): Promise<OmmeshApp>`

Для TypeScript/ESM-проектов со сборщиком:

```ts
import { connect } from "@ommesh/miniapp-sdk";
const app = await connect(5000);
```

### Утилиты пакета `@ommesh/miniapp-sdk`

| Функция | Сигнатура | Назначение |
| :--- | :--- | :--- |
| `validateManifest` | `(raw: unknown) => string \| null` | Проверяет манифест v1; возвращает текст ошибки или `null`. |
| `encodeOmapp` | `(pkg: MiniAppPackage) => Uint8Array` | Валидирует и сериализует пакет в UTF-8 JSON (≤ 512 КБ). |
| `decodeOmapp` | `(input: Uint8Array \| string) => MiniAppPackage` | Парсит и валидирует `.omapp` из байт или строки. |
| `pickText` | `(text: LocalizedText \| undefined, locale: Locale) => string` | Выбирает локализованную строку (`"ru"` / `"en"`) с fallback. |
| `isDevAppId` | `(appId: number) => boolean` | Возвращает `true`, если `appId` в диапазоне `0xFF00..0xFFFF`. |

Константы: `MAX_OMAPP_BYTES = 524288` (512 КБ), `DEV_APP_ID_MIN = 0xff00`, `DEV_APP_ID_MAX = 0xffff`, `SANDBOX_CSP`.

---

## 2. `app.context` (контекст сессии)

Обновляется автоматически при смене темы, изменении экрана/клавиатуры и выдаче новых доступов к контактам.

```ts
interface MiniAppContext {
  appId: number;                                 // 0 для офлайн-утилит, 1..65535 для P2P
  self: { keyPrefix: string; name: string } | null;
  locale: "ru" | "en";
  theme: MiniAppTheme;
  radio: MiniAppRadioInfo;
  viewport?: MiniAppViewport;
  initialActivityId: string | null;              // ID события, если открыто из уведомления или хаба
  grantedPeers: MiniAppPeer[];                   // Уже разрешённые приложению контакты
}
```

### `MiniAppRadioInfo`

| Поле | Тип | Описание |
| :--- | :--- | :--- |
| `connected` | `boolean` | Подключено ли радио прямо сейчас. |
| `maxPayloadBytes` | `number` | Максимум байт полезной нагрузки (`150` в MCRS v2). |
| `supportsPeerData` | `boolean` | Поддерживает ли прошивка радио `McrsCap.PeerData` (MCRS v2). |
| `sf`, `bwHz`, `cr` | `number?` | Текущие параметры LoRa (Spreading Factor, полоса в Гц, Coding Rate 5..8). |

### `MiniAppViewport`

| Поле | Тип | Описание |
| :--- | :--- | :--- |
| `width`, `height` | `number` | Видимая область фрейма мини-приложения в CSS-пикселях. |
| `safeBottom`, `safeLeft`, `safeRight` | `number` | Безопасные отступы от системных панелей (`safeBottom` = `0`, пока открыта клавиатура). |
| `keyboardHeight` | `number` | Высота экранной клавиатуры в CSS-пикселях (`0`, если скрыта). |
| `keyboardOpen` | `boolean` | Открыта ли сейчас экранная клавиатура. |
| `mobile` | `boolean` | `true` в мобильном интерфейсе, `false` на десктопе/планшете. |

---

## 3. `app.peers` — Контакты и Peer Grants

Мини-приложение **не видит** всю адресную книгу пользователя. Контакт становится доступен только после явного выбора через `peers.pick()` либо после получения входящего пакета от этого контакта на ваш `appId`.

### `app.peers.list(): Promise<MiniAppPeer[]>`

- **Разрешение:** не требуется.
- **Возвращает:** список уже разрешённых контактов `{ keyPrefix, name, supportsPeerData }`.

### `app.peers.pick(options?: PickPeerOptions): Promise<MiniAppPeer | null>`

Открывает системный диалог выбора контакта Ommesh.

- **Разрешение:** `peerData`
- **Параметры:** `options?.requirePeerData?: boolean`
- **Возвращает:** выбранный `MiniAppPeer` или `null` при отмене. Выбранный контакт автоматически получает grant.

---

## 4. `app.transport` — Надёжный бинарный LoRa P2P (MCRS v2)

### `app.transport.send(peerPrefix, payload, options?): Promise<SendResult>`

Отправляет зашифрованную бинарную датаграмму (`TXT_TYPE_PEER_DATA`) с подтверждением доставки ACK и тегом вашего `appId`.

- **Разрешение:** `peerData` (и `manifest.appId !== 0`)
- **Параметры:**
  - `peerPrefix: string` — 12-символьный hex-префикс ключа **разрешённого** контакта.
  - `payload: Uint8Array` — от 1 до 150 байт (`MAX_PEER_DATA_LEN`).
  - `options?: { retry?: boolean }` — по умолчанию `true` (до 4 попыток, с переключением direct → flood).
- **Возвращает:** `{ packetId: string; flood: boolean; estTimeoutMs: number }`
- **Ограничения и ошибки:**
  - Ограничитель эфирного времени (rate limit): **5 пакетов подряд**, восполнение **1 токен / 1500 мс**.
  - Ошибки: `permission denied: peerData`, `peer not granted to this mini-app`, `LoRa rate limit exceeded`, `contact not found`.

### `app.transport.onPacket(cb): () => void`

Подписка на входящие пакеты вашего `appId`.

- **Буферизация:** пакеты, пришедшие до первой подписки `onPacket()` (например, пока выполняется `await app.storage.get()`), буферизуются хостом и мостом SDK и доставляются сразу после регистрации обработчика.
- **Структура `IncomingPacket`:**
  - `peerPrefix: string` — hex-префикс отправителя (в нижнем регистре)
  - `peerName: string` — имя контакта
  - `payload: Uint8Array` — бинарная полезная нагрузка
  - `timestamp: number` — Unix-время отправителя (секунды)
  - `snr: number` — SNR в дБ (шаг 0.25 дБ)
  - `hops: number | null` — число хопов при flood или `null` при прямой доставке
  - `mirrored?: boolean` — `true`, если пакет отправлен с другого устройства самого пользователя через релей телефона. **Важно:** обновляйте локальное состояние, но **не отправляйте** ответы и уведомления!

### `app.transport.onDelivery(cb): () => void`

Подписка на статусы доставки (ACK) исходящих пакетов:

- `status`: `"sent" | "retrying" | "delivered" | "unconfirmed" | "failed"`
- `packetId`, `peerPrefix`, `attempt`, `flood?`, `rttMs?`, `error?`

---

## 5. `app.storage` — Изолированное KV-хранилище

Изолировано по ключу `(radioKey, manifest.id)`, переживает перезапуски, лимит — **1 МБ** сериализованного JSON на приложение.

- **Разрешение:** `storage`

| Метод | Сигнатура | Описание |
| :--- | :--- | :--- |
| `app.storage.get` | `<T = unknown>(key: string) => Promise<T \| null>` | Читает JSON-значение или `null`. |
| `app.storage.set` | `(key: string, value: unknown) => Promise<void>` | Сохраняет JSON-значение (ошибка при превышении 1 МБ). |
| `app.storage.delete` | `(key: string) => Promise<void>` | Удаляет ключ. |
| `app.storage.list` | `() => Promise<string[]>` | Возвращает список всех ключей приложения. |

---

## 6. `app.ui` — Хаб активностей, уведомления, тема и мобильный экран

| Метод | Сигнатура | Описание |
| :--- | :--- | :--- |
| `app.ui.setActivities` | `(list: MiniAppActivity[]) => Promise<void>` | Обновляет карточки в разделе «Ждут действия» и счётчик на вкладке «Приложения» (до 64 записей). |
| `app.ui.notify` | `(opts: NotifyOptions) => Promise<void>` | Показывает уведомление (требует `notifications`; учитывает беззвучный режим и настройки колокольчика). |
| `app.ui.onThemeChange` | `(cb: (theme) => void) => () => void` | Вызывается при смене темы, скина (`lcd`/`classic`) или размера текста. CSS-переменные обновляются автоматически. |
| `app.ui.onViewportChange` | `(cb: (vp) => void) => () => void` | Вызывается при изменении размеров, ориентации или выезде/скрытии экранной клавиатуры. |
| `app.ui.onOpenActivity` | `(cb: (activityId) => void) => () => void` | Вызывается при нажатии на уведомление или карточку активности, когда приложение уже открыто. |
| `app.ui.close` | `() => void` | Закрывает экран мини-приложения. |

---

## 7. Фоновый воркер (`workerJs`)

Если пакет `PEER_DATA` приходит, когда экран мини-приложения закрыт, Ommesh запускает `pkg.workerJs` в изолированном Web Worker (лимит **2500 мс**, сеть и `importScripts` заблокированы). Пакеты обрабатываются строго последовательно.

```js
self.onPacket = function (input) {
  // input: { self, locale, packet, storage }
  return {
    storageSet: { games: updatedGames },
    storageDelete: [],
    activities: [/* MiniAppActivity[] */],
    notify: { body: "Ваш ход: e4", tag: "game:0100", peerPrefix: input.packet.peerPrefix },
    send: [/* до 2 авто-ответов: { peerPrefix, payload: number[], retry: true } */],
  };
};
```

### Фоновые уведомления при спящем WebView (`manifest.backgroundNotices`)

На Android и iOS при свёрнутом приложении нативное Rust-ядро `meshcore-core` само считывает `PEER_DATA` с радио по BLE и формирует уведомления по таблице `backgroundNotices` из манифеста (`payload[0] & opcodeMask` → `labels[opcode]`).

---

## 8. Темы, мобильная адаптация и выезд клавиатуры

Хост автоматически внедряет в `:root` CSS-токены текущей темы и мобильного окна:

- **Цвета:** `--bg`, `--panel`, `--elevated`, `--chrome`, `--text`, `--text-muted`, `--text-faint`, `--border`, `--border-strong`, `--accent`, `--accent-contrast`, `--hover`, `--selected`, `--success`, `--warning`, `--danger`, `--bubble-in`, `--bubble-out`, `--bubble-text`, `--bubble-text-muted`, `--text-scale`.
- **Отступы и клавиатура:**
  - `--safe-bottom`, `--safe-left`, `--safe-right` — учитывайте их в нижнем/боковом `padding` корневых контейнеров (`padding-bottom: calc(16px + var(--safe-bottom, 0px))`).
  - `--keyboard-height` и `:root[data-keyboard="open" | "closed"]` — сжимайте второстепенные списки при открытой клавиатуре.
  - `:root[data-mobile="1" | "0"]` — признак мобильного режима.
  - SDK автоматически сообщает хосту о фокусе в `input`/`textarea` внутри `iframe` (чтобы iOS корректно сдвигал экран над клавиатурой), прокручивает активное поле в видимую область и держит размер шрифта полей ≥ 16 px на тач-экранах, предотвращая авто-зум iOS.

---

## 9. Изоляция и безопасность

- **Iframe:** `<iframe sandbox="allow-scripts">` (непрозрачный `null` origin, без `allow-same-origin` и доступа к DOM/хранилищу хоста).
- **CSP:** `connect-src 'none'`, `frame-src 'none'`, `form-action 'none'` — никаких сетевых запросов в интернет.
- **Иконка:** `iconSvg` рисуется хостом через CSS `mask-image`, скрипты внутри SVG никогда не исполняются.
- **Экономия эфира:** пакет до **8 байт** полезной нагрузки укладывается в **1 AES-блок** (20 байт в эфире LoRa).
