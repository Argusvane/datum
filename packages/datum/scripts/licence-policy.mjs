// The licences a Datum distribution may carry from other people, and the one function every notice check asks:
// the npm bundles (notices-lib.mjs packageProblems, scripts/notices.mjs), the JVM jars' and the FastAPI wheels' notices.json rows
// (the notices tests under integrations/). Datum itself is MIT; a package under a copyleft or an unknown licence that
// reaches an npm bundle fails the build with the package's name, so the licence is decided by a person before it ships.
// The JVM and FastAPI rows are the ones the notices declare: those distributions bundle the files the rows name and
// only declare their other dependencies, which the registry resolves for the user, so a row is checked when it is written.
//
// A licence is allowed when its SPDX expression is: `OR` is allowed when one alternative is (the recipient picks it), `AND`
// when every part is, and `WITH <exception>` when the licence and the exception both are. Anything the grammar does not
// read, such as a prose label, is allowed only by an entry of EXCEPTIONS, which names the package, the exact label and why.
// Nothing else is accepted: to add a licence, add it here with a reason in the change that adds the package.

/** The SPDX identifiers (permissive licences, and public-domain dedications) a package may carry. */
export const ALLOWED_LICENCES = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "OFL-1.1",
  "CC0-1.0",
  "Unicode-3.0",
  "Zlib",
  "BlueOak-1.0.0",
  "Python-2.0"
]);

/** The SPDX licence exceptions that only widen what a permissive licence allows. */
export const ALLOWED_EXCEPTIONS = new Set(["LLVM-exception"]);

/**
 * The packages and files under a licence the grammar above does not accept, each by name, exact label and reason. A row
 * matches only when both match, so a new version that changes its licence fails again.
 */
export const EXCEPTIONS = [
  {
    name: /^pdf\.js standard fonts \(Liberation Sans, four unmodified TrueType faces\), bundled data of pdf\.js \d+\.\d+\.\d+$/,
    license: /^GPL-2\.0-only with the Liberation font exception \(Red Hat's licence text\)$/,
    reason: "four unmodified Liberation Sans faces, data files that pdf.js loads and Datum links no code against; the font exception lets them travel with any document or program"
  },
  {
    name: /^DejaVu Fonts$/,
    license: /^DejaVu Fonts License \(Bitstream Vera \+ Arev, free\)$/,
    reason: "a permissive font licence (use, copy, modify and distribute with the notice), data files only"
  },
  {
    name: /^pdf\.js (CMaps|standard fonts \(Foxit\)|JBIG2 decoder)/,
    license: /^BSD-style( \((Adobe|Foxit)\))?$/,
    reason: "pdf.js data files whose texts are BSD-style permissive notices, shipped beside their licence texts in notices/pdfjs/"
  },
  {
    name: /^Bouncy Castle/,
    license: /^MIT \(Bouncy Castle Licence\)$/,
    reason: "the Bouncy Castle Licence is the MIT licence under its authors' own heading; a Maven dependency of the jars, not repackaged"
  },
  {
    name: /^(certifi|hypothesis)$/,
    license: /^MPL-2\.0$/,
    reason: "MPL-2.0 is file-level copyleft; both are optional extras (the PDF/timestamp and testing extras) that Datum never modifies or bundles"
  },
  {
    name: /^@fortawesome\/free-solid-svg-icons$/,
    license: /^\(CC-BY-4\.0 AND MIT\)$/,
    reason: "the opt-in Font Awesome icon plugin: the icons are CC-BY-4.0 and ship with their attribution, the code is MIT"
  }
];

/**
 * Reads an SPDX expression and answers whether it is allowed, or null when the text is not an expression this reads.
 * Grammar: or := and ("OR" and)*, and := with ("AND" with)*, with := atom ("WITH" id)?, atom := id | "(" or ")".
 */
function allowedByExpression(text) {
  const tokens = text.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];
  const fail = () => {
    throw new SyntaxError(text);
  };
  const atom = () => {
    const token = take();
    if (token === undefined || token === "AND" || token === "OR" || token === "WITH" || token === ")") {
      fail();
    }
    if (token === "(") {
      const inner = or();
      if (take() !== ")") {
        fail();
      }
      return inner;
    }
    return ALLOWED_LICENCES.has(token);
  };
  const withException = () => {
    const base = atom();
    if (peek() === "WITH") {
      take();
      const exception = take();
      if (exception === undefined) {
        fail();
      }
      return base && ALLOWED_EXCEPTIONS.has(exception);
    }
    return base;
  };
  const and = () => {
    let all = withException();
    while (peek() === "AND") {
      take();
      all = withException() && all;
    }
    return all;
  };
  const or = () => {
    let any = and();
    while (peek() === "OR") {
      take();
      any = and() || any;
    }
    return any;
  };
  try {
    const verdict = or();
    return at === tokens.length ? verdict : null;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

/** The EXCEPTIONS entry that covers this package and label, or undefined. */
export function exceptionFor(name, license) {
  return EXCEPTIONS.find((entry) => entry.name.test(name) && entry.license.test(license));
}

/**
 * The problem with a package's licence, as a sentence that names the package, or null when the licence is allowed.
 * `license` is what the package.json, the lockfile or the notices row declares; `version` only decorates the sentence.
 */
export function licenceProblem(name, license, version = "") {
  const label = version === "" ? name : `${name} ${version}`;
  if (typeof license !== "string" || license.trim() === "" || license === "UNKNOWN") {
    return `${label} declares no licence`;
  }
  if (allowedByExpression(license) === true || exceptionFor(name, license) !== undefined) {
    return null;
  }
  return `${label} is under "${license}", which is not on the licence allow-list (packages/datum/scripts/licence-policy.mjs): a copyleft or unknown licence may not ship in a Datum distribution; if it is acceptable, add it there with the reason`;
}
