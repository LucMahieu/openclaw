import { generateUlid } from "./canonical-json.js";
import type { ActionItem, GtdState, ReviewKind } from "./schema.js";

function pushReviewRun(state: GtdState, kind: ReviewKind, notes: string[]): void {
  state.reviews.runs.push({
    id: generateUlid(),
    kind,
    runAtMs: Date.now(),
    notes,
  });
  const now = Date.now();
  if (kind === "daily") {
    state.reviews.lastDailyAtMs = now;
  }
  if (kind === "weekly") {
    state.reviews.lastWeeklyAtMs = now;
  }
  if (kind === "horizons") {
    state.reviews.lastHorizonsAtMs = now;
  }
}

export function runDailyInboxZero(state: GtdState): string[] {
  const notes: string[] = [];
  const open = state.inboxItems.filter(
    (item) => item.status === "captured" || item.status === "clarified",
  );
  if (open.length === 0) {
    notes.push("Inbox already at zero.");
  } else {
    notes.push(`Inbox has ${open.length} unorganized item(s).`);
  }
  pushReviewRun(state, "daily", notes);
  return notes;
}

function createProjectHygieneAction(projectId: string, outcome: string): ActionItem {
  const now = Date.now();
  return {
    id: generateUlid(),
    textVerbFirst: `Define next action for project: ${outcome}`,
    context: "deep_work",
    energy: "med",
    estimateMin: 10,
    projectId,
    linkedTo: projectId,
    hardLandscape: false,
    status: "active",
    createdAtMs: now,
    updatedAtMs: now,
  };
}

export function runWeeklyReview(state: GtdState): string[] {
  const notes: string[] = [];
  let createdActions = 0;

  for (const project of state.projects) {
    if (project.status !== "active") {
      continue;
    }
    const next = project.nextActionId
      ? state.actions.find(
          (action) => action.id === project.nextActionId && action.status === "active",
        )
      : undefined;
    if (next) {
      continue;
    }

    const fallback = state.actions.find(
      (action) => action.projectId === project.id && action.status === "active",
    );
    if (fallback) {
      project.nextActionId = fallback.id;
      project.updatedAtMs = Date.now();
      continue;
    }

    const created = createProjectHygieneAction(project.id, project.outcome);
    state.actions.push(created);
    project.nextActionId = created.id;
    project.updatedAtMs = Date.now();
    createdActions += 1;
  }

  if (createdActions > 0) {
    notes.push(`Created ${createdActions} project hygiene next action(s).`);
  } else {
    notes.push("All active projects already have a next action.");
  }

  pushReviewRun(state, "weekly", notes);
  return notes;
}

export function runHorizonsReview(state: GtdState): string[] {
  const notes: string[] = [];
  const linkedProjectIds = new Set(state.horizons.projectLinks.map((entry) => entry.projectId));
  const unlinked = state.projects.filter(
    (project) => project.status === "active" && !linkedProjectIds.has(project.id),
  );

  if (unlinked.length > 0) {
    notes.push(`Unlinked active projects: ${unlinked.length}`);
  } else {
    notes.push("All active projects are linked to horizons metadata.");
  }

  state.horizons.updatedAtMs = Date.now();
  pushReviewRun(state, "horizons", notes);
  return notes;
}
