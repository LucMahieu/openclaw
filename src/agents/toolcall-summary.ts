import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";

const DEFAULT_MODEL = "openai/gpt-5-nano";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_ATTEMPT_TIMEOUT_MS = 6000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = [200, 700];
const DEFAULT_MAX_TOKENS_PLAN = [220, 420, 520, 620, 720];
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
const LEAD_REWRITE_MAP: Array<[RegExp, string]> = [
  [/^\s*run(?:ning)?\s+(.+)$/i, "Uitgevoerd: $1"],
  [/^\s*search(?:ing)?\s+for\s+(.+)$/i, "Gezocht naar $1"],
  [/^\s*finding\s+(.+)$/i, "Gezocht naar $1"],
  [/^\s*analy(?:s|z)(?:e|es|ing)\s+(.+)$/i, "Geanalyseerd: $1"],
  [/^\s*opening\s+(.+)$/i, "Geopend: $1"],
  [/^\s*clicking\s+(.+)$/i, "Geklikt: $1"],
  [/^\s*switching\s+(.+)$/i, "Gewisseld: $1"],
  [/^\s*capturing\s+(.+)$/i, "Vastgelegd: $1"],
  [/^\s*extracting\s+(.+)$/i, "Geëxtraheerd: $1"],
  [/^\s*returning\s+(.+)$/i, "Teruggegeven: $1"],
  [/^\s*locating\s+(.+)$/i, "Gelokaliseerd: $1"],
  [/^\s*waiting\s+(.+)$/i, "Gewacht op $1"],
  [/^\s*using\s+(.+)$/i, "Gebruikt: $1"],
  [/^\s*typing\s+(.+)$/i, "Getypt: $1"],
  [/^\s*checking\s+(.+)$/i, "Gecontroleerd: $1"],
  [/^\s*reading\s+(.+)$/i, "Gelezen: $1"],
  [/^\s*list(?:ing)?\s+(.+)$/i, "Opgevraagd: $1"],
  [/^\s*scheduling\s+(.+)$/i, "Ingepland: $1"],
  [/^\s*spawning\s+(.+)$/i, "Gestart: $1"],
  [/^\s*nam\s+een\s+screenshot\s+(.+)$/i, "Screenshot genomen $1"],
  [/^\s*took\s+a\s+screenshot\s+(.+)$/i, "Screenshot genomen $1"],
  [/^\s*zoeken\s+naar\s+(.+)$/i, "Gezocht naar $1"],
  [/^\s*zoekt\s+naar\s+(.+)$/i, "Gezocht naar $1"],
  [/^\s*analyseren\s+(.+)$/i, "Geanalyseerd: $1"],
  [/^\s*analyseert\s+(.+)$/i, "Geanalyseerd: $1"],
  [/^\s*opent\s+(.+)$/i, "Geopend: $1"],
  [/^\s*klikt\s+(.+)$/i, "Geklikt: $1"],
  [/^\s*schakelt\s+(.+)$/i, "Gewisseld: $1"],
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

function resolveAttemptTimeoutMs(): number {
  const raw = Number.parseInt(
    process.env.OPENCLAW_TOOL_SUMMARY_ATTEMPT_TIMEOUT_MS ??
      process.env.OPENCLAW_TOOL_SUMMARY_TIMEOUT_MS ??
      "",
    10,
  );
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_ATTEMPT_TIMEOUT_MS;
  }
  return Math.max(500, Math.min(raw, 15000));
}

function resolveMaxAttempts(): number {
  const raw = Number.parseInt(process.env.OPENCLAW_TOOL_SUMMARY_MAX_ATTEMPTS ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_MAX_ATTEMPTS;
  }
  return Math.max(1, Math.min(raw, DEFAULT_MAX_TOKENS_PLAN.length));
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

export function normalizeToolSummaryForDisplay(value: string): string {
  let out = value.replace(/\s+/g, " ").trim();
  if (!out) {
    return out;
  }

  out = out
    .replace(/^[•●○□✓✗\-\s]+/u, "")
    .replace(/^`+|`+$/g, "")
    .trim();
  // Force non-first-person status style.
  out = out.replace(/^ik\s+heb\s+/i, "");
  out = out.replace(/^ik\s+ben\s+/i, "");
  out = out.replace(/^ik\s+/i, "");
  out = out.replace(/^startup validatie deadline$/i, "Startup-validatiedeadline gecontroleerd");

  for (const [pattern, replacement] of LEAD_REWRITE_MAP) {
    if (pattern.test(out)) {
      out = out.replace(pattern, replacement);
      break;
    }
  }

  if (/^[a-z0-9][a-z0-9 _-]{2,}$/i.test(out) && !/(ge|ver|be|ont)\w+/i.test(out)) {
    out = `Bijgewerkt: ${out}`;
  }

  out = out.replace(/[.!?…]+$/g, "").trim();
  if (out.length > 0) {
    out = `${out[0].toUpperCase()}${out.slice(1)}`;
  }
  return out;
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
    return "met een terugkerend interval";
  }
  if (ms % 3_600_000 === 0) {
    const h = Math.max(1, Math.round(ms / 3_600_000));
    return `elke ${h}u`;
  }
  if (ms % 60_000 === 0) {
    const m = Math.max(1, Math.round(ms / 60_000));
    return `elke ${m}m`;
  }
  const s = Math.max(1, Math.round(ms / 1000));
  return `elke ${s}s`;
}

function summarizeCronSchedule(schedule: unknown): string | undefined {
  if (!schedule || typeof schedule !== "object") {
    return undefined;
  }
  const record = schedule as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind.trim().toLowerCase() : "";
  if (kind === "every") {
    const everyMs = typeof record.everyMs === "number" ? record.everyMs : undefined;
    return everyMs ? humanizeEveryMs(everyMs) : "met een terugkerend interval";
  }
  if (kind === "at") {
    const at = typeof record.at === "string" ? record.at.trim() : "";
    return at ? `om ${truncatePlain(at, 48)}` : "op een gepland tijdstip";
  }
  if (kind === "cron") {
    const expr = typeof record.expr === "string" ? record.expr.trim() : "";
    return expr ? `met cron ${truncatePlain(expr, 40)}` : "met een cron-schema";
  }
  return undefined;
}

function resolveProcessFallbackSummary(input: ToolCallSummaryInput): string | undefined {
  const action = extractStringArg(input.args, "action")?.toLowerCase();
  const sessionId = extractStringArg(input.args, "sessionId");
  if (action === "list") {
    return "Lopende terminalprocessen en recente sessiestatus gecontroleerd";
  }
  if (action === "poll") {
    const timeoutMs = extractNumberArg(input.args, "timeout");
    if (sessionId && timeoutMs && timeoutMs > 0) {
      return `Proces ${sessionId} gecontroleerd op nieuwe output (${Math.ceil(timeoutMs / 1000)}s)`;
    }
    return sessionId
      ? `Proces ${sessionId} gecontroleerd op output en status`
      : "Procesoutput en sessiestatus gecontroleerd";
  }
  if (action === "log") {
    return sessionId
      ? `Recente output van proces ${sessionId} gelezen`
      : "Recente procesoutput gelezen";
  }
  if (action === "write" || action === "send-keys" || action === "submit" || action === "paste") {
    return sessionId
      ? `Invoer naar proces ${sessionId} verstuurd om uitvoering te vervolgen`
      : "Invoer verstuurd om het lopende proces te vervolgen";
  }
  if (action === "kill" || action === "remove" || action === "clear") {
    return sessionId
      ? `Proces ${sessionId} gestopt en sessiestatus opgeschoond`
      : "Lopend proces gestopt en sessiestatus opgeschoond";
  }
  return sessionId ? `Proces-sessie ${sessionId} beheerd` : "Terminalprocessessies beheerd";
}

function resolveCronFallbackSummary(input: ToolCallSummaryInput): string | undefined {
  const action = extractStringArg(input.args, "action")?.toLowerCase();
  if (action === "status") {
    return "Cronplanner en actieve workers gecontroleerd";
  }
  if (action === "list") {
    return "Cronjobs en hun volgende runs gecontroleerd";
  }
  if (action === "add") {
    const job = extractRecordArg(input.args, "job");
    const name = job && typeof job.name === "string" ? truncatePlain(job.name, 64) : undefined;
    const schedule = summarizeCronSchedule(job?.schedule);
    if (name && schedule) {
      return `Cronjob "${name}" ingepland (${schedule})`;
    }
    if (name) {
      return `Cronjob "${name}" ingepland met monitoring`;
    }
    if (schedule) {
      return `Cronjob ingepland (${schedule}) voor follow-up automatisering`;
    }
    return "Nieuwe cronjob ingepland voor follow-up automatisering";
  }
  if (action === "update") {
    const id = extractStringArg(input.args, "jobId") ?? extractStringArg(input.args, "id");
    return id
      ? `Cronjob ${id} bijgewerkt met nieuwe run-instellingen`
      : "Cronjob-instellingen bijgewerkt";
  }
  if (action === "remove") {
    const id = extractStringArg(input.args, "jobId") ?? extractStringArg(input.args, "id");
    return id
      ? `Cronjob ${id} verwijderd en toekomstige runs gestopt`
      : "Cronjob verwijderd en toekomstige runs gestopt";
  }
  if (action === "run") {
    const id = extractStringArg(input.args, "jobId") ?? extractStringArg(input.args, "id");
    return id ? `Cronjob ${id} direct uitgevoerd` : "Cronjob direct uitgevoerd";
  }
  if (action === "runs") {
    const id = extractStringArg(input.args, "jobId") ?? extractStringArg(input.args, "id");
    return id
      ? `Recente runhistorie van cronjob ${id} gecontroleerd`
      : "Recente cron-runs gecontroleerd";
  }
  if (action === "wake") {
    const mode = extractStringArg(input.args, "mode")?.toLowerCase();
    return mode === "now"
      ? "Agent direct gewekt om deze workflow te vervolgen"
      : "Agent-wake-up ingepland op de volgende heartbeat";
  }
  return "Cronautomatisering en follow-up planning beheerd";
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
    return `Sub-agent gestart voor ${target} met timeout van ${Math.ceil(timeout)}s`;
  }
  return `Sub-agent gestart voor ${target} met actieve voortgangsmonitoring`;
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
    return sanitizeSummary(normalizeToolSummaryForDisplay(explicit));
  }

  if (toolName === "image") {
    return "Screenshot verwerkt";
  }

  if (toolName === "browser") {
    const action = extractStringArg(input.args, "action")?.toLowerCase();
    if (action === "screenshot" || action === "snapshot") {
      return "Screenshot gemaakt";
    }
  }

  if (toolName === "read") {
    const imagePath = extractImagePathFromArgs(input.args);
    if (imagePath) {
      return "Screenshot geanalyseerd";
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

  const attemptTimeoutMs = resolveAttemptTimeoutMs();
  const maxAttempts = resolveMaxAttempts();
  const retryBackoffMs = resolveRetryBackoffMs();
  const requestSummary = async (maxTokens: number): Promise<SummaryAttemptResult> => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("tool summary timeout")),
      attemptTimeoutMs,
    );
    try {
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
              "Je vat tool-calls samen voor chatgebruikers. Geef exact één korte zin (6-14 woorden), in het Nederlands, in de verleden tijd, met sentence case. Wees concreet: noem de uitgevoerde actie en het object/resultaat. Vermijd vage labels zoals 'startup validatie deadline'. Geen markdown, geen bullets, geen IDs.",
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                task: "Vat deze tool-call samen voor de eindgebruiker",
                constraints: {
                  concise: true,
                  no_jargon: true,
                  avoid_information_overload: true,
                  dutch_only: true,
                  past_tense: true,
                  sentence_case: true,
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
      const summary = sanitizeSummary(normalizeToolSummaryForDisplay(content));
      return { ok: true, summary, finishReason, reason: summary ? undefined : "empty" };
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const maxTokensPlan = DEFAULT_MAX_TOKENS_PLAN.slice(0, maxAttempts);
    let lastReason = "unknown";
    for (let i = 0; i < maxTokensPlan.length; i += 1) {
      const maxTokens = maxTokensPlan[i];
      let attempt: SummaryAttemptResult;
      const attemptStartedAt = Date.now();
      try {
        attempt = await requestSummary(maxTokens);
      } catch (err) {
        const timeoutLike = err instanceof Error && /abort|timeout/i.test(err.message);
        attempt = { ok: false, reason: timeoutLike ? "timeout" : "network" };
      }
      const elapsedMs = Date.now() - attemptStartedAt;

      if (!attempt.summary && attempt.finishReason?.toLowerCase() === "length") {
        attempt.reason = "empty_length";
      }
      log.debug(
        `tool summary attempt: tool=${toolName} call=${toolCallId} attempt=${i + 1}/${maxAttempts} status=${
          attempt.summary ? "ok" : "fallback"
        } reason=${attempt.reason ?? "ok"} finishReason=${
          attempt.finishReason ?? "none"
        } elapsedMs=${elapsedMs} timeoutMs=${attemptTimeoutMs}`,
      );
      if (attempt.summary) {
        setCache(cacheKey, attempt.summary);
        if (i > 0) {
          log.debug(
            `tool summary recovered after retry: tool=${toolName} call=${toolCallId} attempt=${
              i + 1
            } timeoutMs=${attemptTimeoutMs}`,
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
      `tool summary fallback: tool=${toolName} call=${toolCallId} reason=${lastReason} attempts=${maxAttempts} timeoutMs=${attemptTimeoutMs}`,
    );
    return fallbackSummary;
  } catch (err) {
    log.debug(
      `tool summary fallback: tool=${toolName} call=${toolCallId} reason=exception error=${String(
        err,
      )}`,
    );
    return fallbackSummary;
  }
}
