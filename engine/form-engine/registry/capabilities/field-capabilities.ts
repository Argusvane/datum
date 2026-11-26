import type {
  CapabilityDefinition,
  PropertyEditorContribution,
  PropertyEditorField
} from "../../core/schema/contracts.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { pdfRenditionCatalogFor } from "../../core/schema/pdf-renditions.js";

/**
 * The properties a field can offer, each expressed as a {@link CapabilityDefinition}.
 *
 * A component type declares which of these it has, and the inspector composes its editor from
 * them (`composePropertyEditor`). That is what a capability is for: a `checkbox` has no
 * placeholder and a `button` has no `required`, and saying so on the type is better than every
 * editor re-listing the same fields and drifting apart.
 *
 * Each is only an *editor* contribution plus a configuration key — the runtime already reads
 * these keys (`disabled` and `hidden` feed semantic state; the markup reads `placeholder`,
 * `tooltip` and `hideLabel`), so a capability adds the way to author a property rather than
 * the property itself.
 *
 * These are *editor* capabilities. What a drawing surface can put on screen (notices, pending,
 * the character count, …) is a separate set, in `drawing-capabilities.ts`.
 */

/**
 * Writes the capability's configuration onto a component. Every field capability is a plain
 * configuration key, so this is a merge — there is no derived structure to build.
 */
function mergeConfiguration(component: ComponentNode, configuration: unknown): ComponentNode {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return component;
  }
  const base =
    component.configuration && typeof component.configuration === "object" && !Array.isArray(component.configuration)
      ? (component.configuration as Record<string, unknown>)
      : {};
  return {
    ...component,
    configuration: { ...base, ...(configuration as Record<string, unknown>) }
  };
}

function fieldsCapability(id: string, fields: PropertyEditorField[]): CapabilityDefinition {
  return {
    id,
    version: "1.0.0",
    configureEditor: (): PropertyEditorContribution => ({ fields }),
    apply: mergeConfiguration
  };
}

function fieldCapability(id: string, field: PropertyEditorField): CapabilityDefinition {
  return fieldsCapability(id, [field]);
}

export const labelCapability = fieldCapability("label", {
  id: "label",
  type: "localized-text",
  propertyPath: "label",
  label: "Label"
});

/**
 * Where the answer is stored: the field's own name in the submitted data, apart
 * from its id. Blank, the id is the name — the form as it has always been. The id stays what
 * rules, errors and the page address; only the stored name moves.
 */
export const dataKeyCapability = fieldCapability("dataKey", {
  id: "dataKey",
  type: "text",
  propertyPath: "dataKey",
  label: "Data key",
  description:
    "The name this answer is stored under in the submitted data. Blank uses the ID. Two answers in one object cannot share a name. Letters, digits, _ and - only."
});

/**
 * What happens to the answer while a rule (or `hidden`) hides the component
 * (`configuration.hiddenValueBehavior`): left out of the submission (the default, so no key is
 * written for it), kept and sent, or sent empty. The answer stays in the form either way, so
 * showing the field again shows what was typed, and a draft keeps it. One field, filed under
 * Data beside the Data key: it decides what the submitted data holds. The Logic workspace's
 * show and hide rules write the same key.
 */
export const HIDDEN_VALUE_FIELD: PropertyEditorField = {
  id: "hiddenValueBehavior",
  type: "select",
  propertyPath: "hiddenValueBehavior",
  label: "When hidden",
  description:
    "What is sent for this answer while the field is hidden. The answer stays on the form, so showing the field again shows it.",
  defaultValue: "exclude-from-submission",
  choices: [
    { value: "exclude-from-submission", label: "Leave the answer out (default)" },
    { value: "retain", label: "Keep and send the answer" },
    { value: "clear", label: "Send it empty" }
  ]
};

export const hiddenValueCapability = fieldCapability("hiddenValue", HIDDEN_VALUE_FIELD);

export const descriptionCapability = fieldCapability("description", {
  id: "description",
  type: "localized-text",
  propertyPath: "description",
  label: "Description"
});

/**
 * Short help shown on hover / focus. A translatable string (the `localized-text` field type)
 * like every other user-facing text — a tooltip is prose, and prose gets translated, in
 * the Languages workspace.
 */
export const tooltipCapability = fieldCapability("tooltip", {
  id: "tooltip",
  type: "localized-text",
  propertyPath: "tooltip",
  label: "Tooltip",
  description: "Shown on hover, and as the control's accessible description."
});

/** Ghost text inside an empty control. Only meaningful where there is a box to put it in. */
export const placeholderCapability = fieldCapability("placeholder", {
  id: "placeholder",
  type: "localized-text",
  propertyPath: "placeholder",
  label: "Placeholder"
});

/**
 * How many lines of a multi-line control are visible before it scrolls.
 *
 * A starting height, not a limit: it says how much room the answer is expected to need, which
 * is a real authoring decision (a one-line "job title" box invites a different answer from an
 * eight-line "describe the incident" one). Read-only rendering ignores it and shows the whole
 * value — see the `textarea[readonly]` rules in `render/live/datum/css.ts`.
 */
export const rowsCapability = fieldCapability("rows", {
  id: "rows",
  type: "number",
  propertyPath: "rows",
  label: "Rows",
  description: "Visible lines before the box scrolls. Defaults to 4."
});

export const requiredCapability = fieldCapability("required", {
  id: "required",
  type: "boolean",
  propertyPath: "required",
  label: "Required"
});

/**
 * Hides the label visually while keeping it as the control's accessible name — which is why
 * this is not the same as clearing the label, and why the label stays required.
 */
export const hideLabelCapability = fieldCapability("hideLabel", {
  id: "hideLabel",
  type: "boolean",
  propertyPath: "hideLabel",
  label: "Hide label",
  description: "Still announced by screen readers."
});

/**
 * Statically disables the control. The rules system's `enabledWhen` does the same thing
 * conditionally; this is the always-on case, and the runtime already folds it into effective
 * state (`baseSemanticState`).
 */
export const disabledCapability = fieldCapability("disabled", {
  id: "disabled",
  type: "boolean",
  propertyPath: "disabled",
  label: "Disabled",
  description: "Always disabled. Use a rule's “Enabled when” for a conditional one."
});

/**
 * A regular expression the value must match, plus the message to show when it does not.
 *
 * Two fields rather than two capabilities: a pattern without a message produces "pattern" as
 * the error text, which tells a form filler nothing. They are authored together because they
 * are only useful together.
 *
 * Enforcement is `validation/core/field-constraints.ts`, which anchors the expression the same
 * way the browser's own `pattern` attribute does, so the hint and the check agree.
 */
export const patternCapability = fieldsCapability("pattern", [
  {
    id: "pattern",
    type: "text",
    propertyPath: "pattern",
    label: "Pattern",
    description: "Regular expression the whole value must match, e.g. [A-Z]{2}[0-9]{4}"
  },
  {
    id: "patternMessage",
    type: "localized-text",
    propertyPath: "patternMessage",
    label: "Pattern message",
    description: "Shown when the value does not match."
  }
]);

/**
 * The field's own validation text per error code (`configuration.messages`): what
 * its errors say instead of the form's or the page's wording for that code. One capability
 * rather than a message field per constraint, because a code is not always one of the
 * engine's — a server rejecting the field, a sandboxed rule — and a map keyed by code is the
 * shape every catalog already has. The inspector opens a table editor for it.
 */
export const messagesCapability = fieldCapability("messages", {
  id: "messages",
  type: "messages-editor",
  propertyPath: "messages",
  label: "Validation messages",
  description: "This field's own text per validation code, over the form's and the page's."
});

/**
 * The fewest and the most characters a value may have.
 *
 * One capability for both, as `pattern` pairs its expression with its message: an author
 * setting a limit is deciding how much room an answer gets, and the two ends of that decision
 * belong side by side. Counted in characters a person would count (code points, so an emoji
 * is one), and enforced by `validation/core/field-constraints.ts`; the markup also hints them
 * to the browser as `minlength` / `maxlength`. A minimum above the maximum is ignored as a
 * whole rather than making every value fail. The count shows the room left under
 * the control as the person types; it needs a maximum to count against, and does nothing
 * without one.
 */
export const lengthCapability = fieldsCapability("length", [
  {
    id: "minLength",
    type: "number",
    propertyPath: "minLength",
    label: "Min length",
    description: "Fewest characters a non-empty value may have."
  },
  {
    id: "maxLength",
    type: "number",
    propertyPath: "maxLength",
    label: "Max length",
    description: "Most characters a value may have."
  },
  {
    id: "characterCount",
    type: "boolean",
    propertyPath: "characterCount",
    label: "Show character count",
    description: "Counts the characters left under the control as the person types. Needs a max length; the box then no longer cuts a longer answer short, and the limit is checked on submit."
  }
]);

/**
 * A prefix and a suffix beside the box: a currency sign before it, a unit after it
 * (`configuration.prefix` / `suffix`, each a translatable string). Decorative, as design
 * systems treat them: hidden from assistive technology, so the label or the
 * description must still say the unit. Offered to the single-line text and number fields; a
 * textarea, a date or a select has no box to flank.
 */
export const affixCapability = fieldsCapability("affix", [
  {
    id: "prefix",
    type: "localized-text",
    propertyPath: "prefix",
    label: "Prefix",
    description: "Shown before the box (£, $). Decorative: say the unit in the label or description too."
  },
  {
    id: "suffix",
    type: "localized-text",
    propertyPath: "suffix",
    label: "Suffix",
    description: "Shown after the box (kg, per month). Decorative: say the unit in the label or description too."
  }
]);

/**
 * What the browser may fill the control in with (`configuration.autocomplete`, the HTML
 * `autocomplete` tokens: `name`, `email`, `postal-code`, `bday-day`, `off`).
 *
 * Its own capability rather than a line in {@link inputModeCapability}: a date field wants
 * `bday` but has no keyboard to choose, and a phone number wants both. Written out as the
 * attribute by the markup (`core/schema/control-hints.ts`); design systems ask
 * for it on every field a browser could fill.
 */
export const autocompleteCapability = fieldCapability("autocomplete", {
  id: "autocomplete",
  type: "text",
  propertyPath: "autocomplete",
  label: "Autocomplete",
  description: "An HTML autocomplete token: name, email, tel, postal-code, bday-day, off…"
});

/**
 * Which keyboard a phone raises for the control (`configuration.inputmode`) and whether the
 * browser spell-checks it (`configuration.spellcheck`). Together because they are the two
 * hints about *typing* into the box: digits for a reference number, no red underline under a
 * code. Off by default and offered to the text controls alone — a select or a checkbox has
 * no keyboard to choose. The values are the attributes' own; the spell-check select stores
 * `"true"` / `"false"` and blank leaves the browser's default in place.
 */
export const inputModeCapability = fieldsCapability("inputMode", [
  {
    id: "inputmode",
    type: "select",
    propertyPath: "inputmode",
    label: "Keyboard",
    description: "The on-screen keyboard a phone shows for this box.",
    choices: [
      { value: "", label: "Default" },
      { value: "numeric", label: "Digits" },
      { value: "decimal", label: "Decimal number" },
      { value: "tel", label: "Telephone" },
      { value: "email", label: "Email address" },
      { value: "url", label: "Web address" },
      { value: "search", label: "Search" },
      { value: "text", label: "Text" },
      { value: "none", label: "None (the page draws its own)" }
    ]
  },
  {
    id: "spellcheck",
    type: "select",
    propertyPath: "spellcheck",
    label: "Spell check",
    description: "Off for a code, a reference or a name the browser would underline.",
    choices: [
      { value: "", label: "Browser default" },
      { value: "false", label: "Off" },
      { value: "true", label: "On" }
    ]
  }
]);

/**
 * Extra classes on the component's rendered element (`configuration.cssClass`).
 *
 * The pressure-release valve for the one form that needs something its binding did not
 * anticipate. It stays honest because a class is not a style: what it means still lives in the
 * binding's CSS, which the form's shadow root keeps to the form.
 */
export const cssClassCapability = fieldCapability("cssClass", {
  id: "cssClass",
  type: "text",
  propertyPath: "cssClass",
  label: "CSS classes",
  description: "Space-separated class names, added to this component's element."
});

/**
 * How the component appears in a generated PDF: its rendition — from the
 * catalog for its type, a container's or a collection's set when that is what it is — and
 * whether it prints at all. The choice is the instance rung of the rendition ladder: a
 * layout binding beats it, and it beats the PDF theme and the type's default.
 */
export const pdfOptionsCapability: CapabilityDefinition = {
  id: "pdf",
  version: "1.0.0",
  configureEditor: ({ component }): PropertyEditorContribution => {
    const catalog = pdfRenditionCatalogFor(component.type, {
      hasChildren: !!component.children && Object.keys(component.children).length > 0,
      collection: component.collection !== undefined
    });
    return {
      fields: [
        {
          id: "pdf.rendition",
          type: "select",
          propertyPath: "pdf.rendition",
          label: "PDF rendition",
          description: "How this appears in a generated PDF. A layout's binding may still override it.",
          choices: [
            { value: "", label: "Default — the PDF theme's choice, else the component's" },
            ...catalog.renditions.map((rendition) => ({ value: rendition.id, label: rendition.label }))
          ]
        },
        {
          id: "pdf.exclude",
          type: "boolean",
          propertyPath: "pdf.exclude",
          label: "Leave out of PDFs",
          description: "Never printed, even where a layout binds it."
        }
      ]
    };
  },
  apply: mergeConfiguration
};

/**
 * How a component prints, the inspector's "On paper" group: whether it is drawn on
 * screen and paper, on screen only or on paper only; whether it starts a new sheet; for a
 * container, whether it stays whole on one; and, from a live form, whether it prints as on screen,
 * always (with a note beside it while a rule hides it) or only when answered. A read-only form
 * prints what it shows. Offered to fields and containers alike; the inspector model leaves "Keep
 * together" to the containers and disables "On paper only" where it would not take effect.
 */
/** The print editors, for a component whose `replace` editor lists its fields itself (a container). */
export const PRINT_OPTION_FIELDS: readonly PropertyEditorField[] = [
  {
    id: "print.on",
    type: "select",
    propertyPath: "print.on",
    label: "Shown",
    description: "On screen only leaves it off every printed copy, its contents with it.",
    choices: [
      { value: "", label: "On screen and on paper" },
      { value: "screen", label: "On screen only" },
      { value: "paper", label: "On paper only" }
    ]
  },
  {
    id: "print.breakBefore",
    type: "boolean",
    propertyPath: "print.breakBefore",
    label: "Start on a new page",
    description: "A printed copy begins a new sheet at this component."
  },
  {
    id: "print.keepTogether",
    type: "boolean",
    propertyPath: "print.keepTogether",
    label: "Keep together",
    description: "A printed copy does not split this across two sheets where it fits on one."
  },
  {
    id: "print.show",
    type: "select",
    propertyPath: "print.show",
    label: "When a rule hides it",
    description: "How it prints from the live form. A read-only form prints what it shows.",
    choices: [
      { value: "", label: "As on screen" },
      { value: "always", label: "Always, with a note while a rule hides it" },
      { value: "answered", label: "Only when it has an answer" }
    ]
  },
  {
    id: "print.note",
    type: "localized-text",
    propertyPath: "print.note",
    label: "Note on paper",
    description: "Printed beside it when it prints while a rule hides it. Empty: \"Complete only if it applies to you.\""
  }
];

export const printOptionsCapability: CapabilityDefinition = {
  id: "print",
  version: "1.0.0",
  configureEditor: (): PropertyEditorContribution => ({ fields: [...PRINT_OPTION_FIELDS] }),
  apply: mergeConfiguration
};

/**
 * Whether a `file` component's uploads travel inside the generated PDF as associated files: the instance rung of that switch, which a layout binding's `attach` outranks.
 * Offered to the file component alone — no other type holds a file.
 */
export const pdfAttachmentsCapability: CapabilityDefinition = {
  id: "pdf-attach",
  version: "1.0.0",
  configureEditor: (): PropertyEditorContribution => ({
    fields: [
      {
        id: "pdf.attach",
        type: "boolean",
        propertyPath: "pdf.attach",
        label: "Attach uploaded files to the PDF",
        description:
          "Each uploaded file is embedded in the PDF, listed in the reader's attachment pane — in an ordinary PDF or under PDF/A-3. PDF/A-2 leaves them out with a warning. A layout's binding may still decide otherwise."
      }
    ]
  }),
  apply: mergeConfiguration
};

export interface StandardFieldCapabilityOptions {
  /** Include the placeholder editor. Off for a control with no text box (checkbox, rating). */
  placeholder?: boolean;
  /** Include the required editor. Off for a component that holds no value (a button). */
  required?: boolean;
  /**
   * Include the data key editor. Follows `required` unless set: a component that
   * holds a value has a place in the data to name, one that holds none (a button) has not.
   */
  dataKey?: boolean;
  /** Include the description editor. */
  description?: boolean;
  /**
   * Include the pattern editor. Off by default: a regular expression only means something for
   * a control the person types free text into, and offering one on a checkbox or a date picker
   * would be an editor for a constraint that can never fail.
   */
  pattern?: boolean;
  /**
   * Include the visible-rows editor. Off by default: only a multi-line control has rows, and
   * on a single-line input the property would be authored and then silently ignored.
   */
  rows?: boolean;
  /**
   * Include the min/max length editor. Off by default, for the reason `pattern` is: a
   * character count only means something for a control the person types free text into.
   */
  length?: boolean;
  /**
   * Include the autocomplete editor. Off by default: only a control a browser can fill in
   * (a text box, a date) has anything for the attribute to say.
   */
  autocomplete?: boolean;
  /**
   * Include the keyboard and spell-check editors. Off by default, for the text controls
   * alone: a select or a checkbox raises no keyboard.
   */
  inputMode?: boolean;
  /**
   * Include the prefix and suffix editors. Off by default, for the single-line
   * text and number fields alone: they are the boxes a unit can flank.
   */
  affix?: boolean;
  /** Include the CSS-classes editor. */
  cssClass?: boolean;
  /**
   * Include the validation-messages editor. On by default; off for a component
   * that raises no validation code (a button).
   */
  messages?: boolean;
  /** Include the PDF rendition and exclusion editors. On by default. */
  pdf?: boolean;
  /** Include the live print editors. On by default. */
  print?: boolean;
  /**
   * Include the attach-uploads editor. Off by default: only a file component holds
   * files, and the switch would be authored and then silently ignored on any other.
   */
  attachFiles?: boolean;
}

/**
 * The usual set for a value-bearing field, in the order the inspector should show them:
 * what it is called, what it says, what it holds, then how it behaves.
 */
export function standardFieldCapabilities(
  options: StandardFieldCapabilityOptions = {}
): CapabilityDefinition[] {
  const {
    placeholder = true,
    required = true,
    description = true,
    pattern = false,
    rows = false,
    length = false,
    autocomplete = false,
    inputMode = false,
    affix = false,
    cssClass = true,
    messages = true,
    pdf = true,
    attachFiles = false,
    print = true
  } = options;
  const dataKey = options.dataKey ?? required;
  return [
    labelCapability,
    ...(description ? [descriptionCapability] : []),
    ...(placeholder ? [placeholderCapability] : []),
    ...(rows ? [rowsCapability] : []),
    // Beside the placeholder: what the box shows around the answer, before what it says on hover.
    ...(affix ? [affixCapability] : []),
    tooltipCapability,
    ...(required ? [requiredCapability] : []),
    // The simple bound before the expression: "at most 20 characters" is read before a regex.
    ...(length ? [lengthCapability] : []),
    ...(pattern ? [patternCapability] : []),
    // After the constraints: what they say when they fail.
    ...(messages ? [messagesCapability] : []),
    hideLabelCapability,
    disabledCapability,
    // With `disabled`, under Behavior: how the browser treats the box, after whether it may be used.
    ...(autocomplete ? [autocompleteCapability] : []),
    ...(inputMode ? [inputModeCapability] : []),
    ...(cssClass ? [cssClassCapability] : []),
    // Last: how it prints is decided after everything about it on screen.
    ...(pdf ? [pdfOptionsCapability] : []),
    ...(attachFiles ? [pdfAttachmentsCapability] : []),
    // How it prints from the live form, beside how it prints in a PDF.
    ...(print ? [printOptionsCapability] : []),
    // The inspector files it under Data whatever its place here; last keeps every other field where it was.
    ...(dataKey ? [dataKeyCapability] : []),
    // What the submitted data holds for it while hidden, under Data beside its key: every
    // component that holds an answer has a place in the data to leave out.
    ...(dataKey ? [hiddenValueCapability] : [])
  ];
}

/** Every field capability the engine ships, keyed by id — for a host resolving them by name. */
export const FIELD_CAPABILITIES: ReadonlyMap<string, CapabilityDefinition> = new Map(
  [
    labelCapability,
    descriptionCapability,
    placeholderCapability,
    tooltipCapability,
    requiredCapability,
    patternCapability,
    lengthCapability,
    messagesCapability,
    rowsCapability,
    affixCapability,
    hideLabelCapability,
    disabledCapability,
    autocompleteCapability,
    inputModeCapability,
    cssClassCapability,
    pdfOptionsCapability,
    pdfAttachmentsCapability,
    printOptionsCapability,
    dataKeyCapability,
    hiddenValueCapability
  ].map((capability) => [capability.id, capability])
);
