# Pi Harness

Pi Harness ist ein plugin-orientierter Web-Host für [Pi](https://github.com/earendil-works/pi), aufgebaut auf DeepSeek Cordis. Enthalten sind Web-Konsole, HTTP-API und CLI.

Sprachen: [English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md)

## Installation

Erforderlich sind Node.js 22.19 oder neuer und npm 10 oder neuer.

```sh
npm install --global @pi-harness/pi-harness
pi-harness
```

Normalerweise wird nur das Hauptpaket installiert; Implementierungsabhängigkeiten wie `@pi-harness/core` werden automatisch installiert.

## Aus dem Quellcode ausführen

```sh
npm ci
npm run build
npm run web
```

## Updates und Konfiguration

Beim Start prüft Pi Harness im Hintergrund auf eine kompatible neue Version von `@pi-harness/core`. Der Start wird nicht blockiert; bei einem Update wird ein Befehl ausgegeben, Netzwerkfehler werden ignoriert. Aktualisieren Sie mit `npm update --global @pi-harness/pi-harness` oder deaktivieren Sie die Prüfung mit `PI_HARNESS_DISABLE_UPDATE_CHECK=1`.

Wichtige Umgebungsvariablen sind `PI_HARNESS_HOST`, `PI_HARNESS_PORT` und `PI_AGENT_DIR`. Die Standardadresse lautet `http://127.0.0.1:3141`.

## CLI

```sh
pih --profile default "Aktuelles Verzeichnis zusammenfassen"
pih --profile development "Aktuelles Verzeichnis zusammenfassen"
pih --config ./cordis.yml "Aktuelles Verzeichnis zusammenfassen"
```

Optionen: `--profile`, `--config`, `--dump-config`, `--help` und `--version`. Ein Profile ist eine Liste von Cordis-Loader-Einträgen mit eindeutiger `id` und Modul-`name`.

## Architektur und Plugins

Cordis Loader, Include und Group laden die Plugins für Modelle, Ressourcen, Sitzungen, Tools, Runtime, Web/API und stdio. `@pi-harness/core` ist ein unabhängiges npm-Paket mit mehreren Cordis-Plugins, kein einzelnes Plugin. Externe Plugins werden mit npm installiert und in `cordis.yml` eingetragen.

## Entwicklung

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

Der vollständige Plugin-Katalog sowie Konfiguration, API, Limits und Sicherheitsgrenzen stehen in der [vollständigen englischen Referenz](README.reference.md).

## Lizenz

MIT. Siehe [LICENSE](LICENSE).
