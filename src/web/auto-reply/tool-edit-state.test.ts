import { afterEach, describe, expect, it, vi } from "vitest";
import { clearToolEditState, getToolEditState, setToolEditState } from "./tool-edit-state.js";

describe("tool-edit-state", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearToolEditState("tool-1");
    clearToolEditState("tool-2");
  });

  it("stores and reads tool edit state entries", () => {
    setToolEditState("tool-1", {
      jid: "123@s.whatsapp.net",
      messageId: "msg-1",
      text: "○ run",
    });

    expect(getToolEditState("tool-1")).toEqual({
      jid: "123@s.whatsapp.net",
      messageId: "msg-1",
      text: "○ run",
    });
  });

  it("expires entries after 10 minutes", () => {
    vi.useFakeTimers();
    setToolEditState("tool-2", {
      jid: "124@s.whatsapp.net",
      messageId: "msg-2",
      text: "○ run",
    });

    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(getToolEditState("tool-2")).toBeUndefined();
  });
});
