// Not type-checked with the package (it uses vitest and the engine's sources): run with the kernel's vitest, `npm run test:plugin-urls`.
// The GC Design System plugin's components that take an address from the definition (the header's two, the card's, the link's):
// an address a browser would run (javascript:, data:, vbscript:, however spelt) is never written into the element; the
// default a missing address gets stands in. The adapter is drawn into text by a stand-in for lit's html.
import { describe, expect, it } from "vitest";
import { isSafeUrl } from "../../../engine/form-engine/core/schema/static-html.js";
import type { FieldAdapter, FieldState } from "../../../engine/form-engine/render/live/contract.js";
import { gcdsPlugin } from "../src/plugin.js";
import { isSafeAddress } from "../src/shared.js";

const NOTHING = { nothing: true };
const UNSET = { unset: true };
const lit = {
  html: (strings: TemplateStringsArray, ...values: unknown[]): string => {
    let out = strings[0] ?? "";
    values.forEach((value, index) => {
      const chunk = strings[index + 1] ?? "";
      if (value === UNSET) {
        out = out.replace(/\s*[\w-]+="?$/, "");
        out += chunk.startsWith('"') ? chunk.slice(1) : chunk;
      } else if (out.endsWith("=")) {
        out += `"${String(value)}"${chunk}`;
      } else {
        out += (value === NOTHING ? "" : String(value)) + chunk;
      }
    });
    return out;
  },
  nothing: NOTHING,
  ifDefined: (value: unknown) => (value === undefined ? UNSET : value)
};

/** The plugin's adapter for a type, drawn with a configuration, as the markup text. */
function draw(type: string, configuration: Record<string, unknown>): string {
  const definition = gcdsPlugin.components?.find((entry) => entry.type === type);
  const adapter = (definition?.adapter as (lit: unknown, datum: unknown) => FieldAdapter)(lit, {});
  const state = {
    locale: "en",
    model: { node: { id: type, type, configuration } },
    text: (key: string) => (typeof configuration[key] === "string" ? configuration[key] : undefined)
  } as unknown as FieldState;
  return String(adapter.template(state as never)).replace(/\s+/g, " ");
}

const BAD = [
  "javascript:alert(1)",
  "JAVASCRIPT:alert(1)",
  "JaVaScRiPt:alert(1)",
  "  javascript:alert(1)",
  "\tjavascript:alert(1)",
  "\u0001javascript:alert(1)",
  "java\tscript:alert(1)",
  "java\nscript:alert(1)",
  "javascript&colon;alert(1)",
  "javascript&#58;alert(1)",
  "data:text/html;base64,AAAA",
  "DaTa:text/html,<script>alert(1)</script>",
  "  data:text/html,x",
  "vbscript:msgbox(1)",
  "VBScript:msgbox(1)",
  "\nvbscript:msgbox(1)"
];

const UNSAFE = /javascript|vbscript|data:|text\/html|msgbox|alert/i;

describe("gcds plugin components never write an unsafe address into an attribute", () => {
  it.each(BAD)("header lang-href and skip-to-href: %j", (address) => {
    const out = draw("gcds-header", { langHref: address, skipToHref: address });
    expect(out).toContain('lang-href="#"');
    expect(out).toContain('skip-to-href="#main-content"');
    expect(out).not.toMatch(UNSAFE);
  });

  it.each(BAD)("card href: %j", (address) => {
    const out = draw("gcds-card", { title: "t", href: address });
    expect(out).toContain('href="#"');
    expect(out).not.toMatch(UNSAFE);
  });

  it.each(BAD)("link href and its default text: %j", (address) => {
    const out = draw("gcds-link", { href: address });
    expect(out).toContain('href="#"');
    expect(out).not.toMatch(UNSAFE);
  });

  it("keeps http, https, mailto, tel, relative and fragment addresses", () => {
    for (const address of ["https://canada.ca/x?y=1&z=2", "http://example.ca", "mailto:a@b.ca", "tel:+16135550100", "/terms", "terms.html", "terms&conditions.html", "a&b/c", "../up", "#top", "?q=1"]) {
      expect(draw("gcds-link", { text: "x", href: address })).toContain(`href="${address}"`);
      expect(draw("gcds-header", { langHref: address, skipToHref: address })).toContain(`lang-href="${address}"`);
      expect(draw("gcds-card", { href: address })).toContain(`href="${address}"`);
    }
  });

  it("a missing or blank address takes the default", () => {
    expect(draw("gcds-link", { text: "x" })).toContain('href="#"');
    expect(draw("gcds-link", { text: "x", href: "   " })).toContain('href="#"');
    expect(draw("gcds-header", {})).toContain('skip-to-href="#main-content"');
  });
});

describe("the binding's address rule never accepts what the engine's isSafeUrl refuses", () => {
  const CASES = [...BAD, "https://canada.ca", "mailto:a@b.ca", "tel:123", "/path", "#frag", "page.html", "data:image/png;base64,AAAA", "ftp://example.ca/x", "file:///etc/passwd", "blob:https://x/y", "custom:thing", "&#106;avascript:alert(1)", "j&Tab;avascript:alert(1)", "x&unknown;y:z"];
  it.each(CASES)("%j", (address) => {
    if (isSafeAddress(address)) {
      expect(isSafeUrl(address)).toBe(true);
    }
  });
});
