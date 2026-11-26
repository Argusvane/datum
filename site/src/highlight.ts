// Syntax colour for the code blocks: a small tokenizer, no dependency. `pre.code[data-lang]`
// blocks are re-rendered from their text: "html" is markup with a script mode for the
// JavaScript inside <script>, "routes" is the endpoint listing, "json" is what the live demo
// shows (values, submission, schema). The palette stays the site's: tags and keywords in the
// accent, strings and numbers in the ok green, comments muted.

type Token = [cls: string | null, text: string];

const KEYWORDS = new Set([
  "async", "await", "const", "let", "var", "function", "return", "if", "else", "new", "import",
  "export", "from", "for", "of", "while", "try", "catch", "throw", "class", "this", "true", "false",
  "null", "undefined", "typeof"
]);

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function render(tokens: Token[]): string {
  return tokens.map(([cls, text]) => (cls ? `<span class="tok-${cls}">${escape(text)}</span>` : escape(text))).join("");
}

function tokenizeScript(src: string, start: number, out: Token[]): number {
  let i = start;
  let plain = "";
  const flush = () => {
    if (plain) out.push([null, plain]);
    plain = "";
  };
  while (i < src.length) {
    if (src.startsWith("</script", i)) break;
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      flush();
      out.push(["cm", src.slice(i, stop)]);
      i = stop;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      flush();
      out.push(["cm", src.slice(i, stop)]);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\") j++;
        j++;
      }
      flush();
      out.push(["str", src.slice(i, j + 1)]);
      i = j + 1;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
    if (word) {
      const text = word[0];
      const after = src.slice(i + text.length).match(/^\s*\(/);
      flush();
      if (KEYWORDS.has(text)) out.push(["kw", text]);
      else if (after) out.push(["fn", text]);
      else out.push([null, text]);
      i += text.length;
      continue;
    }
    const num = /^\d[\d._]*/.exec(src.slice(i));
    if (num) {
      flush();
      out.push(["num", num[0]]);
      i += num[0].length;
      continue;
    }
    plain += ch;
    i++;
  }
  flush();
  return i;
}

function tokenizeHtml(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i);
      const stop = end === -1 ? src.length : end + 3;
      out.push(["cm", src.slice(i, stop)]);
      i = stop;
      continue;
    }
    const open = /^<\/?[A-Za-z][\w-]*/.exec(src.slice(i));
    if (open) {
      const tag = open[0];
      const name = tag.replace(/^<\/?/, "").toLowerCase();
      const closing = tag.startsWith("</");
      out.push(["punct", tag.slice(0, closing ? 2 : 1)]);
      out.push(["tag", tag.slice(closing ? 2 : 1)]);
      i += tag.length;
      // Attributes until the tag closes.
      while (i < src.length && src[i] !== ">") {
        const ch = src[i];
        if (ch === '"' || ch === "'") {
          let j = src.indexOf(ch, i + 1);
          if (j === -1) j = src.length - 1;
          out.push(["str", src.slice(i, j + 1)]);
          i = j + 1;
          continue;
        }
        if (ch === "=" || ch === "/") {
          out.push(["punct", ch]);
          i++;
          continue;
        }
        const attr = /^[^\s=\/>"']+/.exec(src.slice(i));
        if (attr) {
          out.push(["attr", attr[0]]);
          i += attr[0].length;
          continue;
        }
        out.push([null, ch]);
        i++;
      }
      if (i < src.length) {
        out.push(["punct", ">"]);
        i++;
      }
      if (name === "script" && !closing) i = tokenizeScript(src, i, out);
      continue;
    }
    const next = src.indexOf("<", i + 1);
    const stop = next === -1 ? src.length : next;
    out.push([null, src.slice(i, stop)]);
    i = stop;
  }
  return out;
}

function tokenizeRoutes(src: string): Token[] {
  const out: Token[] = [];
  src.split("\n").forEach((line, index) => {
    if (index > 0) out.push([null, "\n"]);
    const route = /^(GET|POST|PUT|DELETE)(\s+)(\S+)(.*)$/.exec(line);
    if (route) {
      out.push(["kw", route[1]], [null, route[2]], [null, route[3]], ["cm", route[4]]);
      return;
    }
    if (/^\s*→/.test(line)) {
      out.push(["cm", line]);
      return;
    }
    out.push([null, line]);
  });
  return out;
}

/** JSON: keys as attributes, string values as strings, numbers, the three literals as keywords. */
function tokenizeJson(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let plain = "";
  const flush = () => {
    if (plain) out.push([null, plain]);
    plain = "";
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      const text = src.slice(i, j + 1);
      const rest = src.slice(j + 1);
      flush();
      out.push([/^\s*:/.test(rest) ? "attr" : "str", text]);
      i = j + 1;
      continue;
    }
    const literal = /^(true|false|null)\b/.exec(src.slice(i, i + 5));
    if (literal) {
      flush();
      out.push(["kw", literal[1]]);
      i += literal[1].length;
      continue;
    }
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i, i + 32));
    if (num) {
      flush();
      out.push(["num", num[0]]);
      i += num[0].length;
      continue;
    }
    if ("{}[]:,".includes(ch)) {
      flush();
      out.push(["punct", ch]);
      i += 1;
      continue;
    }
    plain += ch;
    i += 1;
  }
  flush();
  return out;
}

/** Colours one `pre.code[data-lang]` block from its text. */
export function highlightBlock(block: HTMLPreElement): void {
  const source = block.textContent ?? "";
  const lang = block.dataset.lang;
  let tokens: Token[];
  if (lang === "routes") tokens = tokenizeRoutes(source);
  else if (lang === "json") tokens = tokenizeJson(source);
  else if (lang === "js") {
    tokens = [];
    tokenizeScript(source, 0, tokens);
  } else tokens = tokenizeHtml(source);
  block.innerHTML = render(tokens);
}

/** Colours every `pre.code[data-lang]` block under the root. */
export function highlightCode(root: ParentNode = document): void {
  root.querySelectorAll<HTMLPreElement>("pre.code[data-lang]").forEach(highlightBlock);
}
