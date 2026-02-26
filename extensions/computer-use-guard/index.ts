import type { OpenClawPluginApi, PluginHookBeforeToolCallEvent } from "openclaw/plugin-sdk";

type GuardMode = "enforce" | "warn" | "off";

type GuardConfig = {
  mode?: GuardMode;
  emergencyBypass?: boolean;
};

type Violation = {
  kind: "vm" | "mac";
  reason: string;
  remediation: string;
};

const VM_RAW_RE = /\b(?:xdotool|scrot|xinput_helper(?:\.py)?)\b/i;
const DISPLAY_VM_RE = /(?:^|[\s;])DISPLAY\s*=\s*:1(?:\b|\s)/i;

const MAC_RAW_BIN_RE = /\b(?:cliclick|sendkeys|peekaboo)\b/i;
const MAC_OSASCRIPT_GUI_RE = /\bosascript\b[\s\S]*\b(?:click|keystroke|key\s+code|mouse)\b/i;
const MAC_SCREENSHOT_RE = /\bscreencapture\b/i;

function normalizeMode(input: unknown): GuardMode {
  const value = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (value === "warn" || value === "off") {
    return value;
  }
  return "enforce";
}

function commandFromParams(params: Record<string, unknown>): string {
  const fields = ["command", "cmd", "cmdText"] as const;
  for (const key of fields) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return JSON.stringify(params);
}

function truncateCommand(command: string, maxChars: number = 240): string {
  const singleLine = command.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxChars)}…`;
}

function detectViolation(command: string): Violation | null {
  const hasVmRaw = DISPLAY_VM_RE.test(command) && VM_RAW_RE.test(command);
  if (hasVmRaw) {
    return {
      kind: "vm",
      reason:
        "Raw VM GUI command detected (`DISPLAY=:1` + `xdotool/scrot/xinput_helper`). Helper-only VM route is mandatory.",
      remediation:
        'Use: VMCUA="DISPLAY=:1 python3 ~/.openclaw/workspace/skills/vm-computer-use/scripts/cua_helper.py"; $VMCUA doctor; $VMCUA screenshot; $VMCUA click X Y',
    };
  }

  const hasMacRawInput = MAC_RAW_BIN_RE.test(command) || MAC_OSASCRIPT_GUI_RE.test(command);
  const hasScreenshotAndDirectInput = MAC_SCREENSHOT_RE.test(command) && hasMacRawInput;

  if (hasMacRawInput || hasScreenshotAndDirectInput) {
    return {
      kind: "mac",
      reason:
        "Raw Mac GUI automation detected (`cliclick/sendkeys/peekaboo/osascript`). Helper-only Mac route is mandatory.",
      remediation:
        'Use: MAC="bash ~/.openclaw/workspace/skills/mac-computer-use/mac_helper.sh"; $MAC doctor; $MAC screenshot; $MAC click X Y',
    };
  }

  return null;
}

export function evaluateExecGuard(
  event: PluginHookBeforeToolCallEvent,
  mode: GuardMode,
): { mode: GuardMode; violation: Violation | null; commandPreview: string } {
  const command = commandFromParams(event.params);
  return {
    mode,
    violation: detectViolation(command),
    commandPreview: truncateCommand(command),
  };
}

export default function register(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as GuardConfig;
  const mode = normalizeMode(cfg.mode);
  const emergencyBypass = cfg.emergencyBypass === true;

  api.on(
    "before_tool_call",
    (event, ctx) => {
      if (event.toolName !== "exec") {
        return;
      }
      if (emergencyBypass || mode === "off") {
        return;
      }

      const evaluated = evaluateExecGuard(event, mode);
      if (!evaluated.violation) {
        return;
      }

      const details =
        `[computer-use-guard] ${evaluated.violation.reason} ` +
        `session=${ctx.sessionKey ?? "unknown"} tool=${event.toolName} ` +
        `command="${evaluated.commandPreview}"`;

      if (mode === "warn") {
        api.logger.warn(details);
        return;
      }

      api.logger.warn(details);
      return {
        block: true,
        blockReason: `${evaluated.violation.reason} ${evaluated.violation.remediation}`,
      };
    },
    { priority: 100 },
  );
}
