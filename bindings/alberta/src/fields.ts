/**
 * The Alberta Design System's leaf components as adapters for the engine contract: text box,
 * textarea, number, select, radios, checkboxes, a single checkbox and button, each drawn with the
 * design system's own `goa-*` component inside a `goa-form-item`.
 *
 * What is different about this design system, and how the adapters meet it:
 * - A control says `_change` (composed, `detail` `{ name, value }`) and `_blur`, never `input` /
 *   `change` for the form's sake. `goa-input` and `goa-textarea` say `_change` on every keystroke, so
 *   a text field's value flows per keystroke (`interim`) and settles on `_blur`. The native `input`
 *   event of the box inside is heard as well, since an autofill sends that and no key.
 * - The label, help text and error message are not the control's: `goa-form-item` owns them around
 *   the control and writes `aria-label`, `aria-required` and `aria-describedby` onto it, with ids
 *   inside its own shadow root (`idsWrittenBy: "component"`). What Datum describes the control by
 *   that lives in the form's tree (a field's notices, the count's limit sentence) is added by
 *   element reflection (`reflectDescription`).
 * - A choice control (radio group, checkbox list, dropdown) has no `readonly`, so the adapter's
 *   guard refuses changes while the field is read-only (`data-readonly` on the wrapper).
 *
 * Capabilities are answered as data: hint, placeholder, prefix, suffix (the input's slots) and
 * autocomplete are the component's (`drawn`); notices are Alberta's callout (`drawn`, never the
 * error styling); the character count is drawn under the control and counted and announced by the
 * renderer (`drawn`); tooltip, pending and the worked-out line are folded into the help text by the
 * renderer (`degraded`: goa-form-item has no help bubble and no busy state).
 */
import type {
  ButtonFieldState,
  CheckboxesFieldState,
  CheckboxFieldState,
  FieldAdapter,
  FieldEvents,
  NumberFieldState,
  RadioFieldState,
  SelectFieldState,
  TextareaFieldState,
  TextFieldState
} from "../../../engine/form-engine/render/live/contract.js";
import { bool, boxIn, countLine, describeText, detailOf, formItem, keepDescription, noticesOf, readyWhen, reflectDescription, type Lit } from "./shared.js";

type TextAdapter = FieldAdapter<TextFieldState>;

const COMMON = { notice: "drawn", pending: "degraded", tooltip: "degraded", workedOut: "degraded", hideLabel: "drawn" } as const;

const NUMBER_CAPABILITIES = { ...COMMON, prefix: "drawn", suffix: "drawn", placeholder: "drawn" } as const;
const TEXT_CAPABILITIES = { ...NUMBER_CAPABILITIES, characterCount: "drawn" } as const;

/**
 * Refuses the pointer and the keys that open or change a component while the field is read-only
 * (Tab still moves on). The binding's own guard beside the renderer's (`read-only.ts`), which knows
 * native radios, checkboxes and selects only: Alberta's items act in their own handlers (a label's
 * click before its input's, a dropdown's list), which only a guard on the component's tag can stop.
 * It reads the `data-readonly` the renderer sets on the wrapper.
 */
export function choiceGuard(...tags: string[]): (field: HTMLElement) => () => void {
  return (field) => {
    const refuse = (event: Event): void => {
      if (field.dataset["readonly"] !== "true") {
        return;
      }
      if (event instanceof KeyboardEvent && (event.key === "Tab" || event.key === "Shift")) {
        return;
      }
      if (event.composedPath().some((node) => node instanceof HTMLElement && tags.includes(node.localName))) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const types = ["mousedown", "click", "keydown", "beforeinput"];
    for (const type of types) {
      field.addEventListener(type, refuse, true);
    }
    return () => {
      for (const type of types) {
        field.removeEventListener(type, refuse, true);
      }
    };
  };
}

/** The element inside a goa-radio-group / goa-checkbox-list that names the group (role radiogroup / group): what a description belongs to. */
const groupIn = (field: HTMLElement, tag: string): HTMLElement | null => field.querySelector(tag)?.shadowRoot?.querySelector<HTMLElement>('[role="radiogroup"], [role="group"]') ?? null;

/** What a number box reports: a number for what reads as one, the empty string for none, `badInput` for text the browser could not read. */
const numberReport = (text: string, box: HTMLInputElement | null | undefined): { value: number | string; badInput?: boolean } => {
  if (text === "") {
    return box?.validity.badInput ? { value: "", badInput: true } : { value: "" };
  }
  const number = Number(text);
  return { value: Number.isFinite(number) ? number : text };
};

/** Whether the box's text already stands for the stored number ("0002" for 2): left as typed, so the caret keeps its place. */
const standsFor = (typed: string, stored: string): boolean => (typed === "" || stored === "" ? typed === stored : Number(typed) === Number(stored));

export function createFields(lit: Lit) {
  const { html, nothing, ifDefined, live } = lit;

  /** The text a native `input` event of the box inside a goa-input / goa-textarea carries (an autofill sends that and no key). */
  const nativeText = (event: Event): string => {
    const origin = event.composedPath()[0];
    return origin instanceof HTMLInputElement || origin instanceof HTMLTextAreaElement ? origin.value : "";
  };
  const fromBox = (event: Event): boolean => {
    const origin = event.composedPath()[0];
    return origin instanceof HTMLInputElement || origin instanceof HTMLTextAreaElement;
  };

  const spell = (box: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null, s: TextFieldState): void => {
    if (!box) {
      return;
    }
    if (s.spellcheck === undefined) {
      box.removeAttribute("spellcheck");
    } else {
      box.setAttribute("spellcheck", String(s.spellcheck));
    }
  };

  const connectDescription = (tag: string) => (field: HTMLElement): (() => void) => keepDescription(field, () => boxIn(field, tag));

  /** goa-input's `leadingContent` / `trailingContent` slots hold a prefix and a suffix. */
  const affixes = (s: TextFieldState) =>
    html`${s.prefix === undefined ? nothing : html`<div slot="leadingContent">${s.prefix}</div>`}${s.suffix === undefined ? nothing : html`<div slot="trailingContent">${s.suffix}</div>`}`;

  // ── Text: goa-input ────────────────────────────────────────────────────────────────────────
  const text: TextAdapter = {
    kind: "field",
    name: "goa-input",
    capabilities: TEXT_CAPABILITIES,
    idsWrittenBy: "component",
    template: (s, on) =>
      formItem(
        lit,
        s,
        "text-input",
        html`<goa-input
          id=${s.id}
          name=${s.name}
          type="text"
          width=${ifDefined(s.row === undefined ? undefined : "100%")}
          .value=${live(s.value)}
          placeholder=${s.placeholder ?? ""}
          autocomplete=${s.autocomplete ?? ""}
          arialabel=${s.hideLabel ? s.label : ""}
          error=${bool(s.errors.length > 0)}
          disabled=${bool(s.disabled)}
          readonly=${bool(s.readOnly)}
          @_change=${(event: Event) => on.input(String(detailOf(event).value ?? ""), { interim: true })}
          @input=${(event: Event) => (fromBox(event) ? on.input(nativeText(event), { interim: true }) : undefined)}
          @_blur=${() => on.commit()}
          >${affixes(s)}</goa-input
        >`,
        html`${noticesOf(lit, s)}${countLine(lit, s)}`
      ),
    // No `focused` prop (it focuses 2 ms later and must be reset): the box inside, through the shadow root.
    focusTarget: (field) => boxIn(field, "goa-input"),
    after(field, s) {
      const box = boxIn(field, "goa-input");
      if (!box) {
        return;
      }
      if (s.inputMode === undefined) {
        box.removeAttribute("inputmode");
      } else {
        box.setAttribute("inputmode", s.inputMode);
      }
      spell(box, s);
      reflectDescription(field, box);
      describeText(box, s);
    },
    connect: connectDescription("goa-input"),
    ready: readyWhen("goa-input", "input")
  };

  // ── Number: goa-input type="number" ────────────────────────────────────────────────────────
  const number: FieldAdapter<NumberFieldState> = {
    kind: "field",
    name: "goa-input-number",
    capabilities: NUMBER_CAPABILITIES,
    idsWrittenBy: "component",
    template: (s, on) =>
      formItem(
        lit,
        s,
        "text-input",
        html`<goa-input
          id=${s.id}
          name=${s.name}
          type="number"
          width=${ifDefined(s.row === undefined ? undefined : "100%")}
          placeholder=${s.placeholder ?? ""}
          autocomplete=${s.autocomplete ?? ""}
          min=${s.min === undefined ? "" : String(s.min)}
          max=${s.max === undefined ? "" : String(s.max)}
          step=${s.step === undefined ? "" : String(s.step)}
          arialabel=${s.hideLabel ? s.label : ""}
          error=${bool(s.errors.length > 0)}
          disabled=${bool(s.disabled)}
          readonly=${bool(s.readOnly)}
          @_change=${(event: Event) => {
            const { value, badInput } = numberReport(String(detailOf(event).value ?? ""), boxIn(event.currentTarget as HTMLElement, "goa-input") as HTMLInputElement | null);
            on.input(value, badInput ? { interim: true, badInput } : { interim: true });
          }}
          @_blur=${() => on.commit()}
          >${affixes(s)}</goa-input
        >`,
        noticesOf(lit, s)
      ),
    focusTarget: (field) => boxIn(field, "goa-input"),
    // The text is written here, not bound: a number box keeps what was typed while it stands for the stored number.
    after(field, s) {
      const box = boxIn(field, "goa-input") as HTMLInputElement | null;
      const host = field.querySelector<HTMLElement & { value?: string }>("goa-input");
      if (box && host && !standsFor(box.value, s.value)) {
        host.value = s.value;
      }
      if (box) {
        if (s.inputMode === undefined) {
          box.removeAttribute("inputmode");
        } else {
          box.setAttribute("inputmode", s.inputMode);
        }
        spell(box, s);
        reflectDescription(field, box);
        describeText(box, s);
      }
    },
    connect: connectDescription("goa-input"),
    ready: readyWhen("goa-input", "input")
  };

  // ── Textarea: goa-textarea ─────────────────────────────────────────────────────────────────
  const textarea: FieldAdapter<TextareaFieldState> = {
    kind: "field",
    name: "goa-textarea",
    capabilities: { ...TEXT_CAPABILITIES, prefix: "none", suffix: "none" },
    idsWrittenBy: "component",
    template: (s, on) =>
      formItem(
        lit,
        s,
        "textarea",
        html`<goa-textarea
          name=${s.name}
          .value=${live(s.value)}
          rows=${s.rows ?? 3}
          placeholder=${s.placeholder ?? ""}
          autocomplete=${s.autocomplete ?? ""}
          arialabel=${s.label}
          error=${bool(s.errors.length > 0)}
          disabled=${bool(s.disabled)}
          readonly=${bool(s.readOnly)}
          @_change=${(event: Event) => on.input(String(detailOf(event).value ?? ""), { interim: true })}
          @input=${(event: Event) => (fromBox(event) ? on.input(nativeText(event), { interim: true }) : undefined)}
          @_blur=${() => on.commit()}
        ></goa-textarea>`,
        html`${noticesOf(lit, s)}${countLine(lit, s)}`
      ),
    focusTarget: (field) => boxIn(field, "goa-textarea"),
    after(field, s) {
      const box = boxIn(field, "goa-textarea");
      if (!box) {
        return;
      }
      spell(box, s);
      reflectDescription(field, box);
      describeText(box, s);
    },
    connect: connectDescription("goa-textarea"),
    ready: readyWhen("goa-textarea", "textarea")
  };

  // ── Select: goa-dropdown ───────────────────────────────────────────────────────────────────
  // `native` draws a real <select> in the design system's face: the browser's listbox, keys and
  // autofill. Without it the component draws its own listbox, a custom control a screen reader and
  // a keyboard meet differently: that is the package's `goa-dropdown` type (plugin.ts).
  const dropdown = (native: boolean): FieldAdapter<SelectFieldState> => ({
    kind: "field",
    name: native ? "goa-dropdown-native" : "goa-dropdown",
    capabilities: { ...COMMON, placeholder: "drawn" },
    idsWrittenBy: "component",
    template: (s, on) =>
      formItem(
        lit,
        s,
        "",
        html`<goa-dropdown
          name=${s.name}
          native=${bool(native)}
          .value=${live(s.value)}
          placeholder=${s.emptyLabel}
          error=${bool(s.errors.length > 0)}
          disabled=${bool(s.disabled)}
          arialabel=${s.hideLabel ? s.label : ""}
          .__datumOn=${on}
          @_change=${(event: Event) => {
            on.input(String(detailOf(event).value ?? ""));
            on.commit();
          }}
          >${native ? html`<goa-dropdown-item value="" label=${s.emptyLabel}></goa-dropdown-item>` : nothing}${s.options.map((option) => html`<goa-dropdown-item value=${option.value} label=${option.label}></goa-dropdown-item>`)}</goa-dropdown
        >`,
        noticesOf(lit, s)
      ),
    guard: choiceGuard("goa-dropdown"),
    focusTarget: (field) => boxIn(field, "goa-dropdown"),
    after(field, s) {
      const box = boxIn(field, "goa-dropdown");
      reflectDescription(field, box);
      describeText(box, s);
      if (box) {
        box.setAttribute("aria-readonly", String(s.readOnly));
      }
    },
    connect(field) {
      const stop = keepDescription(field, () => boxIn(field, "goa-dropdown"));
      // A browser's autofill sends `change` to the <select> inside the component, which stays in its shadow root: heard there.
      const box = boxIn(field, "goa-dropdown");
      const host = field.querySelector<HTMLElement & { __datumOn?: FieldEvents }>("goa-dropdown");
      if (!native || !(box instanceof HTMLSelectElement) || !host) {
        return stop;
      }
      const heard = (): void => {
        host.__datumOn?.input(box.value);
        host.__datumOn?.commit();
      };
      box.addEventListener("change", heard);
      return () => {
        box.removeEventListener("change", heard);
        stop();
      };
    },
    // The component draws its <select> and then the options its items say: ready means every option is there (an autofill before that finds none).
    ready: async (field) => {
      await readyWhen("goa-dropdown", "select, input")(field);
      const items = field.querySelectorAll("goa-dropdown-item").length;
      for (let frame = 0; native && frame < 120; frame += 1) {
        const box = boxIn(field, "goa-dropdown");
        if (!(box instanceof HTMLSelectElement) || box.options.length >= items) {
          return;
        }
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      }
    }
  });
  const select = dropdown(true);
  const listbox = dropdown(false);

  // ── Radios: goa-radio-group ────────────────────────────────────────────────────────────────
  const radio: FieldAdapter<RadioFieldState> = {
    kind: "field",
    name: "goa-radio-group",
    capabilities: COMMON,
    idsWrittenBy: "component",
    template: (s, on) =>
      formItem(
        lit,
        s,
        "radio-group",
        html`<goa-radio-group
          name=${s.name}
          .value=${live(s.value)}
          error=${bool(s.errors.length > 0)}
          disabled=${bool(s.disabled)}
          arialabel=${s.hideLabel ? s.label : ""}
          @_change=${(event: Event) => {
            // A choice settles the answer at once, as a native radio's change does: its error is checked again now, not when focus leaves.
            on.input(String(detailOf(event).value ?? ""));
            on.commit();
          }}
          @_blur=${() => on.commit()}
          >${s.options.map((option) => html`<goa-radio-item value=${option.value} label=${option.label} description=${ifDefined(option.hint)}></goa-radio-item>`)}</goa-radio-group
        >`,
        noticesOf(lit, s)
      ),
    // goa-radio-item has no read-only, and its label's own click handler acts before the input's: the item is refused as a whole.
    guard: choiceGuard("goa-radio-item"),
    after(field, s) {
      const group = groupIn(field, "goa-radio-group");
      reflectDescription(field, group);
      describeText(group, s);
    },
    connect: (field) => keepDescription(field, () => groupIn(field, "goa-radio-group")),
    // A radio, never the group: the checked one, else the first.
    focusTarget(field) {
      const radios = Array.from(field.querySelectorAll("goa-radio-item")).flatMap((item) => Array.from(item.shadowRoot?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? []));
      return radios.find((input) => input.checked) ?? radios[0] ?? null;
    },
    ready: async (field) => {
      await readyWhen("goa-radio-item", 'input[type="radio"]')(field);
    }
  };

  // ── Checkboxes: goa-checkbox-list ──────────────────────────────────────────────────────────
  const checkboxes: FieldAdapter<CheckboxesFieldState> = {
    kind: "field",
    name: "goa-checkbox-list",
    capabilities: COMMON,
    idsWrittenBy: "component",
    template: (s, on) =>
      formItem(
        lit,
        s,
        "checkbox-list",
        html`<goa-checkbox-list
          name=${s.name}
          .value=${s.selected}
          error=${bool(s.errors.length > 0)}
          disabled=${bool(s.disabled)}
          arialabel=${s.hideLabel ? s.label : ""}
          @_change=${(event: Event) => {
            // goa-checkbox-list names each item by its `name` (the option's value) and says the chosen names.
            const chosen = detailOf(event).value;
            if (Array.isArray(chosen)) {
              on.input(chosen.map(String));
              // goa-checkbox-list says no blur: a change settles the answer (its error is checked again now).
              on.commit();
            }
          }}
          >${s.options.map((option) => html`<goa-checkbox name=${option.value} text=${option.label} value=${option.value} description=${ifDefined(option.hint)}></goa-checkbox>`)}</goa-checkbox-list
        >`,
        noticesOf(lit, s)
      ),
    guard: choiceGuard("goa-checkbox"),
    after(field, s) {
      const group = groupIn(field, "goa-checkbox-list");
      reflectDescription(field, group);
      describeText(group, s);
    },
    connect: (field) => keepDescription(field, () => groupIn(field, "goa-checkbox-list")),
    focusTarget(field) {
      const boxes = Array.from(field.querySelectorAll("goa-checkbox")).flatMap((item) => Array.from(item.shadowRoot?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []));
      return boxes.find((input) => input.checked) ?? boxes[0] ?? null;
    },
    ready: async (field) => {
      await readyWhen("goa-checkbox", 'input[type="checkbox"]')(field);
    }
  };

  // ── A single checkbox: goa-checkbox ────────────────────────────────────────────────────────
  const loneBox = (field: HTMLElement): HTMLInputElement | null => field.querySelector("goa-checkbox")?.shadowRoot?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
  const checkbox: FieldAdapter<CheckboxFieldState> = {
    kind: "field",
    name: "goa-checkbox",
    capabilities: COMMON,
    idsWrittenBy: "component",
    template: (s, on) =>
      formItem(
        lit,
        { ...s, label: "" },
        "checkbox-list",
        html`<goa-checkbox
          name=${s.name}
          text=${s.label}
          checked=${bool(s.checked)}
          error=${bool(s.errors.length > 0)}
          disabled=${bool(s.disabled)}
          arialabel=${s.hideLabel ? s.label : ""}
          @_change=${(event: Event) => {
            on.input(detailOf(event).checked === true);
            on.commit();
          }}
        ></goa-checkbox>`,
        noticesOf(lit, s)
      ),
    guard: choiceGuard("goa-checkbox"),
    // The notices (marked data-describes) reach the box by element reflection, as for the other controls; hint and errors by aria-description.
    after(field, s) {
      const box = loneBox(field);
      reflectDescription(field, box);
      describeText(box, s);
    },
    connect: (field) => keepDescription(field, () => loneBox(field)),
    focusTarget: (field) => Array.from(field.querySelector("goa-checkbox")?.shadowRoot?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])[0] ?? null,
    ready: async (field) => {
      await readyWhen("goa-checkbox", 'input[type="checkbox"]')(field);
    }
  };

  // ── Button: goa-button ─────────────────────────────────────────────────────────────────────
  const buttonType = (variant: string | undefined): "primary" | "secondary" | "tertiary" => (variant === "secondary" || variant === "light" || variant === "dark" ? "secondary" : variant === "tertiary" || variant === "link" ? "tertiary" : "primary");
  const button: FieldAdapter<ButtonFieldState> = {
    kind: "field",
    name: "goa-button",
    capabilities: {},
    template(s) {
      const action = s.action ?? s.model.buttonAction;
      const variant = s.variant ?? s.model.buttonVariant;
      return html`<goa-button
        type=${buttonType(variant)}
        variant=${variant === "danger" ? "destructive" : "normal"}
        size=${(s.size ?? s.model.buttonSize) === "sm" ? "compact" : "normal"}
        data-button-action=${ifDefined(action)}
        data-button-signature=${ifDefined(s.model.buttonSignature)}
        disabled=${ifDefined(s.disabled || s.readOnly ? "true" : undefined)}
        >${s.label}</goa-button
      >`;
    },
    // A busy form draws aria-disabled, never disabled: goa-button's inner button is its own, so it is marked here.
    after(field, s) {
      const action = s.action ?? s.model.buttonAction;
      const inner = field.querySelector("goa-button")?.shadowRoot?.querySelector("button");
      if (inner) {
        if (action !== undefined && (s.busy === "submitting" || s.busy === "navigating")) {
          inner.setAttribute("aria-disabled", "true");
        } else {
          inner.removeAttribute("aria-disabled");
        }
      }
    },
    ready: readyWhen("goa-button", "button"),
    focusTarget: (field) => field.querySelector("goa-button")?.shadowRoot?.querySelector("button") ?? field.querySelector<HTMLElement>("goa-button")
  };

  return { text, number, textarea, select, listbox, radio, checkboxes, checkbox, button };
}
