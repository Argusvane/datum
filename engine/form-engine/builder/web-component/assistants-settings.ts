/**
 * The Form panel's Browser assistants section: whether the form's author
 * allows an assistant in the person's browser to fill this form for them. It is
 * `root.configuration.agentTools` (`allowed | off`; absent is "not provided"), drafted on the
 * form root like the other root properties, so Save, Cancel and Undo govern it.
 *
 * Three choices, not two: "Not set" is its own word because a site that follows the form's
 * setting treats an absent value as "no", where "Allowed" is a yes and "Not on this form" the
 * author's refusal. Choosing Not set drafts `""`, which the controller removes (it is in
 * `UNSET_WHEN_EMPTY`), so the key goes even over a committed `"off"`. Any stored word the
 * reader does not know (`"maybe"`, `true`) shows as Not set, as it reads (no finding, no warning).
 *
 * The section is drawn on the root whatever the builder's `features` (no inspector part gates
 * it), and a host can lock it with `managed-settings="agentTools"`: the section then draws the
 * "managed by the site" row the inspector's own managed fields draw, with no select. The words
 * come from the builder's catalog (`settings.agentTools.*`), English where it has none.
 */
import { AGENT_TOOLS_SETTINGS, readAgentToolsSetting, type AgentToolsSetting } from "../../core/schema/agent-tools-setting.js";
import { builderText, type BuilderTextKey, type BuilderTextOptions } from "../logic/builder-texts.js";

export const ASSISTANTS_CHOICES = ["unset", "allowed", "off"] as const;
export type AssistantsChoice = (typeof ASSISTANTS_CHOICES)[number];

/** What the section is drawn from; see {@link assistantsSettingsSectionHtml}. */
export interface AssistantsSettingsView {
  /** The setting as the author sees it now: drafted, else committed, else `unset`. */
  value: AssistantsChoice;
  /** The host lists `agentTools` in `managed-settings`: the row is a note, not a select. */
  managed: boolean;
  /** The builder's words, for the locale; absent: English. */
  texts?: BuilderTextOptions | undefined;
}

/** The catalog's text for a key, else the builder's English. */
function say(key: string, texts: BuilderTextOptions | undefined): string {
  return builderText(key as BuilderTextKey, undefined, texts);
}

/** The stored value as the row shows it: "allowed" / "off", anything else "unset" (readAgentToolsSetting). */
export function assistantsChoiceOf(value: unknown): AssistantsChoice {
  return readAgentToolsSetting({ agentTools: value }) ?? "unset";
}

/** The value the row drafts for a choice: "" for unset (removed through UNSET_WHEN_EMPTY), else the word. */
export function assistantsDraftValue(choice: AssistantsChoice): "" | AgentToolsSetting {
  return choice === "unset" ? "" : choice;
}

/** The line under the select for a choice: what it means for sites that follow the form. */
export function assistantsHint(choice: AssistantsChoice, texts?: BuilderTextOptions): string {
  return say(`settings.agentTools.${choice}.hint`, texts);
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The section: a select of the three choices (`data-agent-tools`) and, under it, one line
 * saying what the chosen one means (`data-agent-tools-hint`) and the standing note about
 * sites; the select reads both (`aria-describedby`). Managed: the label and the managed note
 * alone, so there is nothing to draft.
 */
export function assistantsSettingsSectionHtml(view: AssistantsSettingsView, open: boolean): string {
  const texts = view.texts;
  const head = `<details class="inspector-section" data-inspector-section="assistants"${open ? " open" : ""}>
      <summary>${escape(say("settings.agentTools.title", texts))}</summary>
      <div class="inspector-section-body">`;
  if (view.managed) {
    return `${head}
        <div class="field-row" data-managed-setting="agentTools"><span class="field-label">${escape(say("settings.agentTools.label", texts))}</span><p class="field-note" data-severity="info">${escape(say("inspector.managedBySite", texts))}</p></div>
      </div>
    </details>`;
  }
  const options = [
    `<option value=""${view.value === "unset" ? " selected" : ""}>${escape(say("settings.agentTools.unset", texts))}</option>`,
    ...AGENT_TOOLS_SETTINGS.map(
      (choice) => `<option value="${choice}"${choice === view.value ? " selected" : ""}>${escape(say(`settings.agentTools.${choice}`, texts))}</option>`
    )
  ].join("");
  return `${head}
        <label class="property-row"><strong>${escape(say("settings.agentTools.label", texts))}</strong>
          <select data-agent-tools aria-describedby="agent-tools-hint agent-tools-note">${options}</select></label>
        <p class="options-note" id="agent-tools-hint" data-agent-tools-hint>${escape(assistantsHint(view.value, texts))}</p>
        <p class="options-note" id="agent-tools-note">${escape(say("settings.agentTools.hint", texts))}</p>
      </div>
    </details>`;
}
