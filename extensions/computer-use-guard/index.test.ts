import { describe, expect, it, vi } from "vitest";
import register, { evaluateExecGuard } from "./index.js";

function createApi(pluginConfig: Record<string, unknown> = {}) {
  const hooks: Record<string, Function> = {};
  const api = {
    pluginConfig,
    id: "computer-use-guard",
    name: "Computer Use Guard",
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
    on: vi.fn((hookName: string, handler: Function) => {
      hooks[hookName] = handler;
    }),
  };
  return { api, hooks };
}

describe("computer-use-guard evaluateExecGuard", () => {
  it("detects raw VM GUI command", () => {
    const result = evaluateExecGuard(
      {
        toolName: "exec",
        params: {
          command: "DISPLAY=:1 xdotool mousemove 100 200 && DISPLAY=:1 scrot /tmp/a.png",
        },
      },
      "enforce",
    );

    expect(result.violation?.kind).toBe("vm");
  });

  it("allows VM helper command", () => {
    const result = evaluateExecGuard(
      {
        toolName: "exec",
        params: {
          command:
            'VMCUA="DISPLAY=:1 python3 ~/.openclaw/workspace/skills/vm-computer-use/scripts/cua_helper.py"; $VMCUA click 100 200',
        },
      },
      "enforce",
    );

    expect(result.violation).toBeNull();
  });

  it("blocks mixed VM helper + raw GUI command", () => {
    const result = evaluateExecGuard(
      {
        toolName: "exec",
        params: {
          command:
            'VMCUA="DISPLAY=:1 python3 ~/.openclaw/workspace/skills/vm-computer-use/scripts/cua_helper.py"; $VMCUA screenshot; DISPLAY=:1 xdotool click 1',
        },
      },
      "enforce",
    );

    expect(result.violation?.kind).toBe("vm");
  });

  it("detects raw Mac GUI command", () => {
    const result = evaluateExecGuard(
      {
        toolName: "exec",
        params: {
          command: "cliclick c:200,300",
        },
      },
      "enforce",
    );

    expect(result.violation?.kind).toBe("mac");
  });

  it("allows mac_helper command", () => {
    const result = evaluateExecGuard(
      {
        toolName: "exec",
        params: {
          command:
            'MAC="bash ~/.openclaw/workspace/skills/mac-computer-use/mac_helper.sh"; $MAC click 200 300',
        },
      },
      "enforce",
    );

    expect(result.violation).toBeNull();
  });

  it("blocks mixed mac_helper + raw GUI command", () => {
    const result = evaluateExecGuard(
      {
        toolName: "exec",
        params: {
          command:
            'MAC="bash ~/.openclaw/workspace/skills/mac-computer-use/mac_helper.sh"; $MAC screenshot; cliclick c:20,20',
        },
      },
      "enforce",
    );

    expect(result.violation?.kind).toBe("mac");
  });
});

describe("computer-use-guard register", () => {
  it("blocks raw VM command in enforce mode", () => {
    const { api, hooks } = createApi({ mode: "enforce" });
    register(api as any);

    const handler = hooks.before_tool_call;
    expect(handler).toBeTypeOf("function");

    const out = handler(
      {
        toolName: "exec",
        params: { command: "DISPLAY=:1 xdotool key ctrl+l && DISPLAY=:1 scrot /tmp/s.png" },
      },
      { sessionKey: "agent:main:main", toolName: "exec" },
    );

    expect(out).toMatchObject({ block: true });
    expect(String(out?.blockReason ?? "")).toContain("Helper-only VM route is mandatory");
  });

  it("warns without blocking in warn mode", () => {
    const { api, hooks } = createApi({ mode: "warn" });
    register(api as any);

    const out = hooks.before_tool_call(
      {
        toolName: "exec",
        params: { command: "cliclick c:20,20" },
      },
      { sessionKey: "agent:main:main", toolName: "exec" },
    );

    expect(out).toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalled();
  });

  it("skips guard when emergencyBypass=true", () => {
    const { api, hooks } = createApi({ mode: "enforce", emergencyBypass: true });
    register(api as any);

    const out = hooks.before_tool_call(
      {
        toolName: "exec",
        params: { command: "cliclick c:20,20" },
      },
      { sessionKey: "agent:main:main", toolName: "exec" },
    );

    expect(out).toBeUndefined();
    expect(api.logger.warn).not.toHaveBeenCalled();
  });
});
