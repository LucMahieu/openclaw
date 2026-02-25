import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";

const DEFAULT_MODEL = "nvidia/nemotron-3-nano-30b-a3b:free";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_RETRY_BACKOFF_MS = [200, 700];
const MAX_RESPONSE_CHARS = 180;
const CACHE_MAX_ENTRIES = 200;
const log = createSubsystemLogger("agent/toolcall-summary");

type ToolCallSummaryInput = {
  runId?: string;
  toolName: string;
  toolCallId: string;
  args: unknown;
  fallbackMeta?: string;
};

type OpenRouterChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

type SummaryAttemptResult = {
  ok: boolean;
  summary?: string;
  finishReason?: string;
  reason?: string;
  status?: number;
};

const summaryCache = new Map<string, string>();
const IMAGE_PATH_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif|svg)$/i;
const PROGRESSIVE_LEAD_MAP: Array<[RegExp, string]> = [
  [/^\s*run\b/i, "Running"],
  [/^\s*analyze\b/i, "Analyzing"],
  [/^\s*Runs\b/i, "Running"],
  [/^\s*Analyzes\b/i, "Analyzing"],
  [/^\s*Finds\b/i, "Finding"],
  [/^\s*Opens\b/i, "Opening"],
  [/^\s*Clicks\b/i, "Clicking"],
  [/^\s*Switches\b/i, "Switching"],
  [/^\s*Captures\b/i, "Capturing"],
  [/^\s*Extracts\b/i, "Extracting"],
  [/^\s*Returns\b/i, "Returning"],
  [/^\s*Locates\b/i, "Locating"],
  [/^\s*Waits\b/i, "Waiting"],
  [/^\s*Uses\b/i, "Using"],
  [/^\s*Types\b/i, "Typing"],
];

function normalizeKey(value: string | undefined): string {
  return (value ?? "").trim();
}

function resolveApiKey(): string | undefined {
  const envKey = process.env.OPENROUTER_API_KEY?.trim();
  if (envKey) {
    return envKey;
  }

  try {
    const store = ensureAuthProfileStore(undefined, { allowKeychainPrompt: false });
    const ordered = resolveAuthProfileOrder({ store, provider: "openrouter" });
    const fallback = listProfilesForProvider(store, "openrouter");
    const candidateIds = [...new Set([...ordered, ...fallback])];

    for (const profileId of candidateIds) {
      const credential = store.profiles[profileId];
      if (!credential) {
        continue;
      }
      if (credential.type === "api_key") {
        const key = credential.key?.trim();
        if (key) {
          return key;
        }
      }
      if (credential.type === "token") {
        const token = credential.token?.trim();
        if (token) {
          return token;
        }
      }
    }
  } catch {
    // Fall back to disabled summarizer behavior when auth store cannot be loaded.
  }

  return undefined;
}

function resolveEnabled(): boolean {
  const raw = process.env.OPENCLAW_TOOL_SUMMARY_ENABLED?.trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return raw !== "0" && raw !== "false" && raw !== "off";
}

function resolveModel(): string {
  return process.env.OPENCLAW_TOOL_SUMMARY_MODEL?.trim() || DEFAULT_MODEL;
}

function resolveBaseUrl(): string {
  const raw = process.env.OPENCLAW_TOOL_SUMMARY_BASE_URL?.trim();
  return (raw || DEFAULT_BASE_URL).replace(/\/$/, "");
}

function resolveTimeoutMs(): number {
  const raw = Number.parseInt(process.env.OPENCLAW_TOOL_SUMMARY_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(500, Math.min(raw, 15000));
}

function resolveRetryBackoffMs(): number[] {
  const raw = process.env.OPENCLAW_TOOL_SUMMARY_RETRY_BACKOFF_MS?.trim();
  if (!raw) {
    return [...DEFAULT_RETRY_BACKOFF_MS];
  }
  const parsed = raw
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.min(5000, Math.max(0, value)));
  if (parsed.length === 0) {
    return [...DEFAULT_RETRY_BACKOFF_MS];
  }
  return parsed;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function extractContentText(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join(" ")
    .trim();
}

function sanitizeSummary(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= MAX_RESPONSE_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_RESPONSE_CHARS - 1).trimEnd()}…`;
}

function normalizeProgressiveLead(value: string): string {
  for (const [pattern, replacement] of PROGRESSIVE_LEAD_MAP) {
    if (pattern.test(value)) {
      return value.replace(pattern, replacement);
    }
  }
  return value;
}

function extractStringArg(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function extractNumberArg(args: unknown, key: string): number | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractRecordArg(args: unknown, key: string): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function truncatePlain(value: string, max = 80): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function humanizeEveryMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "on a recurring interval";
  }
  if (ms % 3_600_000 === 0) {
    const h = Math.max(1, Math.round(ms / 3_600_000));
    return `every ${h}h`;
  }
  if (ms % 60_000 === 0) {
    const m = Math.max(1, Math.round(ms / 60_000));
    return `every ${m}m`;
  }
  const s = Math.max(1, Math.round(ms / 1000));
  return `every ${s}s`;
}

function summarizeCronSchedule(schedule: unknown): string | undefined {
  if (!schedule || typeof schedule !== "object") {
    return undefined;
  }
  const record = schedule as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind.trim().toLowerCase() : "";
  if (kind === "every") {
    const everyMs = typeof record.everyMs === "number" ? record.everyMs : undefined;
    return everyMs ? humanizeEveryMs(everyMs) : "on a recurring interval";
  }
  if (kind === "at") {
    const at = typeof record.at === "string" ? record.at.trim() : "";
    return at ? `at ${truncatePlain(at, 48)}` : "at a scheduled time";
  }
  if (kind === "cron") {
    const expr = typeof record.expr === "string" ? record.expr.trim() : "";
    return expr ? `on cron ${truncatePlain(expr, 40)}` : "on a cron schedule";
  }
  return undefined;
}

function resolveProcessFallbackSummary(input: ToolCallSummaryInput): string | undefined {
  const action = extractStringArg(input.args, "action")?.toLowerCase();
  const sessionId = extractStringArg(input.args, "sessionId");
  if (action === "list") {
    return "Checking running terminal processes and recent session state.";
  }
  if (action === "poll") {
    const timeoutMs = extractNumberArg(input.args, "timeout");
    if (sessionId && timeoutMs && timeoutMs > 0) {
      return `Checking process ${sessionId} for new output over ${Math.ceil(timeoutMs / 1000)}s.`;
    }
    return sessionId
      ? `Checking process ${sessionId} for new output and status.`
      : "Checking process output and status.";
  }
  if (action === "log") {
    return sessionId
      ? `Reading recent output from process ${sessionId}.`
      : "Reading recent process output.";
  }
  if (action === "write" || action === "send-keys" || action === "submit" || action === "paste") {
    return sessionId
      ? `Sending input to process ${sessionId} to continue execution.`
      : "Sending input to continue the running process.";
  }
  if (action === "kill" || action === "remove" || action === "clear") {
    return sessionId
      ? `Stopping process ${sessionId} and cleaning up session state.`
      : "Stopping the running process and cleaning up session state.";
  }
  return sessionId
    ? `Managing process session ${sessionId}.`
    : "Managing terminal process sessions.";
}

function resolveCronFallbackSummary(input: ToolCallSummaryInput): string | undefined {
  const action = extractStringArg(input.args, "action")?.toLowerCase();
  if (action === "status") {
    return "Checking cron scheduler status and active workers.";
  }
  if (action === "list") {
    return "Reviewing cron jobs and their next scheduled runs.";
  }
  if (action === "add") {
    const job = extractRecordArg(input.args, "job");
    const name = job && typeof job.name === "string" ? truncatePlain(job.name, 64) : undefined;
    const schedule = summarizeCronSchedule(job?.schedule);
    if (name && schedule) {
      return `Scheduling cron job "${name}" ${schedule}.`;
    }
    if (name) {
      return `Scheduling cron job "${name}" with active monitoring.`;
    }
    if (schedule) {
      return `Scheduling a cron job ${schedule} for follow-up automation.`;
    }
    return "Scheduling a new cron job for follow-up automation.";
  }
  if (action === "update") {
    const id = extractStringArg(input.args, "jobId") ?? extractStringArg(input.args, "id");
    return id ? `Updating cron job ${id} and next-run behavior.` : "Updating cron job settings.";
  }
  if (action === "remove") {
    const id = extractStringArg(input.args, "jobId") ?? extractStringArg(input.args, "id");
    return id
      ? `Removing cron job ${id} to stop future runs.`
      : "Removing cron job and stopping future runs.";
  }
  if (action === "run") {
    const id = extractStringArg(input.args, "jobId") ?? extractStringArg(input.args, "id");
    return id ? `Running cron job ${id} immediately.` : "Running cron job immediately.";
  }
  if (action === "runs") {
    const id = extractStringArg(input.args, "jobId") ?? extractStringArg(input.args, "id");
    return id
      ? `Checking recent run history for cron job ${id}.`
      : "Checking recent cron run history.";
  }
  if (action === "wake") {
    const mode = extractStringArg(input.args, "mode")?.toLowerCase();
    return mode === "now"
      ? "Waking the agent immediately to continue this workflow."
      : "Scheduling the agent wake-up on the next heartbeat.";
  }
  return "Managing cron automation and follow-up scheduling.";
}

function resolveSessionsSpawnFallbackSummary(input: ToolCallSummaryInput): string | undefined {
  const task = extractStringArg(input.args, "task");
  const timeout = extractNumberArg(input.args, "runTimeoutSeconds");
  const label = extractStringArg(input.args, "label");
  const target = task
    ? truncatePlain(task, 90)
    : label
      ? truncatePlain(label, 90)
      : "assigned task";
  if (timeout && timeout > 0) {
    return `Spawning sub-agent for ${target} with a ${Math.ceil(timeout)}s timeout.`;
  }
  return `Spawning sub-agent for ${target} and monitoring completion.`;
}

function extractImagePathFromArgs(args: unknown): string | undefined {
  const keys = ["path", "filePath", "file_path", "imagePath", "image_path", "screenshot"];
  for (const key of keys) {
    const value = extractStringArg(args, key);
    if (value && IMAGE_PATH_RE.test(value)) {
      return value;
    }
  }
  return undefined;
}

function resolveFallbackSummary(input: ToolCallSummaryInput): string | undefined {
  const toolName = normalizeKey(input.toolName).toLowerCase();
  if (toolName === "process") {
    return resolveProcessFallbackSummary(input);
  }
  if (toolName === "cron") {
    return resolveCronFallbackSummary(input);
  }
  if (toolName === "sessions_spawn") {
    return resolveSessionsSpawnFallbackSummary(input);
  }

  const explicit = sanitizeSummary(input.fallbackMeta);
  if (explicit) {
    return normalizeProgressiveLead(explicit);
  }

  if (toolName === "image") {
    return "Screenshot verwerken";
  }

  if (toolName === "browser") {
    const action = extractStringArg(input.args, "action")?.toLowerCase();
    if (action === "screenshot" || action === "snapshot") {
      return "Screenshot maken";
    }
  }

  if (toolName === "read") {
    const imagePath = extractImagePathFromArgs(input.args);
    if (imagePath) {
      return "Screenshot analyseren";
    }
  }

  return undefined;
}

function shouldRetryAttempt(result: SummaryAttemptResult): boolean {
  if (result.summary) {
    return false;
  }
  const reason = (result.reason ?? "").toLowerCase();
  if (
    reason === "timeout" ||
    reason === "network" ||
    reason === "empty" ||
    reason === "empty_length"
  ) {
    return true;
  }
  if (reason.startsWith("http_")) {
    const status = Number.parseInt(reason.slice("http_".length), 10);
    if (!Number.isFinite(status)) {
      return true;
    }
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
  return false;
}

async function delay(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function setCache(cacheKey: string, value: string): void {
  summaryCache.set(cacheKey, value);
  if (summaryCache.size <= CACHE_MAX_ENTRIES) {
    return;
  }
  const oldest = summaryCache.keys().next().value;
  if (typeof oldest === "string") {
    summaryCache.delete(oldest);
  }
}

export async function summarizeToolCallForUser(
  input: ToolCallSummaryInput,
): Promise<string | undefined> {
  const fallbackSummary = resolveFallbackSummary(input);

  if (!resolveEnabled()) {
    return fallbackSummary;
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    return fallbackSummary;
  }

  const toolName = normalizeKey(input.toolName);
  const toolCallId = normalizeKey(input.toolCallId);
  const cacheKey = `${toolName}|${stableStringify(input.args)}|${normalizeKey(input.fallbackMeta)}`;
  const cached = summaryCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const timeoutMs = resolveTimeoutMs();
  const retryBackoffMs = resolveRetryBackoffMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("tool summary timeout")), timeoutMs);

  try {
    const requestSummary = async (maxTokens: number): Promise<SummaryAttemptResult> => {
      const payload = {
        model: resolveModel(),
        temperature: 0,
        max_tokens: maxTokens,
        reasoning: { exclude: true },
        include_reasoning: false,
        messages: [
          {
            role: "system",
            content:
              "You summarize tool calls for chat users. Return exactly one short sentence (6-14 words), factual and specific. Start with an agent-progress verb in English (for example: Running, Analyzing, Clicking, Opening, Switching). No markdown, no bullet points, no IDs.",
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                task: "Summarize this tool call for end-user visibility",
                constraints: {
                  concise: true,
                  no_jargon: true,
                  avoid_information_overload: true,
                },
                toolCall: {
                  runId: input.runId,
                  toolName,
                  toolCallId,
                  args: input.args,
                },
              },
              null,
              2,
            ),
          },
        ],
      };

      const res = await fetch(`${resolveBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://openclaw.ai",
          "X-Title": "OpenClaw Tool Summary",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        return { ok: false, reason: `http_${res.status}`, status: res.status };
      }

      const raw = (await res.json()) as OpenRouterChatCompletionResponse;
      const content = extractContentText(raw.choices?.[0]?.message?.content);
      const finishReason = raw.choices?.[0]?.finish_reason;
      const summary = sanitizeSummary(normalizeProgressiveLead(content));
      return { ok: true, summary, finishReason, reason: summary ? undefined : "empty" };
    };
    const maxTokensPlan = [220, 420, 520];
    let lastReason = "unknown";
    for (let i = 0; i < maxTokensPlan.length; i += 1) {
      const maxTokens = maxTokensPlan[i];
      let attempt: SummaryAttemptResult;
      try {
        attempt = await requestSummary(maxTokens);
      } catch (err) {
        const timeoutLike =
          controller.signal.aborted || (err instanceof Error && /abort|timeout/i.test(err.message));
        attempt = { ok: false, reason: timeoutLike ? "timeout" : "network" };
      }

      if (!attempt.summary && attempt.finishReason?.toLowerCase() === "length") {
        attempt.reason = "empty_length";
      }
      if (attempt.summary) {
        setCache(cacheKey, attempt.summary);
        if (i > 0) {
          log.debug(
            `tool summary recovered after retry: tool=${toolName} call=${toolCallId} attempt=${
              i + 1
            } timeoutMs=${timeoutMs}`,
          );
        }
        return attempt.summary;
      }

      lastReason = attempt.reason ?? (attempt.ok ? "empty" : "failed");
      const hasMoreAttempts = i < maxTokensPlan.length - 1;
      if (!hasMoreAttempts || !shouldRetryAttempt(attempt)) {
        break;
      }
      const backoff = retryBackoffMs[Math.min(i, retryBackoffMs.length - 1)] ?? 0;
      if (backoff > 0) {
        await delay(backoff);
      }
    }

    log.debug(
      `tool summary fallback: tool=${toolName} call=${toolCallId} reason=${lastReason} timeoutMs=${timeoutMs}`,
    );
    return fallbackSummary;
  } catch (err) {
    log.debug(
      `tool summary fallback: tool=${toolName} call=${toolCallId} reason=exception error=${String(
        err,
      )}`,
    );
    return fallbackSummary;
  } finally {
    clearTimeout(timer);
  }
}
