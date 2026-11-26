/**
 * Definition generators for `bench-check.ts` and `tests/check-budget.test.ts` (kernel structural
 * check, sandbox ABI 2.13.0). Each returns a fresh definition object. Sizes follow the caps of
 * `core/expressions/definition-structure.ts` (fixtures F1 to F10 below).
 */

type Rec = Record<string, unknown>;

function form(children: unknown[], extra: Rec = {}): Rec {
  return {
    id: "bench",
    version: "1",
    schemaVersion: "1",
    root: { id: "form", type: "form", configuration: {}, children: { content: children } },
    ...extra
  };
}

function field(n: number): Rec {
  return { id: `f${n}`, type: "text", configuration: { label: `Field ${n}` } };
}

/** F1: `count` flat tiny components (180,000 is about 8 MiB). */
export function f1Flat(count = 180_000): Rec {
  const children: unknown[] = [];
  for (let n = 0; n < count; n += 1) {
    children.push({ id: `c${n}`, type: "text", configuration: {} });
  }
  return form(children);
}

/** F2: the 4,000-field form the check budget is measured on, with a visibility rule on every tenth field. */
export function f2Fields(count = 4_000): Rec {
  const children: unknown[] = [];
  for (let n = 0; n < count; n += 1) {
    const node = field(n);
    if (n % 10 === 5) {
      node.rules = { visibleWhen: `f${n - 1} = "x" and not(empty(f${n - 2}))`, requiredWhen: `f${n - 3} != ""` };
    }
    children.push(node);
  }
  return form(children);
}

/** F3: 10,000 components, 1,000 pages of ten, one page with 64 routes. */
export function f3Journey(components = 10_000, pages = 1_000): Rec {
  const children: unknown[] = [];
  for (let n = 0; n < components; n += 1) {
    children.push(field(n));
  }
  const list: Rec[] = [];
  const per = Math.max(1, Math.floor(components / pages));
  for (let p = 0; p < pages; p += 1) {
    const ids: string[] = [];
    for (let k = 0; k < per; k += 1) {
      ids.push(`f${p * per + k}`);
    }
    const page: Rec = { id: `p${p}`, components: ids };
    if (p === 0) {
      page.routes = [];
      for (let r = 1; r <= 64 && r < pages; r += 1) {
        (page.routes as Rec[]).push({ to: `p${r}`, when: `f0 = "${r}"` });
      }
    }
    list.push(page);
  }
  return form(children, { journey: { journeys: [{ id: "main", pages: list }] } });
}

/** F4: `selects` selects of `options` inline options each (25 x 2,000 is 50,000 in all). */
export function f4Options(selects = 25, options = 2_000): Rec {
  const children: unknown[] = [];
  for (let s = 0; s < selects; s += 1) {
    const list: Rec[] = [];
    for (let o = 0; o < options; o += 1) {
      list.push({ value: `v${o}`, label: `Option ${o}` });
    }
    children.push({ id: `s${s}`, type: "select", configuration: { label: `Select ${s}`, options: list } });
  }
  return form(children);
}

/** F5: `count` components that all share one id (the output cap). */
export function f5Duplicates(count = 9_000): Rec {
  const children: unknown[] = [];
  for (let n = 0; n < count; n += 1) {
    children.push({ id: "dup", type: "text", configuration: {} });
  }
  return form(children);
}

/** F6: one component whose id is `bytes` long. */
export function f6LongId(bytes = 8 * 1024 * 1024 - 4096): Rec {
  return form([{ id: "a".repeat(bytes), type: "text", configuration: {} }]);
}

/** F7: `depth` nested containers (32 is the limit) with `wide` fields at every level. */
export function f7DeepWide(depth = 31, wide = 290): Rec {
  let inner: unknown[] = [];
  for (let level = depth; level >= 1; level -= 1) {
    const here: unknown[] = [];
    for (let n = 0; n < wide; n += 1) {
      here.push({ id: `l${level}f${n}`, type: "text", configuration: { dataKey: `k${level}x${n}` } });
    }
    here.push({ id: `box${level}`, type: "container", configuration: { scopeData: false }, children: { content: inner } });
    inner = here;
  }
  return form(inner);
}

/** F8: 64 locales and 64 generated PDF layouts. */
export function f8Sections(locales = 64, layouts = 64): Rec {
  const supported: Rec[] = [];
  for (let n = 0; n < locales; n += 1) {
    supported.push({ code: n === 0 ? "en" : `x${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}`, label: `Locale ${n}` });
  }
  const list: Rec[] = [];
  for (let n = 0; n < layouts; n += 1) {
    list.push({ id: `layout${n}`, kind: "generated", root: { id: `doc${n}`, type: "pdf-document", configuration: {}, children: { content: [] } } });
  }
  return form([field(0), field(1)], { localization: { defaultLocale: "en", supportedLocales: supported }, pdf: { layouts: list } });
}

/**
 * F9: the F7 shape (`depth` nested containers, `wide` fields at every level, about 9,900 in all)
 * with a problem on every field, so the answer is the 200-problem cap and not a clean verdict:
 * `kind` "duplicate" gives every field one id, "invalid" an id the grammar refuses (a `root > slot > id` path must not be built
 * per problem past the cap).
 */
export function f9DeepProblems(kind: "duplicate" | "invalid" = "duplicate", depth = 30, wide = 330): Rec {
  let inner: unknown[] = [];
  for (let level = depth; level >= 1; level -= 1) {
    const here: unknown[] = [];
    for (let n = 0; n < wide; n += 1) {
      here.push({ id: kind === "duplicate" ? "dup" : `${n}x${level}`, type: "text", configuration: {} });
    }
    here.push({ id: `box${level}`, type: "container", configuration: { scopeData: false }, children: { content: inner } });
    inner = here;
  }
  return form(inner);
}

/** F10: `count` repeating sections, each with a random-looking dotted collection path of 500 characters (the places tree). */
export function f10LongPaths(count = 1_000): Rec {
  const children: unknown[] = [];
  let seed = 7;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  for (let n = 0; n < count; n += 1) {
    const pieces: string[] = [];
    let size = 0;
    while (size < 495) {
      const piece = (next() % 100000).toString(36);
      pieces.push(piece);
      size += piece.length + 1;
    }
    children.push({ id: `s${n}`, type: "group", configuration: { collectionPath: pieces.join(".").slice(0, 500) }, collection: { collectionPath: pieces.join(".").slice(0, 500) }, children: { content: [] } });
  }
  return form(children);
}

export const BENCH_FIXTURES: Array<{ name: string; make: () => Rec }> = [
  { name: "F1 flat 180k tiny", make: () => f1Flat() },
  { name: "F2 4,000 fields + rules", make: () => f2Fields() },
  { name: "F3 10k comps, 1k pages, 64 routes", make: () => f3Journey() },
  { name: "F4 25 x 2,000 options", make: () => f4Options() },
  { name: "F5 9,000 duplicate ids", make: () => f5Duplicates() },
  { name: "F6 one 8 MiB id", make: () => f6LongId() },
  { name: "F7 depth 32 x wide", make: () => f7DeepWide() },
  { name: "F8 64 locales, 64 layouts", make: () => f8Sections() },
  { name: "F9 depth 32, a problem on every field", make: () => f9DeepProblems() },
  { name: "F10 1,000 sections, 500-char paths", make: () => f10LongPaths() }
];
