# Pi Harness

Pi Harness es un host web centrado en plugins para [Pi](https://github.com/earendil-works/pi), construido sobre DeepSeek Cordis. Incluye consola web, API HTTP y CLI.

Idiomas: [English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md)

## Instalación

Requiere Node.js 22.19 o posterior y npm 10 o posterior.

```sh
npm install --global @pi-harness/pi-harness
pi-harness
```

Normalmente solo hay que instalar el paquete principal; las dependencias de implementación, incluido `@pi-harness/core`, se instalan automáticamente.

## Ejecutar desde el código fuente

```sh
npm ci
npm run build
npm run web
```

## Actualizaciones y configuración

Al iniciar, Pi Harness comprueba en segundo plano si existe una versión compatible nueva de `@pi-harness/core`. No bloquea el arranque, muestra el comando si encuentra una actualización e ignora los fallos de red. Ejecuta `npm update --global @pi-harness/pi-harness` para actualizar o usa `PI_HARNESS_DISABLE_UPDATE_CHECK=1` para desactivar la comprobación.

Variables habituales: `PI_HARNESS_HOST`, `PI_HARNESS_PORT`, `PI_AGENT_DIR`, `PI_HARNESS_PROVIDER` y `PI_HARNESS_MODEL`. La dirección predeterminada es `http://127.0.0.1:3141`.

El profile de la consola web ([`apps/web/profile/cordis.yml`](../apps/web/profile/cordis.yml)) selecciona `everyapi/deepseek-v4-flash` de forma predeterminada. La selección de modelo es fail-closed: si ese proveedor no está registrado en el `PI_AGENT_DIR` activo, el arranque se aborta con `Pi model is not registered: <provider>/<model>` en lugar de recurrir a otro proveedor. Por eso, tras una instalación nueva hay que preparar antes el catálogo de modelos: ejecuta `everyapi use pi-harness` si tienes la CLI de EveryAPI, que prepara un directorio de agente Pi aislado con el catálogo de proveedores de EveryAPI y lo arranca, o apunta `PI_HARNESS_PROVIDER` y `PI_HARNESS_MODEL` a un modelo ya registrado en ese directorio. El profile `default` integrado en la CLI selecciona `deepseek/deepseek-v4-flash`.

## CLI

```sh
pih --profile default "Resume el directorio actual"
pih --profile development "Resume el directorio actual"
pih --config ./cordis.yml "Resume el directorio actual"
```

Las opciones son `--profile`, `--config`, `--dump-config`, `--help` y `--version`. Un profile es una lista de entradas de Cordis Loader; cada entrada necesita un `id` único y un `name` de módulo.

## Arquitectura y plugins

Loader, Include y Group de Cordis montan los plugins de modelos, recursos, sesiones, herramientas, runtime, Web/API y stdio. `@pi-harness/core` es un paquete npm independiente que contiene varios plugins Cordis, no un único plugin. Los plugins externos se instalan con npm y se declaran en `cordis.yml`.

## Desarrollo

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

Consulta la [referencia en inglés](README.reference.md) para el catálogo seleccionado de plugins, la configuración, todas las rutas de la API HTTP, los límites y la seguridad. Core incluye más plugins de los que describe ese catálogo: [`packages/plugins`](../packages/plugins) es el conjunto completo, y todos se instalan desde el centro de plugins igual que uno de la comunidad. Una instalación nueva solo habilita la infraestructura, que es lo que contiene [`apps/web/profile/cordis.yml`](../apps/web/profile/cordis.yml).

## Licencia

MIT. Consulta [LICENSE](LICENSE).
