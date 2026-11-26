// VAL-04, VAL-05, VAL-06, VAL-08: when leaving a field checks it. A field is not checked on its
// first blur, one already showing an error is checked again when its answer is committed, a typed
// answer is interim until the field is left, and a server's error stands until the answer changes.
// The `checks` form has a required `name`; `checks-submit` is the same form with `validateOn:
// "submit"`.
import { fcx, has, until, wrapperOf } from "./behaviour-kit.mjs";

const codes = async (t) => (await t.errors()).map((e) => `${e.path ?? e.componentId}:${e.code}`);

/** Events of the runtime about `name`'s answer since the last take. */
const answerEvents = async (t) => (await fcx(t, "runtimeEvents", ["COMPONENT_CHANGED", "COMPONENT_COMMITTED"])).map((e) => (e.type === "COMPONENT_CHANGED" ? `changed${e.data?.interim ? " (interim)" : ""}` : "committed"));

export const VALIDATE_ON_SCENARIOS = [
  {
    id: "validate-on-commit",
    title: "A field is checked when left only once it shows an error or a submit was attempted",
    features: ["VAL-04", "VAL-05"],
    async run(t) {
      await t.load("checks");
      // VAL-05: the first blur of a required field left empty.
      await t.click({ path: "name" });
      await t.key("Tab");
      t.equal(await codes(t), [], "VAL-05: leaving a required field empty does not check it the first time");
      t.check("VAL-05: and the field shows no error", !has(await wrapperOf(t, "name"), "data-invalid"), await wrapperOf(t, "name"));
      await t.type({ path: "name" }, "Ada");
      await t.key("Tab");
      t.equal(await codes(t), [], "VAL-05: nor is a filled field");

      // Empty the field and ask for the check: the error shows.
      await t.click({ path: "name" });
      await t.page.keyboard.press("ControlOrMeta+A");
      await t.key("Backspace");
      await t.validate();
      t.equal(await codes(t), ["name:required"], "VAL-04: the whole-form check shows the field's error");

      // VAL-04: leaving the field with the error unfixed checks it again (the error stays) ...
      await t.click({ path: "name" });
      await t.key("Tab");
      t.equal(await codes(t), ["name:required"], "VAL-04: the field still in error when it is left is still in error");
      // ... and committing an answer that fixes it clears the error, without another whole-form check.
      await t.type({ path: "name" }, "Ada");
      await t.key("Tab");
      t.equal(await codes(t), [], "VAL-04: committing a fixing answer clears the error");
      t.check("VAL-04: and the field is no longer marked invalid", !has(await wrapperOf(t, "name"), "data-invalid"), await wrapperOf(t, "name"));
      t.equal(await t.query("[data-datum-summary]"), [], "VAL-04: nor listed in the summary");
      const events = (await fcx(t, "runtimeEvents")).filter((e) => e.type === "VALIDATION_STARTED").map((e) => e.data);
      t.check("VAL-04: the commit ran a check of that one field (scoped to its path)", events.some((d) => Array.isArray(d?.paths) && d.paths[0] === "name"), events);

      // The error does not come back by itself: nothing shows an error now, so leaving the emptied field checks nothing ...
      await t.click({ path: "name" });
      await t.page.keyboard.press("ControlOrMeta+A");
      await t.key("Backspace");
      await t.key("Tab");
      t.equal(await codes(t), [], "VAL-04: a field that shows no error, before any submit attempt, is not checked when emptied and left");

      // ... until a submit was attempted: then every commit checks.
      await fcx(t, "beginSubmit");
      const attempt = await fcx(t, "endSubmit");
      t.check("VAL-04: the submit attempt is refused (the required name is empty)", attempt.value?.accepted === false || (attempt.value?.errors ?? []).length > 0, attempt);
      await t.type({ path: "name" }, "x");
      await t.page.keyboard.press("Backspace");
      await t.key("Tab");
      t.equal(await codes(t), ["name:required"], "VAL-04: after a submit attempt a field is checked on every commit, so the emptied field shows its error");
      await t.shared("checked on commit");

      // validateOn "submit": no commit checks anything.
      await t.load("checks-submit");
      await t.validate();
      t.equal(await codes(t), ["name:required"], "VAL-04: (validateOn submit) the whole-form check shows the error");
      await t.type({ path: "name" }, "Ada");
      await t.key("Tab");
      t.equal(await codes(t), ["name:required"], "VAL-04: (validateOn submit) committing a fixing answer checks nothing: the error stays until the next whole-form check");
      await t.validate();
      t.equal(await codes(t), [], "VAL-04: (validateOn submit) the next whole-form check clears it");
    }
  },
  {
    id: "interim-commit",
    title: "A typed answer is interim while typing and committed once the field is left",
    features: ["VAL-06"],
    async run(t) {
      await t.load("checks");
      await answerEvents(t);
      await t.click({ path: "name" });
      await t.page.keyboard.type("Ada");
      await t.drawn();
      const typing = await answerEvents(t);
      t.check("VAL-06: each keystroke writes the answer as interim", typing.length >= 3 && typing.every((e) => e === "changed (interim)"), typing);
      t.equal((await t.values()).name, "Ada", "VAL-06: the runtime holds what has been typed");
      t.check("VAL-06: nothing is committed while the person is still in the field", !typing.includes("committed"), typing);
      await t.key("Tab");
      t.equal(await answerEvents(t), ["committed"], "VAL-06: leaving the field commits the answer, once");
      await t.click({ path: "name" });
      await t.key("Tab");
      t.equal(await answerEvents(t), [], "VAL-06: leaving a field nothing was typed in reports no commit");
    }
  },
  {
    id: "server-error-stands",
    title: "A server's error stands until the answer changes",
    features: ["VAL-08"],
    async run(t) {
      await t.load("checks", { preset: { name: "Ada" } });
      await fcx(t, "setErrors", [{ code: "server.taken", componentId: "name", path: "name", message: "That name is taken." }]);
      await t.drawn();
      const shown = await t.facts(`[data-value-path="name"] input`);
      t.check("VAL-08: the server's error is drawn on the field, which is invalid and described by it", shown.attributes["aria-invalid"] === "true" && shown.describedText.includes("That name is taken."), shown);
      await t.shared("server error shown");

      // Left again unchanged: the error stands, however often.
      await t.click({ path: "name" });
      await t.key("Tab");
      await t.click({ path: "name" });
      await t.key("Tab");
      t.equal(await codes(t), ["name:server.taken"], "VAL-08: leaving the field with the same answer keeps the server's error");
      t.check("VAL-08: it is still drawn", has(await wrapperOf(t, "name"), "data-invalid"), await wrapperOf(t, "name"));

      // An answer that changes: the error goes at the commit.
      await t.click({ path: "name" });
      await t.page.keyboard.type("m");
      t.check("VAL-08: while the new answer is being typed the error is still shown", (await codes(t)).includes("name:server.taken"), await codes(t));
      await t.key("Tab");
      await until(t, async () => !(await codes(t)).includes("name:server.taken"));
      t.equal(await codes(t), [], "VAL-08: the first commit that changes the answer takes the server's error back");
      t.check("VAL-08: and the field is clear", !has(await wrapperOf(t, "name"), "data-invalid"), await wrapperOf(t, "name"));
      await t.shared("server error taken back");
    }
  }
];
