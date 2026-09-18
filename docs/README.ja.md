# Pi Harness

Pi Harness は [Pi](https://github.com/earendil-works/pi) 向けのプラグイン中心 Web ホストです。DeepSeek Cordis を基盤に、ブラウザコンソール、HTTP API、CLI を提供します。

言語: [English](../README.md) · [简体中文](README.zh-CN.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md)

## インストール

Node.js 22.19 以上、npm 10 以上が必要です。

```sh
npm install --global @pi-harness/pi-harness
pi-harness
```

正規のコマンドラインインターフェースとして `pih` を使い、Web コンソールの起動には `pi-harness` を使ってください。

通常はメインパッケージだけをインストールします。`@pi-harness/core` などの依存パッケージは自動的に入ります。

## ソースから実行

```sh
npm ci
npm run build
npm run web
```

## 更新と設定

起動時に互換性のある `@pi-harness/core` の更新をバックグラウンドで確認します。起動をブロックせず、更新があればコマンドを表示し、ネットワーク障害は無視します。`npm update --global @pi-harness/pi-harness` で更新し、`PI_HARNESS_DISABLE_UPDATE_CHECK=1` で確認を無効化できます。

主な環境変数は `PI_HARNESS_HOST`、`PI_HARNESS_PORT`、`PI_CODING_AGENT_DIR`（`PI_AGENT_DIR` は互換用の別名で、`PI_CODING_AGENT_DIR` が未設定または空のときにだけ読まれます）、`PI_HARNESS_HOME`、`PI_HARNESS_PROVIDER`、`PI_HARNESS_MODEL` です。既定の URL は `http://127.0.0.1:3141` です。

Web コンソールの profile（[`apps/web/profile/cordis.yml`](../apps/web/profile/cordis.yml)）は既定で `everyapi/deepseek-v4-flash` を選択します。モデル選択は fail-closed で、その provider が`PI_CODING_AGENT_DIR` が指す agent ディレクトリに登録されていない場合は別の provider にフォールバックせず `Pi model is not registered: <provider>/<model>` で起動が中断します。新規インストール直後はまずモデルカタログを用意してください。EveryAPI CLI を `curl -fsSL https://dl.everyapi.ai/install.sh | bash`（Windows では `irm https://dl.everyapi.ai/install.ps1 | iex`）で導入し、`everyapi use pi-harness` を実行すると、独立したディレクトリではなく `PI_CODING_AGENT_DIR` が指す永続的な Pi agent ディレクトリに EveryAPI の provider カタログを登録します。あるいは `PI_HARNESS_PROVIDER` と `PI_HARNESS_MODEL` に、その agent ディレクトリへ登録済みのモデルを指定します。CLI 組み込みの `default` と `development` profile も同じ 2 つの変数を介して同じ組み合わせを選択するため、この一手順でカタログは CLI と Web コンソールの両方に登録されます。ただし `everyapi use pi-harness` は EveryAPI の中継キーを自身が起動したプロセスにしか渡さないので、CLI もこのツール経由で起動してください。`PATH` 上に pih を exec する `pi-harness` シムを置き、`everyapi use pi-harness -- <pih の引数>` として実行します。あるいは CLI に `PI_HARNESS_PROVIDER` と `PI_HARNESS_MODEL` を設定し、CLI 自身の認証情報を与えます。

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

抜粋されたプラグインカタログ、設定、すべての HTTP API ルート、制限事項、セキュリティ境界は [英語の完全リファレンス](README.reference.md) を参照してください。core にはカタログが説明するより多くのプラグインが同梱されています。完全な一覧は [`packages/plugins`](../packages/plugins) で、いずれもコミュニティプラグインと同じくプラグインセンターからインストールします。新規インストールで有効になるのは基盤部分だけで、その内容が [`apps/web/profile/cordis.yml`](../apps/web/profile/cordis.yml) です。

## ライセンス

MIT。[LICENSE](../LICENSE) を参照してください。
