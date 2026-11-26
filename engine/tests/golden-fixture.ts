import { runKernel } from "../form-engine/validation/wasm/portable-kernel.js";

/** A run over sections, a container, a grid and several error kinds: the bytes of its outcome are pinned by the kernel golden-outcome test. */
export function goldenCase(): unknown {
  const form = {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: { required: true, maxLength: 5 } },
        { id: "addr", type: "container", configuration: {}, children: { default: [
          { id: "city", type: "text", configuration: { required: true } },
          { id: "pick", type: "select", configuration: { options: [{ value: "a", label: "A" }] } }
        ] } },
        { id: "rows", type: "group", configuration: {}, collection: {}, children: { content: [
          { id: "sku", type: "text", configuration: { required: true } },
          { id: "qty", type: "number", configuration: {} }
        ] } },
        { id: "tags", type: "checkboxes", configuration: { options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] } }
      ]
    }
  } as never;
  const rows = Array.from({ length: 60 }, (_, i) => ({ sku: i % 3 === 0 ? "" : "s" + i, qty: i }));
  const values = {
    name: "toolongname",
    addr: { city: "", pick: "zzz" },
    rows,
    tags: { x: true, y: false },
    stray: 1,
    constructor: "c"
  };
  const document = { b: 1, a: [3, { z: 1, y: 2 }], "10": 1, "2": 2 };
  return runKernel({ formId: "f", values, locale: "en", form, document, logLevel: "debug", reportFold: true } as never, []);
}
