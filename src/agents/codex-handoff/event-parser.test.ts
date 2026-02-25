import { describe, expect, it } from "vitest";
import { parseCodexStatusEvent, parseCodexWatchdogEvent } from "./event-parser.js";

describe("codex-handoff event parser", () => {
  it("parses CODEx_STATUS lines", () => {
    const parsed = parseCodexStatusEvent(
      'CODEx_STATUS done taskId=run-123 sessionId=thread-1 summary="implemented"',
    );
    expect(parsed).toEqual({
      raw: 'CODEx_STATUS done taskId=run-123 sessionId=thread-1 summary="implemented"',
      phase: "done",
      taskId: "run-123",
      sessionId: "thread-1",
      summary: "implemented",
    });
  });

  it("normalizes blocked/error/progress statuses", () => {
    expect(parseCodexStatusEvent("CODEx_STATUS blocked taskId=a")?.phase).toBe("waiting-input");
    expect(parseCodexStatusEvent("CODEx_STATUS error taskId=a")?.phase).toBe("failed");
    expect(parseCodexStatusEvent("CODEx_STATUS progress taskId=a")?.phase).toBe("running");
  });

  it("parses watchdog lines", () => {
    const parsed = parseCodexWatchdogEvent("CODEx_WATCHDOG taskId=run-77");
    expect(parsed).toEqual({
      raw: "CODEx_WATCHDOG taskId=run-77",
      taskId: "run-77",
    });
  });
});
