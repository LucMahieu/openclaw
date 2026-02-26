import { generateUlid } from "./canonical-json.js";
import { rankActionsForEngage, type EngageInput } from "./engage.js";
import { linkProjectToHorizons, setPurposeAndVision, upsertArea, upsertGoal } from "./horizons.js";
import { applyNaturalPlanning, type NaturalPlanInput } from "./natural-planning.js";
import { runDailyInboxZero, runHorizonsReview, runWeeklyReview } from "./review.js";
import type {
  ActionItem,
  CalendarItem,
  CommitmentDecision,
  CommitmentItem,
  DeliveryTarget,
  GtdContext,
  GtdEnergy,
  GtdState,
  InboxItem,
  ReferenceItem,
  WaitingForItem,
} from "./schema.js";

export type CaptureInput = {
  rawText: string;
  source: string;
  sessionKey?: string;
  owner?: string;
};

export type ClarifyInput = {
  inboxId: string;
  actionable: boolean;
  destination?: "trash" | "reference" | "someday";
  outcome?: string;
  nextAction?: {
    textVerbFirst: string;
    context?: GtdContext;
    energy?: GtdEnergy;
    estimateMin?: number;
    dueAtMs?: number;
    hardLandscape?: boolean;
  };
  project?: {
    id?: string;
    outcome?: string;
  };
};

export type OrganizeInput = {
  inboxId: string;
  container: "calendar" | "next_actions" | "projects" | "waiting_for" | "someday" | "reference";
  actionId?: string;
  projectId?: string;
  waitingId?: string;
};

export type WaitingInput = {
  who: string;
  what: string;
  followupAtMs?: number;
  followupCadenceDays?: number;
  deliveryTarget?: DeliveryTarget;
};

export type CommitmentInput = {
  requestRef: string;
  decision: CommitmentDecision;
  owner: string;
  nextUpdateAtMs?: number;
  sessionKey?: string;
};

function sanitizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function createAction(params: {
  textVerbFirst: string;
  context?: GtdContext;
  energy?: GtdEnergy;
  estimateMin?: number;
  dueAtMs?: number;
  hardLandscape?: boolean;
  projectId?: string;
  linkedTo?: string;
}): ActionItem {
  const now = Date.now();
  return {
    id: generateUlid(),
    textVerbFirst: sanitizeText(params.textVerbFirst),
    context: params.context ?? "computer",
    energy: params.energy ?? "med",
    estimateMin: Math.max(1, Math.trunc(params.estimateMin ?? 25)),
    dueAtMs: params.dueAtMs,
    hardLandscape: params.hardLandscape === true,
    projectId: params.projectId,
    linkedTo: params.linkedTo,
    status: "active",
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function ensureCalendarMirrorForHardLandscape(state: GtdState, action: ActionItem): void {
  if (!action.hardLandscape || action.dueAtMs == null) {
    return;
  }

  const existing = state.calendarItems.find((item) => item.id === action.id);
  const now = Date.now();
  const calendarStart = action.dueAtMs;
  const calendarEnd = action.dueAtMs + Math.max(15, action.estimateMin) * 60 * 1000;

  if (existing) {
    existing.title = action.textVerbFirst;
    existing.startMs = calendarStart;
    existing.endMs = calendarEnd;
    existing.allDay = false;
    existing.hardLandscape = true;
    existing.source = existing.source;
    existing.updatedAtMs = now;
    return;
  }

  const created: CalendarItem = {
    id: action.id,
    title: action.textVerbFirst,
    startMs: calendarStart,
    endMs: calendarEnd,
    allDay: false,
    hardLandscape: true,
    source: "gtd",
    createdAtMs: now,
    updatedAtMs: now,
  };
  state.calendarItems.push(created);
}

export function capture(state: GtdState, input: CaptureInput): InboxItem {
  const now = Date.now();
  const item: InboxItem = {
    id: generateUlid(),
    rawText: input.rawText.trim(),
    source: input.source,
    capturedAtMs: now,
    createdAtMs: now,
    updatedAtMs: now,
    sessionKey: input.sessionKey,
    status: "captured",
  };
  state.inboxItems.push(item);
  state.updatedAtMs = now;
  return item;
}

export function clarify(
  state: GtdState,
  input: ClarifyInput,
): {
  inbox: InboxItem;
  action?: ActionItem;
  projectId?: string;
  note: string;
} {
  const inbox = state.inboxItems.find((item) => item.id === input.inboxId);
  if (!inbox) {
    throw new Error(`Inbox item not found: ${input.inboxId}`);
  }

  inbox.actionable = input.actionable;
  inbox.updatedAtMs = Date.now();

  if (!input.actionable) {
    if (input.destination === "reference") {
      const ref: ReferenceItem = {
        id: generateUlid(),
        title: sanitizeText(inbox.rawText).slice(0, 120) || "Reference",
        kind: "captured",
        uriOrText: inbox.rawText,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      };
      state.references.push(ref);
      inbox.status = "organized";
      return { inbox, note: "Moved to reference." };
    }
    if (input.destination === "someday") {
      state.somedayMaybe.push({
        id: generateUlid(),
        title: sanitizeText(inbox.rawText).slice(0, 160) || "Someday",
        reason: "captured from clarify",
        status: "active",
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      inbox.status = "organized";
      return { inbox, note: "Moved to someday/maybe." };
    }
    inbox.status = "trashed";
    return { inbox, note: "Marked as trash." };
  }

  if (!input.nextAction || !input.nextAction.textVerbFirst?.trim()) {
    throw new Error("actionable clarify requires nextAction.textVerbFirst");
  }

  let projectId = input.project?.id?.trim();
  if (!projectId && input.project?.outcome?.trim()) {
    const projectNow = Date.now();
    const project = {
      id: generateUlid(),
      outcome: input.project.outcome.trim(),
      status: "active" as const,
      supportRefs: [],
      createdAtMs: projectNow,
      updatedAtMs: projectNow,
    };
    state.projects.push(project);
    projectId = project.id;
  }

  const action = createAction({
    textVerbFirst: input.nextAction.textVerbFirst,
    context: input.nextAction.context,
    energy: input.nextAction.energy,
    estimateMin: input.nextAction.estimateMin,
    dueAtMs: input.nextAction.dueAtMs,
    hardLandscape: input.nextAction.hardLandscape,
    projectId,
    linkedTo: projectId,
  });

  state.actions.push(action);
  ensureCalendarMirrorForHardLandscape(state, action);

  if (projectId) {
    const project = state.projects.find((item) => item.id === projectId);
    if (project) {
      project.nextActionId = action.id;
      project.updatedAtMs = Date.now();
    }
  }

  inbox.outcome = input.outcome?.trim() || input.project?.outcome?.trim() || undefined;
  inbox.nextActionId = action.id;
  inbox.projectId = projectId;

  if (action.estimateMin <= 2) {
    action.status = "done";
    action.updatedAtMs = Date.now();
    inbox.status = "organized";
    return {
      inbox,
      action,
      projectId,
      note: "Two-minute rule applied: action completed immediately.",
    };
  }

  inbox.status = "clarified";
  return { inbox, action, projectId, note: "Clarified actionable item." };
}

export function organize(
  state: GtdState,
  input: OrganizeInput,
): { inbox: InboxItem; note: string } {
  const inbox = state.inboxItems.find((item) => item.id === input.inboxId);
  if (!inbox) {
    throw new Error(`Inbox item not found: ${input.inboxId}`);
  }

  switch (input.container) {
    case "reference": {
      state.references.push({
        id: generateUlid(),
        title: sanitizeText(inbox.rawText).slice(0, 120) || "Reference",
        kind: "captured",
        uriOrText: inbox.rawText,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      break;
    }
    case "someday": {
      state.somedayMaybe.push({
        id: generateUlid(),
        title: sanitizeText(inbox.rawText).slice(0, 160) || "Someday",
        reason: "organized from inbox",
        status: "active",
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      break;
    }
    case "calendar": {
      if (!input.actionId) {
        throw new Error("calendar organize requires actionId");
      }
      const action = state.actions.find((item) => item.id === input.actionId);
      if (!action) {
        throw new Error(`Action not found: ${input.actionId}`);
      }
      if (action.dueAtMs == null) {
        throw new Error("Hard landscape requires a concrete dueAtMs");
      }
      action.hardLandscape = true;
      action.updatedAtMs = Date.now();
      ensureCalendarMirrorForHardLandscape(state, action);
      break;
    }
    case "projects": {
      if (!input.projectId) {
        throw new Error("projects organize requires projectId");
      }
      const project = state.projects.find((item) => item.id === input.projectId);
      if (!project) {
        throw new Error(`Project not found: ${input.projectId}`);
      }
      inbox.projectId = project.id;
      break;
    }
    case "waiting_for": {
      if (!input.waitingId) {
        throw new Error("waiting_for organize requires waitingId");
      }
      const waiting = state.waitingFor.find((item) => item.id === input.waitingId);
      if (!waiting) {
        throw new Error(`Waiting-for item not found: ${input.waitingId}`);
      }
      break;
    }
    case "next_actions":
    default:
      break;
  }

  inbox.status = "organized";
  inbox.updatedAtMs = Date.now();
  return { inbox, note: `Organized into ${input.container}.` };
}

export function addWaitingFor(state: GtdState, input: WaitingInput): WaitingForItem {
  const now = Date.now();
  const item: WaitingForItem = {
    id: generateUlid(),
    who: sanitizeText(input.who),
    what: sanitizeText(input.what),
    sinceMs: now,
    followupAtMs: input.followupAtMs ?? now + 5 * 24 * 60 * 60 * 1000,
    followupCadenceDays: Math.max(1, Math.trunc(input.followupCadenceDays ?? 5)),
    deliveryTarget: input.deliveryTarget,
    status: "active",
    createdAtMs: now,
    updatedAtMs: now,
  };
  state.waitingFor.push(item);
  return item;
}

export function resolveWaitingFor(state: GtdState, waitingId: string): WaitingForItem {
  const waiting = state.waitingFor.find((item) => item.id === waitingId);
  if (!waiting) {
    throw new Error(`Waiting-for item not found: ${waitingId}`);
  }
  waiting.status = "resolved";
  waiting.updatedAtMs = Date.now();
  return waiting;
}

export function addCommitment(state: GtdState, input: CommitmentInput): CommitmentItem {
  const now = Date.now();
  const commitment: CommitmentItem = {
    id: generateUlid(),
    requestRef: sanitizeText(input.requestRef),
    decision: input.decision,
    nextUpdateAtMs: input.nextUpdateAtMs,
    owner: sanitizeText(input.owner),
    sessionKey: input.sessionKey,
    createdAtMs: now,
    updatedAtMs: now,
  };
  state.commitments.push(commitment);
  return commitment;
}

export function inferCommitmentDecisionFromText(text: string): CommitmentDecision | null {
  const normalized = text.toLowerCase();
  if (
    normalized.includes("i will") ||
    normalized.includes("ik doe") ||
    normalized.includes("accepted")
  ) {
    return "accepted";
  }
  if (
    normalized.includes("i can't") ||
    normalized.includes("ik kan niet") ||
    normalized.includes("decline")
  ) {
    return "declined";
  }
  if (
    normalized.includes("need info") ||
    normalized.includes("meer info") ||
    normalized.includes("clarify")
  ) {
    return "needs_info";
  }
  if (
    normalized.includes("later") ||
    normalized.includes("kom erop terug") ||
    normalized.includes("defer")
  ) {
    return "deferred";
  }
  return null;
}

export function engage(
  state: GtdState,
  input: EngageInput,
): ReturnType<typeof rankActionsForEngage> {
  return rankActionsForEngage(state.actions, input);
}

export function runReview(state: GtdState, kind: "daily" | "weekly" | "horizons"): string[] {
  if (kind === "daily") {
    return runDailyInboxZero(state);
  }
  if (kind === "weekly") {
    return runWeeklyReview(state);
  }
  return runHorizonsReview(state);
}

export function runNaturalPlan(state: GtdState, input: NaturalPlanInput) {
  return applyNaturalPlanning(state, input);
}

export function updateHorizons(
  state: GtdState,
  input: {
    purpose?: string;
    vision?: string;
    addGoal?: string;
    addArea?: string;
    linkProjectId?: string;
    linkGoalId?: string;
    linkAreaId?: string;
  },
): void {
  if (input.purpose != null || input.vision != null) {
    setPurposeAndVision(state, input.purpose, input.vision);
  }
  if (input.addGoal?.trim()) {
    upsertGoal(state, input.addGoal);
  }
  if (input.addArea?.trim()) {
    upsertArea(state, input.addArea);
  }
  if (input.linkProjectId?.trim()) {
    linkProjectToHorizons(state, input.linkProjectId, {
      goalId: input.linkGoalId,
      areaId: input.linkAreaId,
    });
  }
}

export function buildStatusSummary(state: GtdState): Record<string, unknown> {
  return {
    updatedAtMs: state.updatedAtMs,
    inboxOpen: state.inboxItems.filter((item) => item.status !== "trashed").length,
    inboxUnorganized: state.inboxItems.filter(
      (item) => item.status === "captured" || item.status === "clarified",
    ).length,
    activeActions: state.actions.filter((item) => item.status === "active").length,
    activeProjects: state.projects.filter((item) => item.status === "active").length,
    waitingFor: state.waitingFor.filter((item) => item.status === "active").length,
    someday: state.somedayMaybe.filter((item) => item.status === "active").length,
    hardLandscape: state.calendarItems.filter((item) => item.hardLandscape).length,
    lastDailyReviewAtMs: state.reviews.lastDailyAtMs,
    lastWeeklyReviewAtMs: state.reviews.lastWeeklyAtMs,
    lastHorizonsReviewAtMs: state.reviews.lastHorizonsAtMs,
    lastCalendarSyncAtMs: state.sync.google.lastSuccessfulAtMs,
    lastCalendarSyncError: state.sync.google.lastError,
    schedulerLastReconciledAtMs: state.scheduler.lastReconciledAtMs,
    schedulerLastError: state.scheduler.lastError,
  };
}
