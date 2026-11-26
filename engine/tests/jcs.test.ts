import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalizeJcs } from "../form-engine/core/submission/jcs.js";

interface JcsVector {
  name: string;
  input: string;
  canonical: string;
}

const vectors = JSON.parse(readFileSync(new URL("./fixtures/jcs-vectors.json", import.meta.url), "utf8")) as JcsVector[];

/** Bits → number, the way RFC 8785 Appendix B lists its test values. */
function fromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

describe("canonicalizeJcs (RFC 8785)", () => {
  it("writes the RFC's §3.2.4 example", () => {
    const input = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: "€$\u000F\u000aA'B\x22\x5c\\\"/",
      literals: [null, true, false]
    };
    expect(canonicalizeJcs(input)).toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}');
  });

  it("sorts member names by UTF-16 code units, non-BMP included (§3.2.3)", () => {
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis"
    };
    // Read the order from the text: JSON.parse would put the integer-like "1" first again.
    const text = canonicalizeJcs(input);
    const names = [...text.matchAll(/"((?:[^"\\]|\\.)*)":/g)].map((match) => JSON.parse(`"${match[1]}"`) as string);
    expect(names).toEqual(["\r", "1", "\u0080", "ö", "€", "😀", "דּ"]);
  });

  it("writes numbers as ECMAScript does, per Appendix B, and refuses non-finite ones", () => {
    const cases: Array<[string, string]> = [
      ["0000000000000000", "0"],
      ["8000000000000000", "0"],
      ["0000000000000001", "5e-324"],
      ["8000000000000001", "-5e-324"],
      ["7fefffffffffffff", "1.7976931348623157e+308"],
      ["ffefffffffffffff", "-1.7976931348623157e+308"],
      ["4340000000000000", "9007199254740992"],
      ["c340000000000000", "-9007199254740992"],
      ["4430000000000000", "295147905179352830000"],
      ["44b52d02c7e14af5", "9.999999999999997e+22"],
      ["44b52d02c7e14af6", "1e+23"],
      ["44b52d02c7e14af7", "1.0000000000000001e+23"],
      ["444b1ae4d6e2ef4e", "999999999999999700000"],
      ["444b1ae4d6e2ef4f", "999999999999999900000"],
      ["444b1ae4d6e2ef50", "1e+21"],
      ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
      ["3eb0c6f7a0b5ed8d", "0.000001"],
      ["41b3de4355555553", "333333333.3333332"],
      ["41b3de4355555554", "333333333.33333325"],
      ["41b3de4355555555", "333333333.3333333"],
      ["41b3de4355555556", "333333333.3333334"],
      ["41b3de4355555557", "333333333.33333343"],
      ["becbf647612f3696", "-0.0000033333333333333333"],
      ["43143ff3c1cb0959", "1424953923781206.2"]
    ];
    for (const [bits, text] of cases) {
      expect(canonicalizeJcs(fromBits(bits))).toBe(text);
    }
    for (const bits of ["7fffffffffffffff", "7ff0000000000000", "fff0000000000000"]) {
      expect(() => canonicalizeJcs([fromBits(bits)])).toThrow(TypeError);
    }
  });

  it("orders the repo's tricky keys by code unit, not locale, and integer-like keys among the rest", () => {
    const input = { a: 1, B: 2, Text2: 3, text_1: 4, text1: 5, "a-b": 6, a_b: 7, "10": 8, "2": 9 };
    expect(canonicalizeJcs(input)).toBe('{"10":8,"2":9,"B":2,"Text2":3,"a":1,"a-b":6,"a_b":7,"text1":5,"text_1":4}');
    // localeCompare would have put "a" before "B" and "text_1" before "text1".
    expect(canonicalizeJcs({ b: 0, "2": 0, "10": 0 })).toBe('{"10":0,"2":0,"b":0}');
  });

  it("drops undefined members as JSON does, writes null for them in arrays, and refuses what JSON cannot hold", () => {
    expect(canonicalizeJcs({ b: undefined, a: [undefined, () => 1], c: null })).toBe('{"a":[null,null],"c":null}');
    expect(canonicalizeJcs({ when: new Date("2026-10-05T00:00:00Z") })).toBe('{"when":"2026-10-05T00:00:00.000Z"}');
    expect(() => canonicalizeJcs(undefined)).toThrow(TypeError);
    expect(() => canonicalizeJcs({ n: BigInt(1) })).toThrow(TypeError);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => canonicalizeJcs(loop)).toThrow(/circular/);
    // A shared (not circular) value is fine.
    const shared = { x: 1 };
    expect(canonicalizeJcs({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it("agrees with every shared vector (engine/tests/fixtures/jcs-vectors.json)", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(10);
    for (const vector of vectors) {
      expect(canonicalizeJcs(JSON.parse(vector.input)), vector.name).toBe(vector.canonical);
      // The canonical text is a fixed point.
      expect(canonicalizeJcs(JSON.parse(vector.canonical)), vector.name).toBe(vector.canonical);
    }
    expect(vectors.find((vector) => vector.name === "repo-keys")?.canonical).toBe('{"10":8,"2":9,"B":2,"Text2":3,"a":1,"a-b":6,"a_b":7,"text1":5,"text_1":4}');
  });
});
