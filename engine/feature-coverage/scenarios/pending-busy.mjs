// BSY-01..BSY-03: the form says it is busy while it checks or submits, a field says its own async
// check is running, and the buttons hold still while an action is in flight. The `checks` form
// has an async check on `email` (recipe `async-email`, held at gate "email" until the scenario
// lets it go), a required `name` and a submit button.
import { attributes, formOf, fcx, has, until, wrapperOf } from "./behaviour-kit.mjs";

const RECIPES = { recipes: ["async-email"] };
const BUTTON = "[data-button-action]";

export const BUSY_SCENARIOS = [
  {
    id: "busy-form",
    title: "The form is marked busy while it validates or submits, and not once the work ends or fails",
    features: ["BSY-01"],
    async run(t) {
      await t.load("checks", { preset: { name: "Ada" }, behaviours: RECIPES });
      t.check("BSY-01: an idle form is not busy", !has(await formOf(t), "aria-busy"), await formOf(t));

      // A whole-form check that waits on the async stage.
      await fcx(t, "beginValidate");
      await until(t, async () => has(await formOf(t), "aria-busy"));
      t.equal((await formOf(t))["aria-busy"], "true", "BSY-01: the form is aria-busy while a check runs");
      await t.shared("validating");
      await fcx(t, "release", "email");
      const done = await fcx(t, "endValidate");
      t.check("BSY-01: the check ends without error", done.threw === undefined, done);
      await t.drawn();
      t.check("BSY-01: the form is not busy once the check ends", !has(await formOf(t), "aria-busy"), await formOf(t));

      // A submission: busy, with the line that says so, the fields out of reach.
      await t.click({ path: "name" });
      await fcx(t, "beginSubmit");
      await until(t, async () => has(await formOf(t), "aria-busy"));
      const submitting = await formOf(t);
      t.equal(submitting["aria-busy"], "true", "BSY-01: the form is aria-busy while it submits");
      t.check("BSY-01: it says it is submitting in a polite status", (await t.liveText()).some((r) => r.politeness === "polite" && r.text === "Submitting…"), await t.liveText());
      const inert = await t.page.evaluate(() => {
        const out = [];
        const walk = (root) => {
          for (const el of root.querySelectorAll("*")) {
            if (el.localName === "input") out.push(el.closest("[inert]") !== null);
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        };
        walk(window.fc.hostElement().shadowRoot);
        return out;
      });
      t.check("BSY-01: the fields take no input while it submits (inert)", inert.length > 0 && inert.every(Boolean), inert);
      await t.shared("submitting");
      await fcx(t, "release", "email");
      const sent = await fcx(t, "endSubmit");
      t.check("BSY-01: the submission is accepted", sent.value?.accepted === true, sent);
      await t.drawn();
      t.check("BSY-01: the form is not busy once the submission ends", !has(await formOf(t), "aria-busy"), await formOf(t));
      await t.expectFocus({ valuePath: "name", tag: "input" }, "BSY-01: focus is given back to where it was when the lock lifts");

      // A check that fails (the backend is down): busy ends with the failure.
      await t.load("checks", { preset: { name: "Ada" }, behaviours: RECIPES });
      await fcx(t, "beginValidate");
      await until(t, async () => has(await formOf(t), "aria-busy"));
      await fcx(t, "fail", "email", "backend down");
      const failed = await fcx(t, "endValidate");
      t.equal(failed.threw, "backend down", "BSY-01: the failing check reaches the caller");
      await t.drawn();
      t.check("BSY-01: a failed check (VALIDATION_FAILED) clears the form's busy state", !has(await formOf(t), "aria-busy"), await formOf(t));
      t.check("BSY-01: and the field's pending state", !has(await wrapperOf(t, "email"), "data-pending") && (await fcx(t, "pending")).length === 0, await wrapperOf(t, "email"));
      const types = (await fcx(t, "runtimeEvents")).map((e) => e.type);
      t.check("BSY-01: the runtime published VALIDATION_FAILED", types.includes("VALIDATION_FAILED"), types);
      await t.shared("check failed");
    }
  },
  {
    id: "field-pending",
    title: "A field whose async check is running is marked pending; a newer check owns the mark",
    features: ["BSY-02"],
    async run(t) {
      await t.load("checks", { behaviours: RECIPES });
      t.check("BSY-02: nothing is pending before a check", !has(await wrapperOf(t, "email"), "data-pending"), await wrapperOf(t, "email"));

      // One field's check: an error stands on the field, the person changes the answer and leaves it.
      await fcx(t, "setErrors", [{ code: "server.no", componentId: "email", path: "email", message: "The server said no." }]);
      await t.drawn();
      await t.type({ path: "email" }, "ada@example.com");
      await t.key("Tab");
      await until(t, async () => has(await wrapperOf(t, "email"), "data-pending"));
      const email = await wrapperOf(t, "email");
      t.check("BSY-02: the checked field is data-pending and aria-busy", has(email, "data-pending") && email["aria-busy"] === "true", email);
      const form = await formOf(t);
      t.check("BSY-02: one field's check does not make the form busy", !has(form, "aria-busy"), form);
      t.check("BSY-02: no other field is pending", !has(await wrapperOf(t, "name"), "data-pending") && !has(await wrapperOf(t, "nick"), "data-pending"));
      t.equal(await fcx(t, "pending"), ["email"], "BSY-02: the runtime reports the path pending");
      const control = await t.facts(`[data-value-path="email"] input`);
      t.check("BSY-02: the control is described as checking (a hint the binding folds in)", control.describedText.join(" ").includes("Checking this answer"), control.describedText);
      await t.shared("one field pending");

      // A newer check of the same field: the older one's result is dropped, the mark stays until the newer settles.
      await t.click({ path: "email" });
      await t.page.keyboard.type("x");
      await t.key("Tab");
      await until(t, async () => (await fcx(t, "called", "email")) === 2);
      await fcx(t, "releaseNext", "email");
      await t.page.waitForTimeout(100);
      await t.drawn();
      t.check("BSY-02: when the older check settles the newer one still owns the mark", has(await wrapperOf(t, "email"), "data-pending"), await wrapperOf(t, "email"));
      await fcx(t, "release", "email");
      await until(t, async () => !has(await wrapperOf(t, "email"), "data-pending"));
      const settled = await wrapperOf(t, "email");
      t.check("BSY-02: the mark goes when the newest check settles", !has(settled, "data-pending") && !has(settled, "aria-busy"), settled);
      t.equal(await fcx(t, "pending"), [], "BSY-02: nothing is pending");
      t.equal(await t.errors(), [], "BSY-02: the passing check leaves no error");

      // The check's verdict is drawn as any error is.
      await fcx(t, "release", "email", true);
      await fcx(t, "setErrors", [{ code: "server.no", componentId: "email", path: "email", message: "The server said no." }]);
      await t.drawn();
      await t.click({ path: "email" });
      await t.page.keyboard.press("ControlOrMeta+A");
      await t.page.keyboard.type("taken@example.com");
      await t.key("Tab");
      t.check("BSY-02: the check ran and found the address taken", await until(t, async () => (await t.errors()).some((e) => e.code === "email.taken")), await t.errors());
      const taken = await wrapperOf(t, "email");
      t.check("BSY-02: a check's blocking error marks the field invalid", has(taken, "data-invalid") && !has(taken, "data-pending"), taken);
      await t.shared("verdict drawn");

      // A whole-form check marks the declared paths pending too.
      await t.load("checks", { behaviours: RECIPES });
      await fcx(t, "beginValidate");
      await until(t, async () => has(await wrapperOf(t, "email"), "data-pending"));
      t.check("BSY-02: a whole-form check marks the field it judges pending as well", has(await wrapperOf(t, "email"), "data-pending"), await wrapperOf(t, "email"));
      await fcx(t, "release", "email");
      await fcx(t, "endValidate");
    }
  },
  {
    id: "busy-buttons",
    title: "Buttons are aria-disabled while the form submits, and act again afterwards",
    features: ["BSY-03"],
    async run(t) {
      await t.load("checks", { preset: { name: "Ada" }, behaviours: RECIPES });
      const pressed = async () => (await t.events()).filter((e) => e.type === "datum-form-action").length;
      t.check("BSY-03: an idle button is not aria-disabled", !has(await attributes(t, BUTTON), "aria-disabled"), await attributes(t, BUTTON));
      await t.click(BUTTON);
      t.equal(await pressed(), 1, "BSY-03: a press reports the action to the host");

      await fcx(t, "beginSubmit");
      await until(t, async () => has(await formOf(t), "aria-busy"));
      const busy = await attributes(t, BUTTON);
      t.check("BSY-03: while the form submits the button is aria-disabled, not disabled", busy["aria-disabled"] === "true" && !has(busy, "disabled"), busy);
      await t.page.locator(BUTTON).click({ force: true });
      await t.drawn();
      t.equal(await pressed(), 1, "BSY-03: a press while submitting reports nothing");
      await t.shared("buttons held");
      await fcx(t, "release", "email");
      await fcx(t, "endSubmit");
      await t.drawn();
      t.check("BSY-03: the button is released once the submission ends", !has(await attributes(t, BUTTON), "aria-disabled"), await attributes(t, BUTTON));
      await t.click(BUTTON);
      t.equal(await pressed(), 2, "BSY-03: and acts again");
    }
  }
];
