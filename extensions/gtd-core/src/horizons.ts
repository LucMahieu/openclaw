import { generateUlid } from "./canonical-json.js";
import type { GtdState, HorizonArea, HorizonGoal } from "./schema.js";

export function upsertGoal(state: GtdState, title: string, goalId?: string): HorizonGoal {
  const cleaned = title.trim();
  if (!cleaned) {
    throw new Error("goal title required");
  }
  const now = Date.now();
  const existing = goalId ? state.horizons.goals.find((goal) => goal.id === goalId) : undefined;
  if (existing) {
    existing.title = cleaned;
    existing.updatedAtMs = now;
    state.horizons.updatedAtMs = now;
    return existing;
  }
  const created: HorizonGoal = {
    id: goalId?.trim() || generateUlid(),
    title: cleaned,
    createdAtMs: now,
    updatedAtMs: now,
  };
  state.horizons.goals.push(created);
  state.horizons.updatedAtMs = now;
  return created;
}

export function upsertArea(state: GtdState, title: string, areaId?: string): HorizonArea {
  const cleaned = title.trim();
  if (!cleaned) {
    throw new Error("area title required");
  }
  const now = Date.now();
  const existing = areaId ? state.horizons.areas.find((area) => area.id === areaId) : undefined;
  if (existing) {
    existing.title = cleaned;
    existing.updatedAtMs = now;
    state.horizons.updatedAtMs = now;
    return existing;
  }
  const created: HorizonArea = {
    id: areaId?.trim() || generateUlid(),
    title: cleaned,
    createdAtMs: now,
    updatedAtMs: now,
  };
  state.horizons.areas.push(created);
  state.horizons.updatedAtMs = now;
  return created;
}

export function setPurposeAndVision(state: GtdState, purpose?: string, vision?: string): void {
  state.horizons.purpose = purpose?.trim() || undefined;
  state.horizons.vision = vision?.trim() || undefined;
  state.horizons.updatedAtMs = Date.now();
}

export function linkProjectToHorizons(
  state: GtdState,
  projectId: string,
  opts?: { areaId?: string; goalId?: string },
): void {
  const cleanedProjectId = projectId.trim();
  if (!cleanedProjectId) {
    throw new Error("projectId required");
  }
  const now = Date.now();
  const existing = state.horizons.projectLinks.find(
    (entry) => entry.projectId === cleanedProjectId,
  );
  if (existing) {
    existing.areaId = opts?.areaId?.trim() || undefined;
    existing.goalId = opts?.goalId?.trim() || undefined;
    state.horizons.updatedAtMs = now;
    return;
  }
  state.horizons.projectLinks.push({
    projectId: cleanedProjectId,
    areaId: opts?.areaId?.trim() || undefined,
    goalId: opts?.goalId?.trim() || undefined,
  });
  state.horizons.updatedAtMs = now;
}
