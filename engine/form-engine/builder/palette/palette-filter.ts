/**
 * The command palette's commands and their ranking. Pure: the shell builds the commands, the palette's chunk filters and draws them.
 */

/** The palette's groups, in the order an empty query lists them. */
export const BUILDER_COMMAND_GROUPS = ["workspaces", "add", "go to", "edit", "documents", "view", "host"] as const;
export type BuilderCommandGroup = (typeof BUILDER_COMMAND_GROUPS)[number];

/** One thing the palette can do, through the same method its control calls. */
export interface BuilderCommand {
  /** Stable: "add:date", "go:country", "document:pdf:letter", "view:outline". */
  id: string;
  /** "Add Date field", "Go to Country", "Open Letter layout". */
  label: string;
  group: BuilderCommandGroup;
  /** Matched beside the label: a type id, a field's id. */
  keywords?: readonly string[] | undefined;
  /** Shown beside it, never bound by the palette. */
  shortcut?: string | undefined;
  /** Greyed and skipped when false: Undo with nothing to undo. */
  enabled?: (() => boolean) | undefined;
  run: () => void | Promise<void>;
}

/** A host's own commands (`builder.registerCommands`), read each time the palette opens. */
export interface BuilderCommandSource {
  commands(): BuilderCommand[];
}

export interface RankedCommand {
  command: BuilderCommand;
  /** The label's characters the query matched, for highlighting. */
  matched: number[];
}

const WORD_BREAK = /[\s:/_\-.(]/;

function isWordStart(text: string, index: number): boolean {
  return index === 0 || WORD_BREAK.test(text[index - 1]!);
}

/** Whether `needle` is a subsequence of `haystack` from `from` on. */
function fitsFrom(haystack: string, needle: string, from: number): boolean {
  let at = from;
  for (const char of needle) {
    const next = haystack.indexOf(char, at);
    if (next < 0) {
      return false;
    }
    at = next + 1;
  }
  return true;
}

/**
 * Where the query's characters fall in `text`, as a subsequence that takes a word start for a
 * character whenever the rest of the query still fits after it; `undefined` when it does not fit.
 */
function subsequence(text: string, query: string): { indexes: number[]; wordStarts: number; span: number } | undefined {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (!fitsFrom(haystack, needle, 0)) {
    return undefined;
  }
  const indexes: number[] = [];
  let from = 0;
  for (let position = 0; position < needle.length; position += 1) {
    const char = needle[position]!;
    const rest = needle.slice(position + 1);
    let chosen = haystack.indexOf(char, from);
    for (let index = chosen; index >= 0 && index < haystack.length; index = haystack.indexOf(char, index + 1)) {
      if (isWordStart(haystack, index) && fitsFrom(haystack, rest, index + 1)) {
        chosen = index;
        break;
      }
    }
    indexes.push(chosen);
    from = chosen + 1;
  }
  const wordStarts = indexes.filter((index) => isWordStart(haystack, index)).length;
  return { indexes, wordStarts, span: indexes.length > 0 ? indexes[indexes.length - 1]! - indexes[0]! : 0 };
}

/**
 * The commands for `query`, best first: a subsequence match over the label and the
 * keywords, ranked by word-start hits, then by how tight the match is, then by group order. An
 * empty query lists the recent commands first (by `recentIds`, most recent first), then every
 * group in order. Disabled commands stay listed, after the enabled ones of their rank.
 */
export function rankCommands(commands: readonly BuilderCommand[], query: string, recentIds: readonly string[] = []): RankedCommand[] {
  const trimmed = query.trim();
  const groupIndex = (command: BuilderCommand): number => BUILDER_COMMAND_GROUPS.indexOf(command.group);
  if (trimmed === "") {
    const recent = recentIds
      .map((id) => commands.find((command) => command.id === id))
      .filter((command): command is BuilderCommand => command !== undefined);
    const rest = commands.filter((command) => !recentIds.includes(command.id));
    const ordered = [...rest].sort((a, b) => groupIndex(a) - groupIndex(b));
    return [...recent, ...ordered].map((command) => ({ command, matched: [] }));
  }
  const scored: Array<{ command: BuilderCommand; matched: number[]; score: number; order: number }> = [];
  commands.forEach((command, order) => {
    const onLabel = subsequence(command.label, trimmed);
    const onKeyword = (command.keywords ?? []).map((keyword) => subsequence(keyword, trimmed)).find((hit) => hit !== undefined);
    const hit = onLabel ?? onKeyword;
    if (!hit) {
      return;
    }
    // Word starts count most; a label hit beats a keyword hit; a tight span beats a loose one.
    const score = hit.wordStarts * 100 + (onLabel ? 50 : 0) - hit.span - (command.enabled && !command.enabled() ? 1000 : 0);
    scored.push({ command, matched: onLabel ? onLabel.indexes : [], score, order });
  });
  scored.sort((a, b) => b.score - a.score || groupIndex(a.command) - groupIndex(b.command) || a.order - b.order);
  return scored.map(({ command, matched }) => ({ command, matched }));
}
