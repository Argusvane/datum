// SRC-01..SRC-03: a choice field whose data source has not answered is drawn as loading and then
// with its options, a source that fails marks the field and tells the host, and a host can hold
// the first draw for the sources. The `sources` form has two selects fed by the sources `cities`
// and `towns`, held at gates until the scenario lets them answer (recipe `sources`).
import { attributes, fcx, has, mountHeld, wrapperOf } from "./behaviour-kit.mjs";

const RECIPES = { recipes: ["sources"] };

/** The options a select offers, by value path. */
const optionsOf = (t, path) =>
  t.page.evaluate((p) => {
    const find = (root) => {
      const hit = root.querySelector(`[data-value-path="${p}"] select`);
      if (hit) return hit;
      for (const el of root.querySelectorAll("*")) {
        const inner = el.shadowRoot && find(el.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    const select = find(window.fc.hostElement().shadowRoot);
    return select ? [...select.options].filter((o) => o.value !== "").map((o) => [o.value, o.textContent.trim()]) : null;
  }, path);

const pause = (t, ms) => t.page.waitForTimeout(ms);

export const SOURCE_SCENARIOS = [
  {
    id: "source-loading",
    title: "A field whose source has not answered is drawn as loading, then with its options",
    features: ["SRC-01"],
    async run(t) {
      const fields = await mountHeld(t, "sources", { behaviours: RECIPES });
      t.equal(fields, 3, "SRC-01: the form is drawn from the answers known so far, with every field, while the sources are out");
      t.equal([await fcx(t, "waiting", "cities"), await fcx(t, "waiting", "towns")], [1, 1], "SRC-01: both sources are still out");
      const city = await wrapperOf(t, "city");
      t.check("SRC-01: the field is marked as loading and busy", city["data-source"] === "loading" && city["aria-busy"] === "true", city);
      t.equal(await optionsOf(t, "city"), [], "SRC-01: it offers no choice yet");
      const text = await t.composedText(`[data-value-path="city"] [data-source-note]`);
      t.equal(text, "Loading the choices…", "SRC-01: a status line under the field says so");
      const note = await t.query(`[data-value-path="city"] [data-source-note]`);
      t.check("SRC-01: the line is a polite status", note.length === 1 && note[0].role === "status", note);
      t.check("SRC-01: a field with no source is not marked", !has(await wrapperOf(t, "name"), "data-source") && !has(await wrapperOf(t, "name"), "aria-busy"), await wrapperOf(t, "name"));

      // The form is usable meanwhile: what the person types shows, the sources still out.
      await t.page.locator(`[data-value-path="name"] input`).click();
      await t.page.keyboard.type("Ada");
      await pause(t, 200);
      t.equal((await t.values()).name, "Ada", "SRC-01: an answer typed while the sources are out is kept");
      t.equal(await t.facts(`[data-value-path="name"] input`).then((f) => f.value), "Ada", "SRC-01: and shown");
      t.equal((await wrapperOf(t, "city"))["data-source"], "loading", "SRC-01: the field is still loading after that draw");

      // The sources answer: the options come, the marks go.
      // (kept open: every later change asks the sources again)
      await fcx(t, "release", "cities", true);
      await fcx(t, "release", "towns", true);
      await t.drawn();
      t.equal(await optionsOf(t, "city"), [["ott", "Ottawa"], ["tor", "Toronto"]], "SRC-01: the field offers its options once the source answers");
      t.equal(await optionsOf(t, "town"), [["kin", "Kingston"], ["bar", "Barrie"]], "SRC-01: the other field offers its own");
      const done = await wrapperOf(t, "city");
      t.check("SRC-01: the loading marks are gone", !has(done, "data-source") && !has(done, "aria-busy"), done);
      t.equal(await t.query(`[data-source-note]`), [], "SRC-01: and the status line");
      t.equal((await t.values()).name, "Ada", "SRC-01: the answer typed meanwhile is still there");
      await t.page.locator(`[data-value-path="city"] select`).selectOption("tor");
      await t.drawn();
      t.equal((await t.values()).city, "tor", "SRC-01: a choice from the loaded options is written");
      await t.shared("sources answered");
    }
  },
  {
    id: "source-failed",
    title: "A source that fails marks its field, says so under it, and is reported to the host once",
    features: ["SRC-02"],
    async run(t) {
      await mountHeld(t, "sources", { behaviours: RECIPES });
      // (kept so: every later change asks the sources again)
      await fcx(t, "release", "cities", true);
      await fcx(t, "fail", "towns", "boom", true);
      await t.drawn();
      const town = await wrapperOf(t, "town");
      t.equal(town["data-source"], "error", "SRC-02: the field whose source failed is marked");
      t.check("SRC-02: it is no longer busy", !has(town, "aria-busy"), town);
      t.equal(await t.composedText(`[data-value-path="town"] [data-source-error]`), "The choices could not be loaded.", "SRC-02: the reason is said under the field, in the person's words");
      const control = await t.facts(`[data-value-path="town"] select`);
      t.check("SRC-02: the control is described by that line", control.describedText.includes("The choices could not be loaded."), control);
      t.check("SRC-02: the raw reason is not shown to the person", !(await t.composedText()).includes("boom"));
      t.equal(await optionsOf(t, "town"), [], "SRC-02: it offers no choice");
      const city = await wrapperOf(t, "city");
      t.check("SRC-02: the other field is unaffected and has its options", !has(city, "data-source") && (await optionsOf(t, "city")).length === 2, city);

      const reported = () => t.events().then((events) => events.filter((e) => e.type === "datum-error"));
      t.equal((await reported()).map((e) => e.detail), [{ code: "data-source.failed", message: "boom", sourceId: "towns", componentId: "town" }], "SRC-02: the host hears it with its code, the source, the component and the reason");
      // Later draws do not report it again.
      await t.type({ path: "name" }, "Ada");
      await t.type({ path: "name" }, "m");
      t.equal((await reported()).length, 1, "SRC-02: the same failure is reported once, however often the form is drawn");
      await t.shared("source failed");
    }
  },
  {
    id: "source-wait-all",
    title: "dataSourceWait all holds the first draw for the sources",
    features: ["SRC-03"],
    async run(t) {
      const loaded = await t.fc("load", { fixture: "sources", behaviours: { ...RECIPES, dataSourceWait: "all", hold: true } });
      t.record.fixtures.push({ fixture: "sources", source: loaded.source, options: { dataSourceWait: "all" } });
      await pause(t, 600);
      t.equal(await t.query("form"), [], "SRC-03: nothing is drawn while a source is out");
      t.equal(await t.composedText(), "", "SRC-03: and no field shows as loading");
      // The element says it has no form yet in a line of its own (a status for the wait); the renderer alone says nothing.
      const line = await t.fc("loadingLine");
      t.check("SRC-03: the element words the wait; the renderer alone draws nothing", t.record.host === "element" ? line === "Loading form…" : line === null, line);
      t.equal([await fcx(t, "waiting", "cities"), await fcx(t, "waiting", "towns")], [1, 1], "SRC-03: the sources were asked");
      await fcx(t, "release", "cities");
      await pause(t, 300);
      t.equal(await t.query("form"), [], "SRC-03: one source answering is not enough");
      await fcx(t, "release", "towns");
      const fields = await fcx(t, "whenReady");
      await t.drawn();
      t.equal(fields, 3, "SRC-03: once they have all answered the form is drawn");
      t.equal(await t.fc("loadingLine"), null, "SRC-03: and the waiting line is gone");
      const city = await wrapperOf(t, "city");
      t.check("SRC-03: with its options at once, never drawn as loading", !has(city, "data-source") && (await optionsOf(t, "city")).length === 2, city);
      await t.shared("first draw after the sources");
    }
  }
];
