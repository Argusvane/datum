// FIL-01..FIL-04: a file field (`receipt` on the `single` form) stores what is picked, says so,
// takes a drop, gives an embedded file back as a download, and removes it with focus kept in the
// field. A read-only field still gives its file back; a disabled one takes nothing. One scenario
// per feature, so a failure names the feature.

const RECEIPT = `[data-value-path="receipt"]`;
const NOTE = { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello world") };
const SECOND = { name: "second.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 second") };

const receipt = async (t) => (await t.values()).receipt;

/** Waits (bounded) until the stored answer satisfies `test`; files are read before they are stored. */
async function stored(t, test) {
  for (let i = 0; i < 50; i += 1) {
    await t.drawn();
    if (test(await receipt(t))) return true;
    await t.page.waitForTimeout(40);
  }
  return false;
}

/** A person's pick: press the picker, the browser's chooser answers with `file`. */
async function pick(t, file) {
  const [chooser] = await Promise.all([t.page.waitForEvent("filechooser"), t.page.locator(`${RECEIPT} input[type=file]`).click()]);
  await chooser.setFiles(file);
  await stored(t, (value) => value?.name === file.name);
}

/** What the file field shows: its rows and its drag mark. */
const rows = (t) =>
  t.page.evaluate((sel) => {
    const wrapper = (function find(root) {
      const hit = root.querySelector(sel);
      if (hit) return hit;
      for (const el of root.querySelectorAll("*")) {
        const inner = el.shadowRoot && find(el.shadowRoot);
        if (inner) return inner;
      }
      return null;
    })(window.fc.hostElement().shadowRoot);
    return {
      names: [...wrapper.querySelectorAll("li")].map((li) => li.textContent.replace(/\s+/g, " ").trim()),
      picker: wrapper.querySelector("input[type=file]") !== null,
      pickerDisabled: wrapper.querySelector("input[type=file]")?.disabled ?? null,
      removes: wrapper.querySelectorAll("button[aria-label^='Remove']").length,
      dragging: wrapper.hasAttribute("data-file-drag"),
      status: wrapper.querySelector("[data-file-status]")?.textContent ?? null
    };
  }, RECEIPT);

/** What a drag from the desktop does over the wrapper: events carrying a file. */
function drag(t, type, file) {
  return t.page.evaluate(
    ([sel, eventType, name, body]) => {
      const wrapper = (function find(root) {
        const hit = root.querySelector(sel);
        if (hit) return hit;
        for (const el of root.querySelectorAll("*")) {
          const inner = el.shadowRoot && find(el.shadowRoot);
          if (inner) return inner;
        }
        return null;
      })(window.fc.hostElement().shadowRoot);
      const data = new DataTransfer();
      data.items.add(new File([body], name, { type: "text/plain" }));
      const event = new DragEvent(eventType, { bubbles: true, composed: true, cancelable: true, dataTransfer: data });
      wrapper.dispatchEvent(event);
      return event.defaultPrevented;
    },
    [RECEIPT, type, file.name, file.body]
  );
}

const HELD = { storage: "base64", name: "held.txt", type: "text/plain", size: 4, data: Buffer.from("held").toString("base64") };

const pickScenario = {
  id: "files-pick",
  title: "A picked file is stored, listed and announced; focus stays on the picker",
  features: ["FIL-01"],
  async run(t) {
    await t.load("single");
    await pick(t, NOTE);
    const value = await receipt(t);
    t.check("FIL-01: the picked file is stored with its name, type and size", value?.name === "note.txt" && value?.type === "text/plain" && value?.size === 11, value);
    t.check("FIL-01: its bytes are embedded", value?.storage === "base64" && value?.data === Buffer.from("hello world").toString("base64"), value);
    t.equal((await rows(t)).names.map((n) => n.startsWith("note.txt")), [true], "FIL-01: the field lists the file");
    await t.expectFocus({ valuePath: "receipt", type: "file" }, "FIL-01: focus stays on the picker after a pick");
    await t.page.waitForTimeout(150);
    const said = await t.announcements();
    t.check("FIL-01: the pick is announced (a live region says which file was added)", said.some((a) => a.text.includes("note.txt")), said);
    await t.shared("file picked");

    // A single-file field holds one: the next pick replaces it.
    await pick(t, SECOND);
    t.equal((await receipt(t))?.name, "second.pdf", "FIL-01: a second pick replaces the first in a single-file field");
    t.equal((await rows(t)).names.length, 1, "FIL-01: still one row");
  }
};

const removeScenario = {
  id: "files-remove",
  title: "Removing a file clears it, says so, and keeps focus in the field",
  features: ["FIL-02"],
  async run(t) {
    await t.load("single", { preset: { receipt: { ...HELD, name: "second.pdf" } } });
    t.equal((await rows(t)).removes, 1, "FIL-02: a held file has a Remove button naming it");
    await t.announcements();
    await t.page.locator(`${RECEIPT} button[aria-label="Remove second.pdf"]`).click();
    await t.drawn();
    t.equal(await receipt(t), undefined, "FIL-02: removing clears the answer");
    t.equal((await rows(t)).names, [], "FIL-02: the row is gone");
    await t.page.waitForTimeout(100);
    const gone = await t.announcements();
    t.check("FIL-02: the removal is announced politely with the file's name", gone.length === 1 && gone[0].politeness === "polite" && gone[0].text.includes("second.pdf"), gone);
    const active = await t.active();
    t.check("FIL-02: focus stays in the field after the Remove button goes", active?.valuePath === "receipt", active);
    await t.shared("file removed");
  }
};

const dropScenario = {
  id: "files-drop",
  title: "A file dropped on the field is stored; a read-only or disabled field takes none",
  features: ["FIL-03"],
  async run(t) {
    await t.load("single");
    const over = await drag(t, "dragover", { name: "dropped.txt", body: "dropped bytes" });
    t.check("FIL-03: a file dragged over the field is let through (default prevented)", over === true);
    t.equal((await rows(t)).dragging, true, "FIL-03: the field is marked while a file is dragged over it");
    await drag(t, "drop", { name: "dropped.txt", body: "dropped bytes" });
    t.check("FIL-03: dropping stores the file", await stored(t, (v) => v?.name === "dropped.txt" && v?.data === Buffer.from("dropped bytes").toString("base64")), await receipt(t));
    t.equal((await rows(t)).dragging, false, "FIL-03: the mark is gone once the file lands");
    await t.shared("file dropped");

    await t.load("single", { mode: "readonly", preset: { receipt: HELD } });
    await drag(t, "drop", { name: "late.txt", body: "late" });
    await t.page.waitForTimeout(150);
    t.equal((await receipt(t))?.name, "held.txt", "FIL-03: a drop on a read-only field stores nothing");

    await t.load("single", { mode: "disabled", preset: { receipt: HELD } });
    const disabled = await rows(t);
    t.check("FIL-03: a disabled field's picker is disabled and it offers no removal", disabled.pickerDisabled === true && disabled.removes === 0, disabled);
    await drag(t, "drop", { name: "late.txt", body: "late" });
    await t.page.waitForTimeout(150);
    t.equal((await receipt(t))?.name, "held.txt", "FIL-03: a drop on a disabled field stores nothing");
  }
};

const downloadScenario = {
  id: "files-download",
  title: "A stored file is given back as a download, also by a read-only field",
  features: ["FIL-04"],
  async run(t) {
    await t.load("single", { preset: { receipt: { ...HELD, name: "dropped.txt", data: Buffer.from("dropped bytes").toString("base64"), size: 13 } } });
    const [download] = await Promise.all([t.page.waitForEvent("download"), t.page.locator(`${RECEIPT} button[title^="Download"]`).click()]);
    t.equal(download.suggestedFilename(), "dropped.txt", "FIL-04: the download carries the file's name");
    t.equal(await (await import("node:fs/promises")).readFile(await download.path(), "utf8"), "dropped bytes", "FIL-04: and its bytes");
    await t.drawn();

    await t.load("single", { mode: "readonly", preset: { receipt: HELD } });
    const readonly = await rows(t);
    t.check("FIL-04: a read-only field lists its file and offers no picker or removal", readonly.names.length === 1 && !readonly.picker && readonly.removes === 0, readonly);
    const [kept] = await Promise.all([t.page.waitForEvent("download"), t.page.locator(`${RECEIPT} button[title^="Download"]`).click()]);
    t.equal(kept.suggestedFilename(), "held.txt", "FIL-04: a read-only field still gives its file back (a download writes nothing)");
    t.equal((await receipt(t))?.name, "held.txt", "FIL-04: and the answer is unchanged");
  }
};

export const FILE_SCENARIOS = [pickScenario, removeScenario, dropScenario, downloadScenario];
