import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";

interface HttpDispatcherModule {
  applyHttpProxySettings(httpProxy: string | undefined): void;
  configureHttpDispatcher(timeoutMs?: number): void;
}

// Pi installs an undici EnvHttpProxyAgent so provider calls honour HTTP(S)_PROXY and the
// settings-level httpProxy. Its package exports map does not expose that module, so it is
// imported by the file URL derived from the package entry: that keeps one undici instance
// shared with Pi, which a direct undici dependency of our own would not.
async function loadHttpDispatcher(): Promise<HttpDispatcherModule> {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  return await import(new URL("./core/http-dispatcher.js", entry).href) as HttpDispatcherModule;
}

/**
 * Route provider traffic through the proxy the environment or Pi's settings configure.
 *
 * @returns undefined on success, or a diagnostic message when Pi's dispatcher module could not be loaded.
 */
export async function configureHttpProxy(services?: AgentSessionServices): Promise<string | undefined> {
  let dispatcher: HttpDispatcherModule;
  try {
    dispatcher = await loadHttpDispatcher();
  } catch (cause) {
    return `Pi HTTP dispatcher is unavailable, so HTTP_PROXY, HTTPS_PROXY and the httpProxy setting are ignored: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  if (services !== undefined) dispatcher.applyHttpProxySettings(services.settingsManager.getGlobalSettings().httpProxy);
  dispatcher.configureHttpDispatcher(services?.settingsManager.getHttpIdleTimeoutMs());
  return undefined;
}
