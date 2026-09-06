# Pi Harness

Pi Harness est un hôte web orienté plugins pour [Pi](https://github.com/earendil-works/pi), construit avec DeepSeek Cordis. Il fournit une console web, une API HTTP et une CLI.

Langues : [English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Deutsch](README.de.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md)

## Installation

Node.js 22.19 ou plus récent et npm 10 ou plus récent sont requis.

```sh
npm install --global @pi-harness/pi-harness
pi-harness
```

Installez normalement uniquement le paquet principal ; les dépendances d’implémentation, dont `@pi-harness/core`, sont installées automatiquement.

## Exécution depuis les sources

```sh
npm ci
npm run build
npm run web
```

## Mises à jour et configuration

Au démarrage, Pi Harness vérifie en arrière-plan les nouvelles versions compatibles de `@pi-harness/core`. Cette vérification ne bloque pas le démarrage, affiche une commande si une mise à jour est disponible et ignore les erreurs réseau. Utilisez `npm update --global @pi-harness/pi-harness` pour mettre à jour ou `PI_HARNESS_DISABLE_UPDATE_CHECK=1` pour désactiver la vérification.

Variables courantes : `PI_HARNESS_HOST`, `PI_HARNESS_PORT` et `PI_AGENT_DIR`. L’adresse par défaut est `http://127.0.0.1:3141`.

## CLI

```sh
pih --profile default "Résumer le répertoire courant"
pih --profile development "Résumer le répertoire courant"
pih --config ./cordis.yml "Résumer le répertoire courant"
```

Options : `--profile`, `--config`, `--dump-config`, `--help` et `--version`. Un profile est une liste d’entrées Cordis Loader ; chaque entrée doit avoir un `id` unique et un `name` de module.

## Architecture et plugins

Loader, Include et Group de Cordis assemblent les plugins de modèles, ressources, sessions, outils, runtime, Web/API et stdio. `@pi-harness/core` est un paquet npm indépendant contenant plusieurs plugins Cordis, et non un plugin unique. Les plugins externes s’installent avec npm puis se déclarent dans `cordis.yml`.

## Développement

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

Consultez la [référence complète en anglais](README.reference.md) pour le catalogue des plugins, la configuration, l’API, les limites et la sécurité.

## Licence

MIT. Voir [LICENSE](LICENSE).
