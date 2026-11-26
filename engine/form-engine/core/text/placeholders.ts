/**
 * `{{placeholders}}` in a line of text: `"Page {{page}} of {{pages}}"`, `"{{ firstName }} {{lastName}}"`.
 * One scanner for every text that names values by path — a PDF's template text, a printed
 * form's header and footer — so they agree on what a placeholder is: two braces, a path with
 * no brace in it, two braces; the whitespace inside the braces is not part of the path. A brace
 * that opens no placeholder is literal text.
 */

/** A run of literal text, or a placeholder's path (trimmed). */
export type PlaceholderPiece = { text: string } | { path: string };

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * `template` as literal runs and placeholders, in order. Adjacent literal text is one run and an
 * empty run is left out, so `""` is `[]`.
 */
export function scanPlaceholders(template: string): PlaceholderPiece[] {
  const pieces: PlaceholderPiece[] = [];
  const pushText = (text: string): void => {
    if (text.length === 0) {
      return;
    }
    const last = pieces[pieces.length - 1];
    if (last && "text" in last) {
      last.text += text;
    } else {
      pieces.push({ text });
    }
  };
  let cursor = 0;
  PLACEHOLDER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER.exec(template)) !== null) {
    pushText(template.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    pieces.push({ path: match[1]!.trim() });
  }
  pushText(template.slice(cursor));
  return pieces;
}

/** Whether `text` holds any placeholder at all. */
export function hasPlaceholders(text: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(text);
}
