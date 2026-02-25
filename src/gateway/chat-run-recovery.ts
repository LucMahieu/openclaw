import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { loadSessionEntry, readSessionMessages } from "./session-utils.js";

const CHAT_RUN_RECOVERY_VERSION = 1 as const;
const MAX_RECOVERY_ATTEMPTS = 3;
const MAX_RUN_AGE_MS = 2 * 60 * 60_000;

type PersistedGatewayChatRun = {
  runId: string;
  sessionKey: string;
  startedAtMs: number;
  updatedAtMs: number;
  recoveryAttempts?: number;
  lastRecoveryAtMs?: number;
};

type PersistedGatewayChatRuns = {
  version: typeof CHAT_RUN_RECOVERY_VERSION;
  runs: Record<string, PersistedGatewayChatRun>;
};

function resolveGatewayRecoveryStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) {
    return resolveStateDir(env);
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), "openclaw-test-state", String(process.pid));
  }
  return resolveStateDir(env);
}

function resolveGatewayChatRunRecoveryPath(): string {
  return path.join(resolveGatewayRecoveryStateDir(process.env), "gateway", "chat-runs.json");
}

function loadPersistedGatewayChatRuns(): Map<string, PersistedGatewayChatRun> {
  const raw = loadJsonFile(resolveGatewayChatRunRecoveryPath());
  if (!raw || typeof raw !== "object") {
    return new Map();
  }
  const parsed = raw as Partial<PersistedGatewayChatRuns>;
  if (
    parsed.version !== CHAT_RUN_RECOVERY_VERSION ||
    !parsed.runs ||
    typeof parsed.runs !== "object"
  ) {
    return new Map();
  }
  const out = new Map<string, PersistedGatewayChatRun>();
  for (const [runId, entry] of Object.entries(parsed.runs)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const typed = entry;
    if (!typed.runId || typeof typed.runId !== "string") {
      continue;
    }
    if (!typed.sessionKey || typeof typed.sessionKey !== "string") {
      continue;
    }
    out.set(runId, {
      runId: typed.runId,
      sessionKey: typed.sessionKey,
      startedAtMs: Number.isFinite(typed.startedAtMs) ? typed.startedAtMs : Date.now(),
      updatedAtMs: Number.isFinite(typed.updatedAtMs) ? typed.updatedAtMs : Date.now(),
      recoveryAttempts:
        typeof typed.recoveryAttempts === "number" && Number.isFinite(typed.recoveryAttempts)
          ? Math.max(0, Math.floor(typed.recoveryAttempts))
          : undefined,
      lastRecoveryAtMs:
        typeof typed.lastRecoveryAtMs === "number" && Number.isFinite(typed.lastRecoveryAtMs)
          ? typed.lastRecoveryAtMs
          : undefined,
    });
  }
  return out;
}

function savePersistedGatewayChatRuns(runs: Map<string, PersistedGatewayChatRun>) {
  const serialized: Record<string, PersistedGatewayChatRun> = {};
  for (const [runId, entry] of runs.entries()) {
    serialized[runId] = entry;
  }
  saveJsonFile(resolveGatewayChatRunRecoveryPath(), {
    version: CHAT_RUN_RECOVERY_VERSION,
    runs: serialized,
  } satisfies PersistedGatewayChatRuns);
}

export function markGatewayChatRunInFlight(params: { runId: string; sessionKey: string }) {
  const runId = params.runId.trim();
  const sessionKey = params.sessionKey.trim();
  if (!runId || !sessionKey) {
    return;
  }
  const now = Date.now();
  const runs = loadPersistedGatewayChatRuns();
  const existing = runs.get(runId);
  runs.set(runId, {
    runId,
    sessionKey,
    startedAtMs: existing?.startedAtMs ?? now,
    updatedAtMs: now,
    recoveryAttempts: existing?.recoveryAttempts,
    lastRecoveryAtMs: existing?.lastRecoveryAtMs,
  });
  savePersistedGatewayChatRuns(runs);
}

export function clearGatewayChatRunInFlight(runIdRaw: string) {
  const runId = runIdRaw.trim();
  if (!runId) {
    return;
  }
  const runs = loadPersistedGatewayChatRuns();
  if (!runs.delete(runId)) {
    return;
  }
  savePersistedGatewayChatRuns(runs);
}

function containsToolUseBlock(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const type = (block as { type?: unknown }).type;
    if (typeof type !== "string") {
      return false;
    }
    return type === "toolUse" || type === "toolCall" || type === "functionCall";
  });
}

function isCompletedTerminalAssistant(msg: Extract<AgentMessage, { role: "assistant" }>): boolean {
  const stopReasonRaw = (msg as { stopReason?: unknown }).stopReason;
  const stopReason = typeof stopReasonRaw === "string" ? stopReasonRaw.trim().toLowerCase() : "";
  if (stopReason === "stop" || stopReason === "end_turn" || stopReason === "endturn") {
    return true;
  }
  if (stopReason === "error" || stopReason === "aborted") {
    return true;
  }
  if (stopReason === "tooluse" || stopReason === "tool_use" || stopReason === "tool_calls") {
    return false;
  }
  return !containsToolUseBlock(msg.content);
}

function shouldResumeFromTranscript(params: { sessionKey: string }): boolean {
  const { storePath, entry } = loadSessionEntry(params.sessionKey);
  const sessionId = entry?.sessionId;
  if (!sessionId || !storePath) {
    return false;
  }
  const messages = readSessionMessages(sessionId, storePath, entry.sessionFile);
  if (!messages.length) {
    return false;
  }
  const last = messages.at(-1);
  if (!last || typeof last !== "object") {
    return false;
  }
  const role = (last as { role?: unknown }).role;
  if (role === "user" || role === "toolResult") {
    return true;
  }
  if (role !== "assistant") {
    return false;
  }
  return !isCompletedTerminalAssistant(last as Extract<AgentMessage, { role: "assistant" }>);
}

export async function recoverInterruptedGatewayChatRuns(params: {
  resume: (entry: PersistedGatewayChatRun) => Promise<boolean>;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
}) {
  const now = Date.now();
  const runs = loadPersistedGatewayChatRuns();
  if (runs.size === 0) {
    return;
  }

  let changed = false;
  for (const [runId, entry] of runs) {
    const ageMs = now - entry.startedAtMs;
    const attempts = entry.recoveryAttempts ?? 0;
    if (ageMs > MAX_RUN_AGE_MS || attempts >= MAX_RECOVERY_ATTEMPTS) {
      runs.delete(runId);
      changed = true;
      continue;
    }
    if (!shouldResumeFromTranscript({ sessionKey: entry.sessionKey })) {
      runs.delete(runId);
      changed = true;
      continue;
    }

    const nextAttempts = attempts + 1;
    entry.recoveryAttempts = nextAttempts;
    entry.lastRecoveryAtMs = now;
    entry.updatedAtMs = now;
    changed = true;

    params.log.info(
      `resuming interrupted chat run runId=${entry.runId} sessionKey=${entry.sessionKey} attempt=${nextAttempts}`,
    );
    const resumed = await params.resume(entry).catch((err: unknown) => {
      params.log.warn(`failed to resume interrupted chat run runId=${entry.runId}: ${String(err)}`);
      return false;
    });
    if (!resumed) {
      runs.set(runId, entry);
      continue;
    }
    runs.set(runId, entry);
  }

  if (changed) {
    savePersistedGatewayChatRuns(runs);
  }
}
