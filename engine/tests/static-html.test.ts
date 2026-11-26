import { describe, expect, it } from "vitest";

import {
  HTML_BLOCK_TAGS,
  HTML_COMPONENT_TYPE,
  isSafeUrl,
  readHtmlTag,
  sanitizeStaticHtml
} from "../form-engine/core/schema/static-html.js";

describe("static html — the wrapper tag", () => {
  it("takes a known block tag and falls back to div for anything else", () => {
    expect(readHtmlTag({ tag: "section" })).toBe("section");
    expect(readHtmlTag({ tag: "H2" })).toBe("h2");
    expect(readHtmlTag({})).toBe("div");
    // Not an allowed wrapper, so it does not become one.
    expect(readHtmlTag({ tag: "script" })).toBe("div");
    expect(readHtmlTag({ tag: 7 })).toBe("div");
    expect(readHtmlTag(undefined)).toBe("div");
    expect(HTML_BLOCK_TAGS).toContain("div");
    expect(HTML_COMPONENT_TYPE).toBe("html");
  });
});

describe("static html — sanitizing authored content", () => {
  it("keeps the formatting an author actually writes", () => {
    const html = sanitizeStaticHtml(
      '<p class="lede">Read the <a href="/terms" title="Terms">terms</a> &amp; conditions.</p><ul><li><strong>One</strong></li></ul>'
    );
    expect(html).toBe(
      '<p class="lede">Read the <a href="/terms" title="Terms">terms</a> &amp; conditions.</p><ul><li><strong>One</strong></li></ul>'
    );
  });

  it("drops a script and everything inside it", () => {
    const html = sanitizeStaticHtml('<p>Hi</p><script>alert("x")</script><p>Bye</p>');
    expect(html).toBe("<p>Hi</p><p>Bye</p>");
    expect(html).not.toContain("alert");
  });

  it("strips event handlers while keeping the element", () => {
    const html = sanitizeStaticHtml('<p onclick="steal()" class="ok">Text</p>');
    expect(html).toBe('<p class="ok">Text</p>');
  });

  it("refuses a javascript: URL, including an obfuscated one", () => {
    expect(sanitizeStaticHtml('<a href="javascript:alert(1)">go</a>')).toBe("<a>go</a>");
    // Entity- and whitespace-smuggled variants of the same scheme.
    expect(sanitizeStaticHtml('<a href="java&#115;cript:alert(1)">go</a>')).toBe("<a>go</a>");
    expect(sanitizeStaticHtml('<a href="java\tscript:alert(1)">go</a>')).toBe("<a>go</a>");
    // And keeps the ones that only fetch or address.
    expect(sanitizeStaticHtml('<a href="https://example.com">go</a>')).toContain(
      'href="https://example.com"'
    );
    expect(sanitizeStaticHtml('<a href="mailto:a@b.c">mail</a>')).toContain('href="mailto:a@b.c"');
  });

  it("allows a data: URL for an image only", () => {
    expect(sanitizeStaticHtml('<img src="data:image/png;base64,AAA" alt="logo" />')).toContain(
      'src="data:image/png;base64,AAA"'
    );
    expect(sanitizeStaticHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>')).toBe("<a>x</a>");
  });

  it("keeps a data: image URL out of a link, in every image type", () => {
    for (const type of ["png", "jpeg", "gif", "webp", "svg+xml"]) {
      const url = `data:image/${type};base64,AAA`;
      expect(isSafeUrl(url, "image"), url).toBe(true);
      expect(isSafeUrl(url, "link"), url).toBe(false);
      expect(isSafeUrl(url), url).toBe(false);
      expect(sanitizeStaticHtml(`<a href="${url}" target="_blank">x</a>`), url).toBe(
        '<a target="_blank" rel="noopener noreferrer">x</a>'
      );
      expect(sanitizeStaticHtml(`<img src="${url}" alt="logo">`), url).toContain(`src="${url}"`);
    }
    // An image URL in an `<img>` other than its `src` is not a picture load either.
    expect(sanitizeStaticHtml('<a href="data:image/svg+xml;base64,AAA">x</a>')).toBe("<a>x</a>");
  });

  it("replaces an author's opener with noopener noreferrer on a new-tab link", () => {
    const link = (rel: string): string =>
      sanitizeStaticHtml(`<a href="https://example.com" target="_blank" rel="${rel}">x</a>`);
    expect(link("opener")).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>'
    );
    expect(link("OPENER")).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>'
    );
    expect(link("&#111;pener")).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>'
    );
    // The author's other tokens stay; the missing guards are added.
    expect(link("nofollow opener external")).toBe(
      '<a href="https://example.com" target="_blank" rel="nofollow external noopener noreferrer">x</a>'
    );
    expect(link("noreferrer")).toBe(
      '<a href="https://example.com" target="_blank" rel="noreferrer noopener">x</a>'
    );
    // A second rel attribute cannot bring `opener` back.
    expect(
      sanitizeStaticHtml('<a href="/x" target="_blank" rel="noopener" rel="opener">x</a>')
    ).toBe('<a href="/x" target="_blank" rel="noopener noreferrer">x</a>');
    // A link that does not open a new tab keeps its rel as written.
    expect(sanitizeStaticHtml('<a href="/x" rel="opener">x</a>')).toBe('<a href="/x" rel="opener">x</a>');
  });

  it("adds rel to a link that opens a new tab", () => {
    expect(sanitizeStaticHtml('<a href="/x" target="_blank">x</a>')).toBe(
      '<a href="/x" target="_blank" rel="noopener noreferrer">x</a>'
    );
  });

  it("keeps the text of an element it does not allow", () => {
    // The tag goes; what the author wrote stays readable.
    expect(sanitizeStaticHtml("<marquee>Notice</marquee>")).toBe("Notice");
    expect(sanitizeStaticHtml("<form><p>In a form</p></form>")).toBe("<p>In a form</p>");
  });

  it("does not truncate a tag on a > inside an attribute value", () => {
    // The seam a regex-based sanitizer leaks through: everything after the inner ">" would
    // escape as text, putting the rest of the attribute on the page.
    // The value survives whole (a > inside a quoted attribute needs no escaping) and the
    // handler that followed it is still dropped, which is the part that matters.
    const html = sanitizeStaticHtml('<p title="a > b" onclick="x()">t</p>');
    expect(html).toBe('<p title="a > b">t</p>');
  });

  it("balances the block so it cannot escape its wrapper", () => {
    expect(sanitizeStaticHtml("<div><p>open")).toBe("<div><p>open</p></div>");
    // A stray close would otherwise end the component's own element.
    expect(sanitizeStaticHtml("</div><p>after</p>")).toBe("<p>after</p>");
  });

  it("escapes a bare < so prose stays prose", () => {
    expect(sanitizeStaticHtml("1 < 2 and 3 > 2")).toBe("1 &lt; 2 and 3 > 2");
  });

  it("leaves an author's entities alone in an attribute", () => {
    expect(sanitizeStaticHtml('<a href="/s?a=1&amp;b=2">q</a>')).toContain('href="/s?a=1&amp;b=2"');
  });

  it("returns nothing for nothing", () => {
    expect(sanitizeStaticHtml("")).toBe("");
    expect(sanitizeStaticHtml(undefined as unknown as string)).toBe("");
  });
});

describe("static html — URL schemes smuggled through character references", () => {
  // The browser decodes a character reference in an attribute before it reads the URL, so an
  // entity-spelt colon or a Tab/NewLine reference inside the scheme is a live javascript: URL
  // on click. The check decodes the same way before it reads the scheme.
  const smuggled: Array<[string, string]> = [
    ["decimal colon", "javascript&#58;alert(1)"],
    ["hex colon", "javascript&#x3a;alert(1)"],
    ["hex colon, upper case digits", "javascript&#X3A;alert(1)"],
    ["named colon", "javascript&colon;alert(1)"],
    ["named Tab in the scheme", "java&Tab;script:alert(1)"],
    ["named NewLine in the scheme", "java&NewLine;script:alert(1)"],
    ["decimal tab in the scheme", "java&#9;script:alert(1)"],
    ["decimal newline and carriage return", "java&#10;scr&#13;ipt:alert(1)"],
    ["decimal reference without a semicolon", "javascript&#58alert(1)"],
    ["every letter numeric", "&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;:alert(1)"],
    ["mixed case", "JaVaScRiPt:alert(1)"],
    ["mixed case with an entity colon", "JAVASCRIPT&#58;alert(1)"],
    ["leading control character", "\u0001javascript:alert(1)"],
    ["tab and newline inside the scheme", "java\tscr\nipt:alert(1)"],
    ["vbscript", "vbscript:MsgBox(1)"],
    ["data: text", "data:text/html,<script>1</script>"],
    ["data: text through an entity colon", "data&#58;text/html,x"]
  ];
  for (const [name, url] of smuggled) {
    it(`refuses ${name}`, () => {
      expect(isSafeUrl(url), url).toBe(false);
      expect(sanitizeStaticHtml(`<a href="${url}">x</a>`), url).toBe("<a>x</a>");
      expect(sanitizeStaticHtml(`<img src="${url}">`), url).toBe('<img referrerpolicy="no-referrer" />');
    });
  }

  it("refuses the same href unquoted and in a chrome-style img src", () => {
    expect(sanitizeStaticHtml("<a href=javascript&#58;alert(1)>x</a>")).toBe("<a>x</a>");
    expect(sanitizeStaticHtml('<img src="javascript&colon;alert(1)" alt="x">')).toBe('<img alt="x" referrerpolicy="no-referrer" />');
  });

  it("fails closed on a reference it cannot decode ahead of the path", () => {
    // Unknown to the decoder, so it might be anything in the browser: not worth the risk.
    expect(isSafeUrl("javascript&unknownref;alert(1)")).toBe(false);
    // Decoding is one pass, as in a browser: `&amp;#58;` is the text `&#58;`, which the browser
    // does not turn into a colon; still refused, because a reference remains before the path.
    expect(isSafeUrl("javascript&amp;#58;alert(1)")).toBe(false);
  });

  it("keeps the URLs an author writes, references and all", () => {
    for (const url of [
      "/s?a=1&amp;b=2",
      "https://example.com/?q=&colon;&amp;r=1",
      "mailto:a@b.c?subject=hi&amp;body=x",
      "tel:+1-555-0100",
      "#section&amp;more",
      "?page=2&amp;sort=asc",
      "./relative&amp;path",
      "https://example.com/a&#58;b"
    ]) {
      expect(isSafeUrl(url), url).toBe(true);
    }
    expect(isSafeUrl("data:image/png;base64,AAA&#61;", "image")).toBe(true);
    expect(sanitizeStaticHtml('<a href="/s?a=1&amp;b=2">q</a>')).toBe('<a href="/s?a=1&amp;b=2">q</a>');
    expect(sanitizeStaticHtml('<a href="https://example.com/?q=&colon;">q</a>')).toContain('href="https://example.com/?q=&colon;"');
  });

  it("is idempotent over the kept and the refused forms", () => {
    for (const html of [
      '<a href="/s?a=1&amp;b=2" title="x &quot; y">l</a>',
      '<a href="javascript&#58;alert(1)">x</a>',
      '<img src="java&Tab;script:alert(1)">',
      "<p>a &amp; b</p>"
    ]) {
      const once = sanitizeStaticHtml(html);
      expect(sanitizeStaticHtml(once), html).toBe(once);
    }
  });
});

describe("static html — a table keeps its caption", () => {
  it("keeps <caption> as the table's first child, with its normal attributes", () => {
    const html = sanitizeStaticHtml('<table class="t"><caption class="c" id="cap" lang="fr" onclick="x()">Simple Data Table</caption><thead><tr><th scope="col">A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>');
    expect(html).toBe('<table class="t"><caption class="c" id="cap" lang="fr">Simple Data Table</caption><thead><tr><th scope="col">A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>');
    expect(html.startsWith("<table")).toBe(true);
    expect(html.indexOf("<caption")).toBe(html.indexOf(">") + 1);
  });

  it("keeps colgroup and col (col never takes a closing tag) and their span", () => {
    const html = sanitizeStaticHtml('<table><colgroup><col span="2" style="width:9px"><col></colgroup><tr><td>1</td><td>2</td></tr></table>');
    expect(html).toBe('<table><colgroup><col span="2" /><col /></colgroup><tr><td>1</td><td>2</td></tr></table>');
  });

  it("leaves text outside a table, and a caption outside a table's text, as before", () => {
    expect(sanitizeStaticHtml("<p>Plain text</p> after")).toBe("<p>Plain text</p> after");
    // A stray close is dropped, and an unclosed caption is closed at the end.
    expect(sanitizeStaticHtml("</caption><table><caption>Open")).toBe("<table><caption>Open</caption></table>");
  });

  it("is idempotent over a captioned table", () => {
    const once = sanitizeStaticHtml("<table><caption>Cap</caption><tr><td>x</td></tr></table>");
    expect(sanitizeStaticHtml(once)).toBe(once);
  });
});
