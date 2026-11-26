import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import { ASSETS_TRUSTED_TYPES_POLICY, PRINT_TRUSTED_TYPES_POLICY, type DatumFormElement } from "../src/form.js";

import { sampleDefinition, until } from "./helpers.js";

/*
 * `<datum-form>` on a page that enforces Trusted Types and a `style-src` without
 * `'unsafe-inline'`: its shadow skeleton is built from elements and a constructed sheet, never
 * from markup. The page itself (lit-html, datum-print and datum-assets as the only policies) is
 * checked in headless Chromium; here jsdom shows that no string reaches the root's innerHTML and
 * that the element's rules are adopted, not inlined, where the root takes constructed sheets.
 */
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function mount(): DatumFormElement {
  const element = document.createElement("datum-form") as DatumFormElement;
  element.definition = sampleDefinition();
  document.body.append(element);
  return element;
}

/** Replaces a prototype property for the length of `run`, then puts the original back. */
async function withProperty(target: object, name: string, descriptor: PropertyDescriptor, run: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, ...descriptor });
  try {
    await run();
  } finally {
    if (original) {
      Object.defineProperty(target, name, original);
    } else {
      delete (target as Record<string, unknown>)[name];
    }
  }
}

describe("<datum-form> under Trusted Types", () => {
  it("builds its shadow skeleton without setting the root's innerHTML", async () => {
    const original = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, "innerHTML");
    expect(original?.set).toBeTypeOf("function");
    const written: string[] = [];
    await withProperty(
      ShadowRoot.prototype,
      "innerHTML",
      {
        get(this: ShadowRoot) {
          return original?.get?.call(this);
        },
        set(this: ShadowRoot, value: string) {
          // A page that enforces Trusted Types refuses a string here.
          written.push(`${this.host.localName}: ${value.slice(0, 20)}`);
          throw new TypeError("This document requires 'TrustedHTML' assignment.");
        }
      },
      async () => {
        const element = mount();
        await until(() => element.renderer?.shadowRoot?.querySelector("form"));
        expect(element.shadowRoot?.querySelector("datum-form-renderer")?.getAttribute("part")).toBe("form");
      }
    );
    expect(written).toEqual([]);
  });

  it("adopts its own rules as a constructed sheet where the root takes them, with no <style> element", async () => {
    const sheets = new WeakMap<object, CSSStyleSheet[]>();
    await withProperty(
      ShadowRoot.prototype,
      "adoptedStyleSheets",
      {
        get(this: ShadowRoot) {
          return sheets.get(this) ?? [];
        },
        set(this: ShadowRoot, value: CSSStyleSheet[]) {
          sheets.set(this, value);
        }
      },
      async () => {
        const element = mount();
        await until(() => element.renderer?.shadowRoot?.querySelector("form"));
        const root = element.shadowRoot as ShadowRoot;
        expect(root.querySelector("style")).toBeNull();
        const rules = (root.adoptedStyleSheets ?? []).flatMap((sheet) => Array.from(sheet.cssRules, (rule) => rule.cssText));
        expect(rules.some((rule) => rule.startsWith(":host") && rule.includes("display: block"))).toBe(true);
      }
    );
  });

  it("names the policies a page allows in its trusted-types directive", () => {
    expect(PRINT_TRUSTED_TYPES_POLICY).toBe("datum-print");
    expect(ASSETS_TRUSTED_TYPES_POLICY).toBe("datum-assets");
  });
});
