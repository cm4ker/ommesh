# `apps/web` — UI: экраны, навигация, карта, инструменты, темы, i18n

> Справка для разработчика/агента. Снимок на 2026-09-27. Обзор — [README.md](README.md). Ядро — [web-core.md](web-core.md).

Роутера нет — навигация своя (`lib/nav.ts`, `lib/back.ts`). CSS-фреймворка нет — один `styles.css` на ~6450 строк на CSS-переменных темы. Граница «десктоп / телефон» — 840px (`lib/layout.ts` `useWide()`).

## Карта экранов

```
App (App.tsx)  — key={language}, при смене языка перерисовывается всё
├─ ConnectView (connect/ConnectView.tsx)            экран до подключения
│   ├─ RadioCard (connect/RadioCard.tsx)            текущее/последнее радио: Connect, прогресс, PIN, ошибка
│   ├─ ConnectorPanel (connect/ConnectorPanel.tsx)  вкладка на транспорт: найденные устройства, адреса
│   ├─ parts.tsx                                    nameOf, DeviceIcon, rowLine, cardLine, SignalBars
│   └─ PrivacyButton (Privacy.tsx), UpdateButton (Updates.tsx)
├─ Workspace (Workspace.tsx) → useWide() ? <Desktop/> : <Phone/>  + MenuHost, CleanUpHost, ToastHost
│   ├─ «chats»  корень ChatList
│   │    chat → ChatView + Composer (+ MessageDetails)
│   │    message → MessageView (Sheet на телефоне, панель на десктопе)
│   │    channel → ChannelView (+ ChatNotices);  profile → Profile;  node → NodePageView
│   │    NewChat (sheet, событие NEW_CHAT_EVENT)
│   ├─ «mesh»   телефон: MeshPhone (Mesh.tsx) — карта + выезжающий список (peek/half/full) + ToolPanel
│   │           десктоп: MeshList в pane, MeshMap в main, panel = Profile | ToolPanel | GroupPanel
│   │    MeshMap → lazy MapView (Leaflet)
│   │    node → NodePageView (node/NodePage.tsx): neighbours | history | settings | access | console
│   │    tools (tools/ToolPanel.tsx): los→LosView, route→RouteSheet, span→SpanSheet,
│   │                                 neighbours→NeighboursSheet, hears→WhoHears
│   └─ «radio»  корень RadioHome
│        RadioPageView (RadioPages.tsx): name, frequency, advanced, notifications, sound, messages,
│          appearance, connection, power, about, privacy — всё в RadioPages.tsx;
│          readings → NodeReadings/OwnReadings + Readings;  contacts/removed → ContactsPages;
│          air → AirView;  log → LogView
├─ UpdatesDialog (Updates.tsx)
└─ NoticeBanner → NoticeCard
```

Экраны переключаются в одном месте — `ScreenView` в `Workspace.tsx`, по `Screen.kind`.

## Навигация

### Модель (`lib/nav.ts`)

- `Section = "chats"|"mesh"|"radio"`.
- `Screen` — одно из `chat{conversation}`, `message{conversation,id}`, `channel{index}`, `profile{key}`, `node{key,page}`, `radio{page}`.
- `NodePage = neighbours|history|settings|access|console`; `RadioPage` — 16 страниц.
- `Nav = {section, stacks: Record<Section, Screen[]>, meshFocus}`. Хранится в `meshnet.nav`, `restore()` мигрирует два старых формата.

Мутаторы:
- `goSection(s, reset)` — повторный тап по вкладке сбрасывает раздел к корню;
- `push` — одновременно открыт только один `message`;
- `back`, `setStack`, `openConversation`;
- `openProfile(key, inMesh)` — из «Радио», уведомления и палитры открывается в Mesh;
- `openChannel`, `openMessage`;
- `openNodePage` — заменяет соседнюю страницу узла (на десктопе это вкладки);
- `openRadioPage` — заменяет весь стек «Радио»;
- `showOnMap`, `focusOnMap`.

Чтение: `useNav()`, `topOf`, `shownConversation(nav, wide)`.

### Телефон (`Phone` в `Workspace.tsx`)

- Смонтированы верх стека и экран под ним (`layers.slice(-2)`).
- Анимация сдвига и iOS-свайп от края (`useEdgeSwipe`: зона 24px, срабатывает на 1/3 ширины, `SLIDE_MS=180`, только transform).
- В чате таббар скрыт, вместо него Composer.
- `MeshPhone`, открытый один раз, остаётся смонтированным, поэтому карта не теряет тайлы и позицию.

### Десктоп (`Desktop`)

- rail + `.pane` (список) + `.content` + `.panel`, раскладку выбирает `layout(nav)`.
- В разделе «Радио» `RADIO_PARENTS` (`removed→contacts`, `sound→notifications`) подсвечивает родителя и даёт кнопку Back.

### Back (`lib/back.ts`) — по шагу за нажатие

1. Закрывается верхний оверлей (`openLayer`/`useBackLayer`: диалоги, sheet'ы, меню, палитра, инструмент, список карты на полную высоту).
2. Иначе pop стека раздела.
3. Иначе сбрасывается `meshFocus`.
4. Иначе Mesh или Radio → Chats.
5. На голом списке чатов `goBack()` возвращает `false`, и приложение выходит.

Android вызывает `goBack` напрямую. В браузере и Tauri используется guard-запись history (`pushState({meshnet:"back"})` + `popstate`).

### Горячие клавиши (`useDesktopKeys`)

Не срабатывают при открытых `dialog[open]`, `.sheet-layer`, `.palette-layer`, `.popover`.

| Клавиши | Действие |
| --- | --- |
| Ctrl/Cmd+K | Палитра |
| Alt+1–3 (в Tauri Ctrl+1–3) | Раздел |
| Ctrl+N (Tauri) | Новый чат |
| Ctrl+F | Поиск в чате; повторно — поиск по списку |
| Ctrl+I | Инфо-панель |
| Alt+↑/↓ | Предыдущий / следующий чат |
| Esc | Закрыть экран узла, инструмент или панель |

- `Palette.tsx` ищет по чатам, узлам, всем страницам `RADIO_TITLES` и командам (новый чат, advert zero-hop/flood, получить контакты, отключиться).
- Бейджи на вкладках: непрочитанные на Chats, точка на Mesh (у своего узла низкий заряд, `useMeshAttention`), offline-точка на Radio. Полоса `Offline` предлагает reconnect, «попробовать сейчас» и PIN.

## Карта и гео

### `MapView.tsx` (Leaflet 1.9.4, грузится лениво из `Mesh.tsx`)

- `CachedTileLayer` рисует тайл на canvas из `tileBlob()`. В тёмной теме пиксели затемняются **один раз** (`darkenPixels`), а не CSS-фильтром на каждом кадре зума.
- Узлы рисуются на **одном canvas** (`NodeCanvas`, `lib/nodeCanvas.ts`), а не DOM-маркерами: сотни маркеров — это сотни слоёв композитора.
  - Canvas больше экрана на 1/3, не больше ~24 МБ.
  - Во время зума масштабируется, перерисовывается по окончании движения.
  - Тапы определяет `hit()`.
- Узлы ближе 25 м (`SAME_SPOT_M`) показываются списком, а не приближением.
- Перетаскивание ручки маршрута ловится в радиусе 36px (`SNAP_PX`).
- Группировка хранится в `meshnet.map.grouping`.

### Тайлы и рельеф

- **`lib/tiles.ts`** — OSM:
  - кеш в IDB `meshnet-tiles`, до 4000 тайлов (~80 МБ), чистка на каждой 100-й записи до 90%;
  - перезапрос через 30 дней, офлайн отдаётся устаревший тайл;
  - **без предзагрузки** — OSM policy запрещает массовое скачивание;
  - User-Agent приложения — требование той же policy.
- **`lib/elevation.ts`** — Terrarium (Mapzen/AWS): `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`.
  - z12 (~20 м/px), высота = `R*256+G+B/256-32768`;
  - кешируется тем же `tileBlob`, так что LOS работает офлайн; декодированные тайлы в LRU на 48;
  - `profileBetween(a,b)` — 64–400 точек;
  - зданий и деревьев в модели нет.

### Прямая видимость (`lib/los.ts`)

- Кривизна Земли с k=4/3.
- Зона Френеля: `17.32·√(d1·d2/(f_GHz·D))`.
- Точки ближе 250 м к антенне игнорируются.
- Вердикт: `clear` при запасе ≥ 0,6 зоны Френеля, `grazed` при ≥ 0, иначе `blocked`.
- Knife-edge — аппроксимация Lee (ITU-R P.526).
- Бюджет линка: FSPL против `-174 + 10log(BW) + NF6 + snrLimit(SF)`.

### Прочие гео-модули

| Файл | Что делает |
| --- | --- |
| `geo.ts` | `hasPosition` (0,0 = нет позиции), haversine, азимут, `freshness` (у репитеров «часы» длиннее) |
| `darkTile.ts` | Повторяет CSS-цепочку invert/hue-rotate/… попиксельно |
| `cluster.ts` | Жадная кластеризация; пересчёт на зум и данные, не на pan |
| `mapOverlay.ts` | `MapOverlay{lines,pins,numbers,handles,pulse}` и билдеры `route/edit/los/hears/neighbours/span/discoveryOverlay` |
| `legVerdicts.ts` | Кеш вердиктов рельефа по участкам (общий у `RouteSheet` и карты) |

## Инструменты сети

- `lib/meshTool.ts` — один активный `MeshTool` в памяти: `los`, `route`, `span`, `neighbours`, `hears`. Поля `returnTo`/`prev` возвращают туда, откуда инструмент открыли.
- `lib/toolActions.ts` — точки входа. Каждая переключает на Mesh:
  - `openRoute`, `openSpan`, `openLineOfSight`/`lineOfSightTo`;
  - `dropOnRoute`/`tapInRoute`/`cancelRouteEdit`;
  - `openNeighbours*`, `whoHearsMe`;
  - `closeTool`, `closeAllTools`.
- `components/tools/`:

| Файл | Что делает |
| --- | --- |
| `ToolPanel.tsx` | Диспетчер: содержимое sheet на телефоне, `.panel` на десктопе |
| `RouteSheet.tsx` | Маршрут, последняя проверка и одна кнопка. Проверка — 5 трассировок (`lib/ping.ts`); при тишине ищет обрыв и обход через `linkGraph`. Здесь же `QualityChip` и `RouteLink`. |
| `SpanSheet.tsx` | Два репитера, проверка в обе стороны |
| `LosView.tsx` | Профиль рельефа, зона Френеля, высота антенны на узел |
| `NeighboursSheet.tsx` | Соседи репитера, сильные первыми; прошивка хранит ограниченное число соседей |
| `WhoHears.tsx` | Кто слышит меня: один zero-hop запрос, слушает 10 с (`lib/hears.ts`). Репитер отвечает не больше 4 раз за 2 мин, поэтому попытки считаются (`asksLeft`). |

- Библиотеки инструментов:

| Файл | Что делает |
| --- | --- |
| `neighbours.ts` | Строки соседей; `STALE_S` = 1 день (такой сосед рисуется бледным), страница по 10 |
| `neighbourFetch.ts` | Карта вытягивает все страницы: половина списка выглядела бы полной |
| `linkGraph.ts` | Чистая книга «кто кого слышит» из flood-путей, трассировок, соседей и маршрутов; хранится 7 дней |
| `links.ts` | Её хранение на радио: `linkBook`, `noteTrace`, `noteBreak`, `noteHeardUs` |

### Удалённое управление (`components/node/`)

- `NodePageView` без входа показывает «войдите сначала». `settings`, `access`, `console` — только для админа.
- Страницы по типу узла (`Profile.nodePages(type)`):
  - репитер: neighbours, settings, access, console;
  - комната: settings, access, console;
  - сенсор: history, settings, access, console.

| Файл | Что делает |
| --- | --- |
| `Settings.tsx` | Формы поверх CLI-команд `set` с предпросмотром; пробные параметры радио на 10 мин (`TRIAL_MINUTES`) |
| `Access.tsx` | ACL через `setperm`; нужен полный ключ, поэтому роль можно выдать только контакту |
| `Console.tsx` | CLI с подсказками `lib/cli.ts`; regex `DANGEROUS` (reboot, erase, set radio, password, setperm…) спрашивает подтверждение |
| `History.tsx` + `Sparkline.tsx` | Телеметрия за неделю |
| `QueuePill.tsx` | Видимая очередь: радио несёт один удалённый запрос за раз |
| `SignIn.tsx` | Вход с сохранением пароля |

`lib/cli.ts` — каталог CLI из MeshCore `CommonCLI` и форка MeshCoreTel (Wi-Fi, MQTT, web panel), без serial-only команд.

## Компоненты (прочие)

| Файл | Назначение |
| --- | --- |
| `AirView` | «В эфире»: сырые пакеты с догадкой об отправителе |
| `Avatar` / `SenderName` | Цветной кружок с инициалами или эмодзи из конца имени |
| `ChannelView` | Страница канала: имя, ключ, выход |
| `ChatList` | Список чатов и поиск по всем сообщениям, меню сортировки, свайп-действия |
| `ChatNotices` | Уровень уведомлений для чата |
| `ChatView` | Переписка: сначала 60 сообщений (`FIRST_DRAWN`), дальше по 100 вверх, 10 контекста над целью перехода, поиск в чате |
| `CleanUp` | Sheet удаления устаревших узлов |
| `Composer` | Поле ввода: счётчик байт до 160, отметки блоков по 16 байт, airtime, ответ, упоминания, разбивка, транслит |
| `ContactsPages` | Правила auto-add, «Удалённые» (90 дней, «Вернуть»), `NotOnRadio` |
| `Icons` | Inline SVG через фабрику `icon()` |
| `LogView` | Лог событий |
| `Marked` | Подсветка совпадений поиска |
| `MessageDetails` / `MessageView` | Как дошло сообщение: эхо, репитеры, SNR |
| `NewChat` | 4 способа начать чат: услышанный контакт, публичный канал с ключом из имени, общий канал, новый канал |
| `NodeReadings` / `Readings` | Батарея по типу элементов, дрейф часов; плитки Cayenne LPP |
| `NoticeBanner` / `NoticeCard` | Баннер в приложении и строка ответа в карточке |
| `Privacy` | Вшитый `privacy.html`, читается офлайн |
| `Profile` | Профиль любого узла: действия, `RouteLink`, показания, страницы узла, меню «Ещё», вход |
| `RadioHome` | Корень «Радио»: статус, Advertise (zero-hop/flood), Disconnect, pull-to-resync |
| `RadioPages` | Все страницы «Радио»: `RADIO_TITLES`, `RADIO_PARENTS`, `PRESETS` (EU/UK, EU narrow, US, ANZ, OMS), `CommitField` (сохраняет на blur/Enter) |
| `ScreenHead` / `Chrome` / `Gone` | Заголовок экрана; `Chrome` — Back на телефоне, Close в панели десктопа |
| `ErrorBoundary` → `ScreenBoundary` | Падение одного экрана не ломает вкладки и Back |

## `lib/` (UI-хелперы)

| Файл | Назначение |
| --- | --- |
| `layout.ts` | `useWide()` (min-width 840px) |
| `keyboard.ts` | iOS: страница сама двигается за клавиатурой (`--keyboard`, `--keyboard-rise`), нативный resize отстаёт; `watchKeyboard` для Android |
| `press.ts` | `usePress`: long press = правый клик = одно меню |
| `pull.ts` | Pull-to-refresh, порог 64px |
| `jump.ts`, `firstUnread.ts` | Переход к найденному сообщению; открытие чата на первом непрочитанном |
| `chatOrder.ts`, `nodeOrder.ts` | Сортировки: чаты `latest|name|unread` (+ каналы первыми), узлы `heard|name|near|relays` (+ закреплённые первыми) |
| `messageSearch.ts` | `fold`: регистр, ё→е, lookalikes → латиница; минимум 2 символа |
| `composer.ts` | Стоимость пакета как в прошивке, airtime, разбивка, транслит |
| `format.ts` | Кешированные `Intl`-форматтеры: время, дата, «назад», частота, полоса, ключ, батарея, `utf8Length` |
| `glyphs.ts`, `noticeAvatar.ts` | SVG-глифы узлов; аватар уведомления на canvas (`oklchToRgb` для iOS < 15.4) |
| `banner.ts`, `toast.ts` | Баннер; `toast()` и `act(fn, doneText)` |
| `systemBars.ts` | Цвет иконок статус-бара Android по теме |
| `batteryType.ts` | Химия элементов на узел; без выбора считается Li-ion и заряд показывается с «≈» |
| `jumboEmoji.ts`, `quickReply.ts` | Крупные эмодзи; ответ из карточки уведомления |

## UI-примитивы (`src/ui/`)

| Файл | Что внутри |
| --- | --- |
| `Button.tsx` | `Button`, `IconButton` (label → aria-label) |
| `Dialog.tsx` | Нативный `<dialog>`: `Dialog`, `Confirm`, `Prompt` |
| `Field.tsx` | `Field`, `Input`, `PasswordInput`, `SearchField`, `Select`, `Toggle`, `Row`, `Section` |
| `List.tsx` | Сгруппированные строки в стиле iOS: `Group`, `LinkRow`, `ActionRow` (с `AirMark` для всего, что передаёт в эфир), `SwitchRow`, `SelectRow`, `StepperRow`, `ChoiceRow`, `InfoRow` |
| `Menu.tsx` | `showMenu(items, {title, at})`: popover под мышь, sheet под тач. `MenuHost`, `ToastHost` (с отсчётом undo). |
| `Sheet.tsx` | Нижний sheet на телефоне (закрывается свайпом), диалог по центру на широком экране |
| `ErrorBoundary.tsx` | `ScreenBoundary` |

## Темы и размер текста

- **`theme/themes.ts`**:
  - `ThemeToken`: bg, panel, chrome, elevated, hover, selected, border, borderStrong, text, textMuted, textFaint, accent, accentContrast, danger, warning, success, bubbleOut, bubbleIn. Переводятся в `--kebab-case`.
  - Темы по умолчанию — One Dark и One Light (палитры Zed). Ещё: amber, apricot, berry, dusk, grape, lagoon, mint, olive, onyx, pebble.
  - Опциональный `look`: `terminal`, `lcd`, `classic`.
  - Имя темы — ключ i18n (`radio.themes.oneDark`).
- **`theme/store.ts`**:
  - `meshnet.theme` хранит id темы или `system`;
  - `apply()` ставит переменные на `:root`, а также `color-scheme`, `data-appearance`, `data-bubbles`, `data-look`, и вызывает `paintSystemBars`.
- **`theme/textSize.ts`**:
  - `TEXT_STEPS=[0.9,1,1.15,1.3,1.5]` или `system` (iOS Dynamic Type через probe `-apple-system-body`, Android — плагин `SystemText`);
  - результат — `--text-scale`.
- **`styles.css`**:
  - **цвета только из переменных темы, литералов нет**; стиль Zed: тонкие линии, один акцент, сетка 4px, три высоты контролов;
  - `--space-1..6`, `--text-xs..xl = calc(px*var(--text-scale))`, `--box-scale` (боксы растут вдвое медленнее текста);
  - секции помечены `/* ---- name ---- */`;
  - везде `@media (hover:hover)`, `(pointer:coarse)`, `prefers-reduced-motion`.
- **Шрифты**:
  - UI — стек `"IBM Plex Sans", system-ui…` (Plex Sans не вшит);
  - `src/fonts/` вшивает IBM Plex Mono 400/600 и Handjet (latin + cyrillic, OFL) — «у радио в поле нет сети»;
  - шрифт грузится, только когда его называет `look`.

## i18n

- `src/i18n/en/<area>.json` — источник. Области: `app`, `chats`, `common`, `connect`, `contacts`, `mesh`, `node`, `notices`, `radio`, `tools`. `ru/` — перевод.
- **`index.ts`**:
  - тип `Key` = `` `${Area}.${key}` `` из английских JSON: **ключ, которого нет в английском, не компилируется**;
  - `t(key, params)` подставляет `{name}`; множественное число — объект с категориями CLDR (`one/few/many/other`, `other` обязателен), выбор по `params.count`;
  - fallback: английский, затем сам ключ;
  - также `template`, `forms`, `pluralTable` (для нативного кода), `language()`, `locale()`, `useLanguage()`, `setLanguagePreference()` (`meshnet.language`), `initLanguage()`.
- **`languages.ts`** — `import.meta.glob` автоматически подключает каждую папку, кроме `en`. Вынесен отдельно, чтобы тесты работали без Vite.
- **`rich.tsx`** — `tx(key, {name: <b/>})` подставляет React-элементы.
- **`errors.ts`** — `errorText(err)`. **Ошибки показывать только через него**, не `e.message`.

**Правила:**
- `t()` вызывается только при рендере или действии, **никогда на верхнем уровне модуля**. Таблицы хранят `Key`, а `t()` вызывает вью (`SECTIONS`, `RADIO_TITLES`, `CHAT_ORDERS`…).
- Предложение — одно значение, из кусков не склеивать.
- Даты и числа — только через `lib/format.ts`.
- Слова для нативного кода лежат в `notices.core.*` (через `coreWatch`).
- Динамические ключи — template literal: `` t(`tools.quality.${q}`) ``.

**Добавить строку:** ключ в `en/<area>.json` → тот же ключ в `ru/<area>.json` с русскими формами множественного числа → `t("area.key", {...})`.

**Добавить язык:**
1. Скопировать `en/` в `<code>/` и перевести, сохранив ключи и `{плейсхолдеры}`.
2. `pnpm --filter @meshnet/web test` — `i18n.test.ts` проверяет ключи, плейсхолдеры и категории множественного числа.
3. Для iOS — `CFBundleLocalizations` в `Info.plist` и `<code>.lproj/InfoPlist.strings`.

**`ru/GLOSSARY.md`** — термины:
- radio → «радио» (несклоняемое, ср. р.), node → узел, repeater → репитер, advert → анонс, flood → «по всей сети», hop → хоп, раздел Mesh → «Сеть».

Стиль:
- на кнопках инфинитив;
- без родового прошедшего времени;
- «ёлочки», буква ё;
- числа только через формы множественного числа.
