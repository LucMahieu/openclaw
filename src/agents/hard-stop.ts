import { clearSessionQueues, type ClearSessionQueueResult } from "../auto-reply/reply/queue.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose } from "../globals.js";
import { killProcessTree } from "../process/kill-tree.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { type ProcessSession, listRunningSessions, markExited } from "./bash-process-registry.js";
import { abortEmbeddedPiRun } from "./pi-embedded.js";
import { listDescendantRunsForRequester, markSubagentRunTerminated } from "./subagent-registry.js";

export type HardStopProcessSummary = {
  scopeKey: string;
  observed: number;
  sigtermRequested: number;
  forceKilled: number;
  remaining: number;
};

export type HardStopResult = {
  sessionKey: string;
  sessionId?: string;
  abortedRun: boolean;
  queue: ClearSessionQueueResult;
  rootProcesses: HardStopProcessSummary;
  subagentProcesses: Omit<HardStopProcessSummary, "scopeKey">;
  subagentRunsTerminated: number;
  subagentSessionsHandled: number;
  subagentRunsAborted: number;
  durationMs: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function resolveSessionIdForKey(cfg: OpenClawConfig, sessionKey: string): string | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId: parsed?.agentId });
  const store = loadSessionStore(storePath);
  return store[sessionKey]?.sessionId;
}

function activeScopedSessions(scopeKey: string): ProcessSession[] {
  return listRunningSessions().filter((session) => session.scopeKey === scopeKey);
}

async function hardStopProcessScope(
  scopeKey: string,
  escalationMs: number,
): Promise<HardStopProcessSummary> {
  const observedSessions = activeScopedSessions(scopeKey);
  const summary: HardStopProcessSummary = {
    scopeKey,
    observed: observedSessions.length,
    sigtermRequested: 0,
    forceKilled: 0,
    remaining: 0,
  };

  for (const session of observedSessions) {
    if (typeof session.pid !== "number" || session.pid <= 0) {
      continue;
    }
    try {
      process.kill(session.pid, "SIGTERM");
      summary.sigtermRequested += 1;
    } catch {
      // Ignore stale/missing PID errors.
    }
  }

  getProcessSupervisor().cancelScope(scopeKey, "manual-cancel");

  await sleep(escalationMs);

  const remainingSessions = activeScopedSessions(scopeKey);
  summary.remaining = remainingSessions.length;
  for (const session of remainingSessions) {
    if (typeof session.pid === "number" && session.pid > 0) {
      killProcessTree(session.pid, { graceMs: 0 });
      summary.forceKilled += 1;
    }
    markExited(session, null, "SIGKILL", "killed");
  }

  return summary;
}

export function formatHardStopReplyText(result: HardStopResult): string {
  const processCount = result.rootProcesses.forceKilled + result.subagentProcesses.forceKilled;
  const processLabel = processCount === 1 ? "process" : "processes";
  const subagentCount = result.subagentRunsTerminated;
  const subagentLabel = subagentCount === 1 ? "sub-agent" : "sub-agents";
  if (processCount <= 0 && subagentCount <= 0) {
    return "⚙️ Agent was aborted.";
  }
  if (subagentCount <= 0) {
    return `⚙️ Agent was aborted. Stopped ${processCount} ${processLabel}.`;
  }
  if (processCount <= 0) {
    return `⚙️ Agent was aborted. Stopped ${subagentCount} ${subagentLabel}.`;
  }
  return `⚙️ Agent was aborted. Stopped ${processCount} ${processLabel} and ${subagentCount} ${subagentLabel}.`;
}

export async function hardStopSessionExecution(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId?: string;
  escalationMs?: number;
}): Promise<HardStopResult> {
  const startedAt = Date.now();
  const sessionKey = params.sessionKey.trim();
  const escalationMs = params.escalationMs ?? 150;
  const sessionId = params.sessionId ?? resolveSessionIdForKey(params.cfg, sessionKey);
  const queue = clearSessionQueues([sessionKey, sessionId]);
  const abortedRun = sessionId ? abortEmbeddedPiRun(sessionId) : false;

  const rootProcesses = await hardStopProcessScope(sessionKey, escalationMs);

  const descendants = listDescendantRunsForRequester(sessionKey);
  const childSessionKeys = Array.from(
    new Set(
      descendants.map((entry) => entry.childSessionKey.trim()).filter((entry) => entry.length > 0),
    ),
  );
  let subagentRunsTerminated = 0;
  for (const entry of descendants) {
    if (typeof entry.endedAt === "number") {
      continue;
    }
    subagentRunsTerminated += markSubagentRunTerminated({
      runId: entry.runId,
      reason: "killed",
    });
  }

  let subagentRunsAborted = 0;
  let subagentObserved = 0;
  let subagentSigtermRequested = 0;
  let subagentForceKilled = 0;
  let subagentRemaining = 0;
  for (const childSessionKey of childSessionKeys) {
    const childSessionId = resolveSessionIdForKey(params.cfg, childSessionKey);
    clearSessionQueues([childSessionKey, childSessionId]);
    if (childSessionId && abortEmbeddedPiRun(childSessionId)) {
      subagentRunsAborted += 1;
    }
    const childProcesses = await hardStopProcessScope(childSessionKey, escalationMs);
    subagentObserved += childProcesses.observed;
    subagentSigtermRequested += childProcesses.sigtermRequested;
    subagentForceKilled += childProcesses.forceKilled;
    subagentRemaining += childProcesses.remaining;
  }

  const result: HardStopResult = {
    sessionKey,
    sessionId,
    abortedRun,
    queue,
    rootProcesses,
    subagentProcesses: {
      observed: subagentObserved,
      sigtermRequested: subagentSigtermRequested,
      forceKilled: subagentForceKilled,
      remaining: subagentRemaining,
    },
    subagentRunsTerminated,
    subagentSessionsHandled: childSessionKeys.length,
    subagentRunsAborted,
    durationMs: Date.now() - startedAt,
  };

  logVerbose(
    `hard-stop: session=${sessionKey} aborted=${abortedRun} queues=${result.queue.followupCleared}/${result.queue.laneCleared} rootProcesses=${rootProcesses.observed}/${rootProcesses.forceKilled} subagentSessions=${result.subagentSessionsHandled} subagentRuns=${subagentRunsTerminated} durationMs=${result.durationMs}`,
  );

  return result;
}
