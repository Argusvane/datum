// GRD-01 to GRD-06: the data grid's rows. `coverage-grid` has two text columns, no row to start,
// up to four rows, and rows that can be moved. A press on a row button takes focus where a person
// would expect it; each row keeps its answers (and its drawn nodes) across add, remove and move;
// the bounds govern the buttons; every row is named ("Row 2") for the buttons that act on it.

/** The deep active element: what it is and which row button / row it belongs to. */
function activeRow(t) {
  return t.page.evaluate(() => {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    if (!el) return null;
    const row = el.closest("tr[data-row-index]");
    return {
      tag: el.localName,
      id: el.id,
      action: el.getAttribute("data-row-action"),
      row: row ? Number(row.getAttribute("data-row-index")) : null,
      valuePath: el.closest("[data-value-path]")?.getAttribute("data-value-path") ?? null
    };
  });
}

const rowButton = (index, action) => `tr[data-row-index="${index}"] [data-row-action="${action}"]`;

/** The answers per row, read from the boxes. */
async function answers(t) {
  return t.page.evaluate(() => {
    const root = window.fc.hostElement().shadowRoot;
    return Array.from(root.querySelectorAll("tr[data-row-index]")).map((tr) => ({
      sku: tr.querySelector('[data-column-id="sku"] input')?.value,
      note: tr.querySelector('[data-column-id="note"] input')?.value
    }));
  });
}

/** Marks each row's first box (a property no draw writes), so a later look tells whether the node itself moved. */
function markNodes(t) {
  return t.page.evaluate(() => {
    const root = window.fc.hostElement().shadowRoot;
    for (const tr of Array.from(root.querySelectorAll("tr[data-row-index]"))) {
      const box = tr.querySelector('[data-column-id="sku"] input');
      box.__mark = `node:${box.value}`;
    }
  });
}
const marks = (t) =>
  t.page.evaluate(() => Array.from(window.fc.hostElement().shadowRoot.querySelectorAll('tr[data-row-index] [data-column-id="sku"] input')).map((box) => box.__mark ?? null));

export default {
  id: "data-grid",
  title: "Data grid rows: focus after add, remove and move, row identity, bounds and row names",
  features: ["GRD-01", "GRD-02", "GRD-03", "GRD-04", "GRD-05", "GRD-06"],
  async run(t) {
    await t.load("coverage-grid");
    t.check("GRD-05: with no rows the grid says so", (await t.composedText("#items")).includes("No rows yet"));

    // Add: focus goes to the new row's first control; four is the most.
    for (const [index, word] of ["apple", "pear", "plum", "fig"].entries()) {
      await t.click("#items__add");
      t.equal(await activeRow(t), { tag: "input", id: `sku-items_${index}__sku`, action: null, row: index, valuePath: `items[${index}].sku` }, `GRD-01: Add ${index + 1} focuses the new row's first control`);
      await t.page.keyboard.type(word);
      await t.key("Tab");
      await t.page.keyboard.type(`n-${word}`);
      await t.drawn();
    }
    t.equal(await answers(t), [
      { sku: "apple", note: "n-apple" },
      { sku: "pear", note: "n-pear" },
      { sku: "plum", note: "n-plum" },
      { sku: "fig", note: "n-fig" }
    ], "GRD-04: each row holds what was typed into it");
    const maxed = await t.facts("#items__add");
    t.check("GRD-05: at four rows (maxRows) the Add button can no longer be pressed", maxed === null || maxed.disabled === true || maxed.attributes?.["aria-disabled"] === "true", maxed);
    await t.shared("four rows");

    // Names: each row is "Row n" and its buttons are described by it.
    const rowNames = await t.page.evaluate(() => Array.from(window.fc.hostElement().shadowRoot.querySelectorAll("tr[data-row-index] th[scope=row]")).map((th) => th.textContent.trim()));
    t.equal(rowNames, ["Row 1", "Row 2", "Row 3", "Row 4"], "GRD-06: every row is named by its place");
    const described = await t.facts(rowButton(1, "remove"));
    t.equal(described?.describedText, ["Row 2"], "GRD-06: a row's Remove is described by the row's name");
    const fieldNames = (await t.ax()).filter((n) => n.role === "textbox" && n.name === "Item").length;
    t.equal(fieldNames, 4, "GRD-06: each row's Item box is named by its column");

    // Move: the nodes, their answers and the runtime's keys travel together; focus stays on the pressed button.
    await markNodes(t);
    const keysBefore = (await t.fc("rows", "items")).keys;
    await t.click(rowButton(2, "up"));
    t.equal((await answers(t)).map((r) => r.sku), ["apple", "plum", "pear", "fig"], "GRD-03: Move up on row 3 put plum in second place");
    t.equal(await activeRow(t), { tag: "button", id: "", action: "up", row: 1, valuePath: null }, "GRD-03: focus is on the moved row's Move up button, in its new place");
    t.equal(await marks(t), ["node:apple", "node:plum", "node:pear", "node:fig"], "GRD-04: the row's own nodes moved with it (the same elements, answers on them)");
    t.equal((await answers(t))[1], { sku: "plum", note: "n-plum" }, "GRD-04: the moved row kept its other answer");
    const keysMoved = (await t.fc("rows", "items")).keys;
    t.equal(keysMoved, [keysBefore[0], keysBefore[2], keysBefore[1], keysBefore[3]], "GRD-04: the runtime's row keys moved with the rows");
    await t.click(rowButton(1, "up"));
    t.equal((await answers(t)).map((r) => r.sku), ["plum", "apple", "pear", "fig"], "GRD-03: Move up again put plum first");
    t.equal(await activeRow(t), { tag: "input", id: "sku-items_0__sku", action: null, row: 0, valuePath: "items[0].sku" }, "GRD-03: where the pressed button is now disabled, focus goes to the row's first control");
    t.equal((await t.facts(rowButton(0, "up")))?.disabled, true, "GRD-03: the first row's Move up is disabled");
    await t.click(rowButton(0, "down"));
    t.equal((await answers(t)).map((r) => r.sku), ["apple", "plum", "pear", "fig"], "GRD-03: Move down put plum second");
    t.equal(await activeRow(t), { tag: "button", id: "", action: "down", row: 1, valuePath: null }, "GRD-03: focus is on the moved row's Move down button");
    await t.shared("after moves");

    // Remove: focus goes to the row now in the removed one's place; after the last, the one before; after all, Add.
    await t.click(rowButton(1, "remove"));
    t.equal((await answers(t)).map((r) => r.sku), ["apple", "pear", "fig"], "GRD-04: removing plum left the others with their answers");
    t.equal(await marks(t), ["node:apple", "node:pear", "node:fig"], "GRD-04: and their own nodes");
    t.equal(await activeRow(t), { tag: "input", id: "sku-items_1__sku", action: null, row: 1, valuePath: "items[1].sku" }, "GRD-02: removing a middle row focuses the row now in its place");
    await t.click(rowButton(2, "remove"));
    t.equal(await activeRow(t), { tag: "input", id: "sku-items_1__sku", action: null, row: 1, valuePath: "items[1].sku" }, "GRD-02: removing the last row focuses the one before it");
    await t.click(rowButton(1, "remove"));
    await t.click(rowButton(0, "remove"));
    t.equal(await activeRow(t), { tag: "button", id: "items__add", action: "add", row: null, valuePath: null }, "GRD-02: removing the only row focuses the Add button");
    t.equal(await t.fc("rows", "items"), { rows: [], keys: [] }, "GRD-02: no rows are left");
    t.check("GRD-05: with no rows left the grid says so again", (await t.composedText("#items")).includes("No rows yet"));
    await t.shared("all removed");

    // Bounds: the summary form's `rows` grid holds at least one row.
    await t.load("coverage-summary");
    const only = await t.facts(rowButton(0, "remove"));
    t.equal(only?.disabled, true, "GRD-05: a grid at its minimum (one row) cannot remove it");
    await t.click("#rows__add");
    t.equal((await t.facts(rowButton(0, "remove")))?.disabled, false, "GRD-05: with a second row the first can be removed");
  }
};
