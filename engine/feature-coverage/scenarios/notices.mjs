// NOT-01, SUM-06, NOT-02: warnings and info on a field are notices (described by the field, never
// errors, never in the summary, never announced as alerts), and the host's receipt for the whole
// form is drawn, announced once and takes focus. The `checks` form with recipe `advice` raises a
// warning on `nick` (an answer under four characters) and an info on `tip` (any answer).
import { attributes, fcx, has, until, wrapperOf } from "./behaviour-kit.mjs";

const RECIPES = { recipes: ["advice"] };

const noticeOf = (t, path) =>
  t.page.evaluate((p) => {
    const find = (root) => {
      const hit = root.querySelector(`[data-value-path="${p}"]`);
      if (hit) return hit;
      for (const el of root.querySelectorAll("*")) {
        const inner = el.shadowRoot && find(el.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    const wrapper = find(window.fc.hostElement().shadowRoot);
    const block = wrapper?.querySelector("[data-notices]");
    const control = wrapper?.querySelector("input,select,textarea");
    return {
      present: block !== null && block !== undefined,
      id: block?.id ?? null,
      lines: [...(block?.querySelectorAll("[data-severity]") ?? [])].map((line) => ({ severity: line.getAttribute("data-severity"), text: line.textContent.replace(/\s+/g, " ").trim() })),
      announces: block ? block.matches("[role],[aria-live]") || block.querySelector("[role],[aria-live]") !== null : false,
      describedBy: (control?.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean),
      ariaInvalid: control?.getAttribute("aria-invalid") ?? null,
      errorElement: wrapper?.querySelector(`[id$="__error"]`) !== null
    };
  }, path);

export const NOTICE_SCENARIOS = [
  {
    id: "field-notices",
    title: "Warnings and info are drawn as notices described by their field, never as errors or in the summary",
    features: ["NOT-01", "SUM-06"],
    async run(t) {
      // Only warnings and info: nothing blocks.
      await t.load("checks", { preset: { name: "Ada", nick: "ab", tip: "x" }, behaviours: RECIPES });
      const checked = await t.validate();
      t.equal((await t.errors()).map((e) => [e.code, e.severity ?? "error"]), [["nick.short", "warning"], ["tip.saved", "info"]], "NOT-01: the runtime holds the warning and the info");
      const nick = await noticeOf(t, "nick");
      t.check("NOT-01: the warning is drawn as a notice with the field's notice id", nick.present && nick.id === "nick__notice", nick);
      t.equal(nick.lines, [{ severity: "warning", text: "Warning: That nickname is short." }], "NOT-01: led by the severity word, with the message");
      t.check("NOT-01: the control is described by the notice", nick.describedBy.includes("nick__notice"), nick.describedBy);
      t.check("NOT-01: the notice resolves in the same root and comes after the hint", nick.describedBy.indexOf("nick__description") < nick.describedBy.indexOf("nick__notice"), nick.describedBy);
      t.check("NOT-01: the control is not aria-invalid and no error element is drawn", nick.ariaInvalid === "false" && !nick.errorElement, nick);
      const wrapper = await wrapperOf(t, "nick");
      t.check("NOT-01: the wrapper is not marked invalid", !has(wrapper, "data-invalid"), wrapper);
      t.check("NOT-01: the notice is not a live region", !nick.announces, nick);
      const tip = await noticeOf(t, "tip");
      t.equal(tip.lines, [{ severity: "info", text: "Information: Tips are kept for a week." }], "NOT-01: info is drawn the same way with its own word");
      t.check("NOT-01: and also described by the field", tip.describedBy.includes("tip__notice") && tip.ariaInvalid === "false", tip);

      // SUM-06: nothing blocks, so there is no summary and nothing to take focus.
      t.equal(await t.query("[data-datum-summary]"), [], "SUM-06: warnings and info alone draw no summary");
      t.equal(checked.focused, false, "SUM-06: and there is no error for focus to go to");
      t.equal(await t.announcements(), [], "NOT-01: nothing was announced for the notices");
      await t.shared("notices only");

      // They do not stop a submission.
      await fcx(t, "beginSubmit");
      const sent = await fcx(t, "endSubmit");
      t.check("NOT-01: warnings and info do not stop the submission", sent.value?.accepted === true, sent);

      // With a blocking error beside them: the summary lists that error alone.
      await t.load("checks", { preset: { nick: "ab", tip: "x" }, behaviours: RECIPES });
      await t.validate();
      const summary = await t.composedText("[data-datum-summary]");
      t.check("SUM-06: the summary lists the blocking error", summary.includes("Full name") && summary.includes("This field is required"), summary);
      t.check("SUM-06: and none of the notices", !summary.includes("nickname") && !summary.includes("Tips") && !summary.includes("Warning"), summary);
      const links = await t.page.evaluate(() => window.fc.query("[data-datum-summary] a").length);
      t.equal(links, 1, "SUM-06: one entry for one blocking error");
      const alerts = (await t.liveText()).filter((r) => r.politeness === "alert").map((r) => r.text);
      t.check("SUM-06: no alert carries a notice", alerts.every((text) => !text.includes("nickname") && !text.includes("Tips")), alerts);
      const nickAgain = await noticeOf(t, "nick");
      t.check("NOT-01: the notice is still a notice beside a blocking error elsewhere", nickAgain.present && nickAgain.ariaInvalid === "false", nickAgain);
      await t.shared("notices beside an error");

      // Changing the answer lifts the warning once the field is left (a notice counts as shown: the check is due).
      await t.type({ path: "nick" }, "abcdef");
      await t.key("Tab");
      await until(t, async () => !(await noticeOf(t, "nick")).present);
      t.equal((await noticeOf(t, "nick")).present, false, "NOT-01: a longer answer lifts the warning when the field is left");
      t.equal((await noticeOf(t, "tip")).present, true, "NOT-01: the other field's notice is untouched");
      await t.shared("notice lifted");
    }
  },
  {
    id: "form-notice",
    title: "The host's receipt is drawn, announced once, and takes focus",
    features: ["NOT-02"],
    async run(t) {
      await t.load("checks");
      t.equal(await t.query(".datum-form__notice"), [], "NOT-02: no receipt before the host sets one");
      await fcx(t, "setNotice", { kind: "success", title: "Received", message: "Thank you", details: [{ label: "Number", value: "GC-1" }] });
      const live = (await t.liveText()).filter((r) => r.text !== "");
      const receipt = live.find((r) => r.text.includes("Received"));
      t.check("NOT-02: the receipt is drawn in a polite status region", receipt?.politeness === "status" && receipt.text === "Success: Received Thank you Number GC-1", live);
      t.check("NOT-02: its title, message and details are all there", ["Received", "Thank you", "Number", "GC-1"].every((word) => receipt?.text.includes(word)), receipt);
      t.equal(await fcx(t, "focusNotice"), true, "NOT-02: the host can take the person to it");
      const active = await t.active();
      t.check("NOT-02: focus is on the receipt", active?.role === "status" && (active.text ?? "").startsWith("Success: Received"), active);
      await t.shared("receipt");

      // A failure is an alert on the draw that first shows it, a status on later draws; two ends, one reading.
      await fcx(t, "setNotice", { kind: "error", title: "Not sent", message: "Try again", placement: ["top", "bottom"] });
      await t.announcements();
      const first = (await t.liveText()).filter((r) => r.text.includes("Not sent"));
      t.check("NOT-02: a failure notice is an alert on the draw that first shows it", first.length === 1 && first[0].politeness === "alert", first);
      await t.fc("setValue", "name", "x");
      await t.drawn();
      const later = (await t.liveText()).filter((r) => r.text.includes("Not sent"));
      t.check("NOT-02: a later draw of it is a status (it is not announced again)", later.length === 1 && later[0].politeness === "status", later);
      t.check("NOT-02: its copy at the other end is hidden from assistive technology", (await t.query(`[aria-hidden="true"] , [aria-hidden="true"] *`)).some((d) => (d.text ?? "").includes("Not sent")), await t.query(`[aria-hidden="true"]`));
      t.equal(await fcx(t, "focusNotice"), true, "NOT-02: focus goes to the readable copy");
      t.check("NOT-02: and lands in the status region", (await t.active())?.role === "status", await t.active());
      await t.shared("failure receipt");

      await fcx(t, "setNotice", undefined);
      t.equal((await t.liveText()).filter((r) => r.text.includes("Not sent")), [], "NOT-02: the receipt goes when the host clears it");
      t.equal(await fcx(t, "focusNotice"), false, "NOT-02: and there is nothing to focus");
    }
  }
];
