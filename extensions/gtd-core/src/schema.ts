export type GtdScope = "per_agent";
export type GtdMode = "always_on" | "manual";

export type InboxStatus = "captured" | "clarified" | "organized" | "trashed";
export type ActionStatus = "active" | "done" | "cancelled";
export type ProjectStatus = "active" | "on_hold" | "done";
export type WaitingStatus = "active" | "resolved" | "cancelled";
export type SomedayStatus = "active" | "dropped";
export type CalendarSource = "gtd" | "google";

export type CommitmentDecision = "accepted" | "declined" | "deferred" | "needs_info";

export type GtdEnergy = "low" | "med" | "high";

export type GtdContext = "deep_work" | "computer" | "calls" | "errands" | "agenda" | string;

export type ReviewKind = "daily" | "weekly" | "horizons";

export type DeliveryTarget = {
  channel: string;
  to: string;
  accountId?: string;
  sessionKey?: string;
  threadId?: string;
};

export type InboxItem = {
  id: string;
  rawText: string;
  source: string;
  capturedAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  sessionKey?: string;
  status: InboxStatus;
  actionable?: boolean;
  projectId?: string;
  outcome?: string;
  nextActionId?: string;
  note?: string;
};

export type ActionItem = {
  id: string;
  textVerbFirst: string;
  context: GtdContext;
  energy: GtdEnergy;
  estimateMin: number;
  linkedTo?: string;
  projectId?: string;
  dueAtMs?: number;
  hardLandscape: boolean;
  status: ActionStatus;
  createdAtMs: number;
  updatedAtMs: number;
};

export type ProjectItem = {
  id: string;
  outcome: string;
  status: ProjectStatus;
  nextActionId?: string;
  areaId?: string;
  goalId?: string;
  supportRefs: string[];
  createdAtMs: number;
  updatedAtMs: number;
};

export type WaitingForItem = {
  id: string;
  who: string;
  what: string;
  sinceMs: number;
  followupAtMs: number;
  followupCadenceDays: number;
  deliveryTarget?: DeliveryTarget;
  status: WaitingStatus;
  lastFollowupAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
};

export type SomedayMaybeItem = {
  id: string;
  title: string;
  reason?: string;
  reviewAfterMs?: number;
  status: SomedayStatus;
  createdAtMs: number;
  updatedAtMs: number;
};

export type ReferenceItem = {
  id: string;
  title: string;
  kind: string;
  uriOrText: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type CalendarItem = {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  hardLandscape: boolean;
  source: CalendarSource;
  externalId?: string;
  etag?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type CommitmentItem = {
  id: string;
  requestRef: string;
  decision: CommitmentDecision;
  nextUpdateAtMs?: number;
  owner: string;
  createdAtMs: number;
  updatedAtMs: number;
  sessionKey?: string;
};

export type NaturalPlanItem = {
  id: string;
  purpose?: string;
  principles: string[];
  vision?: string;
  brainstorm: string[];
  structure: string[];
  nextActions: string[];
  projectId?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type HorizonGoal = {
  id: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type HorizonArea = {
  id: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type HorizonsState = {
  purpose?: string;
  vision?: string;
  goals: HorizonGoal[];
  areas: HorizonArea[];
  projectLinks: Array<{ projectId: string; areaId?: string; goalId?: string }>;
  updatedAtMs: number;
};

export type GoogleSyncMapping = {
  localId: string;
  remoteId: string;
  createdAtMs: number;
  etag?: string;
  updatedAtMs?: number;
};

export type GoogleSyncState = {
  syncToken?: string;
  lastPullAtMs?: number;
  lastPushAtMs?: number;
  lastSuccessfulAtMs?: number;
  lastError?: string;
  mappings: GoogleSyncMapping[];
};

export type GtdSyncState = {
  google: GoogleSyncState;
};

export type SchedulerJobRef = {
  key: string;
  cronJobId: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type SchedulerRunMarker = {
  key: string;
  runAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
};

export type GtdSchedulerState = {
  jobs: SchedulerJobRef[];
  lastProcessedRuns: SchedulerRunMarker[];
  lastReconciledAtMs?: number;
  lastError?: string;
};

export type ReviewRun = {
  id: string;
  kind: ReviewKind;
  runAtMs: number;
  notes: string[];
};

export type GtdReviewState = {
  lastDailyAtMs?: number;
  lastWeeklyAtMs?: number;
  lastHorizonsAtMs?: number;
  runs: ReviewRun[];
};

export type GtdState = {
  version: 1;
  scope: GtdScope;
  mode: GtdMode;
  createdAtMs: number;
  updatedAtMs: number;
  inboxItems: InboxItem[];
  actions: ActionItem[];
  projects: ProjectItem[];
  waitingFor: WaitingForItem[];
  somedayMaybe: SomedayMaybeItem[];
  references: ReferenceItem[];
  calendarItems: CalendarItem[];
  commitments: CommitmentItem[];
  naturalPlans: NaturalPlanItem[];
  horizons: HorizonsState;
  sync: GtdSyncState;
  scheduler: GtdSchedulerState;
  reviews: GtdReviewState;
};

export type GtdPluginConfig = {
  scope?: GtdScope;
  mode?: GtdMode;
  storage?: {
    rootDir?: string;
  };
  autonomy?: {
    followup?: {
      allowlistedDelivery?: "auto_send";
      nonAllowlistedDelivery?: "draft_confirm";
      autoSendAllowlist?: string[];
    };
  };
  review?: {
    dailyInboxZero?: {
      hour?: number;
      minute?: number;
      weekdaysOnly?: boolean;
    };
    weekly?: {
      dayOfWeek?: number; // 0=Sun..6=Sat
      hour?: number;
      minute?: number;
    };
    horizons?: {
      dayOfMonth?: number;
      hour?: number;
      minute?: number;
    };
  };
  engage?: {
    contexts?: string[];
  };
  calendar?: {
    provider?: "google";
    sync?: "bidirectional";
    conflictPolicy?: "gtd_wins";
    syncIntervalMinutes?: number;
  };
};

export type ResolvedGtdPluginConfig = {
  scope: GtdScope;
  mode: GtdMode;
  storage: {
    rootDir?: string;
  };
  autonomy: {
    followup: {
      allowlistedDelivery: "auto_send";
      nonAllowlistedDelivery: "draft_confirm";
      autoSendAllowlist: string[];
    };
  };
  review: {
    dailyInboxZero: {
      hour: number;
      minute: number;
      weekdaysOnly: boolean;
    };
    weekly: {
      dayOfWeek: number;
      hour: number;
      minute: number;
    };
    horizons: {
      dayOfMonth: number;
      hour: number;
      minute: number;
    };
  };
  engage: {
    contexts: string[];
  };
  calendar: {
    provider: "google";
    sync: "bidirectional";
    conflictPolicy: "gtd_wins";
    syncIntervalMinutes: number;
  };
};

export const DEFAULT_ENGAGE_CONTEXTS: string[] = [
  "deep_work",
  "computer",
  "calls",
  "errands",
  "agenda",
];

export function normalizeAllowlistKey(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, "");
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function resolveGtdPluginConfig(raw: unknown): ResolvedGtdPluginConfig {
  const cfg = raw && typeof raw === "object" ? (raw as GtdPluginConfig) : {};
  const daily = cfg.review?.dailyInboxZero;
  const weekly = cfg.review?.weekly;
  const horizons = cfg.review?.horizons;

  return {
    scope: "per_agent",
    mode: cfg.mode === "manual" ? "manual" : "always_on",
    storage: {
      rootDir: cfg.storage?.rootDir?.trim() || undefined,
    },
    autonomy: {
      followup: {
        allowlistedDelivery: "auto_send",
        nonAllowlistedDelivery: "draft_confirm",
        autoSendAllowlist: (cfg.autonomy?.followup?.autoSendAllowlist ?? [])
          .filter((entry): entry is string => typeof entry === "string")
          .map(normalizeAllowlistKey)
          .filter(Boolean),
      },
    },
    review: {
      dailyInboxZero: {
        hour: clampInt(daily?.hour, 16, 0, 23),
        minute: clampInt(daily?.minute, 30, 0, 59),
        weekdaysOnly: daily?.weekdaysOnly !== false,
      },
      weekly: {
        dayOfWeek: clampInt(weekly?.dayOfWeek, 5, 0, 6),
        hour: clampInt(weekly?.hour, 15, 0, 23),
        minute: clampInt(weekly?.minute, 0, 0, 59),
      },
      horizons: {
        dayOfMonth: clampInt(horizons?.dayOfMonth, 1, 1, 28),
        hour: clampInt(horizons?.hour, 9, 0, 23),
        minute: clampInt(horizons?.minute, 0, 0, 59),
      },
    },
    engage: {
      contexts:
        cfg.engage?.contexts && cfg.engage.contexts.length > 0
          ? cfg.engage.contexts
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean)
          : [...DEFAULT_ENGAGE_CONTEXTS],
    },
    calendar: {
      provider: "google",
      sync: "bidirectional",
      conflictPolicy: "gtd_wins",
      syncIntervalMinutes: clampInt(cfg.calendar?.syncIntervalMinutes, 30, 5, 24 * 60),
    },
  };
}

export function createDefaultState(now = Date.now()): GtdState {
  return {
    version: 1,
    scope: "per_agent",
    mode: "always_on",
    createdAtMs: now,
    updatedAtMs: now,
    inboxItems: [],
    actions: [],
    projects: [],
    waitingFor: [],
    somedayMaybe: [],
    references: [],
    calendarItems: [],
    commitments: [],
    naturalPlans: [],
    horizons: {
      goals: [],
      areas: [],
      projectLinks: [],
      updatedAtMs: now,
    },
    sync: {
      google: {
        mappings: [],
      },
    },
    scheduler: {
      jobs: [],
      lastProcessedRuns: [],
    },
    reviews: {
      runs: [],
    },
  };
}

export function normalizeState(raw: unknown): GtdState {
  const fallback = createDefaultState();
  if (!raw || typeof raw !== "object") {
    return fallback;
  }
  const value = raw as Partial<GtdState>;
  const state: GtdState = {
    ...fallback,
    ...value,
    version: 1,
    scope: "per_agent",
    mode: value.mode === "manual" ? "manual" : "always_on",
    inboxItems: Array.isArray(value.inboxItems) ? (value.inboxItems as InboxItem[]) : [],
    actions: Array.isArray(value.actions) ? (value.actions as ActionItem[]) : [],
    projects: Array.isArray(value.projects) ? (value.projects as ProjectItem[]) : [],
    waitingFor: Array.isArray(value.waitingFor) ? (value.waitingFor as WaitingForItem[]) : [],
    somedayMaybe: Array.isArray(value.somedayMaybe)
      ? (value.somedayMaybe as SomedayMaybeItem[])
      : [],
    references: Array.isArray(value.references) ? (value.references as ReferenceItem[]) : [],
    calendarItems: Array.isArray(value.calendarItems)
      ? (value.calendarItems as CalendarItem[])
      : [],
    commitments: Array.isArray(value.commitments) ? (value.commitments as CommitmentItem[]) : [],
    naturalPlans: Array.isArray(value.naturalPlans)
      ? (value.naturalPlans as NaturalPlanItem[])
      : [],
    horizons:
      value.horizons && typeof value.horizons === "object"
        ? {
            purpose: value.horizons.purpose,
            vision: value.horizons.vision,
            goals: Array.isArray(value.horizons.goals)
              ? (value.horizons.goals as HorizonGoal[])
              : [],
            areas: Array.isArray(value.horizons.areas)
              ? (value.horizons.areas as HorizonArea[])
              : [],
            projectLinks: Array.isArray(value.horizons.projectLinks)
              ? value.horizons.projectLinks
              : [],
            updatedAtMs:
              typeof value.horizons.updatedAtMs === "number"
                ? value.horizons.updatedAtMs
                : fallback.horizons.updatedAtMs,
          }
        : fallback.horizons,
    sync:
      value.sync && typeof value.sync === "object"
        ? {
            google:
              value.sync.google && typeof value.sync.google === "object"
                ? {
                    syncToken: value.sync.google.syncToken,
                    lastPullAtMs: value.sync.google.lastPullAtMs,
                    lastPushAtMs: value.sync.google.lastPushAtMs,
                    lastSuccessfulAtMs: value.sync.google.lastSuccessfulAtMs,
                    lastError: value.sync.google.lastError,
                    mappings: Array.isArray(value.sync.google.mappings)
                      ? value.sync.google.mappings
                          .filter((entry): entry is GoogleSyncMapping =>
                            Boolean(
                              entry &&
                              typeof entry === "object" &&
                              typeof (entry as GoogleSyncMapping).localId === "string" &&
                              typeof (entry as GoogleSyncMapping).remoteId === "string",
                            ),
                          )
                          .map((entry) => ({
                            ...entry,
                            createdAtMs:
                              typeof entry.createdAtMs === "number"
                                ? entry.createdAtMs
                                : fallback.createdAtMs,
                          }))
                      : [],
                  }
                : { mappings: [] },
          }
        : fallback.sync,
    scheduler:
      value.scheduler && typeof value.scheduler === "object"
        ? {
            jobs: Array.isArray(value.scheduler.jobs) ? value.scheduler.jobs : [],
            lastProcessedRuns: Array.isArray(value.scheduler.lastProcessedRuns)
              ? value.scheduler.lastProcessedRuns
              : [],
            lastReconciledAtMs: value.scheduler.lastReconciledAtMs,
            lastError: value.scheduler.lastError,
          }
        : fallback.scheduler,
    reviews:
      value.reviews && typeof value.reviews === "object"
        ? {
            lastDailyAtMs: value.reviews.lastDailyAtMs,
            lastWeeklyAtMs: value.reviews.lastWeeklyAtMs,
            lastHorizonsAtMs: value.reviews.lastHorizonsAtMs,
            runs: Array.isArray(value.reviews.runs) ? value.reviews.runs : [],
          }
        : fallback.reviews,
  };
  return state;
}
