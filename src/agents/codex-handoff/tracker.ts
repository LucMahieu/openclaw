import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import { isTerminalPhase, normalizeRetryBackoffSeconds } from "./policy.js";
import type { CodexHandoffConfig, CodexHandoffPhase, CodexHandoffTask } from "./types.js";

type CodexHandoffStore = {
  version: 1;
  tasks: CodexHandoffTask[];
};

const STORE_VERSION = 1;
let storeCache: CodexHandoffStore | null = null;

function resolveStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "codex-handoff", "tasks.json");
}

function loadStore(): CodexHandoffStore {
  if (storeCache) {
    return storeCache;
  }
  const storePath = resolveStorePath();
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as CodexHandoffStore;
    if (parsed && parsed.version === STORE_VERSION && Array.isArray(parsed.tasks)) {
      storeCache = parsed;
      return parsed;
    }
  } catch {
    // ignore load errors, create fresh store
  }
  storeCache = { version: STORE_VERSION, tasks: [] };
  return storeCache;
}

function saveStore(store: CodexHandoffStore): void {
  const storePath = resolveStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  storeCache = store;
}

export function resolveCodexHandoffConfig(cfg?: OpenClawConfig): CodexHandoffConfig {
  const handoff = cfg?.agents?.defaults?.selfImprovement?.handoff;
  return {
    monitorEnabled: handoff?.monitorEnabled ?? true,
    monitorIntervalSeconds:
      typeof handoff?.monitorIntervalSeconds === "number" &&
      Number.isFinite(handoff.monitorIntervalSeconds)
        ? Math.max(15, Math.floor(handoff.monitorIntervalSeconds))
        : 120,
    monitorMaxAttempts:
      typeof handoff?.monitorMaxAttempts === "number" && Number.isFinite(handoff.monitorMaxAttempts)
        ? Math.max(1, Math.floor(handoff.monitorMaxAttempts))
        : 90,
    staleTimeoutSeconds:
      typeof handoff?.staleTimeoutSeconds === "number" &&
      Number.isFinite(handoff.staleTimeoutSeconds)
        ? Math.max(30, Math.floor(handoff.staleTimeoutSeconds))
        : 600,
    requirePushAck: handoff?.requirePushAck ?? true,
    autoRescheduleOnInFlight: handoff?.autoRescheduleOnInFlight ?? true,
    retryBackoffSeconds: normalizeRetryBackoffSeconds(handoff?.retryBackoffSeconds),
  };
}

function upsertTask(task: CodexHandoffTask): CodexHandoffTask {
  const store = loadStore();
  const index = store.tasks.findIndex((entry) => entry.taskId === task.taskId);
  if (index >= 0) {
    store.tasks[index] = task;
  } else {
    store.tasks.push(task);
  }
  saveStore(store);
  return task;
}

export function registerCodexHandoffTask(params: {
  taskId: string;
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  agentId?: string;
  summary?: string;
  config?: OpenClawConfig;
}): CodexHandoffTask {
  const now = Date.now();
  const handoffCfg = resolveCodexHandoffConfig(params.config);
  const existing = getCodexHandoffTask(params.taskId);
  const task: CodexHandoffTask = {
    taskId: params.taskId,
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    agentId: params.agentId,
    summary: params.summary,
    phase: existing?.phase ?? "queued",
    terminal: existing?.terminal ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastHeartbeatAt: existing?.lastHeartbeatAt,
    lastEventAt: existing?.lastEventAt,
    attempt: existing?.attempt ?? 0,
    nextCheckAt: existing?.nextCheckAt,
    monitorCronJobId: existing?.monitorCronJobId,
    monitorEnabled: handoffCfg.monitorEnabled,
  };
  return upsertTask(task);
}

export function getCodexHandoffTask(taskId: string): CodexHandoffTask | undefined {
  const id = taskId.trim();
  if (!id) {
    return undefined;
  }
  return loadStore().tasks.find((entry) => entry.taskId === id);
}

export function listCodexHandoffTasks(): CodexHandoffTask[] {
  return loadStore().tasks.slice();
}

export function listActiveCodexHandoffTasksByRequester(
  requesterSessionKey: string,
): CodexHandoffTask[] {
  const key = requesterSessionKey.trim();
  if (!key) {
    return [];
  }
  return loadStore().tasks.filter((entry) => entry.requesterSessionKey === key && !entry.terminal);
}

export function markCodexHandoffPhase(params: {
  taskId: string;
  phase: CodexHandoffPhase;
  summary?: string;
  atMs?: number;
}): CodexHandoffTask | undefined {
  const task = getCodexHandoffTask(params.taskId);
  if (!task) {
    return undefined;
  }
  const now = params.atMs ?? Date.now();
  task.phase = params.phase;
  task.terminal = isTerminalPhase(params.phase);
  task.updatedAt = now;
  task.lastEventAt = now;
  if (typeof params.summary === "string" && params.summary.trim()) {
    task.summary = params.summary.trim();
  }
  if (task.terminal) {
    task.nextCheckAt = undefined;
  }
  return upsertTask(task);
}

export function markCodexHandoffHeartbeat(
  taskId: string,
  atMs: number = Date.now(),
): CodexHandoffTask | undefined {
  const task = getCodexHandoffTask(taskId);
  if (!task) {
    return undefined;
  }
  task.lastHeartbeatAt = atMs;
  task.updatedAt = atMs;
  return upsertTask(task);
}

export function bumpCodexHandoffAttempt(
  taskId: string,
  nextCheckAt?: number,
): CodexHandoffTask | undefined {
  const task = getCodexHandoffTask(taskId);
  if (!task) {
    return undefined;
  }
  task.attempt += 1;
  task.updatedAt = Date.now();
  task.nextCheckAt = nextCheckAt;
  return upsertTask(task);
}

export function bindCodexHandoffMonitorJob(
  taskId: string,
  cronJobId: string | undefined,
): CodexHandoffTask | undefined {
  const task = getCodexHandoffTask(taskId);
  if (!task) {
    return undefined;
  }
  task.monitorCronJobId = cronJobId;
  task.updatedAt = Date.now();
  return upsertTask(task);
}

export function clearCodexHandoffMonitorJob(taskId: string): CodexHandoffTask | undefined {
  return bindCodexHandoffMonitorJob(taskId, undefined);
}

export function classifyCodexHandoffStaleness(
  task: CodexHandoffTask,
  config?: OpenClawConfig,
  nowMs: number = Date.now(),
): "fresh" | "stale" {
  const handoffCfg = resolveCodexHandoffConfig(config);
  const reference = task.lastHeartbeatAt ?? task.lastEventAt ?? task.updatedAt;
  if (nowMs - reference > handoffCfg.staleTimeoutSeconds * 1000) {
    return "stale";
  }
  return "fresh";
}

export function resolveCodexHandoffPendingMonitors(
  requesterSessionKey: string,
  config?: OpenClawConfig,
): CodexHandoffTask[] {
  const handoffCfg = resolveCodexHandoffConfig(config);
  if (!handoffCfg.monitorEnabled) {
    return [];
  }
  return listActiveCodexHandoffTasksByRequester(requesterSessionKey).filter(
    (task) => task.monitorEnabled && !task.monitorCronJobId,
  );
}

export function resetCodexHandoffStoreForTests(): void {
  storeCache = { version: STORE_VERSION, tasks: [] };
}

export function resolveSelfImprovementConfig(
  defaults?: AgentDefaultsConfig,
): AgentDefaultsConfig["selfImprovement"] {
  return defaults?.selfImprovement;
}
