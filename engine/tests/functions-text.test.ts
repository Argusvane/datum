import { describe, expect, it } from "vitest";
import { FORMULA_FUNCTION_TABLE } from "../form-engine/core/expressions/function-table.js";
import { kernelTextCall, kernelTextHandles, TEXT_FUNCTIONS } from "../form-engine/rules/evaluator/functions-text.js";

const CASES: Array<[string, unknown[], unknown]> = [
  ["titleCase", ["hello wORLD"], "Hello World"],
  ["titleCase", ["o'brien-smith"], "O'brien-Smith"],
  ["titleCase", [null], undefined],
  ["trim", ["  a b  "], "a b"],
  ["trim", [12], "12"],
  ["startsWith", ["K1A 0B1", "K1"], true],
  ["startsWith", ["K1A", "X"], false],
  ["startsWith", ["K1A", undefined], undefined],
  ["endsWith", ["a@b.ca", ".ca"], true],
  ["endsWith", ["a@b.com", ".ca"], false],
  ["substring", ["123456789", 1, 3], "123"],
  ["substring", ["123456789", 4], "456789"],
  ["substring", ["abc", 2, 0], ""],
  ["substring", ["abc", "x"], undefined],
  ["indexOf", ["a@b", "@"], 2],
  ["indexOf", ["abc", "z"], 0],
  ["indexOf", [["x", "y"], "y"], 2],
  ["indexOf", [["x"], "q"], 0],
  ["replace", ["613-555-0100", "-", ""], "6135550100"],
  ["replace", ["abc", "", "x"], "abc"],
  ["replace", ["abc", "b"], undefined],
  ["split", ["a,b,c", ","], ["a", "b", "c"]],
  ["split", ["ab", ""], ["a", "b"]],
  ["join", [["a", 1, true], ", "], "a, 1, true"],
  ["join", ["nope", ","], undefined],
  ["matches", ["K1A 0B1", "[A-Z]\\d[A-Z] ?\\d[A-Z]\\d"], true],
  ["matches", ["xK1A 0B1", "[A-Z]\\d[A-Z] ?\\d[A-Z]\\d"], false],
  ["matches", ["a", "a|b"], true],
  ["matches", ["a", "("], undefined],
  ["text", [42], "42"],
  ["text", [true], "true"],
  ["text", ["x"], "x"],
  ["text", [null], undefined],
  ["text", [{}], undefined],
  ["padStart", ["7", 3, "0"], "007"],
  ["padStart", ["1234", 3, "0"], "1234"],
  ["padStart", [7, 3, "0"], "007"],
  ["padStart", [undefined, 3, "0"], undefined],
  // The pattern alone must compile; a stray close parenthesis cannot escape the anchors.
  ["matches", ["xyzb", "a)|(b"], undefined],
  ["matches", ["abc", "a)|(b"], undefined],
  ["matches", ["abc", "(?:a)|b"], false],
  ["matches", ["b", "(?:a)|b"], true],
  ["matches", ["ab", "a|ab"], true],
  ["matches", ["abc", "a(b"], undefined],
  // Positions and lengths count code points; a surrogate pair is never cut.
  ["substring", ["\u{1F600}a", 1, 1], "\u{1F600}"],
  ["substring", ["\u{1F600}a", 2, 1], "a"],
  ["substring", ["a\u{1F600}b", 2], "\u{1F600}b"],
  ["substring", ["a\u{1F600}b", 3, 5], "b"],
  ["substring", ["abc", 0, 2], "ab"],
  ["indexOf", ["\u{1F600}a", "a"], 2],
  ["indexOf", ["\u{1F600}a", "\ud83d"], 0],
  ["indexOf", ["\u{1F600}a", "\ude00"], 0],
  ["indexOf", ["\u{1F600}a\u{1F600}", "\u{1F600}"], 1],
  ["split", ["\u{1F600}a", ""], ["\u{1F600}", "a"]]
];

describe("text functions", () => {
  it.each(CASES)("%s(%j) = %j", (name, args, expected) => {
    expect(kernelTextCall(name, args)).toEqual(expected);
  });

  it("handles every text-group table name that lives here", () => {
    const elsewhere = ["concat", "len", "upper", "lower", "contains"];
    for (const row of FORMULA_FUNCTION_TABLE.filter((r) => r.group === "text" && !elsewhere.includes(r.name))) {
      expect(kernelTextHandles(row.name), row.name).toBe(true);
    }
    expect(kernelTextHandles("concat")).toBe(false);
    expect(kernelTextHandles("nope")).toBe(false);
  });

  // A text over the cap is read by its first 10,000 characters, with a warning, not refused.
  it("pads by code points: a surrogate pair in the fill or the text is never split", () => {
    const smile = "\u{1F600}";
    expect(kernelTextCall("padStart", ["", 3, smile])).toBe(smile.repeat(3));
    expect(kernelTextCall("padStart", ["x", 2, smile])).toBe(smile + "x");
    expect(kernelTextCall("padStart", ["\u00e9", 4, smile])).toBe(smile.repeat(3) + "\u00e9");
    expect(kernelTextCall("padStart", [smile, 3, "ab"])).toBe("ab" + smile);
    expect(kernelTextCall("padStart", [smile + smile, 2, "0"])).toBe(smile + smile);
    expect(kernelTextCall("padStart", ["x", 4, "a" + smile])).toBe("a" + smile + "ax");
    expect(kernelTextCall("padStart", ["x", 3, ""])).toBe("x");
    const long = kernelTextCall("padStart", ["", 20000, smile]) as string;
    expect(Array.from(long)).toHaveLength(10000);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(long)).toBe(false);
  });

  it("guards sizes", () => {
    expect(kernelTextCall("padStart", ["a", 1000000000, "a"])).toHaveLength(10000);
    expect(kernelTextCall("matches", ["a", "a".repeat(257)])).toBeUndefined();
    expect(kernelTextCall("matches", ["a".repeat(10001), "a+"])).toBe(true);
    expect(kernelTextCall("split", ["a".repeat(10001), ","])).toEqual(["a".repeat(10000)]);
    expect(kernelTextCall("replace", ["a".repeat(9000), "a", "bb"])).toBe("b".repeat(10000));
    expect(kernelTextCall("join", [["a".repeat(6000), "b".repeat(6000)], ","])).toBe("a".repeat(6000) + "," + "b".repeat(3999));
  });

  it("says what a cap trips, naming the function and the cap", () => {
    const lines: string[] = [];
    const warn = (message: string): void => {
      lines.push(message);
    };
    expect(kernelTextCall("join", [Array.from({ length: 3000 }, () => "abcde"), ","], warn)).toHaveLength(10000);
    expect(kernelTextCall("replace", ["a".repeat(9000), "a", "bb"], warn)).toHaveLength(10000);
    expect(kernelTextCall("matches", ["a", "a".repeat(257)], warn)).toBeUndefined();
    expect(kernelTextCall("matches", ["a".repeat(10001), "a+"], warn)).toBe(true);
    expect(kernelTextCall("split", ["a".repeat(10001), ","], warn)).toEqual(["a".repeat(10000)]);
    expect(kernelTextCall("padStart", ["a", 20000, "a"], warn)).toHaveLength(10000);
    const cut = "the text is over the 10,000 character cap; its first 10,000 characters were used (text.truncated)";
    expect(lines).toEqual([
      "join: " + cut,
      "replace: " + cut,
      "matches: the pattern is over the 256 character cap; no answer",
      "matches: " + cut,
      "split: " + cut,
      "padStart: the length is clamped to the 10,000 character cap (text.truncated)"
    ]);
    // Nothing tripped, nothing said; no sink, no failure.
    lines.length = 0;
    expect(kernelTextCall("join", [["a", "b"], ","], warn)).toBe("a,b");
    expect(lines).toEqual([]);
    expect(kernelTextCall("join", [Array.from({ length: 3000 }, () => "abcde"), ","])).toHaveLength(10000);
  });

  it("reads every whole-text function by the first 10,000 characters, never cutting a surrogate pair", () => {
    const lines: string[] = [];
    const warn = (message: string): void => {
      lines.push(message);
    };
    const long = "x".repeat(9999) + "\u{1F600}tail";
    expect(kernelTextCall("text", [long], warn)).toBe("x".repeat(9999));
    expect(kernelTextCall("startsWith", ["x".repeat(10001), "xx"], warn)).toBe(true);
    expect(kernelTextCall("endsWith", [long, "tail"], warn)).toBe(false);
    expect(kernelTextCall("endsWith", ["x".repeat(10000) + "y", "y"], warn)).toBe(false);
    expect(kernelTextCall("padStart", ["x".repeat(12000), 20, "-"], warn)).toHaveLength(10000);
    expect(kernelTextCall("trim", ["  " + "x".repeat(10001)], warn)).toHaveLength(9998);
    expect(kernelTextCall("titleCase", ["a".repeat(10001)], warn)).toHaveLength(10000);
    expect(kernelTextCall("substring", ["a".repeat(10001), 10000], warn)).toBe("a");
    expect(kernelTextCall("indexOf", ["a".repeat(10001) + "b", "b"], warn)).toBe(0);
    expect(lines).toHaveLength(9);
    expect(lines.every((line) => line.includes("(text.truncated)"))).toBe(true);
  });

  it("lists every declared function", () => {
    expect(TEXT_FUNCTIONS.length).toBe(13);
  });
});

describe("matches: compiled patterns kept on a context cache", () => {
  const PATTERNS = [
    "a+", "[A-Z]\\d[A-Z] ?\\d[A-Z]\\d", "\\p{L}+", "(a|b)*c", "", "a|b",
    // None of these compile alone.
    "a)", "(", "\\", "[", "*", "a{2,1}", "\\p{Nope}", "(?<n>a)\\k<m>",
    // Each is a valid body inside the anchors, so the pattern alone must be asked first.
    "a)|(b", "x)(?:y", "(?:a",
    // Names an object has.
    "__proto__", "constructor", "toString", "hasOwnProperty", "size", "p:a+"
  ];
  const SUBJECTS = ["a", "aaa", "b", "c", "abc", "ababc", "K1A 0B1", "K1A0B1", "Ünï", "", "__proto__", "constructor", "size", "x)(?:y", "a)|(b", "y"];

  it("gives the same answer with a cache, with a reused cache and with none, for every pattern and subject", () => {
    const shared: Record<string, unknown> = {};
    for (const pattern of PATTERNS) {
      for (const subject of SUBJECTS) {
        const bare = kernelTextCall("matches", [subject, pattern]);
        const fresh = kernelTextCall("matches", [subject, pattern], undefined, {});
        const first = kernelTextCall("matches", [subject, pattern], undefined, shared);
        const again = kernelTextCall("matches", [subject, pattern], undefined, shared);
        expect(fresh, JSON.stringify([subject, pattern])).toBe(bare);
        expect(first, JSON.stringify([subject, pattern])).toBe(bare);
        expect(again, JSON.stringify([subject, pattern])).toBe(bare);
      }
    }
  });

  it("keeps the probe of the pattern alone: a pattern that only compiles inside the anchors is no answer", () => {
    for (const pattern of ["a)", "(", "\\", "a)|(b", "x)(?:y"]) {
      expect(kernelTextCall("matches", ["a", pattern], undefined, {}), pattern).toBeUndefined();
      expect(kernelTextCall("matches", ["a", pattern]), pattern).toBeUndefined();
    }
    // The anchored body compiles for these; the bare pattern does not.
    expect(() => new RegExp("^(?:a)|(b)$", "u")).not.toThrow();
    expect(() => new RegExp("a)|(b", "u")).toThrow();
  });

  it("anchors the whole text, whatever the cache holds", () => {
    const cache: Record<string, unknown> = {};
    expect(kernelTextCall("matches", ["aa", "a"], undefined, cache)).toBe(false);
    expect(kernelTextCall("matches", ["a", "a"], undefined, cache)).toBe(true);
    expect(kernelTextCall("matches", ["a\nb", "a.b"], undefined, cache)).toBe(false);
    expect(kernelTextCall("matches", ["xay", "a|xay"], undefined, cache)).toBe(true);
  });

  it("compiles a pattern named after an object member once, leaving Object.prototype alone", () => {
    const cache: Record<string, unknown> = {};
    expect(kernelTextCall("matches", ["__proto__", "__proto__"], undefined, cache)).toBe(true);
    expect(kernelTextCall("matches", ["constructor", "constructor"], undefined, cache)).toBe(true);
    expect(kernelTextCall("matches", ["a", "constructor"], undefined, cache)).toBe(false);
    expect(Object.getPrototypeOf(cache)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["p:__proto__"]).toBeUndefined();
    expect(Object.keys(cache).filter((key) => key.startsWith("p:")).sort()).toEqual(["p:__proto__", "p:constructor"]);
  });

  it("stops keeping patterns at 256 and still answers every one", () => {
    const cache: Record<string, unknown> = {};
    for (let i = 0; i < 400; i += 1) {
      expect(kernelTextCall("matches", [`n${String(i)}`, `n${String(i)}`], undefined, cache)).toBe(true);
    }
    expect(Object.keys(cache).filter((key) => key.startsWith("p:")).length).toBe(256);
    expect(kernelTextCall("matches", ["n399", "n399"], undefined, cache)).toBe(true);
    expect(kernelTextCall("matches", ["n399", "n398"], undefined, cache)).toBe(false);
  });

  it("still says a cap tripped through warn, with or without a cache", () => {
    const lines: string[] = [];
    const warn = (message: string): void => {
      lines.push(message);
    };
    expect(kernelTextCall("matches", ["a", "a".repeat(257)], warn, {})).toBeUndefined();
    expect(kernelTextCall("matches", ["a".repeat(10001), "a+"], warn, {})).toBe(true);
    expect(lines).toEqual([
      "matches: the pattern is over the 256 character cap; no answer",
      "matches: the text is over the 10,000 character cap; its first 10,000 characters were used (text.truncated)"
    ]);
  });
});

// A refused pattern's verdict is kept on the cache, one analysis per pattern.
describe("matches: the risky verdict is kept on the context cache", () => {
  it("records the verdict under r: and counts it against the cache size", () => {
    const cache: Record<string, unknown> = { refuseRisky: true };
    expect(kernelTextCall("matches", ["aaaa!", "^(a+)+$"], undefined, cache)).toBeUndefined();
    expect(kernelTextCall("matches", ["abc", "^[a-z]+$"], undefined, cache)).toBe(true);
    expect(cache["r:^(a+)+$"]).toBe(true);
    expect(cache["r:^[a-z]+$"]).toBe(false);
    expect(cache.size).toBe(3);
    expect(kernelTextCall("matches", ["aaaa!", "^(a+)+$"], undefined, cache)).toBeUndefined();
    expect(cache.size).toBe(3);
  });
});
