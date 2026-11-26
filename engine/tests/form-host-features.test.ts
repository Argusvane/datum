// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { defineDatumFormHostElement, DATUM_FORM_HOST_TAG, type DatumFormHostElement } from "../form-engine/render/web-component/form-host-element.js";

/** The host forwards `features` to the inner renderer, which is the element that reads it. */
afterEach(() => {
  document.body.innerHTML = "";
});

function inner(host: DatumFormHostElement): Element {
  return host.shadowRoot!.querySelector("datum-form-renderer")!;
}

describe("the form host's features", () => {
  it("forwards the attribute and the property to the inner renderer and clears it when absent", () => {
    defineDatumFormHostElement();
    const host = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
    host.setAttribute("features", "minimal drafts");
    document.body.append(host);
    expect(inner(host).getAttribute("features")).toBe("minimal drafts");

    host.features = ["journeys", "print"];
    expect(inner(host).getAttribute("features")).toBe("journeys print");

    host.removeAttribute("features");
    expect(inner(host).hasAttribute("features")).toBe(false);
  });

  it("keeps a property set before connect and applies it once the renderer exists", () => {
    defineDatumFormHostElement();
    const host = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
    host.features = "minimal";
    document.body.append(host);
    expect(inner(host).getAttribute("features")).toBe("minimal");
  });
});
