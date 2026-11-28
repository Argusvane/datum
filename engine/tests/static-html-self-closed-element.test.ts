// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { sanitizeStaticHtml } from "../form-engine/core/schema/static-html.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { EagerJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-eager.js";
import { buildPrintDocument, buildPrintModel, datumPrintTheme } from "../form-engine/render/print/index.js";
import { runtimeOf } from "./live-chrome-harness.js";

/*
 * A browser ignores the slash of a self-closed element that is not void (`<a/>`, `<b />`): the
 * element stays open over everything after it. The sanitizer writes such an element open and closed
 * at once, so an `html` block stays balanced, and print reads each block through it again.
 */

describe("a self-closed element that is not void", () => {
  it("is written as an empty element, closed where it stands", () => {
    expect(sanitizeStaticHtml('<a href="https://example.org" title="x"/>Read')).toBe('<a href="https://example.org" title="x"></a>Read');
    expect(sanitizeStaticHtml("<b/>bold?")).toBe("<b></b>bold?");
    expect(sanitizeStaticHtml("<s />Notice")).toBe("<s></s>Notice");
    expect(sanitizeStaticHtml("<div/>after")).toBe("<div></div>after");
    expect(sanitizeStaticHtml("<table/>after")).toBe("<table></table>after");
    expect(sanitizeStaticHtml("<p/>after")).toBe("<p></p>after");
  });

  it("is closed too when the slash stands between its attributes", () => {
    expect(sanitizeStaticHtml('<a href="https://example.org" / title=x>t')).toBe('<a href="https://example.org" title="x"></a>t');
  });

  it("leaves a void element as it was", () => {
    expect(sanitizeStaticHtml("<br/>line")).toBe("<br />line");
    expect(sanitizeStaticHtml("<hr />")).toBe("<hr />");
  });

  it("leaves nothing open in a browser's reading of the result", () => {
    const host = document.createElement("div");
    host.innerHTML = `${sanitizeStaticHtml('<a href="https://example.org"/><b/><i/>')}<span id="after">after</span>`;
    const after = host.querySelector("#after");
    expect(after?.parentElement).toBe(host);
  });

  it("reads its own output back unchanged", () => {
    const once = sanitizeStaticHtml('<p title="a &amp; b">x<br/><a href="/y"/>z<img src="/i.png"/></p>');
    expect(sanitizeStaticHtml(once)).toBe(once);
  });
});

describe("a printed html block that self-closes a link", () => {
  function definition(children: ComponentNode[]): FormDefinition {
    return {
      id: "f",
      version: "1",
      schemaVersion: "1",
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }] },
      root: { id: "root", type: "form", configuration: { title: "T" }, children: { content: children } }
    } as FormDefinition;
  }

  for (const theme of [undefined, datumPrintTheme]) {
    it(`does not wrap the labels and answers printed after it (${theme?.id ?? "basic"} theme)`, async () => {
      const runtime = runtimeOf(
        definition([
          { id: "note", type: "html", configuration: { content: '<a href="https://example.org/notice" title="Verify"/>Read the notice.' } },
          { id: "name", type: "text", configuration: { label: "Full name" } },
          { id: "amount", type: "number", configuration: { label: "Amount" } }
        ])
      );
      runtime.setValue("name", "Ada Lovelace");
      runtime.setValue("amount", 1250);
      const model = await buildPrintModel(runtime, { render: { journeyKit: EagerJourneyRenderKit } });
      const doc = new DOMParser().parseFromString(buildPrintDocument(model, theme ? { theme } : {}), "text/html");
      for (const id of ["name", "amount"]) {
        const field = doc.querySelector(`[data-component-id="${id}"]`);
        expect(field, id).not.toBeNull();
        expect(field?.closest("a"), id).toBeNull();
      }
      const links = [...doc.querySelectorAll("a")];
      expect(links).toHaveLength(1);
      expect(links[0]?.textContent).toBe("");
    });
  }
});
