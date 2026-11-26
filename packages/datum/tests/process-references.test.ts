// @vitest-environment node
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { repoFiles } from "./support/repo-files.js";

/*
 * Code states what it does. It does not point at records of how it came to be: numbered decision
 * records, audits, dated decisions, decision or plan ids, spikes, review roles, or the tooling
 * folders of the process. Such a pointer goes stale and sends a reader to nothing, so the
 * wording belongs in the code as a plain statement of the logic.
 *
 * The same walk reads the tree for personal data (see the second test): a home directory, the
 * scratch folder of a tool session, an email address that is not a placeholder, and file names that
 * carry any of them.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Dotfiles without an extension (.gitignore, .editorconfig) and CODEOWNERS are scanned too.
const EXTENSIONS =
  /(\.(ts|tsx|js|mjs|cjs|mts|java|py|cs|csproj|vue|css|html|yml|yaml|toml|sh|json|xml|properties|factories|cnf|ini|imports|txt|sql|md)|(^|\/)\.[A-Za-z0-9_-]+|(^|\/)CODEOWNERS)$/;
// Decision records are read like every other document. Vendored, generated and third-party licence
// material and lockfiles are out of scope for the process vocabulary; the personal-data rules still
// read them.
const SKIPPED_PATHS = [
  /(^|\/)(node_modules|dist|_generated|generated|vendor|vendored|third_party|licenses?)\//,
  /(^|\/)LICEN[CS]E[^/]*$/,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|uv\.lock|poetry\.lock)$/
];

/*
 * Files whose subject is these words: the guard and the scripts that strip or forbid them. The
 * conformance suite's docs test asserts that its documentation page and decision record exist, so
 * only the ADR-number rule is off for it. Markdown may link decision records, so the ADR-number
 * rule does not read Markdown either.
 */
const SUBJECT_FILES = new Set([
  "packages/datum/tests/process-references.test.ts",
  "site/scripts/gen-docs-reference.mjs",
  "site/test/build.test.ts"
]);
const ADR_NUMBER_EXEMPT_FILES = new Set(["packages/conformance-suite/tests/docs-and-ci.test.ts"]);

/* The axe accessibility audit is a product feature, not a process record. */
const AUDIT_PRODUCT_PATHS = [/^packages\/datum\/a11y\//];

const REVIEWER_PRODUCT_PATHS = [
  /^\.github\/workflows\//,
  // GitHub's required reviewers on a deployment environment, and the sign-off record's reviewer field.
  /^docs\/releasing\.md$/,
  /^docs\/adr\/0164-/,
  /^bindings\/[^/]+\/README\.md$/,
  /^docs\/binding-authoring\.md$/,
  /^packages\/datum\/(binding-kit|tests\/binding-kit)\//
];

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|<!--|--|;)/;
const TRAILING_COMMENT = /\s(\/\/|#)\s.*$/;
// A package.json description is prose the registry publishes, and the feature matrix's notes are prose
// its page renders, so the whole value of such a key counts as a comment.
const JSON_PROSE = /^\s*"(?:description|\$comment|feature|note|why|what)"\s*:/;
// The title of an it/test/describe call, on the call's own line or on the line after a bare `it(`.
// The call may carry modifiers (it.skip, describe.only, it.todo, it.fails, it.concurrent) and a
// table or condition call (it.each(rows), it.for(rows), it.skipIf(!ready), it.runIf(ready)), whose
// argument may hold one level of parentheses, or a tagged table (it.each\`...\`) on one line.
const TITLE_CALL =
  "\\b(?:it|test|describe)(?:\\.(?:skip|only|todo|fails|concurrent|sequential))*" +
  "(?:\\.(?:each|for|skipIf|runIf)(?:\\((?:[^()]|\\([^()]*\\))*\\)|`[^`]*`))?";
const TEST_TITLE = new RegExp(`${TITLE_CALL}\\(\\s*(["'\`])((?:(?!\\1).)*)\\1`);
const TITLE_OPENER = new RegExp(`${TITLE_CALL}\\(\\s*$`);
const TITLE_LINE = /^\s*(["'`])((?:(?!\1).)*)\1/;

interface FileContext {
  path: string;
  text: string;
}

interface Rule {
  name: string;
  test: RegExp | ((subject: string, file: FileContext) => boolean);
  /** Only consider the comment part of a line (and a JSON prose value). */
  commentOnly?: boolean;
  /** Consider the comment part of a line and the title of a test. */
  commentOrTitle?: boolean;
  /** Only consider the title of a test. */
  titleOnly?: boolean;
  skip?: RegExp[];
  /** A subject that matches this is the thing the rule would otherwise misread, and is not a hit. */
  except?: RegExp;
  /** Files in which this rule does not read (Markdown may link decision records). */
  skipFiles?: RegExp[];
}

// A review or finding id: (G5 F4.4), (HP3-1), (R-B234 finding 16), (Q-P4-C13b-1), and a list that
// mixes words with ids, (C1.3, seam S3). Longer prefixes and digit runs are product ids and standards
// names: the conformance vectors (RES-01, JRN-05), the check codes (W002), algorithm names (SHA-1).
const ID_TOKEN = "(?:[A-Z]{1,2}\\d{1,2}|[A-Z]{1,2}-[A-Z0-9]+(?:-[A-Za-z0-9]+)*)(?:[.-]\\d+)*";
// A token inside quotes or after a colon, dot or hyphen ("A1", cookie:NAME) is data, and so is an
// HTTP header name such as X-XSRF-TOKEN (see NOT_AN_ID).
const ID_IN_PARENTHESES = new RegExp(`(?<![\\w./:"'-])${ID_TOKEN}(?![\\w:"'-])`, "g");
// Tokens that look like ids and are not: a database (H2), a WCAG technique (H39), a paper size (A4), a
// hash and a language level (MD5, ES5), a browser (IE11), a storage service (S3), a COSE key type (EC2),
// the conformance suite's severity levels (S1 to S4), a version (V2, V2.1), a curve (P-256), a licence
// (CC0-1.0, CC-BY-4.0), a character range (A-Z), the binding kit's case ids (HK-02, BF-01), the PAdES
// levels (B-LT, B-LTA), the PDF security handler revisions (R2 to R6), a garbage collector (G1), a
// locale tag (PT-BR), an encoding (B64) and an HTTP header name (X-XSRF-TOKEN).
const NOT_AN_ID =
  /^(?:H\d{1,2}|A[3-5]|MD5|ES[56]|IE11|S[1-4]|EC2|V\d+(?:\.\d+)*|P-\d{3}|CC0(?:-[\d.]+)?|CC-BY(?:-SA)?-[\d.]+|[A-Z]-[A-Z]|[A-Z]{2}-[A-Z]{2}|[A-Z]{2}-\d{2,}|B-L?TA?|R[2-6]|G1|B64|X-[A-Z0-9]+(?:-[A-Za-z0-9]+)*)$/;

// A fixture name that the same file defines as a string (bench-check-fixtures F1 to F10) is data.
function definedInFile(id: string, file: FileContext, wholeString = false): boolean {
  // A quote that is part of a triple-quoted docstring opener ("""C1: ...) does not define the id.
  return new RegExp(`(?<!["'\`]["'\`])["'\`]${id}${wholeString ? "[\"'\`]" : "\\b"}`).test(file.text);
}

function reviewIdInParentheses(subject: string, file: FileContext): boolean {
  // A code span such as `(M-1).9.0` is an example, not an id.
  const text = subject.replace(/`[^`]*`/g, "``");
  for (const group of text.matchAll(/\(([^()]*)\)/g)) {
    for (const token of (group[1] ?? "").matchAll(ID_IN_PARENTHESES)) {
      if (!NOT_AN_ID.test(token[0]) && !definedInFile(token[0], file)) {
        return true;
      }
    }
  }
  return false;
}

// A comment led by an id and a colon (F1: ..., C10: ...) labels a section with a review id.
// A Python docstring opens with a triple quote, optionally prefixed (r, b, u, f).
const LEADING_ID = new RegExp(
  `^\\s*(?:\\/\\/|\\/\\*+|\\*|#|--|;|<!--|[rbuf]?(?:"""|'''))\\s*(${ID_TOKEN}):`
);
// A line inside a Python docstring has no marker: only comment and docstring lines reach a comment-only
// rule, so a Python line that starts with an id and a colon is a docstring body line.
const LEADING_ID_IN_DOCSTRING = new RegExp(`^\\s*(${ID_TOKEN}):`);

// A leading id is exempt only when it is a name from outside the project. The review and finding
// families (H2, S1, G1, R3) are ids here even though they are database, severity, collector and
// revision names elsewhere, so NOT_AN_ID, which reads ids in parentheses, is too wide for a label.
const NOT_A_LEADING_ID = /^(?:A[3-5]|MD5|ES[56]|IE11|EC2|V\d+(?:\.\d+)*|P-\d{3})$/;

function leadingIdLabel(subject: string, file: FileContext): boolean {
  const id =
    LEADING_ID.exec(subject)?.[1] ?? (file.path.endsWith(".py") ? LEADING_ID_IN_DOCSTRING.exec(subject)?.[1] : undefined);
  return id !== undefined && !NOT_A_LEADING_ID.test(id) && !definedInFile(id, file);
}

// A test title led by an id and a colon, with an optional second id or letter and a lowercase id in
// parentheses: "A2: ...", "A23 d: ...", "N1 V1: ...", "T1 (poc8): ...". The id in the title itself
// is the only definition that does not count, so a fixture needs the id as a whole string.
const TITLE_LEADING_ID = new RegExp(`^\\s*(${ID_TOKEN})(?:\\s+(?:[A-Z]\\d+|[a-z]))?(?:\\s+\\([a-z]+\\d+\\))?:`);

function leadingIdTitle(subject: string, file: FileContext): boolean {
  const id = TITLE_LEADING_ID.exec(subject)?.[1];
  return id !== undefined && !NOT_A_LEADING_ID.test(id) && !definedInFile(id, file, true);
}

// A Python test name carrying an id (test_..._with_the_o2_fields). Check codes (e001) are longer
// than two digits, and the names NOT_AN_ID lists (test_h2_, test_md5_, test_b64_, test_v2_) are not ids.
function pythonTestNameWithId(subject: string): boolean {
  const name = /\bdef (test_\w+)/.exec(subject)?.[1];
  if (name === undefined) {
    return false;
  }
  return [...name.matchAll(/_([a-z]{1,2}\d{1,2})(?:_|\b)/g)].some((token) => !NOT_AN_ID.test((token[1] ?? "").toUpperCase()));
}

// Bare ids that are not the ones a label leads with: "R1 and R2 cover", "per D35". A pair or a "per" cite
// of a name NOT_AN_ID lists (H2 and H3, per S1) or a fixture the file defines is data.
const ID_PAIR = new RegExp(`(?<![\\w./:"'-])(${ID_TOKEN}) (?:and|&) (${ID_TOKEN})(?![\\w:"'-])`, "g");
const ID_AFTER_PER = new RegExp(`\\bper (${ID_TOKEN})(?![\\w:"'-])`, "g");

function bareIdCite(subject: string, file: FileContext): boolean {
  const text = subject.replace(/`[^`]*`/g, "``");
  // The C0 and C1 control-code sets are a pair of names from the Unicode standard.
  const tokens = [
    ...[...text.matchAll(ID_PAIR)]
      .filter((pair) => !(pair[1] === "C0" && pair[2] === "C1"))
      .flatMap((pair) => [pair[1] ?? "", pair[2] ?? ""]),
    ...[...text.matchAll(ID_AFTER_PER)].map((cite) => cite[1] ?? "")
  ];
  return tokens.some((token) => !NOT_AN_ID.test(token) && !definedInFile(token, file));
}

// A range of ids after a decision link or number ("ADR 0063 E1-E3", "[ADR 0063](../adr/0063-x.md) E1-E3")
// cites the rows of the record by label.
const ID_RANGE_AFTER_ADR = new RegExp(
  `(?:\\bADR\\b|\\badr\\/)[^\\n]{0,80}?(?<![\\w./:"'-])(${ID_TOKEN})\\s*[\u2013\u2014-]\\s*(${ID_TOKEN})(?![\\w:"'-])`
);

function idRangeAfterAdr(subject: string, file: FileContext): boolean {
  const range = ID_RANGE_AFTER_ADR.exec(subject);
  return range !== null && !NOT_AN_ID.test(range[1] ?? "") && !definedInFile(range[1] ?? "", file);
}

// A divider that labels a section with an id: "// ---- C9 ----", "/* ---- C9 ---- */", "-- ---- C9".
// A name NOT_AN_ID lists (H2) or a fixture the file defines is data.
const DIVIDER_ID = /^\s*(?:\/\/|\/\*+|#|\*|--|;)\s*-{2,}\s*([A-Z]{1,2}\d{1,2})\b/;

function dividerLedById(subject: string, file: FileContext): boolean {
  const id = DIVIDER_ID.exec(subject)?.[1];
  return id !== undefined && !NOT_AN_ID.test(id) && !definedInFile(id, file);
}

// A section number of an internal contract. Section numbers of a standard (RFC 9562 section 5.4,
// section 6.1 of WebAuthn) are citations of the standard.
const STANDARD =
  "(?:RFC|WCAG|XML|WebAuthn|ISO|PDF|ECMA|CSS|HTML|IETF|W3C|PAdES|CAdES|X\\.509|ASN\\.1|JCS|ETSI|EN|CSP|OWASP|ASVS|SemVer|JSON Schema)";
const INTERNAL_SECTION = new RegExp(
  `(?<!\\b${STANDARD}\\b[^;]{0,30})\\bsection \\d+\\.\\d+(?![^;]{0,15}\\b(?:of|in) (?:the )?${STANDARD})`,
  "i"
);

const DATE = /(?<!["']|\bafter )\b20\d\d-\d\d-\d\d\b(?!["'])/;

const RULES: Rule[] = [
  { name: "ADR number", test: /\bADRs?[\s-]?#?\d/, skipFiles: [/\.md$/] },
  // The id after "audit" is matched case-sensitively, so "audit" near a lowercase token such as v2 or h2 is prose.
  { name: "audit with a date or id", test: /\b(?:[Aa]udit|AUDIT)s?\b[^\n]{0,20}?(\b20\d\d-\d\d-\d\d\b|\b[A-Z]\d{1,2}\b)/, skip: AUDIT_PRODUCT_PATHS },
  // A date quoted as an example value ("2026-05-14", @"2026-01-01", `2026-01-31`) or a threshold a rule
  // compares against ("after 2020-01-01") is data, not a decision date.
  // A dated upstream commit or release (a hash beside its date, "QuickJS of 2021-03-27") is an upstream fact.
  // A validity range of a test certificate ("valid 2026-01-01 to 2026-06-01") is fixture data.
  {
    name: "date in a comment",
    test: (subject) => DATE.test(subject.replace(/`[^`]*`/g, "``")),
    commentOnly: true,
    except: /\bcommit [0-9a-f]{7,}, 20\d\d-\d\d-\d\d|\b[0-9a-f]{7,} \(20\d\d-\d\d-\d\d|20\d\d-\d\d-\d\d \([0-9a-f]{7,}\)|\bQuickJS (?:of|since) 20\d\d-\d\d-\d\d|\[--date 20\d\d-\d\d-\d\d\]|\b20\d\d-\d\d-\d\d to 20\d\d-\d\d-\d\d\b/
  },
  { name: "refuter", test: /\brefuters?\b/i },
  { name: "spike", test: /(?<!\b(?:heap|memory|cpu|load|traffic|latency|usage) )\bspikes?\b/i },
  { name: "user decision", test: /\buser[- ]decisions?\b/i },
  { name: "the user asked/chose/decided", test: /\bthe user (asked|chose|decided|wanted|approved|rejected|said|requested)\b/i },
  // The root .gitignore names the folder it ignores; the walk's own tests feed it that folder as a fixture.
  { name: ".claude/ folder", test: /\.claude\//, skip: [/^\.gitignore$/, /^packages\/datum\/tests\/repo-files\.test\.ts$/] },
  { name: "decision id", test: /\bdecisions? [A-Z]\d{1,3}\b/ },
  // "the Q-J1 decision", "the K8 decision".
  { name: "named decision", test: /\b[A-Z]-[A-Z]\d+ decision\b|\bthe [A-Z]{1,2}-?[A-Z]?\d+ decision\b/ },
  { name: "phase id", test: /\bphases? \d+[A-Z]\d*\b/i, commentOnly: true },
  // A bare id in parentheses (E1), (C9), (T12) and a list that mixes words with ids: only in comments and
  // test titles; code such as Clock(T0) and standards names such as signingCertificate(V2) are not ids.
  { name: "review id in parentheses", test: reviewIdInParentheses, commentOrTitle: true },
  { name: "id and colon leading a comment", test: leadingIdLabel, commentOnly: true },
  { name: "id and colon leading a test title", test: leadingIdTitle, titleOnly: true },
  { name: "id in a Python test name", test: pythonTestNameWithId },
  // An internal document cited by section: "spec §71", "contract §3", "design spec §1.4". A standard's own
  // section (RFC 9562 §5.4, ETSI EN 319 122 §6) is a citation of the standard and carries its name.
  // A standard's own name before "spec" (the WebAuthn spec §7.2, the PDF spec §12.8) makes it a citation of the standard.
  {
    name: "spec, contract, plan or brief section",
    test: new RegExp(`\\b(?:(?<!\\b${STANDARD}\\s)spec|contract|plan|brief)\\s*§\\s*\\d|\\bdesign spec\\b`, "i"),
    commentOrTitle: true
  },
  { name: "redesign", test: /\bredesign\b/i, commentOrTitle: true },
  { name: "critic", test: /\bcritic\b/i, commentOrTitle: true },
  // Round-N as a noun of the process: "round 2 ruling", "the review of round-3", "(round 2)". Rounding
  // to a number of places ("round 2 decimals", "round-2 digits") is arithmetic.
  {
    name: "round number",
    test: /\bround[- ]\d\b(?:'s)?\s+(?:ruling|review|finding|audit|fix|pass|report|decision)s?\b|\b(?:ruling|review|finding|audit|fix|pass|report|decision)s?\s+(?:of|from|in|after)\s+round[- ]\d\b|\((?:the )?round[- ]\d\)|\b(?:in|per|from|after|before) round[- ]\d\b/i,
    commentOrTitle: true
  },
  { name: "stage letter", test: /\bstage [A-Z]\b/, commentOrTitle: true },
  // The brief of an agent's task: "the brief says", "per the brief". An adjective ("the brief flash") is prose.
  {
    name: "the brief",
    test: /\bthe brief(?:'s)?\s+(?:says|names|allows|asks|fixes|table|states|lists|requires|specifies|describes|gives|wants|limits|defines|forbids|mentions|expects)\b|\b(?:per|in|from|by) the brief\b/i,
    commentOrTitle: true
  },
  // "the K8 budget", "L10's recipe", "G1 spellings", "engine spec E2".
  { name: "id naming a corpus or budget", test: /\b[A-Z]{1,2}\d{1,2}(?:'s)? (?:corpus|recipe|budget|spellings?)\b|\bspec [A-Z]\d/, commentOrTitle: true },
  { name: "the user's request", test: /\bthe user'?s (?:request|choice|ruling)\b/i, commentOrTitle: true },
  // A divider that labels a section with an id: "// ---- C9 ----".
  { name: "divider led by an id", test: dividerLedById, commentOnly: true },
  { name: "bare id pair or per-id cite", test: bareIdCite, commentOrTitle: true },
  { name: "id range after an ADR", test: idRangeAfterAdr, commentOrTitle: true },
  { name: "seam, redesign or provenance id", test: /\b(?:seam|redesign|provenance) [A-Z]\d/, commentOrTitle: true },
  { name: "plan reference", test: /\bplan\s*§|\bplan sections?\b|\(plan\s+\d/i, commentOrTitle: true },
  // The JVM comments' (plan, "Errors") citations, "plan B6", "the Quarkus plan".
  { name: "plan citation", test: /\(plan[,;:]|\bplan "|\bQuarkus plan\b/i, commentOrTitle: true },
  { name: "plan id", test: /\b[Pp]lan [A-Z]\d/, commentOrTitle: true },
  { name: "section number of an internal contract", test: INTERNAL_SECTION, commentOrTitle: true },
  { name: "task report", test: /\btask reports?\b/i, commentOrTitle: true },
  // Only the lowercase role followed by an id: the macOS Finder and a path finder are products.
  { name: "finder", test: /\bfinders? [A-Z]{1,2}-?[A-Z]?\d/, commentOrTitle: true },
  // GitHub environments have required reviewers, and the binding kit's baseline sign-off record has a
  // reviewer field: both are product terms.
  { name: "reviewer", test: /\breviewers?\b/i, commentOrTitle: true, skip: REVIEWER_PRODUCT_PATHS },
  { name: "finding number", test: /\bfindings? \d/i, commentOrTitle: true },
  { name: "research section", test: /\bresearch sections?\b/i, commentOrTitle: true },
  { name: "ruling number", test: /\brulings? \d/i, commentOrTitle: true },
  { name: "decisions file or coordinator", test: /\bdecisions(?:\.md| file)\b|\(decisions, |\bcoordinator\b/i, commentOrTitle: true },
  { name: "review number or round", test: /\breview \d(?! of \d)|\((?:first|second|third|fourth|fifth|final) review\)/i, commentOrTitle: true },
  { name: "wave or sweep", test: /\b[Ff]inal wave\b|\b[Ww]aves? (?:[A-Z]|\d+)\b|\bi18n sweeps?\b/, commentOrTitle: true },
  {
    name: "item or request id",
    test: /\(items? \d+\)|\b[a-z]-[a-z]+(?:-[a-z]+)*[ -](?:request|driver|ruling|item) \d/,
    commentOrTitle: true
  },
  { name: "spec section number", test: new RegExp(`(?<!\\b${STANDARD}\\s)\\bspec sections? \\d`, "i"), commentOrTitle: true },
  { name: "design board", test: /\bboards? [A-Z]\b/, commentOrTitle: true },
  { name: "build batch or change scope", test: /\b(?:later|earlier|next) batches\b|\boutside this change\b/i, commentOrTitle: true },
  { name: "phase numeral", test: /\(Phase [IVX]+\)/, commentOrTitle: true },
  { name: "mockup", test: /\bmock-?ups?\b/i, commentOrTitle: true }
];

// A file the process-vocabulary rules read: a text extension, outside the skipped paths and the subject files.
function processScanned(path: string): boolean {
  return EXTENSIONS.test(path) && !SKIPPED_PATHS.some((skip) => skip.test(path)) && !SUBJECT_FILES.has(path);
}

// Markdown is prose throughout, and the lines of an XML or HTML comment are comment lines.
function commentLines(path: string, lines: string[]): boolean[] {
  if (path.endsWith(".md")) {
    return lines.map(() => true);
  }
  if (path.endsWith(".py")) {
    // A triple-quoted string is a docstring far more often than data: its lines, and the lines that
    // open and close it, read as comment lines.
    let delimiter: string | undefined;
    return lines.map((line) => {
      let touched = delimiter !== undefined;
      for (const quote of line.matchAll(/"""|'''/g)) {
        if (delimiter === undefined) {
          delimiter = quote[0];
          touched = true;
        } else if (quote[0] === delimiter) {
          delimiter = undefined;
        }
      }
      return touched;
    });
  }
  const markup = path.endsWith(".xml") || path.endsWith(".html");
  let inside = false;
  return lines.map((line) => {
    if (!markup) {
      return false;
    }
    const opens = line.includes("<!--");
    const closes = line.includes("-->");
    const wasInside = inside;
    inside = opens && !closes ? true : closes ? false : inside;
    return wasInside || opens;
  });
}

function commentPart(line: string, path: string, wholeLine: boolean): string | undefined {
  if (wholeLine || COMMENT_LINE.test(line) || (path.endsWith(".json") && JSON_PROSE.test(line))) {
    return line;
  }
  const trailing = TRAILING_COMMENT.exec(line);
  return trailing ? trailing[0] : undefined;
}

function titlePart(line: string, previous: string): string | undefined {
  const call = TEST_TITLE.exec(line);
  if (call) {
    return call[2];
  }
  return TITLE_OPENER.test(previous) ? TITLE_LINE.exec(line)?.[2] : undefined;
}

function matches(rule: Rule, subject: string, file: FileContext): boolean {
  return typeof rule.test === "function" ? rule.test(subject, file) : rule.test.test(subject);
}


/*
 * Personal data. A path from someone's machine, the scratch folder a tool session writes to, or a
 * personal mailbox reaches the public tree by accident and cannot be taken back once published.
 * Every text file is read, licence texts and lockfiles included, because a lockfile can pin a
 * dependency by an absolute path and a licence text can quote a home directory. File names are read
 * too.
 */
// Not inside a URL or a relative path (example.ca/en/home/page): the slash must start the path.
const HOME_PATH = /(?<![A-Za-z0-9._-])\/(?:Users|home)\/([A-Za-z0-9._-]+)/g;
const WINDOWS_HOME_PATH = /\b[A-Za-z]:(?:\\+|\/)Users(?:\\+|\/)([^\\/\s"'`]+)/g;
const SESSION_SCRATCH = /\/tmp\/claude-/;

// Names that stand for "some user" in a negative test: the strings a redaction or a leak check is
// fed, a container's service account, and the placeholder users of an example path.
const PLACEHOLDER_HOMES = new Set(["someone", "app", "a", "ada", "a.wasm", "user", "username", "runner", "node", "ubuntu", "vscode", "root"]);

// An email address: a local part, an at sign and a domain that ends in letters, so a package pinned as
// name@1.2.3 and an image called icon@2x.png are not read as one.
const EMAIL = /(?<![\w.%+-])([A-Za-z0-9][A-Za-z0-9._%+-]*)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;
// Domains and labels that cannot reach a person: the reserved names (RFC 2606 and RFC 6761), the
// examples the tests use (example.ca, example.gov), a one-letter placeholder host (x.ca, b.co), the
// project's own role domain, and the addresses a Git host answers for itself.
const PLACEHOLDER_DOMAIN =
  /(^|\.)(example(\.[a-z]+)?|test|invalid|internal|localhost|local)$|^[a-z]\.[a-z]{2,}$|^(?:github\.com|users\.noreply\.github\.com)$|noreply/i;
// The project's own role mailboxes; a person's address at the project domain is still personal.
const PROJECT_ADDRESS = /^(?:conduct|contact|hello|maintainers|security|noreply)@argusvane\.com$/i;
// A file name after an at sign (icon@2x.png, a retina image) ends in an extension, not a top-level domain.
const FILE_SUFFIX = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|scss|js|mjs|cjs|ts|tsx|json|woff2?|ttf|map|html|md|txt)$/i;
// A local part that is a role or a Git remote's user, not a person.
const ROLE_LOCAL = /^(?:noreply|no-reply|git|user|maintainers|security)$/i;
// A refusal's `code@path` (kinds.base.invalid@definition.kinds) and a presentation alias's
// `name@path` are identifiers that read as an address.
const IDENTIFIER_DOMAIN = /^(?:definition|root)\./;
const IDENTIFIER_EMAILS = new Set(["their_phone@reach.tel", "text@address.city"]);
// Copyright lines of third-party licence texts name their authors by address, and the tree ships them
// as the licences require.
const THIRD_PARTY_TEXT = /(^|\/)(?:licenses?|vendor|vendored|third_party)\/|(^|\/)(?:LICEN[CS]E|NOTICE|COPYING)[^/]*$/;
const LOCKFILE = /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|uv\.lock|poetry\.lock)$/;
// A lockfile's reference to a package by an absolute path on the machine that resolved it.
const LOCKFILE_ABSOLUTE_REFERENCE = /["'](?:file|link):(?:\/\/)?(?:\/|[A-Za-z]:[\\/])|\b(?:path|directory)\s*=\s*"(?:\/|[A-Za-z]:[\\/])/;

// Paths that name the tooling of the process or a person's machine. The current user's own name counts
// too, unless it is a name every runner shares.
const PERSONAL_PATH_PARTS = /(^|\/)(?:\.claude|\.rtk|CLAUDE\.md|tasks\.md|Users)(\/|$)|^home\/[^/]+\/|-Users-|claude-\d{3,}|private-tmp/;
const SHARED_ACCOUNT_NAMES = new Set(["runner", "ubuntu", "docker", "vagrant", "builder", "buildkite", "jenkins", "gitpod", "codespace", "github", "node"]);

function currentUserName(): string | undefined {
  try {
    const name = userInfo().username.toLowerCase();
    return name.length >= 6 && !SHARED_ACCOUNT_NAMES.has(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

function personalPathHit(path: string, account: string | undefined): string | undefined {
  if (PERSONAL_PATH_PARTS.test(path)) {
    return "a path of the process tooling or a home directory";
  }
  if (account !== undefined && path.toLowerCase().split(/[^a-z0-9]+/).includes(account)) {
    return "the name of the account that built the tree";
  }
  return undefined;
}

function personalContentHits(line: string, path: string): string[] {
  const hits: string[] = [];
  if (line.includes("/") || line.includes("\\")) {
    for (const home of [...line.matchAll(HOME_PATH), ...line.matchAll(WINDOWS_HOME_PATH)]) {
      if (!PLACEHOLDER_HOMES.has((home[1] ?? "").toLowerCase())) {
        hits.push("home directory path");
      }
    }
    if (SESSION_SCRATCH.test(line)) {
      hits.push("scratch folder of a tool session");
    }
  }
  if (LOCKFILE.test(path)) {
    if (LOCKFILE_ABSOLUTE_REFERENCE.test(line)) {
      hits.push("lockfile reference by an absolute path");
    }
    // A lockfile's author and maintainer fields carry upstream addresses.
    return hits;
  }
  if (line.includes("@") && !THIRD_PARTY_TEXT.test(path)) {
    for (const email of line.matchAll(EMAIL)) {
      const [address = "", local = "", domain = ""] = email;
      if (!PLACEHOLDER_DOMAIN.test(domain) && !FILE_SUFFIX.test(domain) && !ROLE_LOCAL.test(local) && !IDENTIFIER_DOMAIN.test(domain) && !IDENTIFIER_EMAILS.has(address) && !PROJECT_ADDRESS.test(address)) {
        hits.push("email address");
      }
    }
  }
  return hits;
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

interface Scan {
  files: number;
  process: string[];
  personal: string[];
}

function scanProcessReferences(path: string, text: string, hits: string[]): void {
  const file = { path, text };
  const lines = text.split("\n");
  const wholeLines = commentLines(path, lines);
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.skip?.some((skip) => skip.test(path)) || rule.skipFiles?.some((skip) => skip.test(path))) {
        continue;
      }
      if (rule.name === "ADR number" && ADR_NUMBER_EXEMPT_FILES.has(path)) {
        continue;
      }
      const comment = commentPart(line, path, wholeLines[index] === true);
      const title = titlePart(line, lines[index - 1] ?? "");
      const subjects = rule.titleOnly
        ? [title]
        : rule.commentOrTitle
          ? [comment, title]
          : [rule.commentOnly ? comment : line];
      const hit = subjects.some(
        (subject) => subject !== undefined && matches(rule, subject, file) && !rule.except?.test(subject)
      );
      if (hit) {
        hits.push(`${path}:${index + 1} [${rule.name}] ${line.trim().slice(0, 120)}`);
      }
    }
  });
}

// One pass over the tree serves both tests: each file is read once.
let scanned: Scan | undefined;

function scan(): Scan {
  if (scanned !== undefined) {
    return scanned;
  }
  const account = currentUserName();
  const result: Scan = { files: 0, process: [], personal: [] };
  for (const path of repoFiles(REPO)) {
    // This file holds the samples the rules are tested on; the other subject files only name the process
    // words, so they are still read for personal data.
    if (path === "packages/datum/tests/process-references.test.ts") {
      continue;
    }
    const pathHit = personalPathHit(path, account);
    if (pathHit !== undefined) {
      result.personal.push(`${path} [file name: ${pathHit}]`);
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(REPO, path));
    } catch {
      // A broken symbolic link or a file removed during the walk has nothing to read.
      continue;
    }
    if (isBinary(bytes)) {
      continue;
    }
    result.files += 1;
    const text = bytes.toString("utf8");
    if (processScanned(path) && !SUBJECT_FILES.has(path)) {
      scanProcessReferences(path, text, result.process);
    }
    text.split("\n").forEach((line, index) => {
      for (const kind of new Set(personalContentHits(line, path))) {
        result.personal.push(`${path}:${index + 1} [${kind}] ${line.trim().slice(0, 120)}`);
      }
    });
  }
  scanned = result;
  return result;
}

describe("process references", () => {
  it("are absent from code", () => {
    const { files, process } = scan();
    expect(files).toBeGreaterThan(100);
    expect(process).toEqual([]);
  }, 120_000); // reads every text file in the repo, so it is slower than a unit test

  it("read decision records like any other document", () => {
    expect(processScanned("docs/adr/0001-example.md")).toBe(true);
    expect(processScanned("package-lock.json")).toBe(false);
  });

  it("recognise a home path, a scratch folder, a personal address and a personal file name", () => {
    const kinds = (line: string, path = "src/x.ts") => personalContentHits(line, path);
    expect(kinds("const dir = '/Users/jdoe/work/app'")).toEqual(["home directory path"]);
    expect(kinds("const dir = '/home/jdoe/.cache'")).toEqual(["home directory path"]);
    expect(kinds("path: C:\\Users\\jdoe\\Desktop")).toEqual(["home directory path"]);
    expect(kinds("cwd: /private/tmp/claude-501/session")).toEqual(["scratch folder of a tool session"]);
    expect(kinds("contact jane.doe@gmail.com")).toEqual(["email address"]);
    expect(kinds("contact jane.doe@acme.example, ada@example.com, hello@argusvane.com, a@b.co")).toEqual([]);
    expect(kinds("git@github.com:org/repo.git, 12345+jdoe@users.noreply.github.com, pkg@1.2.3, icon@2x.png")).toEqual([]);
    expect(kinds("ignores /Users/someone/own.wasm and /home/app/src")).toEqual([]);
    expect(kinds("WORKDIR /home/node/app, /home/runner/work/x, https://www.example.ca/en/home/page")).toEqual([]);
    expect(kinds("contact jane@argusvane.com")).toEqual(["email address"]);
    expect(kinds('Copyright 2020 Jane <jane@uni.edu>', "packages/x/notices/licenses/y-1.0.txt")).toEqual([]);
    expect(kinds('"resolved": "file:/Users/jdoe/lib"', "package-lock.json")).toEqual(["home directory path", "lockfile reference by an absolute path"]);
    expect(kinds('"resolved": "file:/srv/lib"', "package-lock.json")).toEqual(["lockfile reference by an absolute path"]);
    expect(kinds('"resolved": "file:../lib", "author": "Jane <jane@uni.edu>"', "package-lock.json")).toEqual([]);
    expect(personalPathHit("docs/Users/jdoe/notes.md", undefined)).toBeDefined();
    expect(personalPathHit(".claude/settings.json", undefined)).toBeDefined();
    expect(personalPathHit("docs/notes-by-janedoe.md", "janedoe")).toBeDefined();
    expect(personalPathHit("docs/notes.md", "janedoe")).toBeUndefined();
  });

  it("leave no personal data in the tree: home paths, session scratch folders, personal emails, file names", () => {
    expect(scan().personal).toEqual([]);
  }, 120_000);
});
