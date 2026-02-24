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
const IMAGE_PATH_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif|svg)$/i;
const PROGRESSIVE_LEAD_MAP: Array<[RegExp, string]> = [
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
  const explicit = sanitizeSummary(input.fallbackMeta);
  if (explicit) {
    return normalizeProgressiveLead(explicit);
  }

  const toolName = normalizeKey(input.toolName).toLowerCase();
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
      return fallbackSummary;
    }

    const raw = (await res.json()) as OpenRouterChatCompletionResponse;
    const content = extractContentText(raw.choices?.[0]?.message?.content);
    const summary = sanitizeSummary(normalizeProgressiveLead(content));
    if (!summary) {
      return fallbackSummary;
    }
    setCache(cacheKey, summary);
    return summary;
  } catch {
    return fallbackSummary;
  } finally {
    clearTimeout(timer);
  }
}
