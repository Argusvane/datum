/** Component type reserved for action buttons in the canonical model. */
export const BUTTON_COMPONENT_TYPE = "button";

/**
 * What activating a `button` component asks the host to do.
 *
 * - `"submit"` — validate and, when accepted, build the canonical submission for the host to
 *   deliver wherever it goes.
 * - `"download"` — the same submit, and when accepted hand the canonical submission to the
 *   person as a JSON file the browser downloads (`downloadSubmission` in the render layer).
 *   For a form with no server behind it, the file *is* the delivery. A rejected submit shows
 *   its errors and downloads nothing: the file always holds validated, canonical data.
 * - `"pdf"` — render the form as a PDF through the host's PDF provider and hand
 *   the file to the person. No submit: a PDF of a half-filled form is a legitimate thing to
 *   want. A host with no provider wired reports the action unhandled.
 *
 * Deliberately a closed union rather than a free string: the builder offers exactly these
 * in its action picker, and adding a future action (`"reset"`, `"navigate"`, …) is a
 * one-line change here that every exhaustive `switch` over it will then flag.
 */
export type ButtonAction = "submit" | "download" | "pdf";

export interface ButtonActionOption {
  value: ButtonAction;
  /** Human-readable choice shown in the builder's action picker. */
  label: string;
}

/** The action vocabulary, in the order a builder should present it. */
export const BUTTON_ACTION_OPTIONS: ButtonActionOption[] = [
  { value: "submit", label: "Submit form" },
  { value: "download", label: "Submit and download JSON" },
  // The form as a PDF, through the host's PDF provider; no submit. A host with
  // no provider wired reports it unhandled, as it would any action it does not serve.
  { value: "pdf", label: "Download as PDF" }
];

const KNOWN_ACTIONS: ReadonlySet<string> = new Set(
  BUTTON_ACTION_OPTIONS.map((option) => option.value)
);

export function isButtonAction(value: unknown): value is ButtonAction {
  return typeof value === "string" && KNOWN_ACTIONS.has(value);
}

/**
 * Reads `configuration.action` off a button node.
 *
 * Returns the raw string even when it is not a {@link ButtonAction} this build knows: a form
 * authored by a newer builder must still render its buttons, and it is the host's dispatcher
 * — not the renderer — that decides an unknown action is unhandled. Use {@link isButtonAction}
 * where a known action is actually required.
 */
export function readButtonAction(configuration: unknown): string | undefined {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return undefined;
  }
  const action = (configuration as { action?: unknown }).action;
  return typeof action === "string" && action.length > 0 ? action : undefined;
}

/**
 * How prominent a button looks. A closed vocabulary rather than free-form CSS: the renderer
 * turns each into a `datum-form__button--<variant>` class the *binding* colours, so a form
 * authored against one binding keeps its emphasis under another. Deliberately the same names
 * Bootstrap and every framework since has used — authors already know what they mean.
 */
export type ButtonVariant =
  | "primary"
  | "start"
  | "secondary"
  | "success"
  | "danger"
  | "warning"
  | "info"
  | "light"
  | "dark"
  | "link";

export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonChoiceOption<T extends string> {
  value: T;
  label: string;
}

/** The variant vocabulary, in the order a builder should present it. */
export const BUTTON_VARIANT_OPTIONS: Array<ButtonChoiceOption<ButtonVariant>> = [
  { value: "primary", label: "Primary" },
  // The call to action that opens a service — GOV.UK's and GC Design System's "start" button:
  // primary's weight, one size up, in the binding's success green unless the binding says otherwise.
  { value: "start", label: "Start" },
  { value: "secondary", label: "Secondary" },
  { value: "success", label: "Success" },
  { value: "danger", label: "Danger" },
  { value: "warning", label: "Warning" },
  { value: "info", label: "Info" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "link", label: "Link" }
];

export const BUTTON_SIZE_OPTIONS: Array<ButtonChoiceOption<ButtonSize>> = [
  { value: "sm", label: "Small" },
  { value: "md", label: "Medium" },
  { value: "lg", label: "Large" }
];

const KNOWN_VARIANTS: ReadonlySet<string> = new Set(
  BUTTON_VARIANT_OPTIONS.map((option) => option.value)
);
const KNOWN_SIZES: ReadonlySet<string> = new Set(BUTTON_SIZE_OPTIONS.map((option) => option.value));

function readKnown<T extends string>(
  configuration: unknown,
  key: string,
  known: ReadonlySet<string>
): T | undefined {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return undefined;
  }
  const value = (configuration as Record<string, unknown>)[key];
  return typeof value === "string" && known.has(value) ? (value as T) : undefined;
}

/**
 * Reads `configuration.variant`, `undefined` when unset *or* unrecognized.
 *
 * Unlike {@link readButtonAction} an unknown value is dropped rather than passed through: an
 * action reaches a host dispatcher that can decide it is unhandled, whereas a variant only
 * ever becomes a class name, and emitting one no stylesheet defines would silently produce an
 * unstyled button. Falling back to the default look is the honest failure.
 */
export function readButtonVariant(configuration: unknown): ButtonVariant | undefined {
  return readKnown<ButtonVariant>(configuration, "variant", KNOWN_VARIANTS);
}

/** Reads `configuration.size`; `undefined` (unset or unrecognized) means the default size. */
export function readButtonSize(configuration: unknown): ButtonSize | undefined {
  return readKnown<ButtonSize>(configuration, "size", KNOWN_SIZES);
}

/**
 * How a submit-like button asks the submission to be signed: `"webauthn"` names
 * the runtime's WebAuthn signing provider, so the person's passkey or security key signs the
 * canonical submission as part of that submit — whatever the mode's own `sign` says. A
 * closed vocabulary like the action; a host that offers other providers dispatches on the
 * raw value it reads itself.
 */
export type ButtonSignature = "webauthn";

const KNOWN_SIGNATURES: ReadonlySet<string> = new Set<ButtonSignature>(["webauthn"]);

/** The signature choices a builder offers; the empty value is "none", stored as `""` and read as unset. */
export const BUTTON_SIGNATURE_OPTIONS: Array<ButtonChoiceOption<ButtonSignature | "">> = [
  { value: "", label: "None" },
  { value: "webauthn", label: "Passkey / security key (WebAuthn)" }
];

/** Reads `configuration.signature`; `undefined` (unset, `""` or unrecognized) means an unsigned submit. */
export function readButtonSignature(configuration: unknown): ButtonSignature | undefined {
  return readKnown<ButtonSignature>(configuration, "signature", KNOWN_SIGNATURES);
}
