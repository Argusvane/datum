/**
 * A fast path for plain selectors.
 *
 * The builder finds its own parts by attribute (`root.querySelector("[data-bar-undo]")`) every
 * time it syncs its chrome, and jsdom's selector engine answers each
 * such question through its general matcher over every node of the tree: measured on the builder
 * test files, more than half of a test's time was this one kind of question. A browser answers it
 * from the same walk in a fraction of the time, so the tests were paying for the engine, not for
 * the builder.
 *
 * Here `querySelector`, `matches` and `closest` answer a selector made only of the plain parts
 * below by walking jsdom's own tree, and hand every other selector to jsdom untouched:
 *
 *   a tag name or `*`, `#id`, `.class`, `[name]`, `[name="value"]` and the `^=`, `$=`, `*=`, `~=`
 *   forms, joined by the descendant and child combinators, in a comma list.
 *
 * Anything else goes to jsdom: a pseudo-class or pseudo-element, a sibling combinator, an escape,
 * a namespace, a case flag, and an attribute whose value HTML compares without case (`type`,
 * `dir` and the rest of that list), so only names known to compare exactly are taken here.
 * `querySelectorAll` stays jsdom's, since its answer is a NodeList.
 *
 * `DATUM_TEST_SELECTOR_CHECK=1` asks jsdom as well on every call and throws where the two answers
 * differ: run the suite with it after a jsdom upgrade or a change here. If jsdom's internals are
 * not the shape this file reads, it patches nothing and the tests run on jsdom's engine alone.
 * Loaded by `vitest.config.ts` (`setupFiles`).
 */

import { createRequire } from "node:module";

type AttributeTest = { name: string; operator: "" | "=" | "^=" | "$=" | "*=" | "~="; value: string };
type Compound = { tag: string | undefined; id: string | undefined; classes: string[]; attributes: AttributeTest[] };
/** Compounds right to left; `combinators[i]` joins `compounds[i]` to `compounds[i + 1]` (its ancestor side). */
type Complex = { compounds: Compound[]; combinators: (" " | ">")[] };

/** jsdom's node behind a wrapper: the fields this file reads. */
interface Impl {
  nodeType: number;
  _localName?: string;
  _namespaceURI?: string | null;
  _attributesByNameMap?: Map<string, { _value: string }[]>;
  _links: { firstChild: Impl | null; nextSibling: Impl | null; parent: Impl | null } | null;
  [key: symbol]: unknown;
}

const HTML_NS = "http://www.w3.org/1999/xhtml";
const IDENT = /^-?[A-Za-z_][\w-]*/;
/** Attribute names whose values a selector compares exactly (never the names HTML compares without case). */
const EXACT_NAME = /^(?:data-[\w-]+|aria-[\w-]+|id|class|role|slot|part|for|name|hidden|title|href|tabindex|open|inert|contenteditable|draggable|popover|is)$/;

function parseCompound(text: string): Compound | undefined {
  const compound: Compound = { tag: undefined, id: undefined, classes: [], attributes: [] };
  let rest = text;
  if (rest.startsWith("*")) {
    rest = rest.slice(1);
  } else {
    const tag = IDENT.exec(rest);
    if (tag) {
      compound.tag = tag[0];
      rest = rest.slice(tag[0].length);
    }
  }
  while (rest.length > 0) {
    const lead = rest[0];
    if (lead === "#" || lead === ".") {
      const name = IDENT.exec(rest.slice(1));
      if (!name) {
        return undefined;
      }
      if (lead === "#") {
        if (compound.id !== undefined) {
          return undefined;
        }
        compound.id = name[0];
      } else {
        compound.classes.push(name[0]);
      }
      rest = rest.slice(1 + name[0].length);
    } else if (lead === "[") {
      const attribute = /^\[\s*([A-Za-z_][\w-]*)\s*(?:([~^$*]?=)\s*(?:"([^"\\]*)"|'([^'\\]*)'|(-?[A-Za-z_][\w-]*))\s*)?\]/.exec(rest);
      if (!attribute) {
        return undefined;
      }
      const name = attribute[1]!.toLowerCase();
      if (!EXACT_NAME.test(name)) {
        return undefined;
      }
      compound.attributes.push({
        name,
        operator: (attribute[2] ?? "") as AttributeTest["operator"],
        value: attribute[3] ?? attribute[4] ?? attribute[5] ?? ""
      });
      rest = rest.slice(attribute[0].length);
    } else {
      return undefined;
    }
  }
  return compound;
}

function parseComplex(text: string): Complex | undefined {
  const compounds: Compound[] = [];
  const combinators: (" " | ">")[] = [];
  let rest = text.trim();
  if (rest.length === 0) {
    return undefined;
  }
  while (rest.length > 0) {
    // One compound: up to the next space or `>` outside brackets and quotes.
    let end = 0;
    let bracket = false;
    let quote = "";
    for (; end < rest.length; end += 1) {
      const char = rest[end]!;
      if (quote) {
        if (char === quote) {
          quote = "";
        }
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === "[") {
        bracket = true;
      } else if (char === "]") {
        bracket = false;
      } else if (!bracket && (char === " " || char === ">" || char === "\t" || char === "\n")) {
        break;
      }
    }
    const compound = parseCompound(rest.slice(0, end));
    if (!compound) {
      return undefined;
    }
    compounds.unshift(compound);
    const gap = /^\s*(>?)\s*/.exec(rest.slice(end))!;
    rest = rest.slice(end + gap[0].length);
    if (rest.length > 0) {
      combinators.unshift(gap[1] === ">" ? ">" : " ");
    } else if (gap[1] === ">") {
      return undefined;
    }
  }
  return { compounds, combinators };
}

const parsed = new Map<string, Complex[] | null>();

/** The selector as a list of plain complexes, or `null` when any part of it is jsdom's to answer. */
function parse(selector: string): Complex[] | null {
  let list = parsed.get(selector);
  if (list !== undefined) {
    return list;
  }
  list = null;
  // A comma inside a quoted value would split the list in the wrong place: such a selector is jsdom's.
  if (!/[:\\|+~]/.test(selector.replace(/~=/g, "")) && !(selector.includes(",") && /["']/.test(selector))) {
    const complexes = selector.split(",").map(parseComplex);
    if (complexes.every((complex) => complex !== undefined)) {
      list = complexes as Complex[];
    }
  }
  parsed.set(selector, list);
  return list;
}

function attributeOf(impl: Impl, name: string): string | undefined {
  return impl._attributesByNameMap!.get(name)?.[0]?._value;
}

function matchesCompound(impl: Impl, compound: Compound): boolean {
  if (compound.tag !== undefined) {
    const local = impl._localName!;
    if (local !== compound.tag && !(impl._namespaceURI === HTML_NS && local === compound.tag.toLowerCase())) {
      return false;
    }
  }
  if (compound.id !== undefined && attributeOf(impl, "id") !== compound.id) {
    return false;
  }
  if (compound.classes.length > 0) {
    const names = attributeOf(impl, "class");
    if (names === undefined) {
      return false;
    }
    const tokens = names.split(/[\t\n\f\r ]+/);
    for (const name of compound.classes) {
      if (!tokens.includes(name)) {
        return false;
      }
    }
  }
  for (const test of compound.attributes) {
    const value = attributeOf(impl, test.name);
    if (value === undefined) {
      return false;
    }
    const wanted = test.value;
    switch (test.operator) {
      case "":
        break;
      case "=":
        if (value !== wanted) {
          return false;
        }
        break;
      case "^=":
        if (wanted === "" || !value.startsWith(wanted)) {
          return false;
        }
        break;
      case "$=":
        if (wanted === "" || !value.endsWith(wanted)) {
          return false;
        }
        break;
      case "*=":
        if (wanted === "" || !value.includes(wanted)) {
          return false;
        }
        break;
      case "~=":
        if (wanted === "" || /\s/.test(wanted) || !value.split(/[\t\n\f\r ]+/).includes(wanted)) {
          return false;
        }
        break;
    }
  }
  return true;
}

const parentElement = (impl: Impl): Impl | null => {
  const parent = impl._links?.parent ?? null;
  return parent !== null && parent.nodeType === 1 ? parent : null;
};

/** Whether the element answers the complex from compound `index` on, its ancestors answering the rest. */
function matchesFrom(impl: Impl, complex: Complex, index: number): boolean {
  if (!matchesCompound(impl, complex.compounds[index]!)) {
    return false;
  }
  if (index === complex.compounds.length - 1) {
    return true;
  }
  let ancestor = parentElement(impl);
  if (complex.combinators[index] === ">") {
    return ancestor !== null && matchesFrom(ancestor, complex, index + 1);
  }
  for (; ancestor !== null; ancestor = parentElement(ancestor)) {
    if (matchesFrom(ancestor, complex, index + 1)) {
      return true;
    }
  }
  return false;
}

function matchesList(impl: Impl, list: Complex[]): boolean {
  for (const complex of list) {
    if (matchesFrom(impl, complex, 0)) {
      return true;
    }
  }
  return false;
}

/** The first descendant element of `root`, in tree order, that answers the list. */
function firstMatch(root: Impl, list: Complex[]): Impl | null {
  let node = root._links?.firstChild ?? null;
  while (node !== null) {
    if (node.nodeType === 1 && matchesList(node, list)) {
      return node;
    }
    const links = node._links;
    let next = links?.firstChild ?? null;
    let from: Impl | null = node;
    while (next === null && from !== null && from !== root) {
      next = from._links?.nextSibling ?? null;
      if (next === null) {
        from = from._links?.parent ?? null;
      }
    }
    node = next;
  }
  return null;
}

function install(): void {
  // jsdom keeps the node behind a wrapper in a private field, which only its own helpers read.
  let utils: { implForWrapper?: (wrapper: unknown) => Impl | null; wrapperForImpl?: (impl: unknown) => unknown };
  try {
    utils = createRequire(import.meta.url)("jsdom/lib/generated/idl/utils.js");
  } catch {
    return;
  }
  const { implForWrapper, wrapperForImpl } = utils;
  if (typeof implForWrapper !== "function" || typeof wrapperForImpl !== "function") {
    return;
  }
  const probe = document.createElement("div");
  probe.setAttribute("data-probe", "1");
  probe.append(document.createElement("span"));
  const probeImpl = implForWrapper(probe);
  const child = probeImpl?._links?.firstChild;
  if (
    !probeImpl ||
    probeImpl.nodeType !== 1 ||
    probeImpl._localName !== "div" ||
    probeImpl._namespaceURI !== HTML_NS ||
    probeImpl._attributesByNameMap?.get("data-probe")?.[0]?._value !== "1" ||
    !child ||
    child._links?.parent !== probeImpl ||
    child._links.nextSibling !== null ||
    wrapperForImpl(child) !== probe.firstChild
  ) {
    return;
  }
  const implOf = (node: Node): Impl | undefined => implForWrapper(node) ?? undefined;
  const wrapperOf = (impl: Impl | null): Element | null => (impl === null ? null : (wrapperForImpl(impl) as Element));
  const check = process.env.DATUM_TEST_SELECTOR_CHECK === "1";

  const patch = (prototype: object, name: "querySelector" | "matches" | "closest", answer: (impl: Impl, list: Complex[]) => unknown): void => {
    const original = (prototype as Record<string, unknown>)[name] as ((this: Node, selector: string) => unknown) | undefined;
    if (typeof original !== "function") {
      return;
    }
    Object.defineProperty(prototype, name, {
      configurable: true,
      writable: true,
      value: function (this: Node, selector: string): unknown {
        const list = typeof selector === "string" && arguments.length === 1 ? parse(selector) : null;
        const impl = list === null ? undefined : implOf(this);
        if (list === null || impl === undefined) {
          return original.apply(this, arguments as unknown as [string]);
        }
        const fast = answer(impl, list);
        if (check) {
          const slow = original.call(this, selector);
          if (slow !== fast) {
            throw new Error(`fast-selectors: ${name}(${JSON.stringify(selector)}) differs from jsdom's answer`);
          }
        }
        return fast;
      }
    });
  };

  const first = (impl: Impl, list: Complex[]): Element | null => wrapperOf(firstMatch(impl, list));
  patch(Element.prototype, "querySelector", first);
  patch(DocumentFragment.prototype, "querySelector", first);
  patch(Document.prototype, "querySelector", first);
  patch(Element.prototype, "matches", (impl, list) => matchesList(impl, list));
  patch(Element.prototype, "closest", (impl, list) => {
    for (let node: Impl | null = impl; node !== null; node = parentElement(node)) {
      if (matchesList(node, list)) {
        return wrapperOf(node);
      }
    }
    return null;
  });
}

// A file that runs under the node environment (`@vitest-environment node`) has no DOM to patch.
if (typeof Element !== "undefined" && process.env.DATUM_TEST_FAST_SELECTORS !== "0") {
  install();
}
