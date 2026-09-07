# Pi Harness

Pi Harness는 DeepSeek Cordis로 구축된 [Pi](https://github.com/earendil-works/pi)용 플러그인 중심 웹 호스트입니다. 브라우저 콘솔, HTTP API, CLI를 제공합니다.

언어: [English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md)

## 설치

Node.js 22.19 이상과 npm 10 이상이 필요합니다.

```sh
npm install --global @pi-harness/pi-harness
pi-harness
```

일반적으로 메인 패키지만 설치하면 됩니다. `@pi-harness/core` 같은 구현 의존성은 자동으로 설치됩니다.

## 소스에서 실행

```sh
npm ci
npm run build
npm run web
```

## 업데이트 및 설정

시작 시 호환 가능한 `@pi-harness/core` 업데이트를 백그라운드에서 확인합니다. 시작을 지연하지 않으며, 업데이트가 있으면 명령을 출력하고 네트워크 오류는 무시합니다. `npm update --global @pi-harness/pi-harness`로 업데이트하고 `PI_HARNESS_DISABLE_UPDATE_CHECK=1`로 확인을 끌 수 있습니다.

주요 환경 변수는 `PI_HARNESS_HOST`, `PI_HARNESS_PORT`, `PI_AGENT_DIR`, `PI_HARNESS_PROVIDER`, `PI_HARNESS_MODEL`입니다. 기본 주소는 `http://127.0.0.1:3141`입니다.

웹 콘솔 profile([`apps/web/profile/cordis.yml`](../apps/web/profile/cordis.yml))은 기본적으로 `everyapi/deepseek-v4-flash`를 선택합니다. 모델 선택은 fail-closed 방식이라 해당 provider가 현재 `PI_AGENT_DIR`에 등록되어 있지 않으면 다른 provider로 대체하지 않고 `Pi model is not registered: <provider>/<model>` 오류로 기동이 중단됩니다. 따라서 새로 설치한 뒤에는 모델 카탈로그를 먼저 준비해야 합니다. EveryAPI CLI가 있으면 `everyapi use pi-harness`를 실행하세요. EveryAPI provider 카탈로그를 갖춘 격리된 Pi agent 디렉터리를 준비하고 기동합니다. 또는 `PI_HARNESS_PROVIDER`와 `PI_HARNESS_MODEL`을 해당 agent 디렉터리에 이미 등록된 모델로 지정하세요. CLI 내장 `default` profile이 선택하는 모델은 `deepseek/deepseek-v4-flash`입니다.

## CLI

```sh
pih --profile default "현재 디렉터리 요약"
pih --profile development "현재 디렉터리 요약"
pih --config ./cordis.yml "현재 디렉터리 요약"
```

사용 가능한 런처 옵션은 `--profile`, `--config`, `--dump-config`, `--help`, `--version`입니다. Profile은 Cordis Loader 항목 배열이며 각 항목에는 고유한 `id`와 모듈 `name`이 필요합니다.

## 아키텍처와 플러그인

Cordis Loader, Include, Group이 모델, 리소스, 세션, 도구, 런타임, Web/API, stdio 플러그인을 구성합니다. `@pi-harness/core`는 여러 Cordis 플러그인을 포함하는 독립 npm 패키지이며 단일 플러그인이 아닙니다. 외부 플러그인은 npm으로 설치한 뒤 `cordis.yml`에서 불러옵니다.

## 개발

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

선별된 플러그인 카탈로그, 설정, 모든 HTTP API 경로, 제한 및 보안 경계는 [영문 전체 참조 문서](README.reference.md)를 확인하세요. core에는 카탈로그가 설명하는 것보다 많은 플러그인이 들어 있습니다. 전체 집합은 [`packages/plugins`](../packages/plugins)이며, 모두 커뮤니티 플러그인과 동일하게 플러그인 센터에서 설치합니다. 새로 설치하면 인프라만 활성화되고, 그 내용이 [`apps/web/profile/cordis.yml`](../apps/web/profile/cordis.yml)입니다.

## 라이선스

MIT. [LICENSE](LICENSE)를 참조하세요.
