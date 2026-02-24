import { describe, expect, it, vi } from "vitest";

const hardStopSessionExecutionMock = vi.fn(async () => ({
  sessionKey: "main",
  abortedRun: true,
  queue: { keys: ["main"], followupCleared: 0, laneCleared: 0 },
  rootProcesses: {
    scopeKey: "main",
    observed: 1,
    sigtermRequested: 1,
    forceKilled: 1,
    remaining: 0,
  },
  subagentProcesses: { observed: 0, sigtermRequested: 0, forceKilled: 0, remaining: 0 },
  subagentRunsTerminated: 0,
  subagentSessionsHandled: 0,
  subagentRunsAborted: 0,
  durationMs: 1,
}));
const formatHardStopReplyTextMock = vi.fn(() => "⚙️ Agent was aborted. Stopped 1 process.");
const createInternalHookEventMock = vi.fn(() => ({ messages: [] }));
const triggerInternalHookMock = vi.fn(async () => {});

vi.mock("../../agents/hard-stop.js", () => ({
  hardStopSessionExecution: hardStopSessionExecutionMock,
  formatHardStopReplyText: formatHardStopReplyTextMock,
}));
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: createInternalHookEventMock,
  triggerInternalHook: triggerInternalHookMock,
}));

const { handleStopCommand } = await import("./commands-session.js");

describe("handleStopCommand hard stop routing", () => {
  it("uses hard stop for WhatsApp /stop", async () => {
    const result = await handleStopCommand(
      {
        cfg: {},
        sessionKey: "main",
        ctx: {},
        command: {
          commandBodyNormalized: "/stop",
          isAuthorizedSender: true,
          surface: "whatsapp",
        },
      } as never,
      true,
    );

    expect(hardStopSessionExecutionMock).toHaveBeenCalledWith({
      cfg: {},
      sessionKey: "main",
      sessionId: undefined,
      escalationMs: 150,
    });
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚙️ Agent was aborted. Stopped 1 process." },
    });
  });
});
