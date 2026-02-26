import type { ActionItem, GtdEnergy } from "./schema.js";

export type EngageInput = {
  context?: string;
  timeAvailableMin?: number;
  energy?: GtdEnergy;
};

export type EngageCandidate = {
  action: ActionItem;
  score: number;
  reasons: string[];
};

const energyWeight: Record<GtdEnergy, number> = {
  low: 1,
  med: 2,
  high: 3,
};

export function rankActionsForEngage(actions: ActionItem[], input: EngageInput): EngageCandidate[] {
  const now = Date.now();
  const results: EngageCandidate[] = [];

  for (const action of actions) {
    if (action.status !== "active") {
      continue;
    }

    let score = 0;
    const reasons: string[] = [];

    if (input.context && action.context === input.context) {
      score += 50;
      reasons.push("context match");
    }

    if (input.timeAvailableMin != null) {
      if (action.estimateMin <= input.timeAvailableMin) {
        score += 25;
        reasons.push("fits available time");
      } else {
        score -= 30;
        reasons.push("too large for available time");
      }
    }

    if (input.energy) {
      const demand = energyWeight[action.energy];
      const available = energyWeight[input.energy];
      if (demand <= available) {
        score += 15;
        reasons.push("fits available energy");
      } else {
        score -= 20;
        reasons.push("energy mismatch");
      }
    }

    if (action.hardLandscape) {
      score += 12;
      reasons.push("hard landscape");
    }

    if (action.dueAtMs != null) {
      const delta = action.dueAtMs - now;
      if (delta <= 0) {
        score += 40;
        reasons.push("overdue");
      } else if (delta < 6 * 60 * 60 * 1000) {
        score += 20;
        reasons.push("due soon");
      } else if (delta < 24 * 60 * 60 * 1000) {
        score += 10;
        reasons.push("due today");
      }
    }

    // Prefer small concrete steps when ties happen.
    score += Math.max(0, 10 - Math.min(10, action.estimateMin));

    results.push({ action, score, reasons });
  }

  return results.toSorted((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    if (a.action.createdAtMs !== b.action.createdAtMs) {
      return a.action.createdAtMs - b.action.createdAtMs;
    }
    return a.action.id.localeCompare(b.action.id);
  });
}
