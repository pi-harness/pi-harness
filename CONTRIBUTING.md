# Contributing to Pi Harness

Use Node.js 22.19 or newer and npm 10 or newer:

```sh
npm ci
npm run build
npm test
npm run lint:check
npm run format:check
```

Keep changes inside the relevant workspace and add tests beside the package they exercise. Desktop changes should run `npm run build -w @pi-harness/desktop` when the platform toolchain is available. Pull requests should describe user-visible behavior, tests, and platform limitations. Keep generated build output out of commits.
