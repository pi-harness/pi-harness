# Pi Harness

Pi Harness est un hôte web orienté plugins pour [Pi](https://github.com/earendil-works/pi), construit avec DeepSeek Cordis. Il fournit une console web, une API HTTP et une CLI.

Langues : [English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Deutsch](README.de.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md)

## Installation

Node.js 22.19 ou plus récent et npm 10 ou plus récent sont requis.

```sh
npm install --global @pi-harness/pi-harness
pi-harness
```

Use `pih` as the canonical command-line interface. Use `pi-harness` to start the web console.

Installez normalement uniquement le paquet principal ; les dépendances d’implémentation, dont `@pi-harness/core`, sont installées automatiquement.

## Exécution depuis les sources

```sh
npm ci
npm run build
npm run web
```

## Mises à jour et configuration

Au démarrage, Pi Harness vérifie en arrière-plan les nouvelles versions compatibles de `@pi-harness/core`. Cette vérification ne bloque pas le démarrage, affiche une commande si une mise à jour est disponible et ignore les erreurs réseau. Utilisez `npm update --global @pi-harness/pi-harness` pour mettre à jour ou `PI_HARNESS_DISABLE_UPDATE_CHECK=1` pour désactiver la vérification.

Variables courantes : `PI_HARNESS_HOST`, `PI_HARNESS_PORT`, `PI_AGENT_DIR`, `PI_HARNESS_PROVIDER` et `PI_HARNESS_MODEL`. L’adresse par défaut est `http://127.0.0.1:3141`.

Le profile de la console web ([`apps/web/profile/cordis.yml`](../apps/web/profile/cordis.yml)) sélectionne `everyapi/deepseek-v4-flash` par défaut. La sélection du modèle est fail-closed : si ce fournisseur n’est pas enregistré dans le `PI_AGENT_DIR` actif, le démarrage échoue avec `Pi model is not registered: <provider>/<model>` au lieu de basculer vers un autre fournisseur. Après une installation neuve, préparez donc d’abord le catalogue de modèles : installez la CLI EveryAPI avec `curl -fsSL https://dl.everyapi.ai/install.sh | bash` (`irm https://dl.everyapi.ai/install.ps1 | iex` sous Windows), puis exécutez `everyapi use pi-harness` — elle inscrit le catalogue de fournisseurs EveryAPI dans le répertoire d’agent Pi durable désigné par `PI_CODING_AGENT_DIR`, et non dans un répertoire isolé qui lui serait propre — ou pointez `PI_HARNESS_PROVIDER` et `PI_HARNESS_MODEL` vers un modèle déjà enregistré dans ce répertoire. Les profiles `default` et `development` intégrés à la CLI sélectionnent le même couple via ces deux mêmes variables : cette seule étape inscrit donc le catalogue pour la CLI comme pour la console web, mais `everyapi use pi-harness` ne transmet la clé de relais EveryAPI qu’au processus qu’il démarre lui-même. Lancez donc aussi la CLI par son intermédiaire, sous la forme `everyapi use pi-harness -- <arguments de pih>` avec un shim `pi-harness` sur `PATH` qui exécute pih via exec, ou donnez-lui `PI_HARNESS_PROVIDER` et `PI_HARNESS_MODEL` accompagnés d’un identifiant qui lui est propre.

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

Consultez la [référence en anglais](README.reference.md) pour le catalogue sélectionné de plugins, la configuration, toutes les routes de l’API HTTP, les limites et la sécurité. Core embarque plus de plugins que ce catalogue n’en décrit : [`packages/plugins`](../packages/plugins) constitue l’ensemble complet, et chacun s’installe depuis le centre de plugins comme un plugin communautaire. Une installation neuve n’active que l’infrastructure, c’est-à-dire ce que contient [`apps/web/profile/cordis.yml`](../apps/web/profile/cordis.yml).

## Licence

MIT. Voir [LICENSE](../LICENSE).
