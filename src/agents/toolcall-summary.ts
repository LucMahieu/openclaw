import {
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";

const DEFAULT_MODEL = "nvidia/nemotron-3-nano-30b-a3b:free";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 3500;
const MAX_RESPONSE_CHARS = 180;
const CACHE_MAX_ENTRIES = 200;

type ToolCallSummaryInput = {
  runId?: string;
  toolName: string;
  toolCallId: string;
  args: unknown;
  fallbackMeta?: string;
};

type OpenRouterChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

const summaryCache = new Map<string, string>();

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
  return Math.max(300, Math.min(raw, 5000));
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
  if (!resolveEnabled()) {
    return input.fallbackMeta;
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    return input.fallbackMeta;
  }

  const toolName = normalizeKey(input.toolName);
  const toolCallId = normalizeKey(input.toolCallId);
  const cacheKey = `${toolName}|${stableStringify(input.args)}|${normalizeKey(input.fallbackMeta)}`;
  const cached = summaryCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const timeoutMs = resolveTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("tool summary timeout")), timeoutMs);

  try {
    const payload = {
      model: resolveModel(),
      temperature: 0,
      max_tokens: 220,
      reasoning: { exclude: true },
      messages: [
        {
          role: "system",
          content:
            "You summarize tool calls for chat users. Return one short sentence, factual and specific. Keep 6-14 words. No markdown, no bullet points, no IDs.",
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
      return input.fallbackMeta;
    }

    const raw = (await res.json()) as OpenRouterChatCompletionResponse;
    const content = extractContentText(raw.choices?.[0]?.message?.content);
    const summary = sanitizeSummary(content);
    if (!summary) {
      return input.fallbackMeta;
    }
    setCache(cacheKey, summary);
    return summary;
  } catch {
    return input.fallbackMeta;
  } finally {
    clearTimeout(timer);
  }
}
