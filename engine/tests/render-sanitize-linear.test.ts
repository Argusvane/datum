import { describe, expect, it } from "vitest";

import { sanitizeStaticHtml } from "../form-engine/core/schema/static-html.js";

/**
 * A quadratic sanitizer needs minutes for this much input (the unterminated-tag case took ten
 * seconds at a fifth of it), so a generous absolute bound tells the two apart without a timing
 * ratio that a busy machine could upset.
 */
function expectLinear(make: (repeat: number) => string): void {
  const input = make(40_000);
  const started = performance.now();
  sanitizeStaticHtml(input);
  expect(performance.now() - started).toBeLessThan(3_000);
}

describe("sanitizeStaticHtml cost on hostile input", () => {
  it.each([
    ["unterminated tags", (n: number) => "<a ".repeat(n)],
    ["unterminated tags with a late close", (n: number) => "<a ".repeat(n) + ">"],
    ["unterminated quoted values", (n: number) => '<a x="'.repeat(n)],
    ["unterminated quoted values, odd count, late close", (n: number) => '<a x="'.repeat(n + 1) + ">"],
    ["mixed quote kinds", (n: number) => "<a x=\"<b y='".repeat(n) + ">"],
    ["tags jammed together before a bad attribute", (n: number) => "<a".repeat(n) + ' x="1"=']
  ])("%s", (_name, make) => {
    expectLinear(make);
  });

  it.each([
    ["script elements", (n: number) => "<script></script>".repeat(n)],
    ["open script elements", (n: number) => "<script>".repeat(n)],
    ["bare less-than signs in prose", (n: number) => "a<b c d ".repeat(n)],
    ["closing tags with nothing to close", (n: number) => "<b>".repeat(n) + "</i>".repeat(n)],
    ["deep unclosed nesting", (n: number) => "<div>".repeat(n)]
  ])("%s", (_name, make) => {
    expectLinear(make);
  });

  it("writes an unterminated tag out as text, never as a partial tag", () => {
    expect(sanitizeStaticHtml("<p>a</p><a href=x")).toBe("<p>a</p>&lt;a href=x");
    expect(sanitizeStaticHtml('<b>x</b><a title="oops')).toBe('<b>x</b>&lt;a title="oops');
  });

  it("still reads a tag whose attribute holds a greater-than sign after an earlier tag failed", () => {
    expect(sanitizeStaticHtml('<i x="1"= <b title="a > b">y</b>')).toBe('&lt;i x="1"= <b title="a > b">y</b>');
    expect(sanitizeStaticHtml('<i x="1"=><b title="a > b">y</b>')).toBe('&lt;i x="1"=><b title="a > b">y</b>');
  });

  it("finds the close of a script element whatever its case", () => {
    expect(sanitizeStaticHtml("<script>x</SCRIPT><p>kept</p>")).toBe("<p>kept</p>");
    expect(sanitizeStaticHtml("<style>x</Style ><p>kept</p>")).toBe("<p>kept</p>");
  });

  it("does not let a letter that changes length when lower-cased shift the close it finds", () => {
    expect(sanitizeStaticHtml("<script>" + "İ".repeat(40) + "</script><p>kept</p>")).toBe("<p>kept</p>");
    expect(sanitizeStaticHtml("İ<script>x</script><p>kept</p>")).toBe("İ<p>kept</p>");
  });

  it("drops a script whose close tag spells a letter with a look-alike", () => {
    // A long s is not an s to the HTML parser, so this element never closes.
    expect(sanitizeStaticHtml("<script>x</ſcript><p>gone</p>")).toBe("");
  });

  it("keeps closing tags balanced after the open-element bookkeeping", () => {
    expect(sanitizeStaticHtml("<b><i>x</b>y</i>")).toBe("<b><i>x</i></b>y");
    expect(sanitizeStaticHtml("</b><b>x</b></b>")).toBe("<b>x</b>");
  });
});
