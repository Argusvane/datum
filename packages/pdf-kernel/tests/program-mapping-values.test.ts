import { describe, expect, it } from "vitest";

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { PDF_ABI_VERSION } from "@argusvane/datum-engine/render";
import { kernelStableStringify } from "@argusvane/datum-engine";
import { handlePdfRequest } from "../src/program/entry.js";

const PROGRAM_PATH = join(process.cwd(), "dist", "datum-pdf.program.js");

/**
 * A mapping's value map is the engine's model builder, bundled into the
 * program: a server host that evaluates the program gets the same plan as the in-process
 * modules. Run in a bare context, as the sandbox does.
 */
describe.runIf(existsSync(PROGRAM_PATH))("a mapping's value map through the bundled program", () => {
  it("translates the answer to the PDF's export value, and warns for one nothing maps, as in-process", async () => {
    const context = vm.createContext({ console, Uint8Array, ArrayBuffer, DataView, Promise, Math: Object.assign(Object.create(Math), { random: () => 0 }) });
    vm.runInContext(readFileSync(PROGRAM_PATH, "utf8"), context, { filename: "datum-pdf.program.js" });
    const call = vm.runInContext("globalThis.__datum_pdf", context) as (json: string) => Promise<string>;
    const request = (change: string) => ({
      abi: PDF_ABI_VERSION,
      op: "build",
      form: {
        id: "f",
        type: "form",
        configuration: {},
        children: { content: [{ id: "change", type: "radio", configuration: { options: [{ value: "improved" }, { value: "unchanged" }, { value: "worsened" }] } }] }
      },
      pdf: {
        layouts: [
          {
            id: "gov",
            kind: "template",
            template: { storage: "base64", name: "gov.pdf", type: "application/pdf", size: 4, data: "JVBERg==" },
            fields: [{ pdfField: "Since", source: { kind: "component", componentId: "change" }, values: { improved: "1", unchanged: "2" } }]
          }
        ]
      },
      values: { change },
      locale: "en"
    });

    const mapped = JSON.parse(await call(kernelStableStringify(request("unchanged"))));
    expect(mapped).toMatchObject({ ok: true, op: "build", layoutKind: "template", fill: { values: { Since: "2" } }, warnings: [] });

    const unmapped = JSON.parse(await call(kernelStableStringify(request("worsened"))));
    expect(unmapped.fill.values).toEqual({ Since: "worsened" });
    expect(unmapped.warnings).toEqual([expect.objectContaining({ code: "mapping.unmappedValue", componentId: "change" })]);

    // Byte for byte the in-process modules' reply.
    expect(JSON.stringify(unmapped)).toBe(JSON.stringify(JSON.parse(kernelStableStringify(await handlePdfRequest(request("worsened") as never)))));
  });
});
