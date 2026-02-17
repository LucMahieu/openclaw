import type { Command } from "commander";
import { autocomplete as clackAutocomplete, isCancel } from "@clack/prompts";
import { stylePromptHint, stylePromptMessage } from "../../terminal/prompt-style.js";
import { fuzzyFilterLower, prepareSearchItems } from "../../tui/components/fuzzy-filter.js";
import { getCoreCliCommandNames, registerCoreCliByName } from "./command-registry.js";
import { getProgramContext } from "./program-context.js";
import { getSubCliEntries, registerSubCliByName } from "./register.subclis.js";

const SHOW_HELP_VALUE = "__show_help__";
const BACK_TO_MAIN_VALUE = "__back_to_main__";
const RUN_CURRENT_VALUE = "__run_current__";
const PATH_SEPARATOR = "\u0000";
const SELECTION_VALUE_SEPARATOR = "\u0001";
const MAX_RESULTS = 200;

type CommandSelectorCandidate = {
  path: string[];
  label: string;
  description: string;
  searchText: string;
};

type PreparedCommandSelectorCandidate = CommandSelectorCandidate & {
  searchTextLower: string;
};

type SelectorPromptResult = string[] | "back_to_main" | "run_current" | null;

function isHiddenCommand(command: Command): boolean {
  // Commander stores hidden state on a private field.
  return Boolean((command as Command & { _hidden?: boolean })._hidden);
}

function shouldSkipCommand(command: Command, _parentDepth: number): boolean {
  return isHiddenCommand(command) || command.name() === "help";
}

function resolveCommandDescription(command: Command): string {
  const summary = typeof command.summary === "function" ? command.summary().trim() : "";
  if (summary) {
    return summary;
  }
  const description = command.description().trim();
  if (description) {
    return description;
  }
  return "Run this command";
}

function prepareSortedCandidates(
  raw: CommandSelectorCandidate[],
): PreparedCommandSelectorCandidate[] {
  const prepared = prepareSearchItems(raw);
  prepared.sort((a, b) => a.label.localeCompare(b.label));
  return prepared;
}

function collectCandidatesRecursive(params: {
  command: Command;
  parentPath: string[];
  seen: Set<string>;
  out: CommandSelectorCandidate[];
}): void {
  for (const child of params.command.commands) {
    if (shouldSkipCommand(child, params.parentPath.length)) {
      continue;
    }
    const path = [...params.parentPath, child.name()];
    const label = path.join(" ");
    if (!params.seen.has(label)) {
      params.seen.add(label);
      params.out.push({
        path,
        label,
        description: resolveCommandDescription(child),
        searchText: path.join(" "),
      });
    }

    collectCandidatesRecursive({
      command: child,
      parentPath: path,
      seen: params.seen,
      out: params.out,
    });
  }
}

export function collectCommandSelectorCandidates(
  program: Command,
): PreparedCommandSelectorCandidate[] {
  const seen = new Set<string>();
  const raw: CommandSelectorCandidate[] = [];
  collectCandidatesRecursive({ command: program, parentPath: [], seen, out: raw });
  return prepareSortedCandidates(raw);
}

export function resolveCommandByPath(program: Command, path: string[]): Command | null {
  let current: Command = program;
  for (const segment of path) {
    const next = current.commands.find((child) => child.name() === segment);
    if (!next) {
      return null;
    }
    current = next;
  }
  return current;
}

export function commandRequiresSubcommand(command: Command): boolean {
  const visibleChildren = command.commands.filter((child) => !shouldSkipCommand(child, 1));
  return visibleChildren.length > 0;
}

export function collectDirectSubcommandSelectorCandidates(
  program: Command,
  basePath: string[],
): PreparedCommandSelectorCandidate[] {
  const parent = resolveCommandByPath(program, basePath);
  if (!parent) {
    return [];
  }

  const raw: CommandSelectorCandidate[] = [];
  for (const child of parent.commands) {
    if (shouldSkipCommand(child, basePath.length)) {
      continue;
    }
    const path = [...basePath, child.name()];
    raw.push({
      path,
      label: child.name(),
      description: resolveCommandDescription(child),
      searchText: `${child.name()} ${path.join(" ")}`,
    });
  }
  return prepareSortedCandidates(raw);
}

function prioritizeDeepCommandsForSubcommandQuery(params: {
  ranked: PreparedCommandSelectorCandidate[];
  queryLower: string;
}): PreparedCommandSelectorCandidate[] {
  const tokens = params.queryLower.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length !== 1) {
    return params.ranked;
  }
  const [token] = tokens;
  if (!token) {
    return params.ranked;
  }

  const deepExact: PreparedCommandSelectorCandidate[] = [];
  const remaining: PreparedCommandSelectorCandidate[] = [];
  for (const candidate of params.ranked) {
    const last = candidate.path[candidate.path.length - 1]?.toLowerCase();
    if (candidate.path.length >= 2 && last === token) {
      deepExact.push(candidate);
      continue;
    }
    remaining.push(candidate);
  }

  if (deepExact.length === 0) {
    return params.ranked;
  }
  return [...deepExact, ...remaining];
}

export function rankCommandSelectorCandidates(
  candidates: PreparedCommandSelectorCandidate[],
  query: string,
): PreparedCommandSelectorCandidate[] {
  const queryLower = query.trim().toLowerCase();
  if (!queryLower) {
    return candidates;
  }
  const ranked = fuzzyFilterLower(candidates, queryLower);
  return prioritizeDeepCommandsForSubcommandQuery({ ranked, queryLower });
}

async function hydrateProgramCommandsForSelector(program: Command): Promise<void> {
  const ctx = getProgramContext(program);
  if (ctx) {
    for (const name of getCoreCliCommandNames()) {
      try {
        await registerCoreCliByName(program, ctx, name);
      } catch {
        // Keep selector usable even if one registrar fails in this environment.
      }
    }
  }

  for (const entry of getSubCliEntries()) {
    try {
      await registerSubCliByName(program, entry.name);
    } catch {
      // Keep selector usable even if one registrar fails in this environment.
    }
  }
}

function serializePath(path: string[]): string {
  return path.join(PATH_SEPARATOR);
}

function deserializePath(value: string): string[] {
  return value
    .split(PATH_SEPARATOR)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function serializeSelectionValue(params: { path: string[]; query: string }): string {
  return `${params.query}${SELECTION_VALUE_SEPARATOR}${serializePath(params.path)}`;
}

function deserializeSelectionPath(value: string): string[] {
  const separatorIndex = value.indexOf(SELECTION_VALUE_SEPARATOR);
  const pathValue = separatorIndex >= 0 ? value.slice(separatorIndex + 1) : value;
  return deserializePath(pathValue);
}

async function promptForCommandSelection(params: {
  message: string;
  placeholder: string;
  candidates: PreparedCommandSelectorCandidate[];
  includeBackToMain?: boolean;
  includeRunCurrent?: boolean;
  currentPath?: string[];
}): Promise<SelectorPromptResult> {
  const selection = await clackAutocomplete<string>({
    message: params.message,
    placeholder: params.placeholder,
    maxItems: 10,
    // We pre-rank the list with our fuzzy scorer, then opt out of clack's own
    // filter so item order stays stable and score-based.
    filter: () => true,
    options() {
      const query = this.userInput.trim();
      const ranked = rankCommandSelectorCandidates(params.candidates, query).slice(0, MAX_RESULTS);
      return [
        ...ranked.map((candidate) => ({
          value: serializeSelectionValue({ path: candidate.path, query }),
          label: candidate.label,
          hint: stylePromptHint(candidate.description),
        })),
        ...(params.includeRunCurrent
          ? [
              {
                value: RUN_CURRENT_VALUE,
                label: "./",
                hint: stylePromptHint(
                  `Run ${params.currentPath?.join(" ") ?? "selected command"} directly`,
                ),
              },
            ]
          : []),
        ...(params.includeBackToMain
          ? [
              {
                value: BACK_TO_MAIN_VALUE,
                label: "../",
                hint: stylePromptHint("Back to main command selector"),
              },
            ]
          : []),
        {
          value: SHOW_HELP_VALUE,
          label: "Show help",
          hint: stylePromptHint("Skip selector and print CLI help"),
        },
      ];
    },
  });

  if (isCancel(selection) || selection === SHOW_HELP_VALUE) {
    return null;
  }
  if (selection === BACK_TO_MAIN_VALUE) {
    return "back_to_main";
  }
  if (selection === RUN_CURRENT_VALUE) {
    return "run_current";
  }
  return deserializeSelectionPath(selection);
}

export async function runInteractiveCommandSelector(program: Command): Promise<string[] | null> {
  await hydrateProgramCommandsForSelector(program);

  const mainCandidates = collectCommandSelectorCandidates(program);
  if (mainCandidates.length === 0) {
    return null;
  }

  while (true) {
    const mainSelection = await promptForCommandSelection({
      message: stylePromptMessage("Find and run a command") ?? "Find and run a command",
      placeholder: "Type to fuzzy-search (e.g. msg snd)",
      candidates: mainCandidates,
    });
    if (!mainSelection || mainSelection === "back_to_main" || mainSelection === "run_current") {
      return null;
    }

    let selectedPath = mainSelection;
    let selectedCommand = resolveCommandByPath(program, selectedPath);
    if (!selectedCommand || !commandRequiresSubcommand(selectedCommand)) {
      return selectedPath;
    }

    while (true) {
      const subcommandCandidates = collectDirectSubcommandSelectorCandidates(program, selectedPath);
      if (subcommandCandidates.length === 0) {
        return selectedPath;
      }

      const subSelection = await promptForCommandSelection({
        message:
          stylePromptMessage(`Select subcommand for ${selectedPath.join(" ")}`) ??
          `Select subcommand for ${selectedPath.join(" ")}`,
        placeholder: "Type to fuzzy-search subcommands",
        candidates: subcommandCandidates,
        includeRunCurrent: true,
        currentPath: selectedPath,
        includeBackToMain: true,
      });
      if (!subSelection) {
        return null;
      }
      if (subSelection === "back_to_main") {
        break;
      }
      if (subSelection === "run_current") {
        return selectedPath;
      }

      selectedPath = subSelection;
      selectedCommand = resolveCommandByPath(program, selectedPath);
      if (!selectedCommand || !commandRequiresSubcommand(selectedCommand)) {
        return selectedPath;
      }
    }
  }
}
