import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionUtilsMock = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  readSessionMessages: vi.fn(),
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: (...args: unknown[]) => sessionUtilsMock.loadSessionEntry(...args),
  readSessionMessages: (...args: unknown[]) => sessionUtilsMock.readSessionMessages(...args),
}));

describe("chat run recovery", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let stateDir = "";

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chat-run-recovery-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    sessionUtilsMock.loadSessionEntry.mockReset();
    sessionUtilsMock.readSessionMessages.mockReset();
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("tracks and clears in-flight runs", async () => {
    const mod = await import("./chat-run-recovery.js");
    mod.markGatewayChatRunInFlight({ runId: "run-1", sessionKey: "main" });
    const storePath = path.join(stateDir, "gateway", "chat-runs.json");
    expect(fs.existsSync(storePath)).toBe(true);
    const first = JSON.parse(fs.readFileSync(storePath, "utf8"));
    expect(first.runs["run-1"]).toMatchObject({
      runId: "run-1",
      sessionKey: "main",
      source: "chat_send",
    });

    mod.clearGatewayChatRunInFlight("run-1");
    const second = JSON.parse(fs.readFileSync(storePath, "utf8"));
    expect(second.runs["run-1"]).toBeUndefined();
  });

  it("migrates legacy entries without source to chat_send", async () => {
    const storePath = path.join(stateDir, "gateway", "chat-runs.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        runs: {
          "run-legacy": {
            runId: "run-legacy",
            sessionKey: "main",
            startedAtMs: Date.now(),
            updatedAtMs: Date.now(),
          },
        },
      }),
    );
    const mod = await import("./chat-run-recovery.js");
    const resume = vi.fn(async () => true);

    sessionUtilsMock.loadSessionEntry.mockReturnValue({
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-legacy", sessionFile: "/tmp/sess-legacy.jsonl" },
    });
    sessionUtilsMock.readSessionMessages.mockReturnValue([{ role: "user", content: "continue" }]);

    await mod.recoverInterruptedRuns({
      source: "chat_send",
      resume,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-legacy", source: "chat_send" }),
    );
  });

  it("filters recovery by source and account", async () => {
    const mod = await import("./chat-run-recovery.js");
    mod.markRunInFlight({
      runId: "run-wa-a",
      sessionKey: "agent:main:whatsapp:direct:+111",
      source: "whatsapp_auto_reply",
      accountId: "default",
    });
    mod.markRunInFlight({
      runId: "run-wa-b",
      sessionKey: "agent:main:whatsapp:direct:+222",
      source: "whatsapp_auto_reply",
      accountId: "other",
    });
    mod.markRunInFlight({ runId: "run-chat", sessionKey: "main", source: "chat_send" });
    sessionUtilsMock.loadSessionEntry.mockReturnValue({
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-1", sessionFile: "/tmp/sess-1.jsonl" },
    });
    sessionUtilsMock.readSessionMessages.mockReturnValue([{ role: "user", content: "continue" }]);
    const resume = vi.fn(async () => true);

    await mod.recoverInterruptedRuns({
      source: "whatsapp_auto_reply",
      accountId: "default",
      resume,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-wa-a",
        source: "whatsapp_auto_reply",
        accountId: "default",
      }),
    );
  });

  it("resumes interrupted runs and keeps them until completion", async () => {
    const mod = await import("./chat-run-recovery.js");
    mod.markGatewayChatRunInFlight({ runId: "run-2", sessionKey: "main" });
    sessionUtilsMock.loadSessionEntry.mockReturnValue({
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-1", sessionFile: "/tmp/sess-1.jsonl" },
    });
    sessionUtilsMock.readSessionMessages.mockReturnValue([{ role: "user", content: "continue" }]);
    const resume = vi.fn(async () => true);
    const log = { info: vi.fn(), warn: vi.fn() };

    await mod.recoverInterruptedGatewayChatRuns({ resume, log });

    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-2" }));
    const storePath = path.join(stateDir, "gateway", "chat-runs.json");
    const saved = JSON.parse(fs.readFileSync(storePath, "utf8"));
    expect(saved.runs["run-2"].recoveryAttempts).toBe(1);
  });

  it("drops completed runs based on terminal assistant stopReason", async () => {
    const mod = await import("./chat-run-recovery.js");
    mod.markGatewayChatRunInFlight({ runId: "run-3", sessionKey: "main" });
    sessionUtilsMock.loadSessionEntry.mockReturnValue({
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-1", sessionFile: "/tmp/sess-1.jsonl" },
    });
    sessionUtilsMock.readSessionMessages.mockReturnValue([
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
    ]);
    const resume = vi.fn(async () => true);

    await mod.recoverInterruptedGatewayChatRuns({
      resume,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(resume).not.toHaveBeenCalled();
    const storePath = path.join(stateDir, "gateway", "chat-runs.json");
    const saved = JSON.parse(fs.readFileSync(storePath, "utf8"));
    expect(saved.runs["run-3"]).toBeUndefined();
  });
});
