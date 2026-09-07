# Pi Harness

Pi Harness é um host web orientado a plugins para o [Pi](https://github.com/earendil-works/pi), construído sobre o DeepSeek Cordis. Ele oferece console web, API HTTP e CLI.

Idiomas: [English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md)

## Instalação

Requer Node.js 22.19 ou superior e npm 10 ou superior.

```sh
npm install --global @pi-harness/pi-harness
pi-harness
```

Normalmente basta instalar o pacote principal; dependências de implementação, como `@pi-harness/core`, são instaladas automaticamente.

## Executar a partir do código-fonte

```sh
npm ci
npm run build
npm run web
```

## Atualizações e configuração

Na inicialização, o Pi Harness verifica em segundo plano se existe uma versão compatível mais nova de `@pi-harness/core`. A inicialização não é bloqueada; uma atualização exibe o comando correspondente e falhas de rede são ignoradas. Use `npm update --global @pi-harness/pi-harness` para atualizar ou `PI_HARNESS_DISABLE_UPDATE_CHECK=1` para desativar a verificação.

As variáveis mais usadas são `PI_HARNESS_HOST`, `PI_HARNESS_PORT`, `PI_AGENT_DIR`, `PI_HARNESS_PROVIDER` e `PI_HARNESS_MODEL`. O endereço padrão é `http://127.0.0.1:3141`.

O profile do console web ([`apps/web/profile/cordis.yml`](../apps/web/profile/cordis.yml)) seleciona `everyapi/deepseek-v4-flash` por padrão. A seleção de modelo é fail-closed: se esse provedor não estiver registrado no `PI_AGENT_DIR` ativo, a inicialização é abortada com `Pi model is not registered: <provider>/<model>` em vez de recorrer a outro provedor. Por isso, depois de uma instalação nova prepare primeiro o catálogo de modelos: execute `everyapi use pi-harness` se a CLI do EveryAPI estiver instalada — ela prepara um diretório de agente Pi isolado com o catálogo de provedores do EveryAPI e inicia o Pi Harness — ou aponte `PI_HARNESS_PROVIDER` e `PI_HARNESS_MODEL` para um modelo já registrado nesse diretório. O profile `default` embutido na CLI seleciona `deepseek/deepseek-v4-flash`.

## CLI

```sh
pih --profile default "Resuma o diretório atual"
pih --profile development "Resuma o diretório atual"
pih --config ./cordis.yml "Resuma o diretório atual"
```

As opções são `--profile`, `--config`, `--dump-config`, `--help` e `--version`. Um profile é uma lista de entradas do Cordis Loader; cada entrada precisa de um `id` exclusivo e um `name` de módulo.

## Arquitetura e plugins

Loader, Include e Group do Cordis montam os plugins de modelos, recursos, sessões, ferramentas, runtime, Web/API e stdio. `@pi-harness/core` é um pacote npm independente que contém vários plugins Cordis, não um plugin único. Plugins externos são instalados com npm e declarados em `cordis.yml`.

## Desenvolvimento

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

Veja a [referência em inglês](README.reference.md) para o catálogo selecionado de plugins, a configuração, todas as rotas da API HTTP, os limites e a segurança. O core traz mais plugins do que esse catálogo descreve: [`packages/plugins`](../packages/plugins) é o conjunto completo, e cada um deles é instalado pelo centro de plugins como um plugin da comunidade. Uma instalação nova habilita apenas a infraestrutura, que é o que está em [`apps/web/profile/cordis.yml`](../apps/web/profile/cordis.yml).

## Licença

MIT. Consulte [LICENSE](LICENSE).
