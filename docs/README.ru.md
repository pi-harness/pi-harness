# Pi Harness

Pi Harness — ориентированный на плагины веб-хост для [Pi](https://github.com/earendil-works/pi), построенный на DeepSeek Cordis. Он предоставляет веб-консоль, HTTP API и CLI.

Языки: [English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md) · [العربية](README.ar.md)

## Установка

Требуются Node.js 22.19 или новее и npm 10 или новее.

```sh
npm install --global @pi-harness/pi-harness
pi-harness
```

Используйте `pih` как основной интерфейс командной строки, а `pi-harness` — для запуска веб-консоли.

Обычно достаточно установить основной пакет: зависимости реализации, включая `@pi-harness/core`, устанавливаются автоматически.

## Запуск из исходников

```sh
npm ci
npm run build
npm run web
```

## Обновления и настройка

При запуске Pi Harness в фоне проверяет наличие совместимой новой версии `@pi-harness/core`. Запуск не блокируется: при обновлении выводится команда, а сетевые ошибки игнорируются. Для обновления выполните `npm update --global @pi-harness/pi-harness`; проверку можно отключить через `PI_HARNESS_DISABLE_UPDATE_CHECK=1`.

Основные переменные окружения: `PI_HARNESS_HOST`, `PI_HARNESS_PORT`, `PI_CODING_AGENT_DIR` (`PI_AGENT_DIR` — псевдоним для совместимости, который читается только когда `PI_CODING_AGENT_DIR` не задана или пуста), `PI_HARNESS_HOME`, `PI_HARNESS_PROVIDER` и `PI_HARNESS_MODEL`. Адрес по умолчанию — `http://127.0.0.1:3141`.

Profile веб-консоли ([`apps/web/profile/cordis.yml`](../apps/web/profile/cordis.yml)) по умолчанию выбирает `everyapi/deepseek-v4-flash`. Выбор модели работает по принципу fail-closed: если этот провайдер не зарегистрирован в каталоге агента, заданном `PI_CODING_AGENT_DIR`, запуск прерывается ошибкой `Pi model is not registered: <provider>/<model>`, а не переключается на другого провайдера. Поэтому после чистой установки сначала подготовьте каталог моделей: установите CLI EveryAPI командой `curl -fsSL https://dl.everyapi.ai/install.sh | bash` (в Windows — `irm https://dl.everyapi.ai/install.ps1 | iex`) и выполните `everyapi use pi-harness` — он записывает каталог провайдеров EveryAPI в постоянный каталог Pi agent, заданный `PI_CODING_AGENT_DIR`, а не в отдельный изолированный, — либо укажите в `PI_HARNESS_PROVIDER` и `PI_HARNESS_MODEL` модель, уже зарегистрированную в этом каталоге. Встроенные в CLI profile `default` и `development` выбирают ту же пару через те же две переменные, поэтому этот один шаг регистрирует каталог сразу и для CLI, и для веб-консоли, но ключ ретранслятора EveryAPI `everyapi use pi-harness` передаёт только тому процессу, который запускает сам. Поэтому запускайте через него и CLI — как `everyapi use pi-harness -- <аргументы pih>` с шимом `pi-harness` в `PATH`, который делает exec pih, — либо задайте ей `PI_HARNESS_PROVIDER` и `PI_HARNESS_MODEL` вместе с собственными учётными данными.

## CLI

```sh
pih --profile default "Суммируй текущий каталог"
pih --profile development "Суммируй текущий каталог"
pih --config ./cordis.yml "Суммируй текущий каталог"
```

Доступны параметры `--profile`, `--config`, `--dump-config`, `--help` и `--version`. Profile — это список записей Cordis Loader; каждая запись должна иметь уникальный `id` и имя модуля `name`.

## Архитектура и плагины

Loader, Include и Group из Cordis подключают плагины моделей, ресурсов, сессий, инструментов, runtime, Web/API и stdio. `@pi-harness/core` — независимый npm-пакет, содержащий несколько плагинов Cordis, а не один плагин. Внешние плагины устанавливаются через npm и указываются в `cordis.yml`.

## Разработка

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

Выборочный каталог плагинов, конфигурация, все маршруты HTTP API, ограничения и границы безопасности описаны в [английской справке](README.reference.md). Core содержит больше плагинов, чем описано в этом каталоге: полный набор — [`packages/plugins`](../packages/plugins), и каждый из них устанавливается из центра плагинов так же, как плагин сообщества. Чистая установка включает только инфраструктуру — именно её содержит [`apps/web/profile/cordis.yml`](../apps/web/profile/cordis.yml).

## Лицензия

MIT. См. [LICENSE](../LICENSE).
