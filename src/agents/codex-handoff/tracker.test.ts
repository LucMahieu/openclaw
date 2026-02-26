import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyCodexHandoffStaleness,
  getCodexHandoffTask,
  markCodexHandoffHeartbeat,
  markCodexHandoffPhase,
  registerCodexHandoffTask,
  resetCodexHandoffStoreForTests,
  resolveCodexHandoffConfig,
} from "./tracker.js";

describe("codex-handoff tracker", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempStateDir = "";

  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-handoff-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    resetCodexHandoffStoreForTests();
  });

  afterEach(async () => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    await fs.rm(tempStateDir, { recursive: true, force: true });
  });

  it("registers and updates phase/heartbeat", () => {
    registerCodexHandoffTask({
      taskId: "run-1",
      runId: "run-1",
      childSessionKey: "agent:main:subagent:1",
      requesterSessionKey: "agent:main:main",
    });

    expect(getCodexHandoffTask("run-1")?.phase).toBe("queued");

    markCodexHandoffPhase({ taskId: "run-1", phase: "running" });
    expect(getCodexHandoffTask("run-1")?.phase).toBe("running");

    markCodexHandoffHeartbeat("run-1", 123);
    expect(getCodexHandoffTask("run-1")?.lastHeartbeatAt).toBe(123);

    markCodexHandoffPhase({ taskId: "run-1", phase: "done" });
    expect(getCodexHandoffTask("run-1")?.terminal).toBe(true);
  });

  it("classifies stale tasks based on configured timeout", () => {
    registerCodexHandoffTask({
      taskId: "run-2",
      runId: "run-2",
      childSessionKey: "agent:main:subagent:2",
      requesterSessionKey: "agent:main:main",
    });

    const task = getCodexHandoffTask("run-2");
    expect(task).toBeTruthy();
    const staleness = classifyCodexHandoffStaleness(task!, undefined, Date.now() + 700_000);
    expect(staleness).toBe("stale");
  });

  it("resolves handoff defaults", () => {
    expect(resolveCodexHandoffConfig()).toMatchObject({
      monitorEnabled: true,
      monitorIntervalSeconds: 120,
      monitorMaxAttempts: 90,
      staleTimeoutSeconds: 600,
      requirePushAck: true,
      autoRescheduleOnInFlight: true,
      retryBackoffSeconds: [60, 120, 300],
    });
  });
});
