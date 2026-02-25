import type {
  CodexHandoffPhase,
  ParsedCodexStatusEvent,
  ParsedCodexWatchdogEvent,
} from "./types.js";

function parseLooseKeyValues(input: string): Record<string, string> {
  const record: Record<string, string> = {};
  const matches = input.matchAll(
    /([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]*)"|([a-zA-Z_][a-zA-Z0-9_-]*)=([^\s]+)/g,
  );
  for (const match of matches) {
    const key = (match[1] ?? match[3] ?? "").trim().toLowerCase();
    const value = (match[2] ?? match[4] ?? "").trim();
    if (key && value) {
      record[key] = value;
    }
  }
  return record;
}

function normalizeStatusToPhase(status: string): CodexHandoffPhase | null {
  const normalized = status.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "done") {
    return "done";
  }
  if (normalized === "cancelled") {
    return "cancelled";
  }
  if (normalized === "waiting-input" || normalized === "waiting" || normalized === "blocked") {
    return "waiting-input";
  }
  if (normalized === "error" || normalized === "failed") {
    return "failed";
  }
  if (normalized === "progress" || normalized === "running") {
    return "running";
  }
  if (normalized === "stale") {
    return "stale";
  }
  return null;
}

export function parseCodexStatusEvent(text: string): ParsedCodexStatusEvent | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const markerMatch = trimmed.match(/^codex_status\s+/i);
  if (!markerMatch) {
    return null;
  }
  const rest = trimmed.slice(markerMatch[0].length).trim();
  if (!rest) {
    return null;
  }
  const firstToken = rest.split(/\s+/, 1)[0] ?? "";
  const phase = normalizeStatusToPhase(firstToken);
  if (!phase) {
    return null;
  }
  const metadata = parseLooseKeyValues(rest);
  return {
    raw: trimmed,
    phase,
    taskId: metadata.taskid ?? metadata.task,
    sessionId: metadata.sessionid ?? metadata.session,
    summary: metadata.summary,
  };
}

export function parseCodexWatchdogEvent(text: string): ParsedCodexWatchdogEvent | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const markerMatch = trimmed.match(/^codex_watchdog\s+/i);
  if (!markerMatch) {
    return null;
  }
  const rest = trimmed.slice(markerMatch[0].length).trim();
  const metadata = parseLooseKeyValues(rest);
  return {
    raw: trimmed,
    taskId: metadata.taskid ?? metadata.task,
  };
}
