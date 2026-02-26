import fs from "node:fs/promises";
import path from "node:path";
import { type OpenClawConfig, loadConfig } from "../config/config.js";
import { isRecord } from "../utils.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  normalizeProviders,
  type ProviderConfig,
  resolveImplicitBedrockProvider,
  resolveImplicitCopilotProvider,
  resolveImplicitProviders,
} from "./models-config.providers.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;

const DEFAULT_MODE: NonNullable<ModelsConfig["mode"]> = "merge";
const OPENROUTER_PROVIDER_KEY = "openrouter";
const OPENROUTER_GEMINI_3_PRO_PREVIEW_MODEL_ID = "google/gemini-3-pro-preview";
const OPENROUTER_GEMINI_31_PRO_PREVIEW_CUSTOMTOOLS_MODEL_ID =
  "google/gemini-3.1-pro-preview-customtools";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_CONTEXT_WINDOW = 1048576;
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;

function ensureOpenRouterGemini31CustomToolsModel(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  const openrouter = providers[OPENROUTER_PROVIDER_KEY];
  if (!openrouter || !Array.isArray(openrouter.models) || openrouter.models.length === 0) {
    return providers;
  }

  const hasCustomTools = openrouter.models.some(
    (model) =>
      model?.id?.trim().toLowerCase() === OPENROUTER_GEMINI_31_PRO_PREVIEW_CUSTOMTOOLS_MODEL_ID,
  );
  if (hasCustomTools) {
    return providers;
  }

  const baseModel = openrouter.models.find(
    (model) => model?.id?.trim().toLowerCase() === OPENROUTER_GEMINI_3_PRO_PREVIEW_MODEL_ID,
  );
  if (!baseModel) {
    return providers;
  }

  return {
    ...providers,
    [OPENROUTER_PROVIDER_KEY]: {
      ...openrouter,
      models: [
        ...openrouter.models,
        {
          ...baseModel,
          id: OPENROUTER_GEMINI_31_PRO_PREVIEW_CUSTOMTOOLS_MODEL_ID,
          name: OPENROUTER_GEMINI_31_PRO_PREVIEW_CUSTOMTOOLS_MODEL_ID,
        },
      ],
    },
  };
}

function ensureOpenRouterProviderFromAgentDefaults(params: {
  providers: Record<string, ProviderConfig>;
  cfg: OpenClawConfig;
}): Record<string, ProviderConfig> {
  const configuredModels = params.cfg.agents?.defaults?.models ?? {};
  const openrouterModelIds = Object.keys(configuredModels)
    .map((raw) => raw.trim())
    .filter((raw) => raw.toLowerCase().startsWith(`${OPENROUTER_PROVIDER_KEY}/`))
    .map((raw) => raw.slice(OPENROUTER_PROVIDER_KEY.length + 1))
    .filter(Boolean);
  if (openrouterModelIds.length === 0) {
    return params.providers;
  }

  const existing = params.providers[OPENROUTER_PROVIDER_KEY];
  const existingModels = Array.isArray(existing?.models) ? existing.models : [];
  const existingIds = new Set(existingModels.map((model) => model.id.trim().toLowerCase()));

  const toAdd = openrouterModelIds
    .filter((id) => !existingIds.has(id.toLowerCase()))
    .map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"] as Array<"text" | "image">,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: OPENROUTER_DEFAULT_CONTEXT_WINDOW,
      maxTokens: OPENROUTER_DEFAULT_MAX_TOKENS,
    }));

  if (existing && toAdd.length === 0) {
    return params.providers;
  }

  return {
    ...params.providers,
    [OPENROUTER_PROVIDER_KEY]: {
      ...existing,
      baseUrl: existing?.baseUrl ?? OPENROUTER_BASE_URL,
      api: existing?.api ?? "openai-completions",
      models: [...existingModels, ...toAdd],
    },
  };
}

function mergeProviderModels(implicit: ProviderConfig, explicit: ProviderConfig): ProviderConfig {
  const implicitModels = Array.isArray(implicit.models) ? implicit.models : [];
  const explicitModels = Array.isArray(explicit.models) ? explicit.models : [];
  if (implicitModels.length === 0) {
    return { ...implicit, ...explicit };
  }

  const getId = (model: unknown): string => {
    if (!model || typeof model !== "object") {
      return "";
    }
    const id = (model as { id?: unknown }).id;
    return typeof id === "string" ? id.trim() : "";
  };
  const seen = new Set(explicitModels.map(getId).filter(Boolean));

  const mergedModels = [
    ...explicitModels,
    ...implicitModels.filter((model) => {
      const id = getId(model);
      if (!id) {
        return false;
      }
      if (seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    }),
  ];

  return {
    ...implicit,
    ...explicit,
    models: mergedModels,
  };
}

function mergeProviders(params: {
  implicit?: Record<string, ProviderConfig> | null;
  explicit?: Record<string, ProviderConfig> | null;
}): Record<string, ProviderConfig> {
  const out: Record<string, ProviderConfig> = params.implicit ? { ...params.implicit } : {};
  for (const [key, explicit] of Object.entries(params.explicit ?? {})) {
    const providerKey = key.trim();
    if (!providerKey) {
      continue;
    }
    const implicit = out[providerKey];
    out[providerKey] = implicit ? mergeProviderModels(implicit, explicit) : explicit;
  }
  return out;
}

async function readJson(pathname: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export async function ensureOpenClawModelsJson(
  config?: OpenClawConfig,
  agentDirOverride?: string,
): Promise<{ agentDir: string; wrote: boolean }> {
  const cfg = config ?? loadConfig();
  const agentDir = agentDirOverride?.trim() ? agentDirOverride.trim() : resolveOpenClawAgentDir();

  const explicitProviders = cfg.models?.providers ?? {};
  const implicitProviders = await resolveImplicitProviders({ agentDir, explicitProviders });
  const providers: Record<string, ProviderConfig> = mergeProviders({
    implicit: implicitProviders,
    explicit: explicitProviders,
  });
  const implicitBedrock = await resolveImplicitBedrockProvider({ agentDir, config: cfg });
  if (implicitBedrock) {
    const existing = providers["amazon-bedrock"];
    providers["amazon-bedrock"] = existing
      ? mergeProviderModels(implicitBedrock, existing)
      : implicitBedrock;
  }
  const implicitCopilot = await resolveImplicitCopilotProvider({ agentDir });
  if (implicitCopilot && !providers["github-copilot"]) {
    providers["github-copilot"] = implicitCopilot;
  }

  if (Object.keys(providers).length === 0) {
    return { agentDir, wrote: false };
  }

  const mode = cfg.models?.mode ?? DEFAULT_MODE;
  const targetPath = path.join(agentDir, "models.json");

  let mergedProviders = providers;
  let existingRaw = "";
  if (mode === "merge") {
    const existing = await readJson(targetPath);
    if (isRecord(existing) && isRecord(existing.providers)) {
      const existingProviders = existing.providers as Record<
        string,
        NonNullable<ModelsConfig["providers"]>[string]
      >;
      mergedProviders = { ...existingProviders, ...providers };
    }
  }

  const withOpenRouterFromDefaults = ensureOpenRouterProviderFromAgentDefaults({
    providers: mergedProviders,
    cfg,
  });
  const augmentedProviders = ensureOpenRouterGemini31CustomToolsModel(withOpenRouterFromDefaults);
  const normalizedProviders = normalizeProviders({
    providers: augmentedProviders,
    agentDir,
  });
  const next = `${JSON.stringify({ providers: normalizedProviders }, null, 2)}\n`;
  try {
    existingRaw = await fs.readFile(targetPath, "utf8");
  } catch {
    existingRaw = "";
  }

  if (existingRaw === next) {
    return { agentDir, wrote: false };
  }

  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(targetPath, next, { mode: 0o600 });
  return { agentDir, wrote: true };
}
