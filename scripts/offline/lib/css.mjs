// A stylesheet with every reference to another host answered from a file beside it, or taken out.
//
// A design system's stylesheet can reach for a third party when it loads: an @import of a font
// service, a url() on the design system's CDN. On a network with no way out the request fails, and a
// form whose imported sheet cannot be fetched is not drawn at all. `localizeCss` walks a stylesheet's
// text and hands each such reference to `resolve`, which either names the local address that replaces
// it or says why nothing can:
//
//   @import of another host        replaced by an @import of the local address, or removed
//   url() in an @font-face `src`   replaced, or that one source removed; a `src` left with no source is
//                                  removed, and an @font-face left with no `src` is removed (the text
//                                  falls back along its font-family list)
//   url() anywhere else            replaced, or `none`
//
// References to the same host (relative or root-absolute), data: URLs and fragments are left as they are.

/** Whether `ref` names another host: `http://`, `https://` or protocol-relative. */
export const isRemote = (ref) => /^(?:https?:)?\/\//i.test(ref.trim());

/** `text` split at each `separator` that is outside quotes and parentheses (a data: URL holds both `;` and `,`). */
export function splitTop(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quote) {
      if (char === "\\") at += 1;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, at));
      start = at + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

const IMPORT = /@import\s*(?:url\(\s*(["']?)([^"')]*)\1\s*\)|(["'])([^"']*)\3)([^;]*);/g;
const URL_REF = /url\(\s*(["']?)([^"')]*)\1\s*\)/g;
const FONT_FACE = /(@font-face\s*\{[^}]*\})/;

/**
 * `text` with every reference to another host resolved. `resolve(kind, url)` gets `kind` "import", "font"
 * or "url" and the reference as written, and returns `{ url }` (the address that replaces it) or
 * `{ drop: reason }`. Returns `{ text, replaced: [{ kind, url, by }], dropped: [{ kind, url, reason }] }`.
 */
export function localizeCss(text, resolve) {
  const replaced = [];
  const dropped = [];
  const ask = (kind, url) => {
    const answer = resolve(kind, url);
    if (answer && typeof answer.url === "string") {
      replaced.push({ kind, url, by: answer.url });
      return answer.url;
    }
    dropped.push({ kind, url, reason: answer?.drop ?? "nothing answers it" });
    return undefined;
  };

  const fontFace = (block) => {
    const open = block.indexOf("{");
    const head = block.slice(0, open + 1);
    const body = block.slice(open + 1, block.lastIndexOf("}"));
    let changed = false;
    let sources = 0;
    const kept = [];
    for (const declaration of splitTop(body, ";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0 || declaration.slice(0, colon).trim().toLowerCase() !== "src") {
        kept.push(declaration);
        continue;
      }
      const entries = [];
      for (const entry of splitTop(declaration.slice(colon + 1), ",")) {
        const match = /url\(\s*(["']?)([^"')]*)\1\s*\)/.exec(entry);
        if (!match || !isRemote(match[2])) {
          entries.push(entry);
          continue;
        }
        changed = true;
        const local = ask("font", match[2]);
        if (local !== undefined) entries.push(entry.replace(match[0], `url("${local}")`));
      }
      if (entries.length > 0) {
        kept.push(`${declaration.slice(0, colon + 1)}${entries.join(",")}`);
        sources += 1;
      }
    }
    if (!changed) return block;
    return sources === 0 ? "" : `${head}${kept.join(";")}}`;
  };

  const outside = (part) =>
    part
      .replace(IMPORT, (whole, _q1, viaUrl, _q2, bare, rest) => {
        const ref = viaUrl ?? bare;
        if (!isRemote(ref)) return whole;
        const local = ask("import", ref);
        return local === undefined ? "" : `@import url("${local}")${rest};`;
      })
      .replace(URL_REF, (whole, _quote, ref) => {
        if (!isRemote(ref)) return whole;
        const local = ask("url", ref);
        return local === undefined ? "none" : `url("${local}")`;
      });

  const out = text
    .split(FONT_FACE)
    .map((part, index) => (index % 2 === 1 ? fontFace(part) : outside(part)))
    .join("");
  return { text: out, replaced, dropped };
}

/**
 * `text` with each same-host url() and @import rewritten by `place(ref)`, which returns the new address or
 * undefined to leave it. References to another host, data: URLs and fragments are not offered.
 */
export function relocateCss(text, place) {
  const keep = (ref) => ref === "" || isRemote(ref) || /^(?:data:|blob:|about:|#)/i.test(ref);
  const moved = (ref) => (keep(ref) ? undefined : place(ref));
  // One pass over both forms, so the url() of an @import that was just rewritten is not offered again.
  const either = new RegExp(`${IMPORT.source}|url\\(\\s*(["']?)([^"')]*)\\6\\s*\\)`, "g");
  return text.replace(either, (whole, _q1, viaUrl, _q2, bare, rest, _q3, plain) => {
    if (plain !== undefined) {
      const to = moved(plain);
      return to === undefined ? whole : `url("${to}")`;
    }
    const to = moved(viaUrl ?? bare);
    return to === undefined ? whole : `@import url("${to}")${rest};`;
  });
}
