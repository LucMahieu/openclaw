import type { Argument, Command, Option } from "commander";
import {
  confirm as clackConfirm,
  isCancel,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import { stylePromptHint, stylePromptMessage } from "../../terminal/prompt-style.js";
import { resolveCommandByPath } from "./command-selector.js";

const INTERNAL_OPTION_NAMES = new Set(["help", "version", "interactive"]);

type PromptResult = string[] | null;

export function splitMultiValueInput(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function preferredOptionFlag(option: Option): string {
  return option.long ?? option.short ?? option.flags.split(/[ ,|]+/)[0] ?? option.flags;
}

export function shouldPromptForOption(option: Option): boolean {
  if (option.hidden) {
    return false;
  }
  return !INTERNAL_OPTION_NAMES.has(option.name());
}

async function askValue(params: {
  message: string;
  placeholder?: string;
  required?: boolean;
}): Promise<string | null> {
  const value = await clackText({
    message: stylePromptMessage(params.message) ?? params.message,
    placeholder: params.placeholder,
    validate: params.required
      ? (input) => {
          if (!input || input.trim().length === 0) {
            return "Value required";
          }
          return undefined;
        }
      : undefined,
  });
  if (isCancel(value)) {
    return null;
  }
  return String(value ?? "").trim();
}

async function askChoice(params: {
  message: string;
  choices: readonly string[];
  hint?: string;
}): Promise<string | null> {
  const choice = await clackSelect<string>({
    message: stylePromptMessage(params.message) ?? params.message,
    options: params.choices.map((value) => ({
      value,
      label: value,
      hint: params.hint ? stylePromptHint(params.hint) : undefined,
    })),
  });
  if (isCancel(choice)) {
    return null;
  }
  return choice;
}

async function promptArgumentValue(argument: Argument): Promise<PromptResult> {
  const label = argument.name();
  const suffix = argument.description ? ` — ${argument.description}` : "";

  if (!argument.required) {
    const include = await clackConfirm({
      message:
        stylePromptMessage(`Provide optional argument <${label}>?${suffix}`) ??
        `Provide optional argument <${label}>?${suffix}`,
      initialValue: false,
    });
    if (isCancel(include)) {
      return null;
    }
    if (!include) {
      return [];
    }
  }

  if (argument.argChoices && argument.argChoices.length > 0 && !argument.variadic) {
    const choice = await askChoice({
      message: `Select value for <${label}>`,
      choices: argument.argChoices,
      hint: argument.description,
    });
    return choice === null ? null : [choice];
  }

  if (argument.variadic) {
    const raw = await askValue({
      message: `Values for <${label}...> (space/comma-separated)${suffix}`,
      placeholder: argument.required ? "value1 value2" : "optional",
      required: argument.required,
    });
    if (raw === null) {
      return null;
    }
    const values = splitMultiValueInput(raw);
    if (argument.required && values.length === 0) {
      return null;
    }
    return values;
  }

  const value = await askValue({
    message: `Value for <${label}>${suffix}`,
    required: argument.required,
  });
  if (value === null) {
    return null;
  }
  if (!value && !argument.required) {
    return [];
  }
  return [value];
}

async function promptOptionValue(option: Option): Promise<PromptResult> {
  const flag = preferredOptionFlag(option);
  const description = option.description ? ` — ${option.description}` : "";

  if (option.isBoolean()) {
    const verb = option.negate ? "Disable" : "Enable";
    const enabled = await clackConfirm({
      message:
        stylePromptMessage(`${verb} ${flag}?${description}`) ?? `${verb} ${flag}?${description}`,
      initialValue: false,
    });
    if (isCancel(enabled)) {
      return null;
    }
    return enabled ? [flag] : [];
  }

  const shouldAsk =
    option.mandatory ||
    (await clackConfirm({
      message: stylePromptMessage(`Set ${flag}?${description}`) ?? `Set ${flag}?${description}`,
      initialValue: false,
    }));
  if (isCancel(shouldAsk)) {
    return null;
  }
  if (!shouldAsk) {
    return [];
  }

  if (option.argChoices && option.argChoices.length > 0 && !option.variadic) {
    const choice = await askChoice({
      message: `Select value for ${flag}`,
      choices: option.argChoices,
      hint: option.description,
    });
    return choice === null ? null : [flag, choice];
  }

  if (option.optional) {
    const raw = await askValue({
      message: `Optional value for ${flag} (leave empty for flag only)${description}`,
      required: false,
    });
    if (raw === null) {
      return null;
    }
    return raw.length > 0 ? [flag, raw] : [flag];
  }

  if (option.variadic) {
    const raw = await askValue({
      message: `Values for ${flag} (space/comma-separated)${description}`,
      placeholder: "value1 value2",
      required: option.mandatory || option.required,
    });
    if (raw === null) {
      return null;
    }
    const values = splitMultiValueInput(raw);
    if (values.length === 0) {
      return option.mandatory || option.required ? null : [flag];
    }
    const tokens: string[] = [];
    for (const value of values) {
      tokens.push(flag, value);
    }
    return tokens;
  }

  const value = await askValue({
    message: `Value for ${flag}${description}`,
    required: option.mandatory || option.required,
  });
  if (value === null) {
    return null;
  }
  if (!value && !(option.mandatory || option.required)) {
    return [];
  }
  return [flag, value];
}

export async function runCommandQuestionnaire(params: {
  program: Command;
  commandPath: string[];
}): Promise<string[] | null> {
  const command = resolveCommandByPath(params.program, params.commandPath);
  if (!command) {
    return [];
  }

  const optionTokens: string[] = [];
  for (const option of command.options) {
    if (!shouldPromptForOption(option)) {
      continue;
    }
    const tokens = await promptOptionValue(option);
    if (tokens === null) {
      return null;
    }
    optionTokens.push(...tokens);
  }

  const argumentTokens: string[] = [];
  for (const argument of command.registeredArguments) {
    const tokens = await promptArgumentValue(argument);
    if (tokens === null) {
      return null;
    }
    argumentTokens.push(...tokens);
  }

  return [...optionTokens, ...argumentTokens];
}
