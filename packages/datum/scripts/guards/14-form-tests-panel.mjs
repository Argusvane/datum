// The builder's Tests panel as a lazy chunk. The shell (default-builder-element.ts)
// keeps the strip item, the loader (tests-panel-loader.ts), the controller's `tests` block and the
// canvas's Show me; the panel itself, the runner, the words, the Accept rewrite and the plain-text
// editor (builder-tests-panel.ts and builder/form-tests/*) come from the loader the first time the
// panel opens, or when a rename has to be followed in a form that has tests. The CodeMirror editor
// is a second lazy chunk behind the panel's (tests-editor-loader.ts), so the panel's own chunk
// never carries the library: a page that opens the Tests panel pays for the library only when the
// author gets as far as typing. Neither chunk is in the builder's module or ever in the renderer's.
// The sentinel is markup only the panel's module writes: its Run all button's attribute.
//
// Two more sentinels hold the sandbox's `test` op (ABI 2.16) and the form-test judge out of both
// eager entries: the op belongs in datum-wasm.js (the sandbox
// program) and the judge in the Tests chunk. They could leak through the Tests runner's full
// in-process host, whose `inspect` names `runInspect`: the kernel module is already in the entry,
// so every statement a chunk reached from it would be kept there too. The panel's sentinel cannot see
// that leak, and a budget raised from a measure would accept it.

const TESTS_PANEL = "data-tests-run-all"; // builder-tests-panel.ts: the Run all button
const JUDGE = "expect.withheld"; // core/form-tests/form-test-run.ts: the judge's withheld miss (the panel's words use it only as a key suffix)
const TEST_OP = "The tests are text"; // validation/wasm/portable-kernel.ts kernelFormTestOp: tests that are not text
const CODE_EDITOR = "cm-lineNumbers"; // CodeMirror (check-bundles.mjs spells it the same way)

// Chunk budgets, in KB: the measure plus about 6%, rounded up, as guard 06 does.
const CHUNK_BUDGETS_KB = [
  // The panel, with Record, Assert this, the rules view, the scaffold, coverage in the engine, the
  // form-test parser and the judge (the run-only host leaves the entry no path to them): measured
  // 207,973 B (203.1 KB), plus 6%: 216 KB.
  [/^datum-builder-builder-tests-panel-.+\.js$/, 216],
  // The editor: measured 16,785 B (16.4 KB), plus 6%: 18 KB.
  [/^datum-builder-tests-editor-.+\.js$/, 18]
];

// No `budgets` export for datum-builder.js: the base budget stands, and the verify role reports
// what the strip item, the loader, the controller's block, Show me and the texts added to it.

/** The chunks a file imports statically (a lazy `import()` call is not one: that is the point). */
function staticImportsOf(text) {
  return [...text.matchAll(/\b(?:from|import)\s*["']\.\/(datum-[A-Za-z0-9_.-]+?\.js)["']/g)].map((match) => match[1]);
}

/**
 * Every chunk loading `name` loads with it: its static imports, theirs, and so on. A shared chunk
 * between the panel's and CodeMirror's would otherwise pass a one-level check.
 */
function staticClosureOf(name, files, read) {
  const seen = new Set();
  const queue = [name];
  while (queue.length > 0) {
    const next = queue.shift();
    for (const imported of staticImportsOf(read(next))) {
      if (files.includes(imported) && !seen.has(imported) && imported !== name) {
        seen.add(imported);
        queue.push(imported);
      }
    }
  }
  return [...seen];
}

export default function guard({ entryText, files, read, chunksOf, expect, sizeKb }) {
  const builder = entryText("datum-builder.js");
  const form = entryText("datum-form.js");
  expect(!builder.includes(TESTS_PANEL), `datum-builder.js (with its core chunk) carries the Tests panel (${TESTS_PANEL}); it belongs in a lazy chunk`);
  expect(!form.includes(TESTS_PANEL), "datum-form.js (with its core chunk) carries the builder's Tests panel");
  for (const [name, text] of [["datum-builder.js", builder], ["datum-form.js", form]]) {
    expect(
      !text.includes(TEST_OP),
      `${name} (with its core chunk) carries the sandbox's test op (${JSON.stringify(TEST_OP)}); it belongs in datum-wasm.js, and nothing eager may name runInspect`
    );
    // The judge is held out of the entry FILE, and out of the renderer's pair. The builder's core chunk (Vite 8 / Rolldown)
    // carries it with the parser (form-test-run.ts about 10 KB and form-test-parse.ts about 20 KB by the core map's
    // mappings): portable-kernel.ts, which the entry reaches, imports both for its test op, and Rolldown puts a module the entry's
    // load set reaches and a lazy chunk (the Tests runner) shares into the shared chunk, with every statement either needs. So
    // "not in the initial payload" does not hold for the builder, and the pair's budget is what bounds it; the entry file
    // alone must still not spell it, which keeps the op and the judge from coming back as entry statements.
    const judgeText = name === "datum-builder.js" ? read("datum-builder.js") : text;
    expect(
      !judgeText.includes(JUDGE),
      `${name}${name === "datum-builder.js" ? "" : " (with its core chunk)"} carries the form-test judge (${JSON.stringify(JUDGE)}); it belongs in the lazy Tests chunk`
    );
  }
  const carriers = chunksOf("datum-builder").filter((name) => name.endsWith(".js") && read(name).includes(TESTS_PANEL));
  expect(carriers.length === 1, `exactly one datum-builder-*.js chunk should carry the Tests panel (${TESTS_PANEL}); found ${carriers.length}${carriers.length ? ` (${carriers.join(", ")})` : ""}`);
  expect(
    chunksOf("datum-form").filter((name) => name.endsWith(".js") && read(name).includes(TESTS_PANEL)).length === 0,
    "a datum-form-*.js chunk carries the builder's Tests panel"
  );
  for (const name of carriers) {
    const text = read(name);
    expect(!text.includes(CODE_EDITOR), `${name} carries CodeMirror (${CODE_EDITOR}); the library belongs behind the editor's own lazy import (tests-editor-loader.ts)`);
    for (const imported of staticClosureOf(name, files, read)) {
      expect(!read(imported).includes(CODE_EDITOR), `${name} loads ${imported} statically (directly or through another chunk), and that chunk carries CodeMirror; the Tests panel must not load the library until the editor does`);
    }
  }
  for (const [pattern, limit] of CHUNK_BUDGETS_KB) {
    const named = files.filter((name) => pattern.test(name));
    expect(named.length === 1, `expected one chunk matching ${pattern}; found ${named.length}`);
    for (const name of named) {
      expect(sizeKb(name) <= limit, `${name} is over its ${limit} KB budget; the lazy Tests panel has grown`);
    }
  }
}
