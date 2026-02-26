import type { CodexHandoffPhase } from "./types.js";

export function isTerminalPhase(phase: CodexHandoffPhase): boolean {
  return phase === "done" || phase === "failed" || phase === "cancelled";
}

export function normalizeRetryBackoffSeconds(values: unknown): number[] {
  if (!Array.isArray(values)) {
    return [60, 120, 300];
  }
  const normalized = values
    .map((value) => (typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN))
    .filter((value) => Number.isFinite(value) && value > 0)
    .slice(0, 10);
  return normalized.length > 0 ? normalized : [60, 120, 300];
}
