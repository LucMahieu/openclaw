import { Option } from "commander";
import { describe, expect, it } from "vitest";
import {
  preferredOptionFlag,
  shouldPromptForOption,
  splitMultiValueInput,
} from "./command-questionnaire.js";

describe("command-questionnaire", () => {
  it("splits multi-value input by spaces and commas", () => {
    expect(splitMultiValueInput("a b, c,,d")).toEqual(["a", "b", "c", "d"]);
  });

  it("prefers long option flags", () => {
    const option = new Option("-p, --provider <name>");
    expect(preferredOptionFlag(option)).toBe("--provider");
  });

  it("falls back to short flag when long is absent", () => {
    const option = new Option("-f");
    expect(preferredOptionFlag(option)).toBe("-f");
  });

  it("skips internal and hidden options", () => {
    expect(shouldPromptForOption(new Option("-h, --help"))).toBe(false);
    expect(shouldPromptForOption(new Option("-V, --version"))).toBe(false);
    expect(shouldPromptForOption(new Option("-i, --interactive"))).toBe(false);

    const hidden = new Option("--secret");
    hidden.hideHelp(true);
    expect(shouldPromptForOption(hidden)).toBe(false);
  });

  it("prompts for regular options", () => {
    expect(shouldPromptForOption(new Option("--provider <name>"))).toBe(true);
  });
});
