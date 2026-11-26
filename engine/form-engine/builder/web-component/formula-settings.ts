/**
 * The Form panel's Formulas section: what the form does with a rule whose formula cannot be
 * read. It is `root.configuration.formulaErrors` (`fail | warn`, default `fail`),
 * drafted on the form root like its other properties, so Save and Cancel govern it. A host
 * can still say otherwise at run time (the renderer's `formula-errors`, the submissions
 * settings); this is the form's own word.
 *
 * The words come from the builder's catalog (`settings.formulaErrors.*`), English where it has
 * none, so a catalog that lacks the keys, or a host that sets none, still draws the section.
 */
import { builderText, type BuilderTextKey, type BuilderTextOptions } from "../logic/builder-texts.js";

export type FormulaErrorsChoice = "fail" | "warn";

/** What the section is drawn from; see {@link formulaSettingsSectionHtml}. */
export interface FormulaSettingsView {
  /** The setting as the author sees it now: drafted, else committed, else `warn`. */
  value: FormulaErrorsChoice;
  /** The builder's words, for the locale; absent: English. */
  texts?: BuilderTextOptions | undefined;
}

export const FORMULA_ERRORS_CHOICES: readonly FormulaErrorsChoice[] = ["fail", "warn"];

/** The form's own default when nothing is set. */
export const DEFAULT_FORMULA_ERRORS: FormulaErrorsChoice = "fail";

/** The catalog's text for a key, else the builder's English. */
function say(key: string, texts: BuilderTextOptions | undefined): string {
  return builderText(key as BuilderTextKey, undefined, texts);
}

/** The setting as the Form panel shows it: a word it knows, else the default. */
export function formulaErrorsOf(value: unknown): FormulaErrorsChoice {
  return value === "warn" || value === "fail" ? value : DEFAULT_FORMULA_ERRORS;
}

/** The line under the select for a choice: what it does. */
export function formulaErrorsHint(choice: FormulaErrorsChoice, texts?: BuilderTextOptions): string {
  return say(`settings.formulaErrors.${choice}.hint`, texts);
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The section: a select of the two choices (`data-formula-errors`) and, under it, one line
 * saying what the chosen one does, which the select reads (`aria-describedby`).
 */
export function formulaSettingsSectionHtml(view: FormulaSettingsView, open: boolean): string {
  const texts = view.texts;
  const options = FORMULA_ERRORS_CHOICES.map(
    (choice) =>
      `<option value="${choice}"${choice === view.value ? " selected" : ""}>${escape(say(`settings.formulaErrors.${choice}`, texts))}</option>`
  ).join("");
  return `<details class="inspector-section" data-inspector-section="formulas"${open ? " open" : ""}>
      <summary>${escape(say("settings.formulaErrors.title", texts))}</summary>
      <div class="inspector-section-body">
        <label class="property-row"><strong>${escape(say("settings.formulaErrors.label", texts))}</strong>
          <select data-formula-errors aria-describedby="formula-errors-hint">${options}</select></label>
        <p class="options-note" id="formula-errors-hint" data-formula-errors-hint>${escape(formulaErrorsHint(view.value, texts))}</p>
      </div>
    </details>`;
}
