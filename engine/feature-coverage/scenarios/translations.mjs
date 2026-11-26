// LOC-02: translations reach labels, hints, options and the renderer's own words. The `translated`
// form is authored in English with French for its labels, hint, options and one message, and for
// the engine's words (the `texts` kind: the count, the summary heading, the notice words, the file
// words, a validation message). A word nobody translated stays the engine's English.
import { fcx, has, wrapperOf } from "./behaviour-kit.mjs";

const RECEIPT = { storage: "base64", name: "recu.pdf", type: "application/pdf", size: 4, data: "aGVsbA==" };
const wait = (t, ms) => t.page.waitForTimeout(ms);

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
    return [...find(window.fc.hostElement().shadowRoot).options].filter((o) => o.value !== "").map((o) => o.textContent.trim());
  }, path);

const labelOf = (t, path) => t.composedText(`[data-value-path="${path}"] label`);

export const TRANSLATION_SCENARIOS = [
  {
    id: "translated-words",
    title: "Translations reach labels, hints, options and the renderer's own words, and switching back re-words them",
    features: ["LOC-02"],
    async run(t) {
      await t.load("translated", { locale: "fr", preset: { nick: "ab", receipt: RECEIPT }, behaviours: { recipes: ["advice"] } });

      // What the form authors.
      const name = await labelOf(t, "name");
      t.check("LOC-02: a label is French", name.startsWith("Nom") && !name.includes("Name"), name);
      t.check("LOC-02: the other labels are French", (await labelOf(t, "nick")).startsWith("Surnom") && (await labelOf(t, "colour")).startsWith("Couleur") && (await labelOf(t, "receipt")).startsWith("Reçu"));
      t.check("LOC-02: the hint is French", (await t.composedText(`[data-value-path="name"]`)).includes("Comme sur votre carte"), await t.composedText(`[data-value-path="name"]`));
      t.equal(await optionsOf(t, "colour"), ["Rouge", "Bleu"], "LOC-02: the options are French");
      t.equal((await t.facts("form")).attributes.lang, "fr", "LOC-02: the form carries the locale");

      // What the renderer says in its own voice.
      t.equal(await t.composedText(`[data-count-for="name"]`), "Vous pouvez saisir jusqu'à 20 caractères 20 caractères restants", "LOC-02: the count and its limit sentence are French");
      t.check("LOC-02: the file's Remove is French", (await t.composedText(`[data-value-path="receipt"] li`)).includes("Retirer"), await t.composedText(`[data-value-path="receipt"] li`));
      const remove = await t.facts(`[data-value-path="receipt"] .datum-form__file-remove`);
      t.equal(remove.attributes["aria-label"], "Remove recu.pdf", "LOC-02: a word nobody translated (the Remove button's name) stays the engine's English");
      t.check("LOC-02: the select's empty option, also untranslated, stays English", (await t.composedText(`[data-value-path="colour"]`)).includes("Select…"), await t.composedText(`[data-value-path="colour"]`));

      // Notices and errors.
      const notice = await t.composedText(`[data-value-path="nick"] [data-notices]`);
      await t.validate();
      t.check("LOC-02: the warning's severity word is French", (await t.composedText(`[data-value-path="nick"] [data-notices]`)).startsWith("Attention :") && notice === "", { before: notice, after: await t.composedText(`[data-value-path="nick"] [data-notices]`) });
      const summary = await t.composedText("[data-datum-summary]");
      t.check("LOC-02: the summary heading is French with the count", summary.startsWith("Il y a 2 problèmes"), summary);
      t.check("LOC-02: a message the form translated is French", summary.includes("Nom: Entrez votre nom."), summary);
      t.check("LOC-02: the engine's own message is French through the texts kind", summary.includes("Couleur: Ce champ est obligatoire."), summary);
      const control = await t.facts(`[data-value-path="colour"] select`);
      t.check("LOC-02: and so is the message under the field", control.describedText.includes("Ce champ est obligatoire."), control.describedText);
      await t.shared("french, validated");

      // A spoken word: the count, said once typing pauses.
      await t.type({ path: "name" }, "abc");
      await t.announcements();
      await wait(t, 1400);
      t.equal((await t.announcements()).map((a) => a.text), ["17 caractères restants"], "LOC-02: the announced count is French");

      // A removal is said in French (the name is left first: its error going shifts the page under the pointer).
      await t.key("Tab");
      await t.page.locator(`[data-value-path="receipt"] .datum-form__file-remove`).click();
      await t.drawn();
      await wait(t, 150);
      t.check("LOC-02: the removal is announced in French", (await t.announcements()).some((a) => a.text === "recu.pdf retiré"));

      // Back to the default language: everything is re-worded.
      await fcx(t, "setLocale", "en");
      await t.drawn();
      // (the count's live region keeps what it last said: it is not part of the form's words)
      const english = [await t.composedText("form > .datum-live-container"), await t.composedText("[data-datum-summary]")].join(" ");
      t.check("LOC-02: switching to English re-words the labels", english.includes("Name") && english.includes("Nickname") && english.includes("Colour") && !english.includes("Nom ") && !english.includes("Surnom"), english);
      t.check("LOC-02: the options and the hint", english.includes("Red") && english.includes("As on your card") && !english.includes("Rouge") && !english.includes("Comme sur"), english);
      t.check("LOC-02: the engine's words follow (summary heading, count, notice word)", english.includes("1 error") && english.includes("17 characters left") && english.includes("Warning:") && !english.includes("restants") && !english.includes("Attention"), english);
      t.check("LOC-02: the message is the engine's English again", (await t.composedText("[data-datum-summary]")).includes("Colour: This field is required"), await t.composedText("[data-datum-summary]"));
      t.equal((await t.facts("form")).attributes.lang, "en", "LOC-02: and the form's lang follows");
      t.check("LOC-02: the form is still a form: fields keep their answers", (await t.values()).name === "abc", await t.values());
      t.check("LOC-02: no wrapper lost its hooks to the switch", has(await wrapperOf(t, "name"), "data-component-id"));
      await t.shared("back in english");
    }
  }
];
