/**
 * The Fluent UI choice fields and the button: select, radio, checkboxes, checkbox, button. The date
 * is date.ts (tier 2).
 *
 * All tier 1, each Fluent's own element. The shape is the one Fluent's documentation writes
 * (field.stories.ts `ComponentExamples`, radio-group.stories.ts, dropdown.stories.ts):
 * - select: `fluent-field` (label above) with a `fluent-dropdown type="select"` in its `input` slot
 *   and a `fluent-listbox` of `fluent-option`s. The caption of an unchosen select is the dropdown's
 *   own `placeholder` (Datum's `emptyLabel`), so there is no empty option to draw and none to pick.
 * - radio: `fluent-field` (label above) around a `fluent-radio-group`, each radio in a
 *   `fluent-field label-position="after"` of its own (the component has no label slot of its own).
 * - checkboxes: Fluent has no checkbox group. The group is a `fluent-field` whose `input` slot
 *   holds a `div role="group"` of one `fluent-field label-position="after"` + `fluent-checkbox` per
 *   option, the arrangement the radio group's documentation uses. The div takes `required` as a
 *   property and an attribute so the field draws its own asterisk (it reads `input.required`).
 * - checkbox: `fluent-field label-position="after"` with a `fluent-checkbox`.
 * - button: `fluent-button`.
 *
 * Option hints go in the option's own field message slot (`fluent-text size="200"`), which
 * `describes` its radio or checkbox; Fluent has no description slot on either. The group's hint,
 * errors and notices are the field's one message element (shared.ts, `messagesOf`).
 *
 * Read-only: Fluent has no read-only for a radio, a checkbox or a dropdown, and the renderer's own
 * guard (guards.ts) reaches only native inputs, native selects and `[role=radiogroup]` attributes,
 * none of which Fluent's elements are (their roles come from ElementInternals). So `guard` refuses,
 * on the field's wrapper and before the component acts, what changes them while the wrapper says
 * `data-readonly` (a click, the choosing keys, a dropdown's opening keys; Tab, Shift and Escape
 * pass), and the hosts carry `aria-readonly`. Never `disabled`.
 *
 * What Fluent does not do for a shadowed control is not done here either: a dropdown's control is a
 * light-DOM `button role=combobox` the field labels itself; a checkbox, a radio and a radio group are
 * the labelled elements (their roles are on the host).
 */
import type {
  ButtonFieldState,
  CheckboxesFieldState,
  CheckboxFieldState,
  ChoiceOption,
  FieldAdapter,
  FieldState,
  LiveBinding,
  RadioFieldState,
  SelectFieldState,
  AdapterEntry
} from "../../../engine/form-engine/render/live/contract.js";
import { createDate } from "./date.js";
import { messagesOf, readyOf, setAttr, VISUALLY_HIDDEN, type Lit } from "./shared.js";

const CAPABILITIES = { notice: "drawn", pending: "degraded", tooltip: "degraded", workedOut: "degraded", hideLabel: "drawn" } as const;

/** The keys that change a radio group's choice or tick a checkbox. */
const CHOICE_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " ", "Spacebar"]);
/** The keys a read-only dropdown still answers: moving on, and nothing else. */
const PASS_KEYS: ReadonlySet<string> = new Set(["Tab", "Shift", "Escape"]);

const CHOICE_TAGS: ReadonlySet<string> = new Set(["fluent-checkbox", "fluent-radio", "fluent-dropdown"]);

/**
 * The guard for Fluent's choice controls (see the module comment): installed once on the field's
 * wrapper, asking the wrapper's own `data-readonly` / `data-disabled` marks at each event, the state
 * as last drawn. The capture phase on the wrapper runs before the component's own listeners.
 */
function guardReadOnly(wrapper: HTMLElement): () => void {
  const refuse = (event: Event): void => {
    if (!wrapper.hasAttribute("data-readonly") || wrapper.hasAttribute("data-disabled")) {
      return;
    }
    const tags = event.composedPath().flatMap((node) => (node instanceof Element ? [node.localName] : []));
    if (!tags.some((tag) => CHOICE_TAGS.has(tag))) {
      return;
    }
    const key = event.type === "keydown" ? (event as KeyboardEvent).key : undefined;
    const stop = key === undefined ? event.type === "click" : tags.includes("fluent-dropdown") ? !PASS_KEYS.has(key) : CHOICE_KEYS.has(key);
    if (stop) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  for (const type of ["click", "keydown"] as const) {
    wrapper.addEventListener(type, refuse, true);
  }
  return () => {
    for (const type of ["click", "keydown"] as const) {
      wrapper.removeEventListener(type, refuse, true);
    }
  };
}

/** `aria-describedby` for a host, or nothing. */
const describedByOf = (ids: readonly string[]): string | undefined => (ids.length > 0 ? ids.join(" ") : undefined);

/** `aria-readonly` on a control that has no read-only of its own (ARIA allows it on a checkbox, a radiogroup and a combobox). */
const markReadOnly = (control: Element | null | undefined, readOnly: boolean): void => setAttr(control, "aria-readonly", readOnly ? "true" : undefined);

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

type Dropdown = HTMLElement & { control?: HTMLElement; listbox?: HTMLElement; value?: string | null };

export function createFields(lit: Lit, datum: LiveBinding): Record<string, AdapterEntry> {
  const { html, nothing, ifDefined, live } = lit;

  const label = (s: FieldState, options: { for?: string } = {}) =>
    html`<label slot="label" id=${s.labelId} for=${ifDefined(options.for)} class=${s.hideLabel ? VISUALLY_HIDDEN : nothing}>${s.label}</label>`;

  /** An option's hint, in its own field's message slot. */
  const optionHint = (option: ChoiceOption) =>
    option.hint === undefined || option.hint === "" ? nothing : html`<fluent-text slot="message" size="200" id=${ifDefined(option.hintId)}>${option.hint}</fluent-text>`;

  // ── Select ──────────────────────────────────────────────────────────────────────────────
  const dropdownOf = (field: HTMLElement): Dropdown | null => field.querySelector<Dropdown>("fluent-dropdown");

  const select: FieldAdapter<SelectFieldState> = {
    kind: "field",
    name: "fluent-dropdown",
    capabilities: { ...CAPABILITIES, placeholder: "drawn" },
    template: (s, on) => html`<fluent-field label-position="above">
      ${label(s, { for: s.id })}
      <fluent-dropdown
        slot="input"
        type="select"
        id=${s.id}
        name=${s.name}
        placeholder=${s.emptyLabel}
        ?required=${s.required}
        ?disabled=${s.disabled}
        @change=${(event: Event) => {
          // The dropdown's own `change` (an option picked); an option's bubbles through here first and is not it.
          if (event.target === event.currentTarget) {
            on.input(String((event.currentTarget as Dropdown).value ?? ""));
            on.commit();
          }
        }}
      >
        <fluent-listbox>${s.options.map((option) => html`<fluent-option value=${option.value} ?selected=${option.checked}>${option.label}</fluent-option>`)}</fluent-listbox>
      </fluent-dropdown>
      ${messagesOf(lit, s)}
    </fluent-field>`,
    after(field, s) {
      const dropdown = dropdownOf(field);
      if (!dropdown) {
        return;
      }
      // `selected` on an option is the initial state: a pick the renderer refused, or a rule that wrote the answer, is drawn back here.
      if (dropdown.listbox && String(dropdown.value ?? "") !== s.value) {
        dropdown.value = s.value;
      }
      const control = dropdown.control;
      setAttr(control, "aria-describedby", describedByOf(s.describedBy));
      setAttr(control, "aria-invalid", s.invalid ? "true" : undefined);
      setAttr(control, "aria-required", s.required ? "true" : undefined);
      markReadOnly(control, s.readOnly);
    },
    // The field labels the dropdown's control once the dropdown has drawn it (it waits for `dropdown.control`): wait for both.
    async ready(field) {
      await readyOf()(field);
      const dropdown = dropdownOf(field);
      for (let waited = 0; dropdown && (!dropdown.control || !dropdown.listbox) && waited < 30; waited += 1) {
        await frame();
      }
      await frame();
    },
    guard: guardReadOnly,
    focusTarget: (field) => dropdownOf(field)
  };

  // ── Radio ───────────────────────────────────────────────────────────────────────────────
  type RadioGroup = HTMLElement & { value?: string | null };
  const groupOf = (field: HTMLElement): RadioGroup | null => field.querySelector<RadioGroup>("fluent-radio-group");
  /** The state each radio field was last drawn with, by its wrapper: what a deferred draw-back reads. */
  const drawn = new WeakMap<HTMLElement, RadioFieldState>();
  /** `checked` on a radio is the initial state and the group decides after that: the stored answer is written back to the group. */
  const restore = (group: RadioGroup, s: RadioFieldState): void => {
    if (String(group.value ?? "") !== s.value) {
      group.value = s.value;
    }
  };

  const radio: FieldAdapter<RadioFieldState> = {
    kind: "field",
    name: "fluent-radio-group",
    capabilities: CAPABILITIES,
    template: (s, on) => html`<fluent-field label-position="above">
      ${label(s, { for: s.id })}
      <fluent-radio-group
        slot="input"
        id=${s.id}
        name=${s.name}
        orientation="vertical"
        role="radiogroup"
        aria-describedby=${ifDefined(describedByOf(s.describedBy))}
        aria-invalid=${ifDefined(s.invalid ? "true" : undefined)}
        ?required=${s.required}
        ?disabled=${s.disabled}
        @change=${(event: Event) => {
          // A radio's `change` bubbles to the group: only the one now checked, and only a new answer, is the person's.
          const target = event.target as HTMLElement & { checked?: boolean; value?: string };
          if (target.localName === "fluent-radio" && target.checked === true && target.value !== undefined && target.value !== s.value) {
            on.input(target.value);
            on.commit();
            // The group goes on writing its own state once this handler returns (it checks the focused radio, then its index), so an answer
            // the renderer refused or a rule rewrote is drawn back after it has, not inside the event.
            const group = event.currentTarget as RadioGroup;
            const wrapper = group.closest<HTMLElement>(".datum-live-field");
            queueMicrotask(() => {
              const state = wrapper ? drawn.get(wrapper) : undefined;
              if (state) {
                restore(group, state);
              }
            });
          }
        }}
      >
        ${s.options.map(
          (option) => html`<fluent-field label-position="after">
            <label slot="label" for=${option.id}>${option.label}</label>
            <fluent-radio slot="input" id=${option.id} value=${option.value} aria-describedby=${ifDefined(option.hint ? option.hintId : undefined)}></fluent-radio>
            ${optionHint(option)}
          </fluent-field>`
        )}
      </fluent-radio-group>
      ${messagesOf(lit, s)}
    </fluent-field>`,
    after(field, s) {
      const group = groupOf(field);
      if (!group) {
        return;
      }
      drawn.set(field, s);
      restore(group, s);
    },
    ready: readyOf(),
    guard: guardReadOnly,
    focusTarget: (field) => groupOf(field)
  };

  // ── Checkboxes ──────────────────────────────────────────────────────────────────────────
  type Checkbox = HTMLElement & { checked?: boolean; value?: string };
  const boxesOf = (field: HTMLElement): Checkbox[] => Array.from(field.querySelectorAll<Checkbox>("fluent-checkbox"));

  const checkboxes: FieldAdapter<CheckboxesFieldState> = {
    kind: "field",
    name: "fluent-checkbox-group",
    capabilities: CAPABILITIES,
    template: (s, on) => html`<fluent-field label-position="above">
      ${label(s)}
      <div
        slot="input"
        id=${s.id}
        class="datum-fluent-checkbox-group"
        role="group"
        aria-labelledby=${s.labelId}
        aria-describedby=${ifDefined(describedByOf(s.describedBy))}
        aria-invalid=${ifDefined(s.invalid ? "true" : undefined)}
        .required=${s.required}
        ?required=${s.required}
        @change=${(event: Event) => {
          on.input(
            Array.from((event.currentTarget as HTMLElement).querySelectorAll<Checkbox>("fluent-checkbox"))
              .filter((box) => box.checked === true)
              .map((box) => String(box.value))
          );
          on.commit();
        }}
      >
        ${s.options.map(
          (option) => html`<fluent-field label-position="after">
            <label slot="label" for=${option.id}>${option.label}</label>
            <fluent-checkbox
              slot="input"
              id=${option.id}
              name=${s.name}
              value=${option.value}
              .checked=${live(option.checked)}
              ?disabled=${s.disabled}
              aria-describedby=${ifDefined(option.hint ? option.hintId : undefined)}
            ></fluent-checkbox>
            ${optionHint(option)}
          </fluent-field>`
        )}
      </div>
      ${messagesOf(lit, s)}
    </fluent-field>`,
    after(field, s) {
      for (const box of boxesOf(field)) {
        markReadOnly(box, s.readOnly);
      }
    },
    ready: readyOf(),
    guard: guardReadOnly,
    focusTarget: (field) => boxesOf(field)[0] ?? null
  };

  // ── Checkbox ────────────────────────────────────────────────────────────────────────────
  const checkbox: FieldAdapter<CheckboxFieldState> = {
    kind: "field",
    name: "fluent-checkbox",
    capabilities: CAPABILITIES,
    template: (s, on) => html`<fluent-field label-position="after">
      ${label(s, { for: s.id })}
      <fluent-checkbox
        slot="input"
        id=${s.id}
        name=${s.name}
        .checked=${live(s.checked)}
        ?required=${s.required}
        ?disabled=${s.disabled}
        aria-describedby=${ifDefined(describedByOf(s.describedBy))}
        aria-invalid=${ifDefined(s.invalid ? "true" : undefined)}
        @change=${(event: Event) => {
          on.input((event.currentTarget as Checkbox).checked === true);
          on.commit();
        }}
      ></fluent-checkbox>
      ${messagesOf(lit, s)}
    </fluent-field>`,
    after: (field, s) => markReadOnly(boxesOf(field)[0], s.readOnly),
    ready: readyOf(),
    guard: guardReadOnly,
    focusTarget: (field) => boxesOf(field)[0] ?? null
  };

  // ── Button ──────────────────────────────────────────────────────────────────────────────
  /**
   * Datum's emphasis in Fluent's appearances. Fluent's button has no danger, warning, success or info
   * appearance: the neutral kinds (`secondary`, `light`, `dark`) draw as an outline button, `link`
   * as a subtle one, and every other kind, `danger` included, as the primary (brand) button. A
   * `danger` button also takes a class that points the primary appearance's three brand backgrounds
   * at Fluent's status tokens (css.ts), so a destructive action does not look like the main call to
   * action; the others (`warning`, `success`, `info`, `start`) stay the brand colour.
   */
  const appearanceOf = (variant: string | undefined): "primary" | "outline" | "subtle" =>
    variant === "secondary" || variant === "light" || variant === "dark" ? "outline" : variant === "link" ? "subtle" : "primary";

  const button: FieldAdapter<ButtonFieldState> = {
    kind: "field",
    name: "fluent-button",
    capabilities: {},
    template(s) {
      const action = s.action ?? s.model.buttonAction;
      // While an action is under way the button is aria-disabled and stays focusable (never `disabled`): the renderer drops the press.
      const working = action !== undefined && (s.busy === "submitting" || s.busy === "navigating");
      const size = s.size ?? s.model.buttonSize;
      const variant = s.variant ?? s.model.buttonVariant;
      return html`<fluent-button
        type="button"
        appearance=${appearanceOf(variant)}
        class=${variant === "danger" ? "datum-fluent-button--danger" : nothing}
        size=${size === "sm" ? "small" : size === "lg" ? "large" : "medium"}
        data-button-action=${ifDefined(action)}
        data-button-signature=${ifDefined(s.model.buttonSignature)}
        ?disabled=${s.disabled || s.readOnly}
        aria-disabled=${working ? "true" : nothing}
        >${s.label}</fluent-button
      >`;
    },
    ready: readyOf(),
    focusTarget: (field) => field.querySelector<HTMLElement>("fluent-button")
  };

  const { date } = createDate(lit, datum);

  return { select, radio, checkboxes, checkbox, button, date };
}
