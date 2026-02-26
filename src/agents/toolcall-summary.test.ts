import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeToolCallForUser } from "./toolcall-summary.js";

describe("summarizeToolCallForUser", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns fallback when OPENROUTER_API_KEY is missing", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const summary = await summarizeToolCallForUser({
      toolName: "exec",
      toolCallId: "t1",
      args: { command: "ls" },
      fallbackMeta: "list files",
    });
    expect(summary).toBe("list files");
  });

  it("uses OpenRouter summary when available", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "Opent WhatsApp Web en focust op het invoerveld." },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await summarizeToolCallForUser({
      toolName: "exec",
      toolCallId: "t2",
      args: { command: "run # Open" },
      fallbackMeta: "run # Open",
    });

    expect(summary).toBe("Opent WhatsApp Web en focust op het invoerveld.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const requestBody = requestInit.body;
    expect(typeof requestBody).toBe("string");
    const body = JSON.parse(requestBody as string);
    expect(body.model).toBe("openai/gpt-5-nano");
    expect(String(body.messages?.[0]?.content ?? "")).toContain("agent-progress verb");
  });

  it("falls back when provider returns non-ok response", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await summarizeToolCallForUser({
      toolName: "exec",
      toolCallId: "t3",
      args: { command: "run # Click" },
      fallbackMeta: "run # Click",
    });

    expect(summary).toBe("Running # Click");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses OpenRouter auth profile key when env key is missing", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tool-summary-"));
    vi.stubEnv("OPENCLAW_AGENT_DIR", agentDir);
    fs.writeFileSync(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "openrouter:default": {
              type: "api_key",
              provider: "openrouter",
              key: "sk-or-from-profile",
            },
          },
          order: {
            openrouter: ["openrouter:default"],
          },
        },
        null,
        2,
      ),
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Klikt op de knop en vult de invoer in." } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await summarizeToolCallForUser({
      toolName: "exec",
      toolCallId: "t4",
      args: { command: "run # Klik" },
      fallbackMeta: "run # Klik",
    });

    expect(summary).toBe("Klikt op de knop en vult de invoer in.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((requestInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-or-from-profile",
    );
  });

  it("falls back to other openrouter profiles when ordered id is missing", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tool-summary-order-"));
    vi.stubEnv("OPENCLAW_AGENT_DIR", agentDir);
    fs.writeFileSync(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "openrouter:manual": {
              type: "token",
              provider: "openrouter",
              token: "sk-or-manual-token",
            },
          },
          order: {
            openrouter: ["openrouter:default"],
          },
        },
        null,
        2,
      ),
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Vult de loginflow in en start authenticatie." } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await summarizeToolCallForUser({
      toolName: "exec",
      toolCallId: "t5",
      args: { command: "codex login" },
      fallbackMeta: "run login",
    });

    expect(summary).toBe("Vult de loginflow in en start authenticatie.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((requestInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-or-manual-token",
    );
  });

  it("returns Dutch screenshot fallback when image tool has no explicit meta", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const summary = await summarizeToolCallForUser({
      toolName: "image",
      toolCallId: "t6",
      args: {},
    });
    expect(summary).toBe("Screenshot verwerken");
  });

  it("normalizes third-person lead into progressive style", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const summary = await summarizeToolCallForUser({
      toolName: "exec",
      toolCallId: "t7",
      args: { command: "echo hi" },
      fallbackMeta: "run a command to print output.",
    });
    expect(summary).toBe("Running a command to print output.");
  });

  it("retries once on empty length-truncated response", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ finish_reason: "length", message: { content: "" } }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "Analyzing image for button coordinates." },
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await summarizeToolCallForUser({
      toolName: "image",
      toolCallId: "t8",
      args: { imagePath: "/tmp/screen.png" },
      fallbackMeta: "Screenshot verwerken",
    });

    expect(summary).toBe("Analyzing image for button coordinates.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries after timeout-like failure and recovers", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENCLAW_TOOL_SUMMARY_RETRY_BACKOFF_MS", "0,0");
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("tool summary timeout"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            { finish_reason: "stop", message: { content: "Running a command in terminal." } },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await summarizeToolCallForUser({
      toolName: "exec",
      toolCallId: "t9",
      args: { command: "pwd" },
      fallbackMeta: "run pwd",
    });

    expect(summary).toBe("Running a command in terminal.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a fresh timeout scope per retry attempt after abort timeout", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENCLAW_TOOL_SUMMARY_ATTEMPT_TIMEOUT_MS", "500");
    vi.stubEnv("OPENCLAW_TOOL_SUMMARY_RETRY_BACKOFF_MS", "0,0");

    const attemptSignalsAborted: boolean[] = [];
    const fetchMock = vi.fn((_: string, init?: RequestInit) => {
      const attemptIndex = fetchMock.mock.calls.length;
      const signal = init?.signal as AbortSignal | undefined;
      attemptSignalsAborted.push(Boolean(signal?.aborted));
      if (attemptIndex === 1) {
        return new Promise<unknown>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("tool summary timeout"));
            },
            { once: true },
          );
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "Running second attempt after timeout." },
            },
          ],
        }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await summarizeToolCallForUser({
      toolName: "exec",
      toolCallId: "t9b",
      args: { command: "echo fresh-timeout-scope" },
      fallbackMeta: "run fresh timeout scope",
    });

    expect(summary).toBe("Running second attempt after timeout.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(attemptSignalsAborted).toEqual([false, false]);
  });

  it("uses natural process fallback summary instead of raw detail", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const summary = await summarizeToolCallForUser({
      toolName: "process",
      toolCallId: "t10",
      args: { action: "poll", sessionId: "keen-shell", timeout: 5000 },
      fallbackMeta: "session keen-shell",
    });

    expect(summary).toBe("Checking process keen-shell for new output over 5s.");
  });

  it("uses natural cron fallback summary with schedule context", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const summary = await summarizeToolCallForUser({
      toolName: "cron",
      toolCallId: "t11",
      args: {
        action: "add",
        job: {
          name: "resume-notion",
          schedule: { kind: "every", everyMs: 120000 },
        },
      },
      fallbackMeta: "add job",
    });

    expect(summary).toBe('Scheduling cron job "resume-notion" every 2m.');
  });

  it("falls back after repeated timeout errors (hypothesis: timeout)", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENCLAW_TOOL_SUMMARY_RETRY_BACKOFF_MS", "0,0");
    const fetchMock = vi.fn().mockRejectedValue(new Error("tool summary timeout"));
    vi.stubGlobal("fetch", fetchMock);

    const summary = await summarizeToolCallForUser({
      toolName: "exec",
      toolCallId: "h-timeout",
      args: { command: "echo timeout" },
      fallbackMeta: "run timeout probe",
    });

    expect(summary).toBe("Running timeout probe");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("falls back after repeated empty length responses (hypothesis: finish_reason=length)", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENCLAW_TOOL_SUMMARY_RETRY_BACKOFF_MS", "0,0");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: "length", message: { content: "" } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await summarizeToolCallForUser({
      toolName: "exec",
      toolCallId: "h-empty-length",
      args: { command: "echo empty-length" },
      fallbackMeta: "run empty length probe",
    });

    expect(summary).toBe("Running empty length probe");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("falls back after repeated empty stop responses (hypothesis: no content)", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENCLAW_TOOL_SUMMARY_RETRY_BACKOFF_MS", "0,0");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: "stop", message: { content: "" } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await summarizeToolCallForUser({
      toolName: "exec",
      toolCallId: "h-empty-stop",
      args: { command: "echo empty-stop" },
      fallbackMeta: "run empty stop probe",
    });

    expect(summary).toBe("Running empty stop probe");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-retriable HTTP status (hypothesis: something else)", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENCLAW_TOOL_SUMMARY_RETRY_BACKOFF_MS", "0,0");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await summarizeToolCallForUser({
      toolName: "exec",
      toolCallId: "h-http-400",
      args: { command: "echo bad-request" },
      fallbackMeta: "run bad request probe",
    });

    expect(summary).toBe("Running bad request probe");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
