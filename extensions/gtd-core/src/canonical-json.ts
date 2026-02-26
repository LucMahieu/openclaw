import type {
  ActionItem,
  CalendarItem,
  CommitmentItem,
  GtdState,
  GoogleSyncMapping,
  InboxItem,
  NaturalPlanItem,
  ProjectItem,
  ReferenceItem,
  ReviewRun,
  SchedulerJobRef,
  SchedulerRunMarker,
  SomedayMaybeItem,
  WaitingForItem,
} from "./schema.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value: number, len: number): string {
  let out = "";
  let current = value;
  for (let i = 0; i < len; i += 1) {
    out = CROCKFORD[current % 32] + out;
    current = Math.floor(current / 32);
  }
  return out;
}

function randomChars(len: number): string {
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += CROCKFORD[Math.floor(Math.random() * 32)] ?? "0";
  }
  return out;
}

let lastTime = 0;
let lastRand = "0000000000000000";

function incrementRandom(randomPart: string): string {
  const chars = randomPart.split("");
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const idx = CROCKFORD.indexOf(chars[i] ?? "0");
    if (idx < 0) {
      chars[i] = "0";
      continue;
    }
    if (idx < 31) {
      chars[i] = CROCKFORD[idx + 1] ?? "0";
      return chars.join("");
    }
    chars[i] = "0";
  }
  return chars.join("");
}

export function generateUlid(now = Date.now()): string {
  const ts = Math.max(now, lastTime);
  const timePart = encodeBase32(ts, 10);
  if (ts === lastTime) {
    lastRand = incrementRandom(lastRand);
  } else {
    lastTime = ts;
    lastRand = randomChars(16);
  }
  return `${timePart}${lastRand}`;
}

function compareByCreated<T extends { id: string; createdAtMs: number }>(a: T, b: T): number {
  if (a.createdAtMs !== b.createdAtMs) {
    return a.createdAtMs - b.createdAtMs;
  }
  return a.id.localeCompare(b.id);
}

function compareByCreatedInbox(a: InboxItem, b: InboxItem): number {
  if (a.createdAtMs !== b.createdAtMs) {
    return a.createdAtMs - b.createdAtMs;
  }
  return a.id.localeCompare(b.id);
}

function compareSyncMapping(a: GoogleSyncMapping, b: GoogleSyncMapping): number {
  if (a.createdAtMs !== b.createdAtMs) {
    return a.createdAtMs - b.createdAtMs;
  }
  return `${a.localId}:${a.remoteId}`.localeCompare(`${b.localId}:${b.remoteId}`);
}

function compareSchedulerJob(a: SchedulerJobRef, b: SchedulerJobRef): number {
  if (a.createdAtMs !== b.createdAtMs) {
    return a.createdAtMs - b.createdAtMs;
  }
  return a.key.localeCompare(b.key);
}

function compareSchedulerRunMarker(a: SchedulerRunMarker, b: SchedulerRunMarker): number {
  if (a.createdAtMs !== b.createdAtMs) {
    return a.createdAtMs - b.createdAtMs;
  }
  return a.key.localeCompare(b.key);
}

function compareReviewRuns(a: ReviewRun, b: ReviewRun): number {
  if (a.runAtMs !== b.runAtMs) {
    return a.runAtMs - b.runAtMs;
  }
  return a.id.localeCompare(b.id);
}

export function canonicalizeState(state: GtdState): GtdState {
  return {
    ...state,
    inboxItems: [...state.inboxItems].sort(compareByCreatedInbox),
    actions: [...state.actions].sort(compareByCreated<ActionItem>),
    projects: [...state.projects].sort(compareByCreated<ProjectItem>),
    waitingFor: [...state.waitingFor].sort(compareByCreated<WaitingForItem>),
    somedayMaybe: [...state.somedayMaybe].sort(compareByCreated<SomedayMaybeItem>),
    references: [...state.references].sort(compareByCreated<ReferenceItem>),
    calendarItems: [...state.calendarItems].sort(compareByCreated<CalendarItem>),
    commitments: [...state.commitments].sort(compareByCreated<CommitmentItem>),
    naturalPlans: [...state.naturalPlans].sort(compareByCreated<NaturalPlanItem>),
    horizons: {
      ...state.horizons,
      goals: [...state.horizons.goals].sort(compareByCreated),
      areas: [...state.horizons.areas].sort(compareByCreated),
      projectLinks: [...state.horizons.projectLinks].sort((a, b) =>
        `${a.projectId}:${a.areaId ?? ""}:${a.goalId ?? ""}`.localeCompare(
          `${b.projectId}:${b.areaId ?? ""}:${b.goalId ?? ""}`,
        ),
      ),
    },
    sync: {
      ...state.sync,
      google: {
        ...state.sync.google,
        mappings: [...state.sync.google.mappings].sort(compareSyncMapping),
      },
    },
    scheduler: {
      ...state.scheduler,
      jobs: [...state.scheduler.jobs].sort(compareSchedulerJob),
      lastProcessedRuns: [...state.scheduler.lastProcessedRuns].sort(compareSchedulerRunMarker),
    },
    reviews: {
      ...state.reviews,
      runs: [...state.reviews.runs].sort(compareReviewRuns),
    },
  };
}
