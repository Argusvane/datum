import assert from "node:assert/strict";
import { test } from "node:test";

import { isRemote, localizeCss, relocateCss, splitTop } from "../lib/css.mjs";

const drop = () => ({ drop: "no route" });

test("isRemote: another host is http, https or protocol-relative", () => {
  for (const ref of ["https://cdn.example/a.css", "http://cdn.example/a", "//cdn.example/a", " HTTPS://CDN.example/a"]) assert.equal(isRemote(ref), true, ref);
  for (const ref of ["a.css", "./a.css", "/assets/a.woff", "data:font/woff2;base64,AAAA", "#mask", ""]) assert.equal(isRemote(ref), false, ref);
});

test("splitTop: a separator inside quotes or parentheses does not split", () => {
  assert.deepEqual(splitTop('url(data:font/woff2;base64,AA,BB) format("woff2"), url("a,b.woff")', ","), ['url(data:font/woff2;base64,AA,BB) format("woff2")', ' url("a,b.woff")']);
  assert.deepEqual(splitTop("font-family:A;src:url(data:x;y);font-weight:400", ";"), ["font-family:A", "src:url(data:x;y)", "font-weight:400"]);
});

test("an @import of another host is replaced by the local address, in every way it is written", () => {
  const seen = [];
  const resolve = (kind, url) => {
    seen.push([kind, url]);
    return { url: "./fonts.css" };
  };
  const css = '@import"https://fonts.example/css2?family=A&display=swap";@import url(//fonts.example/b) screen;@import url("local.css");a{color:red}';
  const result = localizeCss(css, resolve);
  assert.equal(result.text, '@import url("./fonts.css");@import url("./fonts.css") screen;@import url("local.css");a{color:red}');
  assert.deepEqual(seen, [["import", "https://fonts.example/css2?family=A&display=swap"], ["import", "//fonts.example/b"]]);
  assert.equal(result.replaced.length, 2);
  assert.equal(result.dropped.length, 0);
});

test("an @import nothing answers is removed, with the reason", () => {
  const result = localizeCss('@import url("https://fonts.example/x");a{color:red}', drop);
  assert.equal(result.text, "a{color:red}");
  assert.deepEqual(result.dropped, [{ kind: "import", url: "https://fonts.example/x", reason: "no route" }]);
});

test("@font-face: a remote source goes, the local ones of the same src stay", () => {
  const css = '@font-face{font-family:"Open Sans";src:url("https://gov.example/f.eot");src:url("https://gov.example/f.eot?#iefix") format("embedded-opentype"),url("fonts/f.woff") format("woff");font-weight:700}';
  const result = localizeCss(css, drop);
  assert.equal(result.text, '@font-face{font-family:"Open Sans";src:url("fonts/f.woff") format("woff");font-weight:700}');
  assert.equal(result.dropped.length, 2);
  assert.ok(result.dropped.every((entry) => entry.kind === "font"));
});

test("@font-face: with no source left the whole rule goes", () => {
  const css = 'a{b:c}@font-face{font-family:acumin;src:url("https://use.example/af/1/l") format("woff2"),url("https://use.example/af/1/d") format("woff")}d{e:f}';
  assert.equal(localizeCss(css, drop).text, "a{b:c}d{e:f}");
});

test("@font-face: a remote source a route answers is rewritten, hash and format kept by the caller", () => {
  const css = "@font-face{font-family:icons;src:url(https://cdn.example/fonts@1/icons.ttf) format(\"truetype\")}";
  const result = localizeCss(css, (kind, url) => ({ url: `../fonts/${url.split("/").pop()}` }));
  assert.equal(result.text, '@font-face{font-family:icons;src:url("../fonts/icons.ttf") format("truetype")}');
});

test("@font-face: one with only local and data sources is returned as written", () => {
  const css = "@font-face { font-family: A; src: url(data:font/woff2;base64,AA;BB,CC) format('woff2'), url( 'a.woff' ) }";
  const result = localizeCss(css, () => assert.fail("nothing to resolve"));
  assert.equal(result.text, css);
});

test("a url() of another host outside @font-face becomes none, or the local address", () => {
  const css = ".footer{background:#0058a4 url(https://gov.example/bg.svg) bottom/100% fixed no-repeat}.icon{background-image:url('/img/a.svg')}";
  assert.equal(localizeCss(css, drop).text, ".footer{background:#0058a4 none bottom/100% fixed no-repeat}.icon{background-image:url('/img/a.svg')}");
  assert.equal(localizeCss(css, () => ({ url: "./bg.svg" })).text, '.footer{background:#0058a4 url("./bg.svg") bottom/100% fixed no-repeat}.icon{background-image:url(\'/img/a.svg\')}');
});

test("the same reference is asked for and recorded each time it is written", () => {
  const result = localizeCss("a{background:url(https://x.example/a.png)}b{background:url(https://x.example/a.png)}", drop);
  assert.equal(result.dropped.length, 2);
});

test("relocateCss moves same-host references and leaves the others", () => {
  const css = '@import "base.css";@font-face{src:url("path/to/file/a.woff2") format("woff2"),url(data:x;y)}a{background:url(https://x.example/a.png)}b{mask:url(#m)}';
  const moved = relocateCss(css, (ref) => `/moved/${ref}`);
  assert.equal(moved, '@import url("/moved/base.css");@font-face{src:url("/moved/path/to/file/a.woff2") format("woff2"),url(data:x;y)}a{background:url(https://x.example/a.png)}b{mask:url(#m)}');
});
