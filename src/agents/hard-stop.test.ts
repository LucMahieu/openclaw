import { describe, expect, it, vi } from "vitest";

const loadSessionStoreMock = vi.fn(() => ({
  "agent:child": { sessionId: "sess-child" },
}));
const resolveStorePathMock = vi.fn(() => "/tmp/sessions.json");
const logVerboseMock = vi.fn();
const killProcessTreeMock = vi.fn();
const cancelScopeMock = vi.fn();
const parseAgentSessionKeyMock = vi.fn(() => ({ agentId: "agent" }));
const listDescendantRunsForRequesterMock = vi.fn(() => [
  {
    runId: "sub-1",
    childSessionKey: "agent:child",
    requesterSessionKey: "main",
    createdAt: Date.now(),
  },
]);
const markSubagentRunTerminatedMock = vi.fn(() => 1);
const listRunningSessionsMock = vi.fn();
const markExitedMock = vi.fn();
const abortEmbeddedPiRunMock = vi.fn((sessionId: string) => sessionId.length > 0);
const clearSessionQueuesMock = vi.fn(() => ({
  keys: ["main"],
  followupCleared: 1,
  laneCleared: 2,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: loadSessionStoreMock,
  resolveStorePath: resolveStorePathMock,
}));
vi.mock("../globals.js", () => ({
  logVerbose: logVerboseMock,
}));
vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: killProcessTreeMock,
}));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    cancelScope: cancelScopeMock,
  }),
}));
vi.mock("../routing/session-key.js", () => ({
  parseAgentSessionKey: parseAgentSessionKeyMock,
}));
vi.mock("./subagent-registry.js", () => ({
  listDescendantRunsForRequester: listDescendantRunsForRequesterMock,
  markSubagentRunTerminated: markSubagentRunTerminatedMock,
}));
vi.mock("./bash-process-registry.js", () => ({
  listRunningSessions: listRunningSessionsMock,
  markExited: markExitedMock,
}));
vi.mock("./pi-embedded.js", () => ({
  abortEmbeddedPiRun: abortEmbeddedPiRunMock,
}));
vi.mock("../auto-reply/reply/queue.js", () => ({
  clearSessionQueues: clearSessionQueuesMock,
}));

const { hardStopSessionExecution } = await import("./hard-stop.js");

describe("hardStopSessionExecution", () => {
  it("aborts run, cancels scoped processes, and cascades to subagents", async () => {
    const rootRun = { scopeKey: "main", pid: 101 };
    const childRun = { scopeKey: "agent:child", pid: 202 };
    listRunningSessionsMock
      .mockReturnValueOnce([rootRun])
      .mockReturnValueOnce([rootRun])
      .mockReturnValueOnce([childRun])
      .mockReturnValueOnce([]);

    const result = await hardStopSessionExecution({
      cfg: {},
      sessionKey: "main",
      sessionId: "sess-main",
      escalationMs: 0,
    });

    expect(abortEmbeddedPiRunMock).toHaveBeenCalledWith("sess-main");
    expect(abortEmbeddedPiRunMock).toHaveBeenCalledWith("sess-child");
    expect(cancelScopeMock).toHaveBeenCalledWith("main", "manual-cancel");
    expect(cancelScopeMock).toHaveBeenCalledWith("agent:child", "manual-cancel");
    expect(markSubagentRunTerminatedMock).toHaveBeenCalledWith({
      runId: "sub-1",
      reason: "killed",
    });
    expect(killProcessTreeMock).toHaveBeenCalledWith(101, { graceMs: 0 });
    expect(markExitedMock).toHaveBeenCalledWith(rootRun, null, "SIGKILL", "killed");
    expect(result.subagentRunsTerminated).toBe(1);
    expect(result.subagentSessionsHandled).toBe(1);
    expect(result.rootProcesses.forceKilled).toBe(1);
  });
});
