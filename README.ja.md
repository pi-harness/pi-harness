# Pi Harness

Pi Harness は [Pi](https://github.com/earendil-works/pi) 向けのプラグイン中心 Web ホストです。DeepSeek Cordis を基盤に、ブラウザコンソール、HTTP API、CLI を提供します。

言語: [English](README.md) · [简体中文](README.zh-CN.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md)

## インストール

Node.js 22.19 以上、npm 10 以上が必要です。

```sh
npm install --global @pi-harness/pi-harness
pi-harness
```

通常はメインパッケージだけをインストールします。`@pi-harness/core` などの依存パッケージは自動的に入ります。

## ソースから実行

```sh
npm ci
npm run build
npm run web
```

## 更新と設定

起動時に互換性のある `@pi-harness/core` の更新をバックグラウンドで確認します。起動をブロックせず、更新があればコマンドを表示し、ネットワーク障害は無視します。`npm update --global @pi-harness/pi-harness` で更新し、`PI_HARNESS_DISABLE_UPDATE_CHECK=1` で確認を無効化できます。

主な環境変数は `PI_HARNESS_HOST`、`PI_HARNESS_PORT`、`PI_AGENT_DIR` です。既定の URL は `http://127.0.0.1:3141` です。

## CLI

```sh
pih --profile default "現在のディレクトリを要約"
pih --profile development "現在のディレクトリを要約"
pih --config ./cordis.yml "現在のディレクトリを要約"
```

`--profile`、`--config`、`--dump-config`、`--help`、`--version` を利用できます。Profile は Cordis Loader のエントリ配列で、各エントリには一意な `id` と `name` が必要です。

## アーキテクチャとプラグイン

Cordis の Loader、Include、Group がモデル、リソース、セッション、ツール、ランタイム、Web/API、stdio プラグインを構成します。`@pi-harness/core` は複数の Cordis プラグインを含む独立 npm パッケージです。外部プラグインは npm で追加し、`cordis.yml` から読み込みます。

## 開発

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

完全なプラグイン一覧、設定、API、制限事項、セキュリティ境界は [英語の完全リファレンス](README.reference.md) を参照してください。

## ライセンス

MIT。[LICENSE](LICENSE) を参照してください。
