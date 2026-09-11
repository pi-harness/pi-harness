# @pi-harness/plugin-api

The contract a [Pi Harness](https://github.com/pi-harness/pi-harness) plugin is written against. A plugin is an ordinary [Cordis](https://github.com/deepseek-ai/cordis) plugin; this package supplies the service types the harness puts on the Cordis `Context`, the helpers for declaring plugin configuration, and the bounded file access the harness expects a plugin to use when it touches the workspace.

It carries no launcher, no HTTP server and no bundled runtime, so installing it does not pull the harness itself.

## Install

```sh
npm install @pi-harness/plugin-api @deepseek-ai/cordis @deepseek-ai/schemastery @earendil-works/pi-ai @earendil-works/pi-coding-agent
```

The four runtimes are `peerDependencies`. They appear in this package's published type surface, so the plugin and the harness have to resolve the same copy of each: a second copy of `@deepseek-ai/cordis` detaches the `declare module` augmentation and the plugin compiles against a `Context` that carries none of the harness services. Match the versions declared here and npm reports any conflict at install time.

## Use

```ts
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type {} from "@pi-harness/plugin-api";

export const helloTool = defineTool({
  name: "hello",
  label: "Hello",
  description: "Greet a person by name.",
  parameters: Type.Object({ name: Type.String({ description: "The name to greet." }) }),
  execute(_toolCallId, params) {
    return Promise.resolve({ content: [{ type: "text", text: `Hello, ${params.name}!` }], details: undefined });
  },
});

export default {
  name: "pi-hello",
  inject: ["piTools"],
  apply(context: Context) {
    context.effect(() => context.piTools.register(helloTool));
  },
};
```

The bare `import type {} from "@pi-harness/plugin-api"` is what applies the `Context` augmentation; without it `context.piTools` does not exist as far as TypeScript is concerned.

`examples/plugin-hello` in the repository is this plugin with its tests.

## Test a plugin against a real runtime

`@pi-harness/core/test-harness` boots the harness services a plugin injects - resources, session, tools and, with `createTestRuntimeContext`, the runtime - against a stub model provider, so a test can activate the plugin and call its tools without a network or an API key. Install `@pi-harness/core` as a `devDependency` to use it; the plugin itself still depends only on this package.

```ts
import { createTestRuntimeServices } from "@pi-harness/core/test-harness";

const { context } = await createTestRuntimeServices([]);
await context.plugin(helloPlugin, {});
expect(context.piTools.snapshot().customTools.map((tool) => tool.name)).toContain("hello");
```

The argument is the list of scripted model responses; pass `[]` for a plugin that never prompts the model, and use `createTestRuntimeContext` instead when the test needs the runtime to answer one. Every plugin under `packages/plugins` in the repository is tested this way.

## Exports

- **Services** — the service interfaces the harness puts on the Cordis `Context` (`PiToolsSnapshot`, `PiSessionService`, `PiModelsService`, `PiRuntimeService`, `PiResourcesService`, `PiMcpService`, `PiTelemetryService`, `PiHarnessLaunch`), the `declare module` augmentation that attaches them, and the `PiToolRegistry` / `PiPluginUiRegistry` a test can construct directly.
- **Config** — `EmptyConfig` for a plugin that takes no options, and `assertKnownConfigKeys` for rejecting unknown keys with a message that lists the supported ones. Both are built on [Schemastery](https://github.com/shigma/schemastery).
- **Workspace paths** — `resolveExistingWorkspacePath`, `resolveWorkspaceFilePath`, `prepareWorkspaceFile` and `isPathInside`, which keep a plugin from escaping the workspace root through symlinks or `..`.
- **Bounded file access** — `readBoundedFile` and `readBoundedTextFile` with their `BoundedFileSizeError` / `BoundedFileTypeError`, which refuse oversized files, directories, FIFOs and symlinks rather than stranding the process on them. Both readers accept an optional `AbortSignal` and stop between filesystem reads when the caller cancels.
- **Atomic writes** — `atomicWriteFile`, which serialises concurrent writes to the same path, preserves an existing target's permission bits and fsyncs the containing directory.
- **Bounded commands** — `runBoundedCommand(argv, cwd, timeoutMs, maxOutputBytes, signal?, options?)`, a no-shell, stdin-EOF runner with per-stream byte limits. Optional `env` applies only to the child; `encoding: "buffer"` preserves raw stdout/stderr on success and failure, while the default remains UTF-8 strings. Timeout must be an integer from 1 to 2147483647 ms; output limits must be non-negative safe integers. Failures retain bounded stdout/stderr and exec-style code/killed metadata. POSIX commands own a process group; failure signals the group and escalates after one second even if its leader exits. Escalation closes pipes and settles failure independently of escaped descendants. Windows uses taskkill tree termination with direct-process fallback; native Windows acceptance is outstanding. This is local lifecycle cleanup, not a sandbox or proof that deliberately escaped descendants or remote jobs stopped.

The command runner accepts an optional sixth argument `{ env }` for an explicit child environment. Omit it to inherit the host environment. Supplying it does not mutate `process.env`; include inherited values explicitly when they are needed. Notification integrations use this to carry text as data rather than executable source.

## License

MIT
