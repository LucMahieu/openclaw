import { generateUlid } from "./canonical-json.js";
import type { ActionItem, GtdState, NaturalPlanItem, ProjectItem } from "./schema.js";

export type NaturalPlanInput = {
  purpose?: string;
  principles?: string[];
  vision?: string;
  brainstorm?: string[];
  structure?: string[];
  nextActions?: string[];
  createProject?: boolean;
};

function createActionFromText(text: string, projectId?: string): ActionItem {
  const now = Date.now();
  return {
    id: generateUlid(),
    textVerbFirst: text,
    context: "deep_work",
    energy: "med",
    estimateMin: 30,
    linkedTo: projectId,
    projectId,
    hardLandscape: false,
    status: "active",
    createdAtMs: now,
    updatedAtMs: now,
  };
}

export function applyNaturalPlanning(
  state: GtdState,
  input: NaturalPlanInput,
): {
  plan: NaturalPlanItem;
  project?: ProjectItem;
  actionIds: string[];
} {
  const now = Date.now();
  const nextActionTexts = (input.nextActions ?? []).map((entry) => entry.trim()).filter(Boolean);

  let project: ProjectItem | undefined;
  if (input.createProject !== false && input.vision?.trim()) {
    project = {
      id: generateUlid(),
      outcome: input.vision.trim(),
      status: "active",
      supportRefs: [],
      createdAtMs: now,
      updatedAtMs: now,
    };
    state.projects.push(project);
  }

  const actionIds: string[] = [];
  for (const text of nextActionTexts) {
    const action = createActionFromText(text, project?.id);
    state.actions.push(action);
    actionIds.push(action.id);
  }

  if (project && actionIds.length > 0) {
    project.nextActionId = actionIds[0];
  }

  const plan: NaturalPlanItem = {
    id: generateUlid(),
    purpose: input.purpose?.trim() || undefined,
    principles: (input.principles ?? []).map((entry) => entry.trim()).filter(Boolean),
    vision: input.vision?.trim() || undefined,
    brainstorm: (input.brainstorm ?? []).map((entry) => entry.trim()).filter(Boolean),
    structure: (input.structure ?? []).map((entry) => entry.trim()).filter(Boolean),
    nextActions: nextActionTexts,
    projectId: project?.id,
    createdAtMs: now,
    updatedAtMs: now,
  };

  state.naturalPlans.push(plan);
  return { plan, project, actionIds };
}
