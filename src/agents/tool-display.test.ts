import { describe, expect, it } from "vitest";
import { resolveToolBarStatus } from "./tool-display.js";

describe("resolveToolBarStatus", () => {
  it("returns Running command / Ran command for exec without command", () => {
    expect(resolveToolBarStatus({ name: "exec", args: {}, isPartial: true })).toBe(
      "Running command",
    );
    expect(resolveToolBarStatus({ name: "exec", args: {}, isPartial: false })).toBe("Ran command");
  });

  it("returns command-specific labels for exec (sentence case)", () => {
    expect(
      resolveToolBarStatus({
        name: "exec",
        args: { command: "ls -la" },
        isPartial: true,
      }),
    ).toBe("Listing directory");
    expect(
      resolveToolBarStatus({
        name: "exec",
        args: { command: "ls -la" },
        isPartial: false,
      }),
    ).toBe("Listed directory");
    expect(
      resolveToolBarStatus({
        name: "exec",
        args: { command: 'grep "foo" file.txt' },
        isPartial: false,
      }),
    ).toBe("Searched with grep");
    expect(
      resolveToolBarStatus({
        name: "exec",
        args: { command: "find . -name '*.ts'" },
        isPartial: false,
      }),
    ).toBe("Found files");
    expect(
      resolveToolBarStatus({
        name: "exec",
        args: { command: "git status" },
        isPartial: false,
      }),
    ).toBe("Checked git status");
    expect(
      resolveToolBarStatus({
        name: "exec",
        args: { command: "npm run build" },
        isPartial: false,
      }),
    ).toBe("Ran build");
  });

  it("returns Read, Write, Edit, Attach for file tools", () => {
    expect(resolveToolBarStatus({ name: "read" })).toBe("Read");
    expect(resolveToolBarStatus({ name: "write" })).toBe("Write");
    expect(resolveToolBarStatus({ name: "edit" })).toBe("Edit");
    expect(resolveToolBarStatus({ name: "attach" })).toBe("Attach");
  });

  it("returns tool label for other tools", () => {
    expect(resolveToolBarStatus({ name: "web_search" })).toBe("Web Search");
    expect(resolveToolBarStatus({ name: "browser" })).toBe("Browser");
  });
});
