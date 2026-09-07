# Pi Harness

Pi Harness è un host web basato sui plugin per [Pi](https://github.com/earendil-works/pi), costruito su DeepSeek Cordis. Offre console web, API HTTP e CLI.

Lingue: [English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md)

## Installazione

Sono richiesti Node.js 22.19 o superiore e npm 10 o superiore.

```sh
npm install --global @pi-harness/pi-harness
pi-harness
```

Di norma è sufficiente installare il pacchetto principale; le dipendenze, incluso `@pi-harness/core`, vengono installate automaticamente.

## Esecuzione dal sorgente

```sh
npm ci
npm run build
npm run web
```

## Aggiornamenti e configurazione

All’avvio Pi Harness verifica in background la presenza di una versione compatibile più recente di `@pi-harness/core`. L’avvio non viene bloccato, il comando viene mostrato quando è disponibile un aggiornamento e gli errori di rete vengono ignorati. Usa `npm update --global @pi-harness/pi-harness` per aggiornare oppure `PI_HARNESS_DISABLE_UPDATE_CHECK=1` per disattivare il controllo.

Le variabili principali sono `PI_HARNESS_HOST`, `PI_HARNESS_PORT`, `PI_AGENT_DIR`, `PI_HARNESS_PROVIDER` e `PI_HARNESS_MODEL`. L’indirizzo predefinito è `http://127.0.0.1:3141`.

Il profile della console web ([`apps/web/profile/cordis.yml`](../apps/web/profile/cordis.yml)) seleziona `everyapi/deepseek-v4-flash` come impostazione predefinita. La selezione del modello è fail-closed: se quel provider non è registrato nel `PI_AGENT_DIR` attivo, l’avvio si interrompe con `Pi model is not registered: <provider>/<model>` invece di ripiegare su un altro provider. Dopo un’installazione nuova prepara quindi prima il catalogo dei modelli: esegui `everyapi use pi-harness` se hai la CLI di EveryAPI — predispone una directory agent Pi isolata con il catalogo dei provider EveryAPI e avvia Pi Harness — oppure imposta `PI_HARNESS_PROVIDER` e `PI_HARNESS_MODEL` su un modello già registrato in quella directory. Il profile `default` incluso nella CLI seleziona invece `deepseek/deepseek-v4-flash`.

## CLI

```sh
pih --profile default "Riassumi la directory corrente"
pih --profile development "Riassumi la directory corrente"
pih --config ./cordis.yml "Riassumi la directory corrente"
```

Le opzioni sono `--profile`, `--config`, `--dump-config`, `--help` e `--version`. Un profile è un elenco di voci Cordis Loader; ogni voce richiede un `id` univoco e un `name` di modulo.

## Architettura e plugin

Loader, Include e Group di Cordis compongono i plugin per modelli, risorse, sessioni, strumenti, runtime, Web/API e stdio. `@pi-harness/core` è un pacchetto npm indipendente che contiene più plugin Cordis, non un singolo plugin. I plugin esterni si installano con npm e si dichiarano in `cordis.yml`.

## Sviluppo

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

Consulta il [riferimento in inglese](README.reference.md) per il catalogo selezionato dei plugin, la configurazione, tutte le rotte dell’API HTTP, i limiti e la sicurezza. Core include più plugin di quanti il catalogo ne descriva: [`packages/core/src/plugins`](../packages/core/src/plugins) è l’insieme completo e [`apps/web/profile/cordis.yml`](../apps/web/profile/cordis.yml) elenca quelli abilitati per impostazione predefinita dalla console web.

## Licenza

MIT. Vedi [LICENSE](LICENSE).
