import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { PdfTemplateSource } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

/**
 * Two small seams of the builder element: an uploaded PDF template travels inside the definition
 * as base64, so one that would make the form unloadable (past `max-definition-bytes`) is refused
 * at upload; and the "Formula reference" link is drawn only where the host sets
 * `formulaReferenceHref`.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

async function mount(attributes: Record<string, string> = {}): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  if (attributes.pdf !== "off") {
    await until(() => element.pdfMode !== undefined);
  }
  return element;
}

function upload(bytes: number, name = "intake.pdf"): PdfTemplateSource {
  return { storage: "base64", name, type: "application/pdf", size: bytes, data: "A".repeat(Math.ceil(bytes / 3) * 4) };
}

describe("an uploaded PDF template and max-definition-bytes", () => {
  it("refuses a template that would push the form past the limit in force, naming the three sizes, and changes nothing", async () => {
    const element = await mount({ "max-definition-bytes": "100000" });
    const before = JSON.stringify(element.definition);
    // 80 000 bytes are 106 668 of base64: the form would weigh about 107 KB against a 97 KB limit.
    expect(() => element.pdfMode!.addTemplateLayout(upload(80_000, "paper.pdf"), "Paper")).toThrowError(
      /"paper\.pdf" \(79 KB\) would make this form 10\d KB\. A form opens only up to 97 KB, so it could be saved here and never opened again\. Nothing was changed\./
    );
    expect(JSON.stringify(element.definition)).toBe(before);
  });

  it("measures the definition as the load path does: the form's own weight counts, not only the file's", async () => {
    const element = await mount({ "max-definition-bytes": "100000" });
    // 60 000 bytes are 80 000 of base64 and fit; the form's own JSON and a second copy do not.
    element.pdfMode!.addTemplateLayout(upload(60_000), "One");
    expect(() => element.pdfMode!.addTemplateLayout(upload(60_000, "two.pdf"), "Two")).toThrowError(/would make this form/);
    expect(() => element.pdfMode!.duplicateLayout("one")).toThrowError(/would make this form/);
    expect(element.pdfMode!.layouts.map((layout) => layout.id)).toEqual(["one"]);
  });

  it("applies the higher limit a host raised it to, and the default 2 MiB otherwise", async () => {
    const raised = await mount({ "max-definition-bytes": "4194304" });
    expect(() => raised.pdfMode!.addTemplateLayout(upload(1_600_000), "Paper")).not.toThrow();
    document.body.innerHTML = "";

    const standard = await mount();
    expect(() => standard.pdfMode!.addTemplateLayout(upload(1_600_000), "Paper")).toThrowError(/would make this form 2\.\d+ MB\. A form opens only up to 2 MB/);
  });

  it("does not hold a template from the host's store to it: its bytes stay out of the definition", async () => {
    const element = await mount({ "max-definition-bytes": "100000" });
    const hosted: PdfTemplateSource = { storage: "asset", name: "big.pdf", type: "application/pdf", size: 20_000_000, ref: { id: "big" } };
    expect(() => element.pdfMode!.addTemplateLayout(hosted, "Hosted")).not.toThrow();
    expect(JSON.stringify(element.definition)).not.toContain("AAAA");
  });
});

describe("the Formula reference link", () => {
  const panel = (element: DatumFormBuilderElement): HTMLElement => element.builder!.shadowRoot!.querySelector("datum-builder-variables-panel") as HTMLElement;
  const link = (element: DatumFormBuilderElement): HTMLAnchorElement | null => panel(element).shadowRoot!.querySelector<HTMLAnchorElement>("[data-variables-reference]");

  it("is not drawn in the Variables panel until the host sets formulaReferenceHref", async () => {
    const element = await mount({ pdf: "off" });
    element.builder!.panel = "variables";
    await until(() => panel(element).shadowRoot!.querySelector("[data-variables-group]"));
    expect(link(element)).toBeNull();
    // No stray gap in the intro either: it ends where its words do.
    expect(panel(element).shadowRoot!.querySelector(".variables-intro")!.innerHTML.endsWith(" ")).toBe(false);

    element.formulaReferenceHref = "https://docs.example.test/formulas";
    await until(() => link(element));
    expect(link(element)!.getAttribute("href")).toBe("https://docs.example.test/formulas");
    expect(link(element)!.textContent).toBe("Formula reference");

    element.formulaReferenceHref = undefined;
    await until(() => link(element) === null);
  });
});
