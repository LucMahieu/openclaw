import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("subscribeEmbeddedPiSession tool handler drain", () => {
  it("waits for async tool handler tasks before resolving tool-handler drain", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    let resolveToolDelivery: (() => void) | undefined;
    const onToolResult = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveToolDelivery = resolve;
        }),
    );
    const toolHarness = createSubscribedSessionHarness({
      runId: "run-tool-handler-drain",
      verboseLevel: "on",
      onToolResult,
    });

    toolHarness.emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-drain-1",
      args: { path: "/tmp/a.txt" },
    });

    let drained = false;
    const drainPromise = toolHarness.subscription.waitForToolHandlerTasks().then(() => {
      drained = true;
    });

    await Promise.resolve();
    expect(drained).toBe(false);
    expect(onToolResult).toHaveBeenCalledTimes(1);

    resolveToolDelivery?.();
    await drainPromise;
    expect(drained).toBe(true);
  });

  it("drops late tool summaries when subscription is already closed", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    let resolveFetch: ((value: unknown) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onToolResult = vi.fn();
    const toolHarness = createSubscribedSessionHarness({
      runId: "run-late-tool-summary",
      verboseLevel: "on",
      onToolResult,
    });

    toolHarness.emit({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-late-1",
      args: { command: "pwd" },
    });
    toolHarness.subscription.unsubscribe();

    resolveFetch?.({
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: "stop", message: { content: "Running pwd in shell." } }],
      }),
    });

    await toolHarness.subscription.waitForToolHandlerTasks();
    expect(onToolResult).not.toHaveBeenCalled();
  });
});
