import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatToolAggregate, formatToolPrefix, shortenMeta, shortenPath } from "./tool-meta.js";

// Use path.resolve so inputs match the resolved HOME on every platform.
const home = path.resolve("/Users/test");

describe("tool meta formatting", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("shortens paths under HOME", () => {
    vi.stubEnv("HOME", home);
    expect(shortenPath(home)).toBe("~");
    expect(shortenPath(`${home}/a/b.txt`)).toBe("~/a/b.txt");
    expect(shortenPath("/opt/x")).toBe("/opt/x");
  });

  it("shortens meta strings with optional colon suffix", () => {
    vi.stubEnv("HOME", home);
    expect(shortenMeta(`${home}/a.txt`)).toBe("~/a.txt");
    expect(shortenMeta(`${home}/a.txt:12`)).toBe("~/a.txt:12");
    expect(shortenMeta(`cd ${home}/dir && ls`)).toBe("cd ~/dir && ls");
    expect(shortenMeta("")).toBe("");
  });

  it("formats aggregates with grouping and brace-collapse", () => {
    vi.stubEnv("HOME", home);
    const out = formatToolAggregate("  fs  ", [
      `${home}/dir/a.txt`,
      `${home}/dir/b.txt`,
      "note",
      "a→b",
    ]);
    expect(out).toMatch(/^🧩 Fs/);
    expect(out).toContain("~/dir/{a.txt, b.txt}");
    expect(out).toContain("note");
    expect(out).toContain("a→b");
  });

  it("wraps aggregate meta in backticks when markdown is enabled", () => {
    vi.stubEnv("HOME", home);
    const out = formatToolAggregate("fs", [`${home}/dir/a.txt`], { markdown: true });
    expect(out).toContain("`~/dir/a.txt`");
  });

  it("wraps full aggregate in inline backticks when monospace fence is enabled", () => {
    vi.stubEnv("HOME", home);
    const out = formatToolAggregate("exec", ["Running command"], { monospaceFence: true });
    expect(out).toBe("`💻 Running command`");
  });

  it("can render aggregate without emoji", () => {
    vi.stubEnv("HOME", home);
    const out = formatToolAggregate("exec", ["Running command"], { includeEmoji: false });
    expect(out).toBe("Running command");
  });

  it("keeps exec flags outside markdown and moves them to the front", () => {
    vi.stubEnv("HOME", home);
    const out = formatToolAggregate("exec", [`cd ${home}/dir && gemini 2>&1 · elevated`], {
      markdown: true,
    });
    expect(out).toBe("💻 elevated · `cd ~/dir && gemini 2>&1`");
  });

  it("formats prefixes with default labels", () => {
    vi.stubEnv("HOME", home);
    expect(formatToolPrefix(undefined, undefined)).toBe("🧩 Tool");
    expect(formatToolPrefix("x", `${home}/a.txt`)).toBe("🧩 X: ~/a.txt");
    expect(formatToolPrefix("image", "Screenshot van ChatGPT Atlas")).toBe(
      "📸 Screenshot van ChatGPT Atlas",
    );
    expect(formatToolPrefix("exec", "Running a command in terminal.")).toBe(
      "💻 Running a command in terminal.",
    );
    expect(formatToolPrefix("process", "Checking process keen-shell for new output.")).toBe(
      "🧰 Checking process keen-shell for new output.",
    );
    expect(formatToolPrefix("cron", 'Scheduling cron job "resume-notion" every 2m.')).toBe(
      '⏰ Scheduling cron job "resume-notion" every 2m.',
    );
    expect(
      formatToolPrefix("exec", "Running a command in terminal.", { includeEmoji: false }),
    ).toBe("Running a command in terminal.");
  });
});
