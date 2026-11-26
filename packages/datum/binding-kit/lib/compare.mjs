// Comparing two drawn trees: the elements one by one (box, font, colour), and the lines of text
// they show and read out. Pure functions; the kit page (page/kit-page.js) produces the inputs.

/** A line diff (longest common subsequence): the lines only one side has, in order. */
export function diffLines(reference, binding) {
  const n = reference.length;
  const m = binding.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = reference[i] === binding[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (reference[i] === binding[j]) { i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ side: "reference only", line: reference[i] }); i += 1; }
    else { out.push({ side: "binding only", line: binding[j] }); j += 1; }
  }
  for (; i < n; i += 1) out.push({ side: "reference only", line: reference[i] });
  for (; j < m; j += 1) out.push({ side: "binding only", line: binding[j] });
  return out;
}

/** The text lines of each side with `ignore` ([{ match, reason }]) applied, and their difference. */
export function compareTexts(reference, binding, ignore = []) {
  const patterns = ignore.map((item) => new RegExp(item.match));
  const keep = (lines) => lines.filter((line) => !patterns.some((pattern) => pattern.test(line)));
  const a = keep(reference);
  const b = keep(binding);
  const differences = diffLines(a, b);
  return { equal: differences.length === 0, lines: { reference: a.length, binding: b.length }, differences };
}

const NUMERIC = ["x", "y", "w", "h"];
const STRINGS = ["el", "font", "color", "background", "border"];

/** Pairs the two element lists in order (elements whose text matches an `ignore` entry, [{ match, reason }], are dropped first); a pair differs in tag, font, colour, border or a box beyond `tolerance` px. */
export function compareBoxes(reference, binding, tolerance = 1, ignore = []) {
  const patterns = ignore.map((item) => new RegExp(item.match));
  const keep = (list) => list.filter((entry) => !patterns.some((pattern) => pattern.test(entry.text)));
  reference = keep(reference);
  binding = keep(binding);
  const mismatches = [];
  for (let i = 0; i < Math.max(reference.length, binding.length); i += 1) {
    const r = reference[i];
    const b = binding[i];
    if (!r || !b) { mismatches.push({ index: i, reference: r, binding: b, fields: ["count"] }); continue; }
    const fields = [...NUMERIC.filter((key) => Math.abs(r[key] - b[key]) > tolerance), ...STRINGS.filter((key) => r[key] !== b[key])];
    if (fields.length > 0) mismatches.push({ index: i, reference: r, binding: b, fields });
  }
  return { count: { reference: reference.length, binding: binding.length }, mismatches };
}

/** A one-line account of a box mismatch, for the console. */
export function describeMismatch(m) {
  const show = (e) => (e ? `${e.el}"${e.text}" ${e.x},${e.y} ${e.w}x${e.h} ${e.font} ${e.color}` : "(none)");
  return `#${m.index} [${m.fields.join(",")}] reference ${show(m.reference)} | binding ${show(m.binding)}`;
}
