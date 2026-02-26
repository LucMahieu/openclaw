import fs from "node:fs/promises";
import path from "node:path";
import {
  readJsonFileWithFallback,
  withFileLock,
  writeJsonFileAtomically,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { canonicalizeState } from "./canonical-json.js";
import {
  createDefaultState,
  normalizeState,
  type GtdState,
  type ResolvedGtdPluginConfig,
} from "./schema.js";
import { renderAllViews } from "./views.js";

const LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 25,
    maxTimeout: 2_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

export type GtdStoreContext = {
  stateDir: string;
  config: OpenClawConfig;
  pluginConfig: ResolvedGtdPluginConfig;
};

export type AgentStorePaths = {
  rootDir: string;
  agentDir: string;
  jsonPath: string;
  viewsDir: string;
  auditLogPath: string;
};

function resolveRootDir(ctx: GtdStoreContext): string {
  if (ctx.pluginConfig.storage.rootDir) {
    return path.resolve(ctx.pluginConfig.storage.rootDir);
  }
  return path.join(ctx.stateDir, "plugins", "gtd-core");
}

export function resolveAgentStorePaths(ctx: GtdStoreContext, agentId: string): AgentStorePaths {
  const rootDir = resolveRootDir(ctx);
  const safeAgentId = agentId.trim().toLowerCase() || "main";
  const agentDir = path.join(rootDir, "agents", safeAgentId);
  return {
    rootDir,
    agentDir,
    jsonPath: path.join(agentDir, "gtd.json"),
    viewsDir: path.join(agentDir, "views"),
    auditLogPath: path.join(agentDir, "audit.ndjson"),
  };
}

async function writeTextAtomically(filePath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmpPath, value, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}

export async function loadState(ctx: GtdStoreContext, agentId: string): Promise<GtdState> {
  const paths = resolveAgentStorePaths(ctx, agentId);
  const { value } = await readJsonFileWithFallback(paths.jsonPath, createDefaultState());
  return canonicalizeState(normalizeState(value));
}

export async function saveState(
  ctx: GtdStoreContext,
  agentId: string,
  nextState: GtdState,
  opts?: { auditReason?: string },
): Promise<GtdState> {
  const paths = resolveAgentStorePaths(ctx, agentId);
  const state = canonicalizeState({
    ...nextState,
    version: 1,
    scope: "per_agent",
    mode: nextState.mode,
    updatedAtMs: Date.now(),
  });

  await withFileLock(paths.jsonPath, LOCK_OPTIONS, async () => {
    await writeJsonFileAtomically(paths.jsonPath, state);

    const views = renderAllViews({ agentId, state });
    await fs.mkdir(paths.viewsDir, { recursive: true, mode: 0o700 });
    await Promise.all(
      Object.entries(views).map(async ([name, markdown]) => {
        const viewPath = path.join(paths.viewsDir, name);
        await writeTextAtomically(viewPath, markdown);
      }),
    );

    if (opts?.auditReason) {
      const event = {
        ts: Date.now(),
        agentId,
        reason: opts.auditReason,
        counts: {
          inbox: state.inboxItems.length,
          actions: state.actions.length,
          projects: state.projects.length,
          waitingFor: state.waitingFor.length,
        },
      };
      await fs.mkdir(path.dirname(paths.auditLogPath), { recursive: true, mode: 0o700 });
      await fs.appendFile(paths.auditLogPath, `${JSON.stringify(event)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
  });

  return state;
}

export function resolveDefaultAgentId(cfg: OpenClawConfig): string {
  const list = cfg.agents?.list;
  if (!Array.isArray(list) || list.length === 0) {
    return "main";
  }
  const preferred = list.find((entry) => entry?.default) ?? list[0];
  const id = typeof preferred?.id === "string" ? preferred.id.trim().toLowerCase() : "";
  return id || "main";
}

export function listConfiguredAgentIds(cfg: OpenClawConfig): string[] {
  const list = cfg.agents?.list;
  if (!Array.isArray(list) || list.length === 0) {
    return ["main"];
  }
  const ids = list
    .map((entry) => (typeof entry?.id === "string" ? entry.id.trim().toLowerCase() : ""))
    .filter(Boolean);
  return ids.length > 0 ? Array.from(new Set(ids)) : ["main"];
}

export function resolveAgentDirFromStateDir(stateDir: string, agentId: string): string {
  const safeAgentId = agentId.trim().toLowerCase() || "main";
  return path.join(stateDir, "agents", safeAgentId, "agent");
}
