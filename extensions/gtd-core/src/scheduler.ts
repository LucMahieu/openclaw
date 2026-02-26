import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  ReplyPayload,
} from "openclaw/plugin-sdk";
import { syncGoogleCalendar } from "./calendar/google.js";
import { generateUlid } from "./canonical-json.js";
import { addCommitment, capture, runReview } from "./engine.js";
import {
  normalizeAllowlistKey,
  type GtdState,
  type ResolvedGtdPluginConfig,
  type SchedulerJobRef,
} from "./schema.js";
import { listConfiguredAgentIds, loadState, saveState, type GtdStoreContext } from "./store.js";

const RECONCILE_INTERVAL_MS = 60_000;
const CRON_TIMEOUT_MS = 10_000;
const JOB_NAMESPACE = "gtd";
const DAY_MS = 24 * 60 * 60 * 1000;

type CronJobRecord = {
  id: string;
  name: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  schedule?: unknown;
  sessionTarget?: unknown;
  wakeMode?: unknown;
  payload?: unknown;
  delivery?: unknown;
};

type CronRunEntry = {
  ts?: number;
  runAtMs?: number;
  status?: string;
};

type DesiredCronJob = {
  key: string;
  create: Record<string, unknown>;
  patch: Record<string, unknown>;
};

type AgentSchedulerContext = {
  api: OpenClawPluginApi;
  service: OpenClawPluginServiceContext;
  pluginConfig: ResolvedGtdPluginConfig;
  agentId: string;
  storeContext: GtdStoreContext;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function resolveTimezone(cfg: OpenClawPluginServiceContext["config"]): string {
  const configured = cfg.agents?.defaults?.userTimezone?.trim();
  if (configured) {
    return configured;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function buildRecurringCronExpr(params: {
  hour: number;
  minute: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  weekdaysOnly?: boolean;
}): string {
  const minute = Math.max(0, Math.min(59, Math.trunc(params.minute)));
  const hour = Math.max(0, Math.min(23, Math.trunc(params.hour)));

  if (params.dayOfMonth != null) {
    const day = Math.max(1, Math.min(28, Math.trunc(params.dayOfMonth)));
    return `${minute} ${hour} ${day} * *`;
  }

  if (params.dayOfWeek != null) {
    const dow = Math.max(0, Math.min(6, Math.trunc(params.dayOfWeek)));
    return `${minute} ${hour} * * ${dow}`;
  }

  if (params.weekdaysOnly) {
    return `${minute} ${hour} * * 1-5`;
  }

  return `${minute} ${hour} * * *`;
}

function buildJobKey(agentId: string, suffix: string): string {
  return `${JOB_NAMESPACE}:${agentId}:${suffix}`;
}

function buildBaseCronJob(params: {
  key: string;
  agentId: string;
  schedule: Record<string, unknown>;
  deleteAfterRun: boolean;
}): DesiredCronJob {
  const payload = {
    kind: "agentTurn",
    message: `GTD_SCHEDULER_TICK key=${params.key}. Reply exactly with OK.`,
    deliver: false,
  };

  const create = {
    name: params.key,
    enabled: true,
    deleteAfterRun: params.deleteAfterRun,
    schedule: params.schedule,
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    delivery: { mode: "none" },
    agentId: params.agentId,
    sessionKey: `${JOB_NAMESPACE}:${params.agentId}:scheduler`,
  };

  const patch = {
    name: params.key,
    enabled: true,
    deleteAfterRun: params.deleteAfterRun,
    schedule: params.schedule,
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    delivery: { mode: "none" },
  };

  return {
    key: params.key,
    create,
    patch,
  };
}

function buildDesiredCronJobs(params: {
  agentId: string;
  state: GtdState;
  service: OpenClawPluginServiceContext;
  pluginConfig: ResolvedGtdPluginConfig;
}): DesiredCronJob[] {
  const { agentId, state, service, pluginConfig } = params;
  const tz = resolveTimezone(service.config);
  const jobs: DesiredCronJob[] = [];

  jobs.push(
    buildBaseCronJob({
      key: buildJobKey(agentId, "daily-review"),
      agentId,
      deleteAfterRun: false,
      schedule: {
        kind: "cron",
        expr: buildRecurringCronExpr({
          hour: pluginConfig.review.dailyInboxZero.hour,
          minute: pluginConfig.review.dailyInboxZero.minute,
          weekdaysOnly: pluginConfig.review.dailyInboxZero.weekdaysOnly,
        }),
        tz,
      },
    }),
  );

  jobs.push(
    buildBaseCronJob({
      key: buildJobKey(agentId, "weekly-review"),
      agentId,
      deleteAfterRun: false,
      schedule: {
        kind: "cron",
        expr: buildRecurringCronExpr({
          hour: pluginConfig.review.weekly.hour,
          minute: pluginConfig.review.weekly.minute,
          dayOfWeek: pluginConfig.review.weekly.dayOfWeek,
        }),
        tz,
      },
    }),
  );

  jobs.push(
    buildBaseCronJob({
      key: buildJobKey(agentId, "horizons-review"),
      agentId,
      deleteAfterRun: false,
      schedule: {
        kind: "cron",
        expr: buildRecurringCronExpr({
          hour: pluginConfig.review.horizons.hour,
          minute: pluginConfig.review.horizons.minute,
          dayOfMonth: pluginConfig.review.horizons.dayOfMonth,
        }),
        tz,
      },
    }),
  );

  jobs.push(
    buildBaseCronJob({
      key: buildJobKey(agentId, "calendar-sync"),
      agentId,
      deleteAfterRun: false,
      schedule: {
        kind: "every",
        everyMs: Math.max(5, pluginConfig.calendar.syncIntervalMinutes) * 60 * 1000,
        anchorMs: Date.now() + 60_000,
      },
    }),
  );

  const activeWaiting = state.waitingFor.filter((item) => item.status === "active");
  for (const waiting of activeWaiting) {
    const atMs = Math.max(waiting.followupAtMs, Date.now() + 1_000);
    jobs.push(
      buildBaseCronJob({
        key: buildJobKey(agentId, `waiting:${waiting.id}`),
        agentId,
        deleteAfterRun: true,
        schedule: {
          kind: "at",
          at: new Date(atMs).toISOString(),
        },
      }),
    );
  }

  return jobs;
}

async function callCronList(
  api: OpenClawPluginApi,
  config: OpenClawPluginServiceContext["config"],
) {
  const payload = await api.runtime.gateway.call<{ jobs?: unknown[] }>({
    method: "cron.list",
    params: { includeDisabled: true },
    timeoutMs: CRON_TIMEOUT_MS,
    config,
  });
  const jobsRaw = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const jobs: CronJobRecord[] = [];
  for (const raw of jobsRaw) {
    const record = asRecord(raw);
    const id = typeof record.id === "string" ? record.id : "";
    const name = typeof record.name === "string" ? record.name : "";
    if (!id || !name) {
      continue;
    }
    jobs.push({
      id,
      name,
      enabled: record.enabled === true,
      deleteAfterRun: record.deleteAfterRun === true,
      schedule: record.schedule,
      sessionTarget: record.sessionTarget,
      wakeMode: record.wakeMode,
      payload: record.payload,
      delivery: record.delivery,
    });
  }
  return jobs;
}

function jobMatchesDesired(job: CronJobRecord, desired: DesiredCronJob): boolean {
  const current = {
    name: job.name,
    enabled: job.enabled === true,
    deleteAfterRun: job.deleteAfterRun === true,
    schedule: job.schedule,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payload: job.payload,
    delivery: job.delivery,
  };

  const expected = {
    name: desired.key,
    enabled: true,
    deleteAfterRun: desired.patch.deleteAfterRun === true,
    schedule: desired.patch.schedule,
    sessionTarget: desired.patch.sessionTarget,
    wakeMode: desired.patch.wakeMode,
    payload: desired.patch.payload,
    delivery: desired.patch.delivery,
  };

  return stable(current) === stable(expected);
}

function updateSchedulerJobRefs(state: GtdState, refs: SchedulerJobRef[]): void {
  state.scheduler.jobs = refs;
  state.scheduler.lastReconciledAtMs = Date.now();
  state.scheduler.lastError = undefined;
}

function getLastProcessedRunAt(state: GtdState, key: string): number {
  const marker = state.scheduler.lastProcessedRuns.find((entry) => entry.key === key);
  return typeof marker?.runAtMs === "number" ? marker.runAtMs : 0;
}

function setLastProcessedRunAt(state: GtdState, key: string, runAtMs: number): void {
  const now = Date.now();
  const existing = state.scheduler.lastProcessedRuns.find((entry) => entry.key === key);
  if (existing) {
    existing.runAtMs = runAtMs;
    existing.updatedAtMs = now;
    return;
  }
  state.scheduler.lastProcessedRuns.push({
    key,
    runAtMs,
    createdAtMs: now,
    updatedAtMs: now,
  });
}

async function fetchLatestRun(
  api: OpenClawPluginApi,
  config: OpenClawPluginServiceContext["config"],
  cronJobId: string,
): Promise<CronRunEntry | null> {
  const payload = await api.runtime.gateway.call<{ entries?: unknown[] }>({
    method: "cron.runs",
    params: { id: cronJobId, limit: 1 },
    timeoutMs: CRON_TIMEOUT_MS,
    config,
  });
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  if (entries.length === 0) {
    return null;
  }
  const latest = asRecord(entries[0]);
  return {
    ts: typeof latest.ts === "number" ? latest.ts : undefined,
    runAtMs: typeof latest.runAtMs === "number" ? latest.runAtMs : undefined,
    status: typeof latest.status === "string" ? latest.status : undefined,
  };
}

function parseWaitingIdFromJobKey(agentId: string, key: string): string | null {
  const prefix = buildJobKey(agentId, "waiting:");
  if (!key.startsWith(prefix)) {
    return null;
  }
  const waitingId = key.slice(prefix.length).trim();
  return waitingId || null;
}

function buildAutoSendAllowKey(params: {
  channel: string;
  accountId?: string;
  to: string;
}): string {
  return normalizeAllowlistKey(`${params.channel}:${params.accountId ?? ""}:${params.to}`);
}

function ensureCalendarAuthRecoveryAction(state: GtdState): void {
  const label = "Reconnect Google Calendar auth for GTD sync";
  const existing = state.actions.find(
    (item) => item.status === "active" && item.textVerbFirst === label,
  );
  if (existing) {
    return;
  }
  const now = Date.now();
  state.actions.push({
    id: generateUlid(now),
    textVerbFirst: label,
    context: "computer",
    energy: "low",
    estimateMin: 10,
    hardLandscape: false,
    status: "active",
    createdAtMs: now,
    updatedAtMs: now,
  });
}

async function runWaitingFollowup(params: {
  state: GtdState;
  agentId: string;
  api: OpenClawPluginApi;
  storeContext: GtdStoreContext;
  pluginConfig: ResolvedGtdPluginConfig;
  waitingId: string;
}): Promise<string> {
  const waiting = params.state.waitingFor.find(
    (item) => item.id === params.waitingId && item.status === "active",
  );
  if (!waiting) {
    return `waiting:${params.waitingId} already resolved`;
  }

  const now = Date.now();
  const nextFollowupAt = now + waiting.followupCadenceDays * DAY_MS;
  const target = waiting.deliveryTarget;
  const followupText = `Follow-up voor ${waiting.who}: ${waiting.what}`;

  if (!target || !target.channel.trim() || !target.to.trim()) {
    capture(params.state, {
      rawText: `[draft_confirm] ${followupText}`,
      source: "scheduler.waiting.draft_confirm",
      owner: params.agentId,
      sessionKey: target?.sessionKey,
    });
    addCommitment(params.state, {
      requestRef: waiting.id,
      decision: "needs_info",
      owner: params.agentId,
      nextUpdateAtMs: now + 60 * 60 * 1000,
      sessionKey: target?.sessionKey,
    });
    waiting.followupAtMs = nextFollowupAt;
    waiting.updatedAtMs = now;
    return `waiting:${waiting.id} draft_confirm (missing delivery target)`;
  }

  const allowKey = buildAutoSendAllowKey({
    channel: target.channel,
    accountId: target.accountId,
    to: target.to,
  });
  const isAllowlisted = params.pluginConfig.autonomy.followup.autoSendAllowlist.includes(allowKey);

  if (!isAllowlisted) {
    capture(params.state, {
      rawText: `[draft_confirm] ${followupText} -> ${target.channel}:${target.accountId ?? ""}:${target.to}`,
      source: "scheduler.waiting.draft_confirm",
      owner: params.agentId,
      sessionKey: target.sessionKey,
    });
    addCommitment(params.state, {
      requestRef: waiting.id,
      decision: "deferred",
      owner: params.agentId,
      nextUpdateAtMs: now + 60 * 60 * 1000,
      sessionKey: target.sessionKey,
    });
    waiting.followupAtMs = nextFollowupAt;
    waiting.updatedAtMs = now;
    return `waiting:${waiting.id} draft_confirm (target not allowlisted)`;
  }

  const payload: ReplyPayload = {
    text: followupText,
  };

  const sent = await params.api.runtime.channel.reply.routeReply({
    payload,
    channel: target.channel as never,
    to: target.to,
    accountId: target.accountId,
    threadId: target.threadId,
    sessionKey: target.sessionKey,
    cfg: params.storeContext.config,
    mirror: false,
  });

  if (!sent.ok) {
    capture(params.state, {
      rawText: `[followup_send_error] ${followupText} error=${sent.error ?? "unknown"}`,
      source: "scheduler.waiting.send_error",
      owner: params.agentId,
      sessionKey: target.sessionKey,
    });
    waiting.followupAtMs = now + 6 * 60 * 60 * 1000;
    waiting.updatedAtMs = now;
    return `waiting:${waiting.id} send_error`;
  }

  waiting.lastFollowupAtMs = now;
  waiting.followupAtMs = nextFollowupAt;
  waiting.updatedAtMs = now;
  return `waiting:${waiting.id} auto_send`;
}

async function processJobRun(params: {
  key: string;
  ctx: AgentSchedulerContext;
  state: GtdState;
}): Promise<string> {
  const { key, ctx, state } = params;
  if (key === buildJobKey(ctx.agentId, "daily-review")) {
    const notes = runReview(state, "daily");
    return `daily-review: ${notes.join(" | ")}`;
  }
  if (key === buildJobKey(ctx.agentId, "weekly-review")) {
    const notes = runReview(state, "weekly");
    return `weekly-review: ${notes.join(" | ")}`;
  }
  if (key === buildJobKey(ctx.agentId, "horizons-review")) {
    const notes = runReview(state, "horizons");
    return `horizons-review: ${notes.join(" | ")}`;
  }
  if (key === buildJobKey(ctx.agentId, "calendar-sync")) {
    const sync = await syncGoogleCalendar({
      ctx: ctx.storeContext,
      agentId: ctx.agentId,
      state,
    });
    if (!sync.ok) {
      ensureCalendarAuthRecoveryAction(state);
    }
    return `calendar-sync: ${sync.message}`;
  }

  const waitingId = parseWaitingIdFromJobKey(ctx.agentId, key);
  if (waitingId) {
    return await runWaitingFollowup({
      state,
      agentId: ctx.agentId,
      api: ctx.api,
      storeContext: ctx.storeContext,
      pluginConfig: ctx.pluginConfig,
      waitingId,
    });
  }

  return `ignored:${key}`;
}

async function reconcileAgentJobs(ctx: AgentSchedulerContext, state: GtdState): Promise<boolean> {
  const desired = buildDesiredCronJobs({
    agentId: ctx.agentId,
    state,
    service: ctx.service,
    pluginConfig: ctx.pluginConfig,
  });

  const existing = await callCronList(ctx.api, ctx.service.config);
  const managedPrefix = `${JOB_NAMESPACE}:${ctx.agentId}:`;
  const managedJobs = existing.filter((job) => job.name.startsWith(managedPrefix));
  const desiredByKey = new Map(desired.map((entry) => [entry.key, entry]));

  const managedByName = new Map<string, CronJobRecord[]>();
  for (const job of managedJobs) {
    const bucket = managedByName.get(job.name) ?? [];
    bucket.push(job);
    managedByName.set(job.name, bucket);
  }

  let changed = false;
  const nextRefs: SchedulerJobRef[] = [];
  const previousRefsByKey = new Map(state.scheduler.jobs.map((entry) => [entry.key, entry]));

  for (const desiredJob of desired) {
    const sameName = (managedByName.get(desiredJob.key) ?? []).toSorted((a, b) =>
      a.id.localeCompare(b.id),
    );

    let active = sameName[0];
    if (!active) {
      const created = await ctx.api.runtime.gateway.call<{ id?: string }>({
        method: "cron.add",
        params: desiredJob.create,
        timeoutMs: CRON_TIMEOUT_MS,
        config: ctx.service.config,
      });
      const createdId = typeof created?.id === "string" ? created.id : "";
      if (createdId) {
        active = {
          id: createdId,
          name: desiredJob.key,
          enabled: true,
          deleteAfterRun: desiredJob.patch.deleteAfterRun === true,
          schedule: desiredJob.patch.schedule,
          sessionTarget: desiredJob.patch.sessionTarget,
          wakeMode: desiredJob.patch.wakeMode,
          payload: desiredJob.patch.payload,
          delivery: desiredJob.patch.delivery,
        };
        changed = true;
      }
    } else if (!jobMatchesDesired(active, desiredJob)) {
      await ctx.api.runtime.gateway.call({
        method: "cron.update",
        params: {
          id: active.id,
          patch: desiredJob.patch,
        },
        timeoutMs: CRON_TIMEOUT_MS,
        config: ctx.service.config,
      });
      changed = true;
    }

    for (const duplicate of sameName.slice(1)) {
      await ctx.api.runtime.gateway.call({
        method: "cron.remove",
        params: { id: duplicate.id },
        timeoutMs: CRON_TIMEOUT_MS,
        config: ctx.service.config,
      });
      changed = true;
    }

    if (active?.id) {
      const previous = previousRefsByKey.get(desiredJob.key);
      const now = Date.now();
      const isSameRef = previous?.cronJobId === active.id;
      nextRefs.push({
        key: desiredJob.key,
        cronJobId: active.id,
        createdAtMs: previous?.createdAtMs ?? now,
        updatedAtMs: isSameRef ? previous.updatedAtMs : now,
      });
    }
  }

  for (const stale of managedJobs) {
    if (desiredByKey.has(stale.name)) {
      continue;
    }
    await ctx.api.runtime.gateway.call({
      method: "cron.remove",
      params: { id: stale.id },
      timeoutMs: CRON_TIMEOUT_MS,
      config: ctx.service.config,
    });
    changed = true;
  }

  if (changed || stable(state.scheduler.jobs) !== stable(nextRefs)) {
    updateSchedulerJobRefs(state, nextRefs);
    changed = true;
  }

  return changed;
}

async function processTriggeredRuns(ctx: AgentSchedulerContext, state: GtdState): Promise<boolean> {
  let changed = false;

  for (const ref of state.scheduler.jobs) {
    const latest = await fetchLatestRun(ctx.api, ctx.service.config, ref.cronJobId);
    if (!latest) {
      continue;
    }
    const runAtMs =
      (typeof latest.runAtMs === "number" ? latest.runAtMs : undefined) ??
      (typeof latest.ts === "number" ? latest.ts : 0);
    if (!runAtMs) {
      continue;
    }
    const lastSeen = getLastProcessedRunAt(state, ref.key);
    if (runAtMs <= lastSeen) {
      continue;
    }

    if (latest.status === "ok") {
      const summary = await processJobRun({
        key: ref.key,
        ctx,
        state,
      });
      ctx.service.logger.info(`[gtd-core] ${summary}`);
    } else {
      ctx.service.logger.warn(
        `[gtd-core] cron job ${ref.key} last run status=${latest.status ?? "unknown"}`,
      );
    }

    setLastProcessedRunAt(state, ref.key, runAtMs);
    changed = true;
  }

  return changed;
}

async function runAgentTick(ctx: AgentSchedulerContext): Promise<void> {
  const state = await loadState(ctx.storeContext, ctx.agentId);
  let changed = false;

  try {
    if (await reconcileAgentJobs(ctx, state)) {
      changed = true;
    }
    if (await processTriggeredRuns(ctx, state)) {
      changed = true;
    }
    state.scheduler.lastError = undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.scheduler.lastError = message;
    changed = true;
    ctx.service.logger.warn(`[gtd-core] scheduler tick failed for ${ctx.agentId}: ${message}`);
  }

  if (changed) {
    await saveState(ctx.storeContext, ctx.agentId, state, {
      auditReason: "scheduler:tick",
    });
  }
}

async function runSchedulerTick(params: {
  api: OpenClawPluginApi;
  service: OpenClawPluginServiceContext;
  pluginConfig: ResolvedGtdPluginConfig;
}): Promise<void> {
  const { api, service, pluginConfig } = params;
  const agentIds = listConfiguredAgentIds(service.config);

  for (const agentId of agentIds) {
    const safeAgentId = agentId.trim().toLowerCase() || "main";
    const storeContext: GtdStoreContext = {
      stateDir: service.stateDir,
      config: service.config,
      pluginConfig,
    };

    await runAgentTick({
      api,
      service,
      pluginConfig,
      agentId: safeAgentId,
      storeContext,
    });
  }
}

export function createGtdSchedulerService(params: {
  api: OpenClawPluginApi;
  pluginConfig: ResolvedGtdPluginConfig;
}): OpenClawPluginService {
  const { api, pluginConfig } = params;

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const tick = async (service: OpenClawPluginServiceContext) => {
    if (running || pluginConfig.mode !== "always_on") {
      return;
    }
    const apiRuntime = (api as unknown as { runtime?: Record<string, unknown> }).runtime;
    const apiGateway = (apiRuntime as { gateway?: { call?: unknown } } | undefined)?.gateway;
    const serviceGateway = (service as unknown as { runtime?: { gateway?: { call?: unknown } } })
      .runtime?.gateway;
    if (
      (!apiGateway || typeof apiGateway.call !== "function") &&
      serviceGateway &&
      typeof serviceGateway.call === "function" &&
      apiRuntime &&
      typeof apiRuntime === "object"
    ) {
      // Fallback for runtimes where service context has newer gateway bindings than captured api.
      (apiRuntime as { gateway: { call: unknown } }).gateway = {
        call: serviceGateway.call,
      };
    }
    running = true;
    try {
      await runSchedulerTick({
        api,
        service,
        pluginConfig,
      });
    } finally {
      running = false;
    }
  };

  return {
    id: "gtd-core-scheduler",
    start: async (service) => {
      await tick(service).catch((error) => {
        service.logger.warn(`[gtd-core] scheduler initial tick failed: ${String(error)}`);
      });

      timer = setInterval(() => {
        void tick(service).catch((error) => {
          service.logger.warn(`[gtd-core] scheduler interval tick failed: ${String(error)}`);
        });
      }, RECONCILE_INTERVAL_MS);
      timer.unref?.();
    },
    stop: async () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      running = false;
    },
  };
}
