import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { syncGoogleCalendar } from "./calendar/google.js";
import {
  addCommitment,
  addWaitingFor,
  buildStatusSummary,
  capture,
  clarify,
  engage,
  organize,
  resolveWaitingFor,
  runNaturalPlan,
  runReview,
  updateHorizons,
} from "./engine.js";
import { loadState, saveState, type GtdStoreContext } from "./store.js";

const GtdToolSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    action: {
      type: "string",
      enum: [
        "status",
        "capture",
        "clarify",
        "organize",
        "engage",
        "waiting_add",
        "waiting_resolve",
        "commitment",
        "natural_plan",
        "review",
        "horizons_update",
        "calendar_sync",
      ],
    },
  },
  required: ["action"],
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} required`);
  }
  return value.trim();
}

export function createGtdTool(params: {
  storeContext: GtdStoreContext;
  agentId: string;
}): AnyAgentTool {
  return {
    name: "gtd",
    label: "GTD",
    description:
      "Run GTD capture/clarify/organize/reflect/engage operations with canonical JSON state and markdown views.",
    parameters: GtdToolSchema,
    execute: async (_toolCallId, args) => {
      const input = asRecord(args);
      const action = requiredString(input.action, "action");
      const state = await loadState(params.storeContext, params.agentId);

      if (action === "status") {
        return jsonResult({ ok: true, status: buildStatusSummary(state) });
      }

      if (action === "capture") {
        const created = capture(state, {
          rawText: requiredString(input.rawText, "rawText"),
          source: typeof input.source === "string" ? input.source : "tool",
          sessionKey: typeof input.sessionKey === "string" ? input.sessionKey : undefined,
          owner: params.agentId,
        });
        await saveState(params.storeContext, params.agentId, state, {
          auditReason: "tool:capture",
        });
        return jsonResult({ ok: true, item: created });
      }

      if (action === "clarify") {
        const nextActionRaw = asRecord(input.nextAction);
        const result = clarify(state, {
          inboxId: requiredString(input.inboxId, "inboxId"),
          actionable: input.actionable !== false,
          destination:
            typeof input.destination === "string"
              ? (input.destination as "trash" | "reference" | "someday")
              : undefined,
          outcome: typeof input.outcome === "string" ? input.outcome : undefined,
          nextAction:
            Object.keys(nextActionRaw).length > 0
              ? {
                  textVerbFirst: requiredString(
                    nextActionRaw.textVerbFirst,
                    "nextAction.textVerbFirst",
                  ),
                  context:
                    typeof nextActionRaw.context === "string" ? nextActionRaw.context : undefined,
                  energy:
                    typeof nextActionRaw.energy === "string"
                      ? (nextActionRaw.energy as "low" | "med" | "high")
                      : undefined,
                  estimateMin:
                    typeof nextActionRaw.estimateMin === "number"
                      ? nextActionRaw.estimateMin
                      : undefined,
                  dueAtMs:
                    typeof nextActionRaw.dueAtMs === "number" ? nextActionRaw.dueAtMs : undefined,
                  hardLandscape: nextActionRaw.hardLandscape === true,
                }
              : undefined,
          project:
            input.project && typeof input.project === "object"
              ? {
                  id:
                    typeof asRecord(input.project).id === "string"
                      ? (asRecord(input.project).id as string)
                      : undefined,
                  outcome:
                    typeof asRecord(input.project).outcome === "string"
                      ? (asRecord(input.project).outcome as string)
                      : undefined,
                }
              : undefined,
        });
        await saveState(params.storeContext, params.agentId, state, {
          auditReason: "tool:clarify",
        });
        return jsonResult({ ok: true, ...result });
      }

      if (action === "organize") {
        const result = organize(state, {
          inboxId: requiredString(input.inboxId, "inboxId"),
          container: requiredString(input.container, "container") as
            | "calendar"
            | "next_actions"
            | "projects"
            | "waiting_for"
            | "someday"
            | "reference",
          actionId: typeof input.actionId === "string" ? input.actionId : undefined,
          projectId: typeof input.projectId === "string" ? input.projectId : undefined,
          waitingId: typeof input.waitingId === "string" ? input.waitingId : undefined,
        });
        await saveState(params.storeContext, params.agentId, state, {
          auditReason: "tool:organize",
        });
        return jsonResult({ ok: true, ...result });
      }

      if (action === "engage") {
        const ranked = engage(state, {
          context: typeof input.context === "string" ? input.context : undefined,
          timeAvailableMin:
            typeof input.timeAvailableMin === "number"
              ? Math.trunc(input.timeAvailableMin)
              : undefined,
          energy:
            typeof input.energy === "string" ? (input.energy as "low" | "med" | "high") : undefined,
        }).slice(0, 3);
        return jsonResult({
          ok: true,
          choices: ranked.map((entry) => ({
            id: entry.action.id,
            textVerbFirst: entry.action.textVerbFirst,
            context: entry.action.context,
            score: entry.score,
            reasons: entry.reasons,
          })),
        });
      }

      if (action === "waiting_add") {
        const created = addWaitingFor(state, {
          who: requiredString(input.who, "who"),
          what: requiredString(input.what, "what"),
          followupAtMs: typeof input.followupAtMs === "number" ? input.followupAtMs : undefined,
          followupCadenceDays:
            typeof input.followupCadenceDays === "number" ? input.followupCadenceDays : undefined,
          deliveryTarget:
            input.deliveryTarget && typeof input.deliveryTarget === "object"
              ? {
                  channel: requiredString(
                    asRecord(input.deliveryTarget).channel,
                    "deliveryTarget.channel",
                  ),
                  to: requiredString(asRecord(input.deliveryTarget).to, "deliveryTarget.to"),
                  accountId:
                    typeof asRecord(input.deliveryTarget).accountId === "string"
                      ? (asRecord(input.deliveryTarget).accountId as string)
                      : undefined,
                  sessionKey:
                    typeof asRecord(input.deliveryTarget).sessionKey === "string"
                      ? (asRecord(input.deliveryTarget).sessionKey as string)
                      : undefined,
                  threadId:
                    typeof asRecord(input.deliveryTarget).threadId === "string"
                      ? (asRecord(input.deliveryTarget).threadId as string)
                      : undefined,
                }
              : undefined,
        });
        await saveState(params.storeContext, params.agentId, state, {
          auditReason: "tool:waiting_add",
        });
        return jsonResult({ ok: true, item: created });
      }

      if (action === "waiting_resolve") {
        const item = resolveWaitingFor(state, requiredString(input.waitingId, "waitingId"));
        await saveState(params.storeContext, params.agentId, state, {
          auditReason: "tool:waiting_resolve",
        });
        return jsonResult({ ok: true, item });
      }

      if (action === "commitment") {
        const commitment = addCommitment(state, {
          requestRef: requiredString(input.requestRef, "requestRef"),
          decision: requiredString(input.decision, "decision") as
            | "accepted"
            | "declined"
            | "deferred"
            | "needs_info",
          owner: typeof input.owner === "string" ? input.owner : params.agentId,
          nextUpdateAtMs:
            typeof input.nextUpdateAtMs === "number" ? input.nextUpdateAtMs : undefined,
          sessionKey: typeof input.sessionKey === "string" ? input.sessionKey : undefined,
        });
        await saveState(params.storeContext, params.agentId, state, {
          auditReason: "tool:commitment",
        });
        return jsonResult({ ok: true, item: commitment });
      }

      if (action === "natural_plan") {
        const result = runNaturalPlan(state, {
          purpose: typeof input.purpose === "string" ? input.purpose : undefined,
          principles: Array.isArray(input.principles)
            ? input.principles.filter((entry): entry is string => typeof entry === "string")
            : undefined,
          vision: typeof input.vision === "string" ? input.vision : undefined,
          brainstorm: Array.isArray(input.brainstorm)
            ? input.brainstorm.filter((entry): entry is string => typeof entry === "string")
            : undefined,
          structure: Array.isArray(input.structure)
            ? input.structure.filter((entry): entry is string => typeof entry === "string")
            : undefined,
          nextActions: Array.isArray(input.nextActions)
            ? input.nextActions.filter((entry): entry is string => typeof entry === "string")
            : undefined,
          createProject: input.createProject !== false,
        });
        await saveState(params.storeContext, params.agentId, state, {
          auditReason: "tool:natural_plan",
        });
        return jsonResult({ ok: true, ...result });
      }

      if (action === "review") {
        const kind = requiredString(input.kind, "kind") as "daily" | "weekly" | "horizons";
        const notes = runReview(state, kind);
        await saveState(params.storeContext, params.agentId, state, {
          auditReason: `tool:review:${kind}`,
        });
        return jsonResult({ ok: true, kind, notes });
      }

      if (action === "horizons_update") {
        updateHorizons(state, {
          purpose: typeof input.purpose === "string" ? input.purpose : undefined,
          vision: typeof input.vision === "string" ? input.vision : undefined,
          addGoal: typeof input.addGoal === "string" ? input.addGoal : undefined,
          addArea: typeof input.addArea === "string" ? input.addArea : undefined,
          linkProjectId: typeof input.linkProjectId === "string" ? input.linkProjectId : undefined,
          linkGoalId: typeof input.linkGoalId === "string" ? input.linkGoalId : undefined,
          linkAreaId: typeof input.linkAreaId === "string" ? input.linkAreaId : undefined,
        });
        await saveState(params.storeContext, params.agentId, state, {
          auditReason: "tool:horizons_update",
        });
        return jsonResult({ ok: true, horizons: state.horizons });
      }

      if (action === "calendar_sync") {
        const summary = await syncGoogleCalendar({
          ctx: params.storeContext,
          agentId: params.agentId,
          state,
        });
        await saveState(params.storeContext, params.agentId, state, {
          auditReason: "tool:calendar_sync",
        });
        return jsonResult({ ok: summary.ok, summary });
      }

      throw new Error(`Unknown gtd action: ${action}`);
    },
  };
}
