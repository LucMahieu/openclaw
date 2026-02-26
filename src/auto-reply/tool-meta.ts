import { formatToolDetail, formatToolSummary, resolveToolDisplay } from "../agents/tool-display.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";

type ToolAggregateOptions = {
  markdown?: boolean;
  monospaceFence?: boolean;
  includeEmoji?: boolean;
  /** Bullet prefix for status (e.g. "○ ", "□ ", "✓ "). When set, replaces emoji as status indicator. */
  bulletPrefix?: string;
};

export function shortenPath(p: string): string {
  return shortenHomePath(p);
}

export function shortenMeta(meta: string): string {
  if (!meta) {
    return meta;
  }
  return shortenHomeInString(meta);
}

export function formatToolAggregate(
  toolName?: string,
  metas?: string[],
  options?: ToolAggregateOptions,
): string {
  const filtered = (metas ?? []).filter(Boolean).map(shortenMeta);
  const display = resolveToolDisplay({ name: toolName });
  const includeEmoji = options?.includeEmoji !== false;
  const bulletPrefix = options?.bulletPrefix;
  const hideLabel = shouldHideToolLabel(toolName);
  const labelPrefix = hideLabel ? "" : display.label;
  const emojiPrefix = includeEmoji
    ? hideLabel
      ? display.emoji
      : `${display.emoji} ${display.label}`
    : labelPrefix;
  const prefix = bulletPrefix ? labelPrefix : emojiPrefix;
  if (!filtered.length) {
    const base = bulletPrefix ? display.label : prefix || display.label;
    return bulletPrefix ? `${bulletPrefix}${base}` : base;
  }

  const rawSegments: string[] = [];
  // Group by directory and brace-collapse filenames
  const grouped: Record<string, string[]> = {};
  for (const m of filtered) {
    if (!isPathLike(m)) {
      rawSegments.push(m);
      continue;
    }
    if (m.includes("→")) {
      rawSegments.push(m);
      continue;
    }
    const parts = m.split("/");
    if (parts.length > 1) {
      const dir = parts.slice(0, -1).join("/");
      const base = parts.at(-1) ?? m;
      if (!grouped[dir]) {
        grouped[dir] = [];
      }
      grouped[dir].push(base);
    } else {
      if (!grouped["."]) {
        grouped["."] = [];
      }
      grouped["."].push(m);
    }
  }

  const segments = Object.entries(grouped).map(([dir, files]) => {
    const brace = files.length > 1 ? `{${files.join(", ")}}` : files[0];
    if (dir === ".") {
      return brace;
    }
    return `${dir}/${brace}`;
  });

  const allSegments = [...rawSegments, ...segments];
  const meta = allSegments.join("; ");
  const formattedMeta = formatMetaForDisplay(toolName, meta, options?.markdown);
  const body = bulletPrefix
    ? formattedMeta
    : hideLabel
      ? prefix
        ? `${prefix} ${formattedMeta}`
        : formattedMeta
      : `${prefix}: ${formattedMeta}`;
  if (bulletPrefix) {
    const fencedBody = options?.monospaceFence ? wrapMonospaceFence(body) : body;
    return `${bulletPrefix}${fencedBody}`;
  }
  return options?.monospaceFence ? wrapMonospaceFence(body) : body;
}

export function formatToolPrefix(
  toolName?: string,
  meta?: string,
  options?: { includeEmoji?: boolean },
) {
  const extra = meta?.trim() ? shortenMeta(meta) : undefined;
  const display = resolveToolDisplay({ name: toolName, meta: extra });
  const includeEmoji = options?.includeEmoji !== false;
  const emojiPrefix = includeEmoji ? `${display.emoji} ` : "";
  if (shouldHideToolLabel(toolName)) {
    const detail = formatToolDetail(display);
    if (detail) {
      return includeEmoji ? `${display.emoji} ${detail}` : detail;
    }
    return includeEmoji ? display.emoji : display.label;
  }
  const base = formatToolSummary(display);
  return includeEmoji ? base : base.replace(emojiPrefix, "");
}

function formatMetaForDisplay(
  toolName: string | undefined,
  meta: string,
  markdown?: boolean,
): string {
  const normalized = (toolName ?? "").trim().toLowerCase();
  if (normalized === "exec" || normalized === "bash") {
    const { flags, body } = splitExecFlags(meta);
    if (flags.length > 0) {
      if (!body) {
        return flags.join(" · ");
      }
      return `${flags.join(" · ")} · ${maybeWrapMarkdown(body, markdown)}`;
    }
  }
  return maybeWrapMarkdown(meta, markdown);
}

function splitExecFlags(meta: string): { flags: string[]; body: string } {
  const parts = meta
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return { flags: [], body: "" };
  }
  const flags: string[] = [];
  const bodyParts: string[] = [];
  for (const part of parts) {
    if (part === "elevated" || part === "pty") {
      flags.push(part);
      continue;
    }
    bodyParts.push(part);
  }
  return { flags, body: bodyParts.join(" · ") };
}

function isPathLike(value: string): boolean {
  if (!value) {
    return false;
  }
  if (value.includes(" ")) {
    return false;
  }
  if (value.includes("://")) {
    return false;
  }
  if (value.includes("·")) {
    return false;
  }
  if (value.includes("&&") || value.includes("||")) {
    return false;
  }
  return /^~?(\/[^\s]+)+$/.test(value);
}

function maybeWrapMarkdown(value: string, markdown?: boolean): string {
  if (!markdown) {
    return value;
  }
  if (value.includes("`")) {
    return value;
  }
  return `\`${value}\``;
}

function wrapMonospaceFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  // Use inline code fences by default (single backtick), but expand
  // to longer inline fences when content already contains backticks.
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed;
  }
  const runs = trimmed.match(/`+/g) ?? [];
  const maxRun = runs.reduce((acc, run) => Math.max(acc, run.length), 0);
  const fence = "`".repeat(Math.max(1, maxRun + 1));
  return `${fence}${trimmed}${fence}`;
}

function shouldHideToolLabel(toolName?: string): boolean {
  const normalized = (toolName ?? "").trim().toLowerCase();
  return (
    normalized === "exec" ||
    normalized === "bash" ||
    normalized === "image" ||
    normalized === "process" ||
    normalized === "cron" ||
    normalized === "sessions_spawn"
  );
}
