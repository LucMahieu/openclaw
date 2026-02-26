import type { OpenClawPluginApi, OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk";
import { syncGoogleCalendar } from "./calendar/google.js";
import { buildStatusSummary, engage, runReview } from "./engine.js";
import { loadState, resolveDefaultAgentId, saveState, type GtdStoreContext } from "./store.js";

function formatHelp(): string {
  return [
    "GTD commands:",
    "/gtd status",
    "/gtd inbox",
    "/gtd next",
    "/gtd waiting",
    "/gtd review-now [daily|weekly|horizons]",
    "/gtd calendar-sync-now",
  ].join("\n");
}

function toShortJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function createGtdCommand(params: {
  api: OpenClawPluginApi;
  storeContext: GtdStoreContext;
}): OpenClawPluginCommandDefinition {
  const { api, storeContext } = params;

  return {
    name: "gtd",
    description: "Show GTD status and run GTD maintenance actions",
    acceptsArgs: true,
    handler: async (ctx) => {
      const tokens = (ctx.args ?? "")
        .split(/\s+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
      const sub = (tokens[0] ?? "status").toLowerCase();
      const agentId = resolveDefaultAgentId(api.config);

      if (sub === "help") {
        return { text: formatHelp() };
      }

      const state = await loadState(storeContext, agentId);

      if (sub === "status") {
        return { text: toShortJson(buildStatusSummary(state)) };
      }

      if (sub === "inbox") {
        const lines = state.inboxItems
          .slice(-20)
          .map((item) => `- [${item.status}] ${item.rawText}`);
        return { text: lines.length > 0 ? lines.join("\n") : "Inbox empty." };
      }

      if (sub === "next") {
        const ranked = engage(state, {
          context: "computer",
          timeAvailableMin: 60,
          energy: "med",
        }).slice(0, 5);
        const lines = ranked.map(
          (entry) =>
            `- ${entry.action.textVerbFirst} (score=${entry.score}; ${entry.reasons.join(", ")})`,
        );
        return { text: lines.length > 0 ? lines.join("\n") : "No active actions." };
      }

      if (sub === "waiting") {
        const lines = state.waitingFor
          .filter((item) => item.status === "active")
          .map(
            (item) =>
              `- ${item.who}: ${item.what} (follow-up ${new Date(item.followupAtMs).toISOString()})`,
          );
        return { text: lines.length > 0 ? lines.join("\n") : "No active waiting-for items." };
      }

      if (sub === "review-now") {
        const kind = (tokens[1] ?? "weekly").toLowerCase();
        const reviewKind =
          kind === "daily" || kind === "weekly" || kind === "horizons" ? kind : "weekly";
        const notes = runReview(state, reviewKind);
        await saveState(storeContext, agentId, state, {
          auditReason: `command:review-now:${reviewKind}`,
        });
        return { text: `Review (${reviewKind}) complete:\n- ${notes.join("\n- ")}` };
      }

      if (sub === "calendar-sync-now") {
        const result = await syncGoogleCalendar({
          ctx: storeContext,
          agentId,
          state,
        });
        await saveState(storeContext, agentId, state, {
          auditReason: "command:calendar-sync-now",
        });
        return { text: toShortJson(result) };
      }

      return { text: formatHelp() };
    },
  };
}
