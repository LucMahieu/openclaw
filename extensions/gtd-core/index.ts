import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createGtdCommand } from "./src/commands.js";
import { registerGtdHooks } from "./src/hooks.js";
import { createGoogleCalendarProvider } from "./src/provider-google-calendar-auth.js";
import { createGtdSchedulerService } from "./src/scheduler.js";
import { resolveGtdPluginConfig } from "./src/schema.js";
import { resolveDefaultAgentId, type GtdStoreContext } from "./src/store.js";
import { createGtdTool } from "./src/tool.js";

const gtdConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    scope: {
      type: "string",
      enum: ["per_agent"],
      default: "per_agent",
    },
    mode: {
      type: "string",
      enum: ["always_on", "manual"],
      default: "always_on",
    },
    storage: {
      type: "object",
      additionalProperties: false,
      properties: {
        rootDir: {
          type: "string",
          default: "${STATE_DIR}/plugins/gtd-core",
        },
      },
    },
    autonomy: {
      type: "object",
      additionalProperties: false,
      properties: {
        followup: {
          type: "object",
          additionalProperties: false,
          properties: {
            allowlistedDelivery: {
              type: "string",
              enum: ["auto_send"],
              default: "auto_send",
            },
            nonAllowlistedDelivery: {
              type: "string",
              enum: ["draft_confirm"],
              default: "draft_confirm",
            },
            autoSendAllowlist: {
              type: "array",
              items: { type: "string" },
              default: [],
            },
          },
        },
      },
    },
    review: {
      type: "object",
      additionalProperties: false,
      properties: {
        dailyInboxZero: {
          type: "object",
          additionalProperties: false,
          properties: {
            hour: { type: "integer", minimum: 0, maximum: 23, default: 16 },
            minute: { type: "integer", minimum: 0, maximum: 59, default: 30 },
            weekdaysOnly: { type: "boolean", default: true },
          },
        },
        weekly: {
          type: "object",
          additionalProperties: false,
          properties: {
            dayOfWeek: { type: "integer", minimum: 0, maximum: 6, default: 5 },
            hour: { type: "integer", minimum: 0, maximum: 23, default: 15 },
            minute: { type: "integer", minimum: 0, maximum: 59, default: 0 },
          },
        },
        horizons: {
          type: "object",
          additionalProperties: false,
          properties: {
            dayOfMonth: { type: "integer", minimum: 1, maximum: 28, default: 1 },
            hour: { type: "integer", minimum: 0, maximum: 23, default: 9 },
            minute: { type: "integer", minimum: 0, maximum: 59, default: 0 },
          },
        },
      },
    },
    engage: {
      type: "object",
      additionalProperties: false,
      properties: {
        contexts: {
          type: "array",
          items: { type: "string" },
          default: ["deep_work", "computer", "calls", "errands", "agenda"],
        },
      },
    },
    calendar: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: {
          type: "string",
          enum: ["google"],
          default: "google",
        },
        sync: {
          type: "string",
          enum: ["bidirectional"],
          default: "bidirectional",
        },
        conflictPolicy: {
          type: "string",
          enum: ["gtd_wins"],
          default: "gtd_wins",
        },
        syncIntervalMinutes: {
          type: "integer",
          minimum: 5,
          maximum: 1440,
          default: 30,
        },
      },
    },
  },
};

function safeParseConfig(value: unknown) {
  if (value === undefined) {
    return { success: true, data: undefined };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      success: false,
      error: {
        issues: [{ path: [], message: "expected config object" }],
      },
    };
  }
  return { success: true, data: value };
}

function buildStoreContext(api: OpenClawPluginApi): GtdStoreContext {
  return {
    stateDir: api.runtime.state.resolveStateDir(),
    config: api.config,
    pluginConfig: resolveGtdPluginConfig(api.pluginConfig),
  };
}

const gtdCorePlugin = {
  id: "gtd-core",
  name: "GTD Core",
  description: "Per-agent GTD harness with canonical JSON state and markdown views.",
  configSchema: {
    safeParse: safeParseConfig,
    jsonSchema: gtdConfigJsonSchema,
  },
  register(api: OpenClawPluginApi) {
    const pluginConfig = resolveGtdPluginConfig(api.pluginConfig);

    api.registerTool(
      (ctx) => {
        const effectiveConfig = ctx.config ?? api.config;
        const agentId = (ctx.agentId || resolveDefaultAgentId(effectiveConfig))
          .trim()
          .toLowerCase();
        const storeContext: GtdStoreContext = {
          stateDir: api.runtime.state.resolveStateDir(),
          config: effectiveConfig,
          pluginConfig,
        };
        return createGtdTool({
          storeContext,
          agentId: agentId || "main",
        });
      },
      { name: "gtd" },
    );

    api.registerCommand(
      createGtdCommand({
        api,
        storeContext: buildStoreContext(api),
      }),
    );

    registerGtdHooks({
      api,
      storeContext: buildStoreContext(api),
      pluginConfig,
    });

    api.registerService(
      createGtdSchedulerService({
        api,
        pluginConfig,
      }),
    );

    api.registerProvider(createGoogleCalendarProvider());
  },
};

export default gtdCorePlugin;
