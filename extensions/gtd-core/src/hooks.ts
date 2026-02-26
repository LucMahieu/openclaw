import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  addCommitment,
  capture,
  inferCommitmentDecisionFromText,
  type CommitmentInput,
} from "./engine.js";
import type { ResolvedGtdPluginConfig } from "./schema.js";
import { loadState, resolveDefaultAgentId, saveState, type GtdStoreContext } from "./store.js";

function shouldCapturePrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("read heartbeat.md")) {
    return false;
  }
  if (lower === "heartbeat_ok") {
    return false;
  }
  if (trimmed.startsWith("/")) {
    return false;
  }
  if (lower.includes("heartbeat poll") || lower.includes("heartbeat wake")) {
    return false;
  }
  if (lower.includes("gtd_scheduler_tick")) {
    return false;
  }
  if (lower.startsWith("codex_watchdog")) {
    return false;
  }
  return true;
}

function looksLikeExplicitRequest(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return (
    lower.includes("?") ||
    lower.includes("please") ||
    lower.includes("kun je") ||
    lower.includes("kan je") ||
    lower.includes("could you") ||
    lower.includes("can you") ||
    lower.includes("need") ||
    lower.includes("moet")
  );
}

function extractTextFromAgentMessage(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const obj = message as { content?: unknown };
  if (!Array.isArray(obj.content)) {
    return null;
  }
  const texts = obj.content
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const asText = entry as { type?: unknown; text?: unknown };
      if (asText.type !== "text" || typeof asText.text !== "string") {
        return null;
      }
      return asText.text;
    })
    .filter((value): value is string => typeof value === "string");
  if (texts.length === 0) {
    return null;
  }
  return texts.join("\n\n");
}

function appendTextToAgentMessage(message: unknown, line: string): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const obj = message as { content?: unknown };
  if (!Array.isArray(obj.content)) {
    return message;
  }
  for (const entry of obj.content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const asText = entry as { type?: unknown; text?: unknown };
    if (asText.type !== "text" || typeof asText.text !== "string") {
      continue;
    }
    asText.text = `${asText.text}\n\n${line}`;
    return message;
  }
  obj.content.push({ type: "text", text: line });
  return message;
}

export function registerGtdHooks(params: {
  api: OpenClawPluginApi;
  storeContext: GtdStoreContext;
  pluginConfig: ResolvedGtdPluginConfig;
}): void {
  const { api, storeContext, pluginConfig } = params;

  api.on("before_prompt_build", async (event, ctx) => {
    if (pluginConfig.mode !== "always_on") {
      return;
    }
    if (!shouldCapturePrompt(event.prompt)) {
      return;
    }

    const agentId = (ctx.agentId || resolveDefaultAgentId(api.config)).trim().toLowerCase();
    const prompt = event.prompt.trim().slice(0, 10_000);

    const state = await loadState(storeContext, agentId);
    const inbox = capture(state, {
      rawText: prompt,
      source: "before_prompt_build",
      sessionKey: ctx.sessionKey,
      owner: agentId,
    });

    if (looksLikeExplicitRequest(prompt)) {
      const commitment: CommitmentInput = {
        requestRef: inbox.id,
        decision: "needs_info",
        owner: agentId,
        nextUpdateAtMs: Date.now() + 60 * 60 * 1000,
        sessionKey: ctx.sessionKey,
      };
      addCommitment(state, commitment);
    }

    await saveState(storeContext, agentId, state, { auditReason: "hook:capture" });
  });

  api.on("before_message_write", (event, ctx) => {
    if (pluginConfig.mode !== "always_on") {
      return;
    }

    const messageText = extractTextFromAgentMessage(event.message);
    if (!messageText) {
      return;
    }

    const hasCommitmentSignal =
      messageText.toLowerCase().includes("status:") ||
      messageText.toLowerCase().includes("next update") ||
      inferCommitmentDecisionFromText(messageText) != null;

    if (!hasCommitmentSignal) {
      appendTextToAgentMessage(
        event.message,
        "Status: captured en geordend. Volgende update volgt via GTD-planning.",
      );
    }

    const agentId = (ctx.agentId || resolveDefaultAgentId(api.config)).trim().toLowerCase();
    void (async () => {
      const state = await loadState(storeContext, agentId);
      const decision = inferCommitmentDecisionFromText(messageText);

      const sessionCommitments = state.commitments
        .filter((item) => item.sessionKey && item.sessionKey === ctx.sessionKey)
        .toSorted((a, b) => b.createdAtMs - a.createdAtMs);
      const latest = sessionCommitments[0];

      if (latest && decision) {
        latest.decision = decision;
        latest.updatedAtMs = Date.now();
      }

      if (latest && !hasCommitmentSignal) {
        latest.decision = "deferred";
        latest.nextUpdateAtMs = Date.now() + 60 * 60 * 1000;
        latest.updatedAtMs = Date.now();
      }

      await saveState(storeContext, agentId, state, {
        auditReason: "hook:before_message_write",
      });
    })().catch((err) => {
      api.logger.warn(`[gtd-core] before_message_write hook failed: ${String(err)}`);
    });

    return { message: event.message };
  });
}
