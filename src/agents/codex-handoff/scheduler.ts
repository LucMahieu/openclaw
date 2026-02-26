import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import {
  bindCodexHandoffMonitorJob,
  bumpCodexHandoffAttempt,
  clearCodexHandoffMonitorJob,
  getCodexHandoffTask,
  listActiveCodexHandoffTasksByRequester,
  resolveCodexHandoffConfig,
} from "./tracker.js";

export async function ensureCodexMonitorCron(
  taskId: string,
  cfg?: OpenClawConfig,
): Promise<string | undefined> {
  const task = getCodexHandoffTask(taskId);
  if (!task || task.terminal) {
    return undefined;
  }
  if (task.monitorCronJobId) {
    return task.monitorCronJobId;
  }
  const handoffCfg = resolveCodexHandoffConfig(cfg);
  if (!handoffCfg.monitorEnabled || !task.monitorEnabled) {
    return undefined;
  }

  const cronPayload = {
    name: `codex-handoff-monitor:${task.taskId}`,
    schedule: {
      kind: "every",
      everyMs: handoffCfg.monitorIntervalSeconds * 1000,
      anchorMs: Date.now() + handoffCfg.monitorIntervalSeconds * 1000,
    },
    sessionTarget: "main",
    wakeMode: "now",
    payload: {
      kind: "systemEvent",
      text: `CODEx_WATCHDOG taskId=${task.taskId}`,
    },
    enabled: true,
    agentId: task.agentId,
    sessionKey: task.requesterSessionKey,
    deleteAfterRun: false,
  };

  const created = await callGateway<{ id?: string }>({
    method: "cron.add",
    params: cronPayload,
    timeoutMs: 10_000,
    config: cfg,
  });

  const cronJobId = typeof created?.id === "string" ? created.id : undefined;
  bindCodexHandoffMonitorJob(task.taskId, cronJobId);
  bumpCodexHandoffAttempt(task.taskId, Date.now() + handoffCfg.monitorIntervalSeconds * 1000);
  return cronJobId;
}

export async function removeCodexMonitorCron(taskId: string, cfg?: OpenClawConfig): Promise<void> {
  const task = getCodexHandoffTask(taskId);
  if (!task?.monitorCronJobId) {
    clearCodexHandoffMonitorJob(taskId);
    return;
  }
  try {
    await callGateway({
      method: "cron.remove",
      params: { id: task.monitorCronJobId },
      timeoutMs: 10_000,
      config: cfg,
    });
  } catch {
    // best-effort cleanup
  } finally {
    clearCodexHandoffMonitorJob(taskId);
  }
}

export async function repairCodexMonitorsForSession(
  requesterSessionKey: string,
  cfg?: OpenClawConfig,
): Promise<void> {
  const handoffCfg = resolveCodexHandoffConfig(cfg);
  if (!handoffCfg.monitorEnabled) {
    return;
  }
  const tasks = listActiveCodexHandoffTasksByRequester(requesterSessionKey);
  for (const task of tasks) {
    if (!task.monitorCronJobId) {
      await ensureCodexMonitorCron(task.taskId, cfg);
    }
  }
}
