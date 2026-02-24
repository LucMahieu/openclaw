import { describe, expect, it, vi } from "vitest";

const hardStopSessionExecutionMock = vi.fn(async () => ({
  sessionKey: "main",
  abortedRun: true,
}));

vi.mock("../../agents/hard-stop.js", () => ({
  hardStopSessionExecution: hardStopSessionExecutionMock,
}));

vi.mock("../session-utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...original,
    loadSessionEntry: () => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "sess-main",
        sessionFile: "/tmp/sess-main.jsonl",
      },
      canonicalKey: "main",
    }),
  };
});

const { chatHandlers } = await import("./chat.js");

function createContext() {
  const now = Date.now();
  return {
    chatAbortControllers: new Map([
      [
        "run-1",
        {
          controller: new AbortController(),
          sessionId: "sess-main",
          sessionKey: "main",
          startedAtMs: now,
          expiresAtMs: now + 30_000,
        },
      ],
    ]),
    chatRunBuffers: new Map<string, string>(),
    chatDeltaSentAt: new Map<string, number>(),
    chatAbortedRuns: new Map<string, number>(),
    removeChatRun: vi.fn().mockReturnValue({ sessionKey: "main", clientRunId: "run-1" }),
    agentRunSeq: new Map<string, number>(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    dedupe: new Map(),
    logGateway: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  };
}

function createClient(mode: "ui" | "webchat") {
  return {
    connect: {
      role: "operator",
      scopes: ["operator.admin"],
      client: {
        mode,
      },
    },
  };
}

describe("chat.send /stop hard stop scope", () => {
  it("runs hard-stop for UI clients", async () => {
    hardStopSessionExecutionMock.mockClear();
    const respond = vi.fn();
    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "main",
        message: "/stop",
        idempotencyKey: "run-1",
      },
      respond: respond as never,
      context: createContext() as never,
      req: {} as never,
      client: createClient("ui") as never,
      isWebchatConnect: () => false,
    });

    expect(hardStopSessionExecutionMock).toHaveBeenCalledWith({
      cfg: {},
      sessionKey: "main",
      sessionId: "sess-main",
      escalationMs: 150,
    });
    const payload = respond.mock.calls.at(-1)?.[1];
    expect(payload?.hardStop).toBeDefined();
  });

  it("keeps soft stop for non-UI clients", async () => {
    hardStopSessionExecutionMock.mockClear();
    const respond = vi.fn();
    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "main",
        message: "/stop",
        idempotencyKey: "run-2",
      },
      respond: respond as never,
      context: createContext() as never,
      req: {} as never,
      client: createClient("webchat") as never,
      isWebchatConnect: () => true,
    });

    expect(hardStopSessionExecutionMock).not.toHaveBeenCalled();
    const payload = respond.mock.calls.at(-1)?.[1];
    expect(payload?.hardStop).toBeUndefined();
  });
});
