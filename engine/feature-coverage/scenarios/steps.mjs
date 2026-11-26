// STP-01, STP-02, STP-03: a steps container. The corpus `steps` form has two steps (About you, with
// a required Name; Where) and a field outside them. Continue and Back move between steps and take
// focus to the new step's heading; Continue with errors stays and shows them; the step entries go
// to a step the person may reach; the current step is marked and its panel alone shows.

const state = (t) =>
  t.page.evaluate(() => {
    const root = window.fc.hostElement().shadowRoot;
    return {
      shown: Array.from(root.querySelectorAll("[data-step-panel]")).filter((p) => !p.hidden).map((p) => p.getAttribute("data-step-panel")),
      current: Array.from(root.querySelectorAll("[aria-current=step]")).map((el) => el.querySelector("[data-step-select]")?.getAttribute("data-step-select")),
      statuses: Object.fromEntries(Array.from(root.querySelectorAll("[data-step-status]")).map((li) => [li.querySelector("[data-step-select]")?.getAttribute("data-step-select"), li.getAttribute("data-step-status")])),
      disabled: Array.from(root.querySelectorAll("[data-step-select][aria-disabled=true]")).map((b) => b.getAttribute("data-step-select")),
      progress: root.querySelector(".datum-form__step-progress")?.textContent.replace(/\s+/g, " ").trim()
    };
  });

export default {
  id: "steps",
  title: "Steps: Next and Back, the step entries, the current step marked and alone shown",
  features: ["STP-01", "STP-02", "STP-03"],
  async run(t) {
    await t.load("steps");
    let s = await state(t);
    t.equal(s.shown, ["step1"], "STP-03: only the first step's panel shows to start");
    t.equal(s.current, ["step1"], "STP-03: the first step is marked current");
    t.equal(s.statuses, { step1: "active", step2: "upcoming" }, "STP-03: the others are marked by their status");
    t.check("STP-03: the progress line says where the person is", /Step 1 of 2/.test(s.progress ?? ""), s.progress);
    const live = (await t.liveText()).some((r) => r.politeness === "polite" && /Step 1 of 2/.test(r.text));
    t.check("STP-03: and is a polite live region", live);
    const names = await t.page.evaluate(() => Array.from(window.fc.hostElement().shadowRoot.querySelectorAll("[data-step-panel]")).map((p) => p.getAttribute("aria-labelledby")));
    t.equal(names, ["step1__label", "step2__label"], "STP-03: each panel is named by its heading");
    await t.shared("first step");

    // Continue with the required name empty: stays, shows the error, focus on it.
    await t.click("button:has-text('Continue')");
    s = await state(t);
    t.equal(s.shown, ["step1"], "STP-01: Continue with errors stays on the step");
    await t.expectFocus({ region: "summary" }, "STP-01: and takes focus to the error summary");
    t.equal((await t.errors()).map((e) => e.path), ["name"], "STP-01: the error is the step's required name");

    // A step ahead cannot be entered while this one holds an error.
    await t.page.locator('[data-step-select="step2"]').click({ force: true });
    await t.drawn();
    s = await state(t);
    t.equal(s.shown, ["step1"], "STP-02: an entry for a step not yet reachable does not go there");
    t.equal(s.disabled, ["step2"], "STP-02: and is marked aria-disabled");

    // Continue with the name answered: step 2, its heading focused.
    await t.type({ path: "name" }, "Ada Lovelace");
    await t.key("Tab");
    await t.click("button:has-text('Continue')");
    s = await state(t);
    t.equal(s.shown, ["step2"], "STP-01: Continue went to the second step");
    t.equal(s.current, ["step2"], "STP-03: the second step is current");
    t.equal(s.statuses.step1, "completed", "STP-03: the first is marked complete");
    await t.expectFocus({ id: "step2__label", tag: "h2" }, "STP-01: focus is on the new step's heading");
    t.check("STP-03: the progress line follows", /Step 2 of 2/.test((await state(t)).progress ?? ""));
    await t.shared("second step");

    // Back.
    await t.click("button:has-text('Back')");
    s = await state(t);
    t.equal(s.shown, ["step1"], "STP-01: Back went to the first step");
    await t.expectFocus({ id: "step1__label", tag: "h2" }, "STP-01: focus is on its heading");
    t.equal((await t.values()).name, "Ada Lovelace", "STP-01: the answer stayed");

    // The entries: the completed step 2 can be entered from the first.
    await t.page.locator('[data-step-select="step2"]').click();
    await t.drawn();
    s = await state(t);
    t.equal(s.shown, ["step2"], "STP-02: an entry for a reachable step goes to it");
    await t.expectFocus({ id: "step2__label", tag: "h2" }, "STP-02: and focuses its heading");
    await t.page.locator('[data-step-select="step1"]').click();
    await t.drawn();
    t.equal((await state(t)).shown, ["step1"], "STP-02: an entry for an earlier step goes back to it");
    await t.shared("after the entries");
  }
};
