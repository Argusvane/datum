/**
 * Datum's signature component: the part of the form that says who must sign the submission.
 *
 * A signature component holds no answer. Its configuration lists the participants (an id and a
 * role each); signing happens when the form is submitted, by the host's signing provider, over
 * the canonical submission. The field draws its label, its description, the roles that must sign
 * and any error, in a named group. The roles are the author's data, drawn as given: the adapter
 * words nothing of its own.
 *
 * Capabilities: notices, the help mark and a hidden label are drawn; a running check is a word
 * folded into the hint by the renderer.
 */
import type { FieldAdapter, FieldState } from "../contract.js";
import { html, ifDefined, nothing } from "../lit.js";
import {
  assembleParts,
  describedByAttr,
  descriptionView,
  errorView,
  fieldClassNames,
  labelView,
  resolveFieldOptions,
  type DatumFieldOptionsInput
} from "./field-scaffold.js";
import { configurationOf } from "./leaf-kit.js";

/** One participant of a signature component. */
export interface SignatureParticipantView {
  id: string;
  role: string;
}

/** The participants a signature component names, read the way the sandbox reads them: an entry needs a string id and a string role. */
export function participantsOf(state: Pick<FieldState, "model">): SignatureParticipantView[] {
  const raw = configurationOf(state).participants;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") {
      return [];
    }
    const { id, role } = entry as { id?: unknown; role?: unknown };
    return typeof id === "string" && typeof role === "string" ? [{ id, role }] : [];
  });
}

/** Datum's signature component, drawn with the host's field options. */
export function createDatumSignatureAdapter(input?: DatumFieldOptionsInput): FieldAdapter {
  const options = resolveFieldOptions(input);
  return {
    kind: "field",
    name: "datum signature",
    capabilities: { notice: "drawn", workedOut: "drawn", tooltip: "drawn", hideLabel: "drawn", pending: "degraded" },
    template(state) {
      const participants = participantsOf(state);
      const described = options.controls.groupDescription === "none" ? undefined : describedByAttr(state.describedBy);
      return html`<div
        class=${fieldClassNames(state, "signature", "datum-form__field datum-form__signature")}
        role="group"
        aria-labelledby=${state.labelId}
        aria-describedby=${ifDefined(described)}
      >${assembleParts(
        {
          label: labelView(state, options),
          description: descriptionView(state),
          control:
            participants.length > 0
              ? html`<ul class="datum-form__signature-participants">${participants.map(
                  (participant) => html`<li class="datum-form__signature-participant" data-participant=${participant.id}>${participant.role}</li>`
                )}</ul>`
              : nothing,
          error: errorView(state, options)
        },
        options.fieldOrder,
        state
      )}</div>`;
    }
  };
}

/** Datum's signature component with the default options. */
export const datumSignature: FieldAdapter = createDatumSignatureAdapter();
