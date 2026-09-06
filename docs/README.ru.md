# Pi Harness

Pi Harness — ориентированный на плагины веб-хост для [Pi](https://github.com/earendil-works/pi), построенный на DeepSeek Cordis. Он предоставляет веб-консоль, HTTP API и CLI.

Языки: [English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md) · [العربية](README.ar.md)

## Установка

Требуются Node.js 22.19 или новее и npm 10 или новее.

```sh
npm install --global @pi-harness/pi-harness
pi-harness
```

Обычно достаточно установить основной пакет: зависимости реализации, включая `@pi-harness/core`, устанавливаются автоматически.

## Запуск из исходников

```sh
npm ci
npm run build
npm run web
```

## Обновления и настройка

При запуске Pi Harness в фоне проверяет наличие совместимой новой версии `@pi-harness/core`. Запуск не блокируется: при обновлении выводится команда, а сетевые ошибки игнорируются. Для обновления выполните `npm update --global @pi-harness/pi-harness`; проверку можно отключить через `PI_HARNESS_DISABLE_UPDATE_CHECK=1`.

Основные переменные окружения: `PI_HARNESS_HOST`, `PI_HARNESS_PORT` и `PI_AGENT_DIR`. Адрес по умолчанию — `http://127.0.0.1:3141`.

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

Полный каталог плагинов, конфигурация, API, ограничения и границы безопасности описаны в [полной английской справке](README.reference.md).

## Лицензия

MIT. См. [LICENSE](LICENSE).
