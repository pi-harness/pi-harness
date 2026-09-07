import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { boundedLine, StdioApplication } from "../stdio.js";
import { assertKnownConfigKeys } from "@pi-harness/plugin-api";

const resourceTypeLimit = 32;
const diagnosticMessageLimit = 2_048;
const extensionPathLimit = 512;
const resourceDiagnosticLimit = 100;

export const Config = z.object({});

function dataProperty(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function diagnosticText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return boundedLine(value, diagnosticMessageLimit) || "Unknown extension failure";
  if (typeof value === "number") return boundedLine(Number.isFinite(value) ? String(value) : "Unknown extension failure", diagnosticMessageLimit);
  if (typeof value === "bigint" || typeof value === "boolean") return boundedLine(String(value), diagnosticMessageLimit);
  const message = dataProperty(value, "message");
  return typeof message === "string" ? boundedLine(message, diagnosticMessageLimit) || "Unknown extension failure" : "Unknown extension failure";
}

function arrayLength(value: unknown): number {
  try {
    if (!Array.isArray(value)) return 0;
  } catch {
    return 0;
  }
  const length = dataProperty(value, "length");
  return typeof length === "number" && Number.isSafeInteger(length) && length >= 0 ? length : 0;
}

export default {
  name: "pi-stdio",
  inject: ["piRuntime", "piResources", "piHarnessStdio", "piHarnessLaunch"],
  Config,
  apply(context: Context, config: unknown) {
    assertKnownConfigKeys("pi-stdio", config, []);
    const application = new StdioApplication(context.piRuntime, context.piHarnessLaunch, context.piHarnessStdio);
    const diagnostics = context.piResources.diagnostics;
    const diagnosticCount = arrayLength(diagnostics);
    for (let index = 0; index < Math.min(diagnosticCount, resourceDiagnosticLimit); index += 1) {
      const diagnostic = dataProperty(diagnostics, String(index));
      const rawType = dataProperty(diagnostic, "type");
      const rawMessage = dataProperty(diagnostic, "message");
      const type = typeof rawType === "string" ? boundedLine(rawType, resourceTypeLimit) : "";
      const message = typeof rawMessage === "string" ? boundedLine(rawMessage, diagnosticMessageLimit) : "";
      if (type !== "" && type !== "error" && message !== "") context.piHarnessStdio.writeError(`Resource ${type}: ${message}\n`);
    }
    if (diagnosticCount > resourceDiagnosticLimit)
      context.piHarnessStdio.writeError(`Resource diagnostics: ${diagnosticCount - resourceDiagnosticLimit} additional entries omitted\n`);
    context.on("pi/session-event", (event) => {
      application.writeSessionEvent(event);
    });
    context.on("pi/extension-error", (error) => {
      const rawPath = dataProperty(error, "extensionPath");
      const message = diagnosticText(dataProperty(error, "error"));
      const path = typeof rawPath === "string" ? boundedLine(rawPath, extensionPathLimit) : "";
      if (path !== "" && message !== undefined && message !== "") context.piHarnessStdio.writeError(`Extension error (${path}): ${message}\n`);
    });
    context.provide("piApplication", application);
  },
};
