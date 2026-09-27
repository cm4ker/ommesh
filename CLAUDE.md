# Ommesh — памятка для агента

Ommesh — альтернативный клиент (companion app) для LoRa-радио MeshCore. Один клиент на React работает в браузере, в Tauri 2 (десктоп) и в Capacitor 8 (Android/iOS). Внутреннее имя — `meshnet` (`@meshnet/*`, `dev.cm4ker.meshnet`, ключи `meshnet.*`), его не переименовывать.

**Прежде чем читать код, открой `docs/dev/README.md`.** Там карта репозитория, архитектура, библиотеки и таблица «где что менять». Документы по областям:

- `docs/dev/protocol.md` — `packages/meshcore`: протокол, `MeshCoreClient`, `MeshSession` (всё состояние и логика);
- `docs/dev/web-core.md` — транспорты, подключение, хранилище, отправка, уведомления, апдейтер;
- `docs/dev/web-ui.md` — экраны, навигация, карта, инструменты, темы, i18n;
- `docs/dev/desktop.md` — Tauri, команды ↔ веб, WinRT BLE;
- `docs/dev/mobile.md` — Capacitor-плагины, relay, сборка под телефоны;
- `docs/dev/rust-core.md` — `crates/meshcore-core`;
- `docs/dev/build-release.md` — команды, CI, релизы, соглашения.

## Команды

```
pnpm install
pnpm web          # dev-сервер http://localhost:5180 (демо без радио: /?demo)
pnpm typecheck
pnpm test         # node:test + tsx; сначала пересобирает packages/meshcore
cargo test --manifest-path crates/meshcore-core/Cargo.toml
pnpm --filter @meshnet/desktop desktop:check
```

## Правила, которые легко нарушить

- `@meshnet/meshcore` потребляется через `dist/`. После правки протокола выполни `pnpm meshcore`, иначе веб правку не увидит.
- Протокол продублирован в TS (`packages/meshcore/src/protocol/`) и Rust (`crates/meshcore-core/src/{codes,frames}.rs`), менять их синхронно.
- Любой текст UI добавляется в оба языка: `apps/web/src/i18n/en/*.json` и `ru/*.json`, с формами множественного числа. `t()` не вызывать на верхнем уровне модуля. Ошибки выводить через `errorText()`.
- CSS: цвета только из переменных темы.
- Видимое пользователю изменение описывается пунктом и в `CHANGELOG.md`, и в `CHANGELOG.ru.md`.
- Формат коммитов: `type(scope): Capitalized imperative subject (#NN)`, по-английски, в теле — проза.
- Переносы строк: в индексе LF, в рабочей копии CRLF (`core.autocrlf=true`). Правь через Edit, файлы целиком не переписывай. Shell-скрипты для Mac отдаются с LF (`git -c core.autocrlf=false archive`).
- Сгенерированное руками не правится: иконки (`pnpm icons` из `apps/web/public/icon.svg`), звуки (`pnpm sounds`), `apps/mobile/ios/App/CapApp-SPM/Package.swift`, `apps/desktop/src-tauri/tauri.release.json`.
