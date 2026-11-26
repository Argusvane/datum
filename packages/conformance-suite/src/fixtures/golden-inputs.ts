// What the golden file is generated from (scripts/write-golden.ts). Kept apart from golden.ts so the writer
// does not import the file it is about to replace.

/**
 * Documents whose canonical text and digest are pinned (CAN-02). Each is JSON
 * text, never an object literal, so a number past 2^53, a `-0` and a `__proto__` key reach the
 * serializers exactly as a request body would carry them.
 */
export const GOLDEN_DOCUMENT_INPUTS: { name: string; input: string }[] = [
  { name: "numbers", input: '{"a":1e21,"b":-0,"c":5e-7,"d":9007199254740993,"e":0.1,"f":123456789012345680000,"g":1.5e300,"h":[0.30000000000000004,1e-7,100,1.0,5.0]}' },
  { name: "integer-like keys", input: '{"10":"ten","2":"two","4294967295":"max","01":"zero-one","1":"one","b":1,"a":2}' },
  { name: "prototype keys", input: '{"__proto__":{"x":1},"constructor":2,"toString":3,"a":4}' },
  { name: "separators and surrogates", input: '{"s":"a\\u2028b\\u2029c","lone":"\\ud800","pair":"\\ud83d\\ude00"}' },
  { name: "astral keys", input: '{"\\ud83d\\ude00":1,"\\uffff":2,"z":3,"\\u00e9":4}' },
  { name: "case", input: '{"B":1,"a":2,"Ab":3,"aa":4}' },
  { name: "punctuation", input: '{"a-b":1,"a_b":2,"a.b":3,"ab":4,"a b":5}' },
  { name: "empty containers", input: '{"o":{},"l":[],"n":null,"s":""}' },
  { name: "strings", input: '{"q":"say \\"hi\\"","bs":"a\\\\b","nl":"x\\ny\\tz","ctl":"\\u0001\\u001f","sol":"a/b","uni":"café 你好 🙂"}' }
];

/**
 * The golden case: a run over sections, a container, a grid and several error kinds, 60 rows,
 * a document and the fold report. The bytes of its outcome are pinned by the engine's own
 * the engine's kernel test; the golden file carries their length and SHA-256 so a
 * program can be held to them. A copy of `engine/tests/golden-fixture.ts` (the suite cannot
 * import engine tests).
 */
export function goldenCaseContext(): Record<string, unknown> {
  const form = {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: { required: true, maxLength: 5 } },
        {
          id: "addr",
          type: "container",
          configuration: {},
          children: {
            default: [
              { id: "city", type: "text", configuration: { required: true } },
              { id: "pick", type: "select", configuration: { options: [{ value: "a", label: "A" }] } }
            ]
          }
        },
        {
          id: "rows",
          type: "group",
          configuration: {},
          collection: {},
          children: {
            content: [
              { id: "sku", type: "text", configuration: { required: true } },
              { id: "qty", type: "number", configuration: {} }
            ]
          }
        },
        { id: "tags", type: "checkboxes", configuration: { options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] } }
      ]
    }
  };
  const rows = Array.from({ length: 60 }, (_, i) => ({ sku: i % 3 === 0 ? "" : "s" + i, qty: i }));
  const values = { name: "toolongname", addr: { city: "", pick: "zzz" }, rows, tags: { x: true, y: false }, stray: 1, constructor: "c" };
  const document = { b: 1, a: [3, { z: 1, y: 2 }], "10": 1, "2": 2 };
  return { formId: "f", values, locale: "en", form, document, logLevel: "debug", reportFold: true };
}
