import { describe, expect, it } from "vitest";
import { buildEmbeddedRunPayloads } from "./payloads.js";

type BuildPayloadParams = Parameters<typeof buildEmbeddedRunPayloads>[0];

function buildPayloads(overrides: Partial<BuildPayloadParams> = {}) {
  return buildEmbeddedRunPayloads({
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
    sessionKey: "session:telegram",
    inlineToolResultsAllowed: false,
    verboseLevel: "off",
    reasoningLevel: "off",
    toolResultFormat: "plain",
    ...overrides,
  });
}

describe("buildEmbeddedRunPayloads tool-error warnings", () => {
  it("suppresses exec tool errors when verbose mode is off", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "exec", error: "command failed" },
      verboseLevel: "off",
    });

    expect(payloads).toHaveLength(0);
  });

  it("shows exec tool errors when verbose mode is on", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "exec", error: "command failed" },
      verboseLevel: "on",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads[0]?.text).toContain("💻");
    expect(payloads[0]?.text).toContain("command failed");
  });

  it("keeps non-exec mutating tool failures visible", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "write", error: "permission denied" },
      verboseLevel: "off",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads[0]?.text).toContain("Write");
  });

  it("wraps tool summary lines in inline backticks when monospace fence is enabled", () => {
    const payloads = buildPayloads({
      toolMetas: [{ toolName: "exec", meta: "Running cd ~/workspace" }],
      inlineToolResultsAllowed: true,
      verboseLevel: "on",
      toolResultMonospaceFence: true,
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("_```💻 Running cd ~/workspace```_");
  });

  it("can render tool summary lines without emoji", () => {
    const payloads = buildPayloads({
      toolMetas: [{ toolName: "exec", meta: "Running cd ~/workspace" }],
      inlineToolResultsAllowed: true,
      verboseLevel: "on",
      toolResultIncludeEmoji: false,
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Running cd ~/workspace");
  });
});
