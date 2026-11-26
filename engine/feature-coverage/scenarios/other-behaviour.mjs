// The "other behaviour" group and the two features the earlier groups left: TAB-03 (the narrow
// tabs view), JNY-05 (a quiet page change for an agent), AGT-06 (an agent's quiet refused
// submit), TIP-01 (help bubbles), MED-01 (labels
// that follow a media query), UNK-01 (a component type nothing draws), BTN-01 (buttons and button
// groups) and SIG-01 (signatures). One scenario per feature, so a failure names the feature.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `read` (bounded) until `test` holds; the last reading either way. */
async function until(t, read, test, tries = 40) {
  let value = await read();
  for (let i = 0; i < tries && !test(value); i += 1) {
    await t.page.waitForTimeout(50);
    await t.drawn();
    value = await read();
  }
  return value;
}

const actions = async (t) => (await t.events()).filter((e) => e.type === "datum-form-action").map((e) => e.detail);

// ── TAB-03 ─────────────────────────────────────────────────────────────────────────────────

const narrowTabs = {
  id: "tabs-narrow",
  title: "Below the binding's width tabs are drawn as contents over stacked panels, and back as tabs above it",
  features: ["TAB-03"],
  async run(t) {
    const view = () =>
      t.page.evaluate(() => ({
        tabs: window.fc.query('[role="tab"]').length,
        tablists: window.fc.query('[role="tablist"]').length,
        contents: window.fc.query('[data-tabs-view="contents"]').length,
        links: window.fc.query('[data-tabs-view="contents"] a[href^="#"]').map((d) => d.text),
        panels: window.fc.query('[data-tab-panel]:not([hidden])').map((d) => d.id)
      }));

    // A form that keeps tabs at every width is the control: narrow, it is still a strip.
    await t.page.setViewportSize({ width: 480, height: 900 });
    await t.load("coverage-tabs");
    const always = await view();
    t.check("TAB-03: with no breakpoint (tabsFrom always) a narrow form keeps its strip of tabs", always.tablists === 1 && always.tabs === 3 && always.contents === 0, always);

    await t.page.setViewportSize({ width: 1280, height: 900 });
    await t.load("coverage-tabs", { binding: { controls: { tabsFrom: 640 } } });
    const wide = await view();
    t.check("TAB-03: wider than the breakpoint the tabs are a strip with one panel shown", wide.tablists === 1 && wide.tabs === 3 && wide.contents === 0 && wide.panels.length === 1, wide);

    await t.page.setViewportSize({ width: 480, height: 900 });
    const narrow = await until(t, view, (v) => v.contents === 1);
    t.equal(narrow.contents, 1, "TAB-03: narrower than the breakpoint the tabs are drawn as the contents view");
    t.equal([narrow.tablists, narrow.tabs], [0, 0], "TAB-03: the narrow view has no tab strip and no tab roles");
    t.equal(narrow.links, ["General", "Contact", "Extra"], "TAB-03: the contents list links to each panel by the tab's label");
    t.equal(narrow.panels, ["sections__panel-general", "sections__panel-contact", "sections__panel-extra"], "TAB-03: every panel is shown, stacked in order");
    t.check("TAB-03: the contents view is headed", (await t.composedText('[data-tabs-view="contents"]')).startsWith("Sections Contents"), await t.composedText('[data-tabs-view="contents"]'));
    for (const [slot, label] of [["general", "General"], ["contact", "Contact"], ["extra", "Extra"]]) {
      t.check(`TAB-03: the ${label} panel is headed by its label`, (await t.composedText(`#sections__panel-${slot}`)).startsWith(label), await t.composedText(`#sections__panel-${slot}`));
    }
    await t.shared("narrow view");

    // A contents link goes to its panel: its heading takes focus.
    await t.page.locator('[data-tabs-view="contents"] a[href="#sections__panel-contact"]').click();
    await t.drawn();
    const active = await t.active();
    t.check("TAB-03: following a contents link focuses that panel's heading", /^h[1-6]$/.test(active?.tag ?? "") && active?.text === "Contact", active);
    // A field in a later panel is reached without opening anything.
    await t.type("#code", "X1");
    t.equal((await t.values()).code, "X1", "TAB-03: a field in the last panel takes an answer in the narrow view");
    const checked = await t.validate();
    t.equal(checked.errors, 1, "TAB-03: a check in the narrow view finds the one error left");
    await t.expectFocus({ region: "summary" }, "TAB-03: and takes focus to the summary");
    await t.shared("narrow view checked");

    await t.page.setViewportSize({ width: 1280, height: 900 });
    const back = await until(t, view, (v) => v.tablists === 1);
    t.check("TAB-03: widened past the breakpoint the strip of tabs is back, one panel shown", back.tablists === 1 && back.tabs === 3 && back.contents === 0 && back.panels.length === 1, back);
    t.equal((await t.values()).code, "X1", "TAB-03: the answer typed in the narrow view stays");
    await t.shared("wide again");
  }
};

// ── JNY-05 ─────────────────────────────────────────────────────────────────────────────────

const quietPage = {
  id: "journey-quiet",
  title: "An agent's page change paints the page and leaves focus where the person left it",
  features: ["JNY-05"],
  async run(t) {
    const outside = () =>
      t.page.evaluate(() => {
        let button = document.getElementById("outside");
        if (!button) {
          button = document.createElement("button");
          button.id = "outside";
          button.textContent = "Outside the form";
          document.body.prepend(button);
        }
        button.focus();
        return document.activeElement?.id;
      });
    const page = async () => (await t.fc("journey"))?.pageId;

    await t.load("journey", { preset: { applicant_name: "Ada Lovelace", age: 30 } });
    t.equal(await outside(), "outside", "JNY-05: focus is on a control outside the form");
    const scrolled = await t.page.evaluate(() => window.scrollY);
    const moved = await t.fc("quietPageMove", "next");
    t.equal(moved.pageId, "contact", "JNY-05: the agent's move went to the next page");
    t.check("JNY-05: the new page is painted", (await t.query("#contact_method")).length === 1 && (await t.query("#applicant_name")).length === 0);
    await sleep(100);
    await t.expectFocus({ id: "outside" }, "JNY-05: focus stays where the person left it");
    t.equal(await t.page.evaluate(() => window.scrollY), scrolled, "JNY-05: and the page did not scroll");
    await t.shared("quiet move");

    // The quiet was used up: the next move nobody quieted takes focus to the new page's heading.
    await outside();
    t.equal(await t.fc("pageMove", "back"), "intro", "JNY-05: a host's own move goes back");
    await t.expectFocus({ id: "intro__page-heading" }, "JNY-05: a move nobody quieted takes focus to the heading (the quiet was one-shot)");

    // A quiet asked for while focus is in the form is not taken: the page holding focus is being left.
    await t.page.locator("#applicant_name").focus();
    t.equal((await t.fc("quietPageMove", "next")).pageId, "contact", "JNY-05: the agent's move with focus in the form goes on");
    await t.expectFocus({ id: "contact__page-heading" }, "JNY-05: with focus inside the form the move takes it to the new heading");

    // A move the runtime refuses leaves no quiet behind for a later page change.
    await t.load("journey");
    await outside();
    await t.fc("quietPageMove", "next");
    t.equal(await page(), "intro", "JNY-05: a quiet move on a page with an error is refused");
    await t.fc("setValue", "applicant_name", "Ada Lovelace");
    await t.drawn();
    await outside();
    t.equal(await t.fc("pageMove", "next"), "contact", "JNY-05: the host's next move goes on");
    await t.expectFocus({ id: "contact__page-heading" }, "JNY-05: and is not quieted by the refused move's release");
    await t.shared("after the refused move");
  }
};

// ── AGT-06 ─────────────────────────────────────────────────────────────────────────────────

const quietSubmit = {
  id: "agent-submit-quiet",
  title: "An agent's refused submit draws its errors and leaves focus in the field the person is typing in",
  features: ["AGT-06"],
  async run(t) {
    await t.load("single");
    await t.type({ path: "age" }, "3");
    await t.expectFocus({ valuePath: "age" }, "AGT-06: the person is typing in Age");
    const agent = await t.fc("quietSubmit");
    t.equal(agent.accepted, false, "AGT-06: the empty required fields refuse the submit");
    const summary = await t.composedText("[data-datum-summary]");
    t.check("AGT-06: the refused submit draws the summary", summary.includes("Full name"), summary);
    await sleep(100);
    if (agent.quieted) {
      await t.expectFocus({ valuePath: "age" }, "AGT-06: an agent's refused submit leaves focus in the person's field");
      const typed = await t.page.evaluate(() => {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        return { value: active?.value ?? null, caret: active?.selectionStart ?? null };
      });
      t.check("AGT-06: what the person typed is still there", typed.value === "3", typed);
      await t.shared("agent refused, focus kept");
    } else {
      // The renderer with nothing around it has no agent: every submit is the person's.
      await t.expectFocus({ region: "summary" }, "AGT-06: with no element, a refused submit is the person's and focuses the summary");
    }

    // The quiet ends with the agent's submit: the person's own refused submit takes them to the errors.
    await t.click({ path: "age" });
    const own = await t.fc("pageSubmit");
    t.equal(own, false, "AGT-06: the person's own submit is refused too");
    await sleep(100);
    await t.expectFocus({ region: "summary" }, "AGT-06: the person's own refused submit focuses the summary (no quiet left behind)");
  }
};

// ── TIP-01 ─────────────────────────────────────────────────────────────────────────────────

const tooltip = {
  id: "tooltip",
  title: "A help bubble opens on hover and focus, Escape dismisses it, and it opens again once left",
  features: ["TIP-01"],
  async run(t) {
    await t.load("coverage-tooltip");
    const MARK = '[data-value-path="reference"] [data-tooltip-mark]';
    const state = () =>
      t.page.evaluate(() => {
        const root = window.fc.hostElement().shadowRoot;
        const tip = root.querySelector('[data-value-path="reference"] [data-tooltip]');
        const mark = tip?.querySelector("[data-tooltip-mark]");
        const bubble = mark ? root.getElementById(mark.getAttribute("aria-describedby")) : null;
        return { shown: bubble ? getComputedStyle(bubble).visibility === "visible" && getComputedStyle(bubble).opacity !== "0" : null, dismissed: tip?.hasAttribute("data-dismissed") ?? null };
      });
    const shown = (want) => until(t, state, (s) => s.shown === want, 20);
    // A real pointer over the mark: once it is hovered, the bubble's bridge (a box over the mark's
    // row that keeps the hover on the way to the bubble) is what the pointer rests on.
    const pointAtMark = async () => {
      const box = await t.page.locator(MARK).boundingBox();
      await t.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    };

    t.equal(await t.query('[data-value-path="name"] [data-tooltip]'), [], "TIP-01: a field without help draws no mark");
    const mark = await t.facts(MARK);
    t.check("TIP-01: the mark is a focusable button named Help", mark?.attributes.role === "button" && mark.attributes.tabindex === "0" && mark.attributes["aria-label"] === "Help", mark);
    const control = await t.facts("#reference");
    t.check("TIP-01: the control is described by the help text", (control?.describedText ?? []).includes("It is printed at the top of your letter."), control);
    t.equal((await state()).shown, false, "TIP-01: the bubble is shut to start");

    // Hover opens it; Escape dismisses it under a resting pointer; leaving and coming back opens it again.
    await pointAtMark();
    t.equal((await shown(true)).shown, true, "TIP-01: hovering the mark opens the bubble");
    await t.page.keyboard.press("Escape");
    const escaped = await shown(false);
    t.check("TIP-01: Escape dismisses it while the pointer rests on it", escaped.shown === false && escaped.dismissed === true, escaped);
    await t.page.locator("#name").hover();
    t.equal((await state()).dismissed, false, "TIP-01: the dismissal ends once the pointer leaves");
    await pointAtMark();
    t.equal((await shown(true)).shown, true, "TIP-01: hovering again opens it");
    await t.page.mouse.move(1200, 880);
    t.equal((await shown(false)).shown, false, "TIP-01: the bubble shuts when the pointer goes");

    // Focus opens it; Escape dismisses it and leaves focus on the mark; Enter toggles it.
    await t.page.locator("#reference").focus();
    await t.page.keyboard.press("Shift+Tab");
    await t.expectFocus({ componentId: "reference", role: "button" }, "TIP-01: the mark is in the tab order, before its field's control");
    t.equal((await shown(true)).shown, true, "TIP-01: focus on the mark opens the bubble");
    await t.page.keyboard.press("Escape");
    t.equal((await shown(false)).shown, false, "TIP-01: Escape dismisses it while the mark holds focus");
    t.equal((await t.active())?.role, "button", "TIP-01: focus stays on the mark");
    await t.page.keyboard.press("Enter");
    t.equal((await shown(true)).shown, true, "TIP-01: Enter on the mark opens it again");
    await t.page.keyboard.press(" ");
    t.equal((await shown(false)).shown, false, "TIP-01: Space on the mark shuts it");
    t.equal(await t.page.evaluate(() => window.scrollY), 0, "TIP-01: Space on the mark does not scroll the page");
    await t.page.keyboard.press("Tab");
    t.equal((await state()).dismissed, false, "TIP-01: leaving the mark ends the dismissal");
    await t.shared("after the bubble");

    // A press on the mark is about the help: the label does not hand it to the control.
    const box = await t.page.locator(MARK).boundingBox();
    await t.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await t.drawn();
    t.check("TIP-01: clicking the mark does not focus the text box", (await t.active())?.id !== "reference", await t.active());
    t.equal((await t.values()).reference, undefined, "TIP-01: and writes nothing");
  }
};

// ── MED-01 ─────────────────────────────────────────────────────────────────────────────────

const mediaLabels = {
  id: "media-labels",
  title: "A control's name that depends on a media query follows the viewport",
  features: ["MED-01"],
  async run(t) {
    const name = async () => {
      const facts = await t.facts("#where");
      const ax = (await t.ax()).find((node) => node.role === "textbox");
      return { label: facts?.attributes["aria-label"], ax: ax?.name };
    };
    await t.page.setViewportSize({ width: 1280, height: 900 });
    await t.load("coverage-media", { adapters: ["media-label"] });
    t.equal(await name(), { label: "Where you live (wide)", ax: "Where you live (wide)" }, "MED-01: where the query matches the control takes the matching name");
    await t.page.setViewportSize({ width: 480, height: 900 });
    const narrow = await until(t, name, (n) => n.label === "Where you live (narrow)");
    t.equal(narrow, { label: "Where you live (narrow)", ax: "Where you live (narrow)" }, "MED-01: once it stops matching the control takes the other name");
    await t.type("#where", "Ottawa");
    await t.key("Tab");
    t.equal((await name()).label, "Where you live (narrow)", "MED-01: a draw keeps the name the viewport calls for");
    t.equal((await t.values()).where, "Ottawa", "MED-01: the control still takes its answer");
    await t.page.setViewportSize({ width: 1280, height: 900 });
    t.equal((await until(t, name, (n) => n.label === "Where you live (wide)")).label, "Where you live (wide)", "MED-01: widened again it takes the matching name back");
    await t.shared("media labels");
  }
};

// ── UNK-01 ─────────────────────────────────────────────────────────────────────────────────

const unknown = {
  id: "unknown-component",
  title: "A component type nothing draws is reported once and drawn as a note; the rest of the form works",
  features: ["UNK-01"],
  async run(t) {
    await t.fc("consoleTake");
    const loaded = await t.load("coverage-unknown");
    const expected = ['box: component "mystery-box"', 'dial: component "mystery-dial"'];
    t.equal([...loaded.unsupported].sort(), expected, "UNK-01: unsupported() lists the two types nothing draws, and nothing else");
    const note = await t.query('[data-value-path="dial"] [role="note"]');
    t.check("UNK-01: the unknown field is drawn as a note naming its type", note.length === 1 && note[0].text.includes("mystery-dial"), note);
    t.equal(await t.query('[data-value-path="dial"] :is(input,select,textarea,button)'), [], "UNK-01: the note offers no control");
    t.check("UNK-01: the unknown container still draws what it holds", (await t.query('[data-container-id="box"] #town')).length === 1);

    // Redrawn several times: still reported once each.
    await t.type("#name", "Ada");
    await t.type("#town", "Ottawa");
    await t.key("Tab");
    await t.validate();
    t.equal([...(await t.fc("unsupported"))].sort(), expected, "UNK-01: after redraws each type is still listed once");
    const said = (await t.fc("consoleTake")).filter((m) => m.type === "warn");
    t.equal(
      ["mystery-dial", "mystery-box"].map((type) => said.filter((m) => m.text.includes(`"${type}"`)).length),
      [1, 1],
      "UNK-01: each type is warned about once, however often the form draws"
    );
    t.equal(await t.values(), { name: "Ada", town: "Ottawa" }, "UNK-01: the answers around it are stored; the note holds none");
    await t.shared("unknown drawn");
  }
};

// ── BTN-01 ─────────────────────────────────────────────────────────────────────────────────

const buttons = {
  id: "buttons",
  title: "Form buttons and the buttons of a group report their action once per press; a locked form reports none",
  features: ["BTN-01"],
  async run(t) {
    await t.load("coverage-buttons");
    const group = await t.query('[data-container-id="actions"] .datum-form__button-group button');
    t.equal(group.map((b) => b.text), ["Submit", "Download a copy"], "BTN-01: the group draws its buttons together, in order");
    for (const [label, componentId, action] of [
      ["Submit", "send", "submit"],
      ["Download a copy", "copy", "download"],
      ["Download as PDF", "print", "pdf"]
    ]) {
      const before = (await actions(t)).length;
      await t.page.getByRole("button", { name: label }).click();
      await t.drawn();
      t.equal((await actions(t)).slice(before), [{ componentId, action }], `BTN-01: pressing "${label}" reports ${action} for ${componentId} once`);
    }
    await t.page.getByRole("button", { name: "Submit" }).focus();
    await t.key("Enter");
    await t.key(" ");
    t.equal((await actions(t)).slice(3), [{ componentId: "send", action: "submit" }, { componentId: "send", action: "submit" }], "BTN-01: Enter and Space on a button press it, once each");
    t.equal(await t.values(), {}, "BTN-01: a press writes nothing to the answers");
    await t.shared("buttons pressed");

    // A group drawn as a list presses the same.
    await t.load("coverage-buttons", { binding: { controls: { buttonGroup: "list" } } });
    t.equal((await t.query('[data-container-id="actions"] ul > li button')).map((b) => b.text), ["Submit", "Download a copy"], "BTN-01: a group drawn as a list has one item per button");
    await t.page.getByRole("button", { name: "Download a copy" }).click();
    await t.drawn();
    t.equal(await actions(t), [{ componentId: "copy", action: "download" }], "BTN-01: a button in a list group reports its action");

    // A read-only or disabled form runs no action.
    for (const mode of ["readonly", "disabled"]) {
      await t.load("coverage-buttons", { mode });
      const drawn = await t.page.evaluate(() => window.fc.query("button[data-button-action]").length);
      t.equal(drawn, 3, `BTN-01: a ${mode} form still draws its buttons`);
      await t.page.getByRole("button", { name: "Submit" }).click({ force: true });
      await t.drawn();
      t.equal(await actions(t), [], `BTN-01: a press in a ${mode} form reports nothing`);
    }
  }
};

// ── SIG-01 ─────────────────────────────────────────────────────────────────────────────────

const signature = {
  id: "signature",
  title: "A signature component names who signs; a signed submit button asks for the signature",
  features: ["SIG-01"],
  async run(t) {
    await t.load("participants");
    const wrapper = await t.facts('[data-value-path="sig"]');
    t.check("SIG-01: the signature is drawn in its wrapper with its kind", wrapper !== null && wrapper.attributes["data-component-id"] === "sig" && "data-kind" in wrapper.attributes, wrapper?.attributes);
    const group = (await t.ax()).find((node) => node.role === "group" && node.name === "Signatures");
    t.check("SIG-01: it is a group named by its label", group !== undefined);
    const who = await t.query('[data-value-path="sig"] [data-participant]');
    t.equal(who.map((p) => p.text), ["signer"], "SIG-01: it lists the roles that must sign");
    t.equal(await t.query('[data-value-path="sig"] :is(input,select,textarea)'), [], "SIG-01: it takes no typed answer");
    await t.type("#name", "Ada");
    t.equal(await t.values(), { name: "Ada" }, "SIG-01: it holds no answer of its own");
    await t.shared("participants");

    await t.load("signing-button");
    const button = await t.facts("button[data-button-action]");
    t.equal(button?.attributes["data-button-signature"], "webauthn", "SIG-01: a signed submit button carries its signing provider");
    await t.page.getByRole("button", { name: "Submit" }).click();
    await t.drawn();
    t.equal(await actions(t), [{ componentId: "send", action: "submit", signature: "webauthn" }], "SIG-01: pressing it asks the host for a signed submit, once");
    await t.shared("signed submit");
  }
};

export const OTHER_SCENARIOS = [narrowTabs, quietPage, quietSubmit, tooltip, mediaLabels, unknown, buttons, signature];
