type ToolEditStateEntry = {
  jid: string;
  messageId: string;
  text: string;
  cleanupTimer: ReturnType<typeof setTimeout>;
};

const TOOL_EDIT_STATE_TTL_MS = 10 * 60 * 1000;
const toolEditStateByCallId = new Map<string, ToolEditStateEntry>();

function clearCleanupTimer(timer: ReturnType<typeof setTimeout>) {
  clearTimeout(timer);
}

function createCleanupTimer(toolCallId: string): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    toolEditStateByCallId.delete(toolCallId);
  }, TOOL_EDIT_STATE_TTL_MS);
  if (typeof timer === "object" && typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
}

export function setToolEditState(
  toolCallId: string,
  value: Omit<ToolEditStateEntry, "cleanupTimer">,
): void {
  const existing = toolEditStateByCallId.get(toolCallId);
  if (existing) {
    clearCleanupTimer(existing.cleanupTimer);
  }
  const cleanupTimer = createCleanupTimer(toolCallId);
  toolEditStateByCallId.set(toolCallId, { ...value, cleanupTimer });
}

export function getToolEditState(
  toolCallId: string,
): { jid: string; messageId: string; text: string } | undefined {
  const entry = toolEditStateByCallId.get(toolCallId);
  if (!entry) {
    return undefined;
  }
  return {
    jid: entry.jid,
    messageId: entry.messageId,
    text: entry.text,
  };
}

export function clearToolEditState(toolCallId: string): void {
  const existing = toolEditStateByCallId.get(toolCallId);
  if (!existing) {
    return;
  }
  clearCleanupTimer(existing.cleanupTimer);
  toolEditStateByCallId.delete(toolCallId);
}
