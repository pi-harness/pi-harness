import type { Context } from "@deepseek-ai/cordis";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, test } from "vitest";
import { createTestRuntimeContext } from "./runtime-fixture.js";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

async function createRuntimeContext(): Promise<{ context: Context; responseText: string[]; callCount: () => number }> {
  const { context, faux } = await createTestRuntimeContext([fauxAssistantMessage("deterministic response")]);
  contexts.push(context);
  const responseText: string[] = [];
  context.piRuntime.session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") responseText.push(event.assistantMessageEvent.delta);
  });
  return { context, responseText, callCount: () => faux.state.callCount };
}

describe("Pi runtime plugin", () => {
  test("completes a deterministic Pi agent run", async () => {
    const { context, responseText, callCount } = await createRuntimeContext();

    await context.piRuntime.prompt("respond once");

    expect(responseText.join("")).toBe("deterministic response");
    expect(callCount()).toBe(1);
  });

  test("disposes the Pi session with its Cordis fiber", async () => {
    const { context } = await createRuntimeContext();
    const runtime = context.piRuntime;

    await context.fiber.dispose();

    await expect(runtime.prompt("too late")).rejects.toThrow(/disposed/);
  });
});
