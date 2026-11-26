// A binding whose choice controls and page buttons are custom elements with no native control inside,
// the way a web-component design system draws them: the radio, the checkbox and the select's combobox
// take their role from ElementInternals (no `role` attribute a selector could see), a choice carries
// its state in `checked` and `value` properties, the select's combobox lives in its host's shadow root
// and is described by element reflection (`ariaDescribedByElements`), and the page buttons are
// `role="button"` elements (on the host, or inside the host's shadow root). The suite must find,
// operate and read them by role, as it does native controls. Text fields, dates and the rest are Datum's.
const define = (name, make) => {
  if (!customElements.get(name)) customElements.define(name, make());
};

const CHOICE_CSS = ":host{display:inline-flex;align-items:center;gap:.5em;min-height:1.5em;cursor:pointer}:host([disabled]){cursor:default;opacity:.6}[part=box]{display:inline-block;width:1em;height:1em;border:1px solid currentColor}:host([data-checked]) [part=box]{background:currentColor}";

/** A form-associated choice: its role is in ElementInternals only; click and Space toggle it unless `disabled` or `readonly`. */
const choice = (role) => () =>
  class extends HTMLElement {
    static formAssociated = true;
    #internals = this.attachInternals();
    #checked = false;
    constructor() {
      super();
      this.#internals.role = role;
      this.#internals.ariaChecked = "false";
      this.attachShadow({ mode: "open" }).innerHTML = `<style>${CHOICE_CSS}</style><span part="box" aria-hidden="true"></span><slot></slot>`;
      this.addEventListener("click", () => this.#toggle());
      this.addEventListener("keydown", (event) => {
        if (event.key === " ") {
          event.preventDefault();
          this.#toggle();
        }
      });
    }
    connectedCallback() {
      if (!this.hasAttribute("tabindex")) this.tabIndex = 0;
    }
    get checked() {
      return this.#checked;
    }
    set checked(next) {
      this.#checked = next === true;
      this.#internals.ariaChecked = String(this.#checked);
      this.toggleAttribute("data-checked", this.#checked);
    }
    get value() {
      return this.getAttribute("value") ?? "on";
    }
    #toggle() {
      if (this.hasAttribute("disabled") || this.hasAttribute("readonly")) return;
      if (role === "radio" && this.#checked) return;
      this.checked = !this.#checked;
      this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }
  };

define("bc-fixture-radio", choice("radio"));
define("bc-fixture-checkbox", choice("checkbox"));

/** A select drawn as a combobox in the host's shadow root; it shows the chosen option's label (the suite never operates it: VAL-05 skips). */
define("bc-fixture-select", () =>
  class extends HTMLElement {
    static formAssociated = true;
    #value = "";
    #choices = [];
    constructor() {
      super();
      this.attachShadow({ mode: "open", delegatesFocus: true }).innerHTML = `<div role="combobox" tabindex="0" aria-haspopup="listbox" aria-expanded="false" style="display:inline-block;min-width:10em;padding:.25em;border:1px solid currentColor"></div>`;
    }
    get value() {
      return this.#value;
    }
    set value(next) {
      this.#value = String(next ?? "");
      this.#caption();
    }
    set choices(next) {
      this.#choices = next;
      this.#caption();
    }
    #caption() {
      const box = this.shadowRoot.querySelector("[role=combobox]");
      box.textContent = this.#choices.find((option) => option.value === this.#value)?.label ?? this.getAttribute("placeholder") ?? "";
    }
  }
);

/** A button whose `role="button"` element is inside its shadow root; the host has no role. */
define("bc-fixture-action", () =>
  class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" }).innerHTML = `<span role="button" tabindex="0" style="display:inline-block;padding:.4em 1em;border:1px solid currentColor;cursor:pointer"><slot></slot></span>`;
    }
  }
);

/**
 * A link the way a FAST anchor draws it: the host carries the words (its text) and the role (ElementInternals),
 * and appends an empty, inert proxy `a[href]` over itself to its light DOM; the host's shadow root only slots.
 */
define("bc-fixture-link", () =>
  class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" }).innerHTML = `<style>:host{position:relative;display:inline-block}</style><slot></slot>`;
      this.attachInternals().role = "link";
    }
    connectedCallback() {
      if (this.querySelector("a")) return;
      const proxy = document.createElement("a");
      proxy.setAttribute("href", this.getAttribute("href") ?? "");
      proxy.tabIndex = -1;
      proxy.setAttribute("aria-hidden", "true");
      proxy.style.cssText = "position:absolute;inset:0";
      this.append(proxy);
    }
  }
);

export const createBinding = (lit, datum) => {
  const { html, nothing, ifDefined, live } = lit;
  const CAPABILITIES = { notice: "drawn" };
  const describedBy = (s) => (s.describedBy.length > 0 ? s.describedBy.join(" ") : undefined);
  const invalid = (s) => (s.invalid ? "true" : undefined);
  const label = (s) => html`<span class="bc-fixture-label" id=${s.labelId}>${s.label}</span>`;
  /** The hint, the errors and the notices, each with the id Datum describes the control by. */
  const messages = (s) => html`${s.hint ? html`<div id=${ifDefined(s.hintId)}>${s.hint}</div>` : nothing}${s.errors.length ? html`<div id=${ifDefined(s.errorId)}>${s.errors.join("; ")}</div>` : nothing}${s.notices.length
    ? html`<div id=${ifDefined(s.noticeId)}>${s.notices.map((notice) => html`<div>${s.words(notice.severity === "warning" ? "noticeWarning" : "noticeInfo")} ${notice.message}</div>`)}</div>`
    : nothing}`;
  const choiceOf = (tag, s, option) =>
    tag === "radio"
      ? html`<bc-fixture-radio id=${option.id} value=${option.value} .checked=${live(option.checked)} ?readonly=${s.readOnly} ?disabled=${s.disabled}>${option.label}</bc-fixture-radio>`
      : html`<bc-fixture-checkbox id=${option.id} name=${s.name} value=${option.value} .checked=${live(option.checked)} ?readonly=${s.readOnly} ?disabled=${s.disabled}>${option.label}</bc-fixture-checkbox>`;

  const radio = {
    kind: "field",
    name: "bc-fixture-radio-group",
    capabilities: CAPABILITIES,
    template: (s, on) => html`${label(s)}
      <div
        role="radiogroup"
        id=${s.id}
        aria-labelledby=${s.labelId}
        aria-describedby=${ifDefined(describedBy(s))}
        aria-invalid=${ifDefined(invalid(s))}
        @change=${(event) => {
          if (event.target.localName === "bc-fixture-radio" && event.target.checked) {
            on.input(event.target.value);
            on.commit();
          }
        }}
      >
        ${s.options.map((option) => choiceOf("radio", s, option))}
      </div>
      ${messages(s)}`,
    focusTarget: (field) => field.querySelector("bc-fixture-radio")
  };

  const checkboxes = {
    kind: "field",
    name: "bc-fixture-checkboxes",
    capabilities: CAPABILITIES,
    template: (s, on) => html`${label(s)}
      <div
        role="group"
        id=${s.id}
        aria-labelledby=${s.labelId}
        aria-describedby=${ifDefined(describedBy(s))}
        @change=${(event) => {
          on.input(Array.from(event.currentTarget.querySelectorAll("bc-fixture-checkbox")).filter((box) => box.checked).map((box) => box.value));
          on.commit();
        }}
      >
        ${s.options.map((option) => choiceOf("checkbox", s, option))}
      </div>
      ${messages(s)}`,
    focusTarget: (field) => field.querySelector("bc-fixture-checkbox")
  };

  // The lone checkbox is described by an attribute on its host (no group around it).
  const checkbox = {
    kind: "field",
    name: "bc-fixture-checkbox",
    capabilities: CAPABILITIES,
    template: (s, on) => html`<bc-fixture-checkbox
        id=${s.id}
        name=${s.name}
        aria-labelledby=${s.labelId}
        aria-describedby=${ifDefined(describedBy(s))}
        aria-invalid=${ifDefined(invalid(s))}
        .checked=${live(s.checked)}
        ?readonly=${s.readOnly}
        ?disabled=${s.disabled}
        @change=${(event) => {
          on.input(event.currentTarget.checked === true);
          on.commit();
        }}
        >${label(s)}</bc-fixture-checkbox
      >
      ${messages(s)}`,
    focusTarget: (field) => field.querySelector("bc-fixture-checkbox")
  };

  // The select's combobox sits in the host's shadow root: it is named and described by element reflection after each draw.
  const select = {
    kind: "field",
    name: "bc-fixture-select",
    capabilities: CAPABILITIES,
    template: (s) => html`${label(s)}
      <bc-fixture-select id=${s.id} placeholder=${s.emptyLabel} ?disabled=${s.disabled} .choices=${s.options} .value=${s.value}></bc-fixture-select>
      ${messages(s)}`,
    after(field, s) {
      const box = field.querySelector("bc-fixture-select")?.shadowRoot?.querySelector("[role=combobox]");
      if (!box) return;
      const home = field.getRootNode();
      box.ariaLabelledByElements = [home.getElementById(s.labelId)].filter(Boolean);
      box.ariaDescribedByElements = s.describedBy.map((id) => home.getElementById(id)).filter(Boolean);
      if (s.invalid) box.setAttribute("aria-invalid", "true");
      else box.removeAttribute("aria-invalid");
    },
    focusTarget: (field) => field.querySelector("bc-fixture-select")
  };

  // Back is a role="button" host; Continue and Submit a host whose button role is in its shadow root.
  const page = {
    heading: (p) =>
      p.title === ""
        ? html`${nothing}`
        : html`<h2 id=${p.headingId} tabindex="-1">${p.progress ? html`<span>${p.progress}: </span>` : nothing}${p.title}</h2>${p.description ? html`<p>${p.description}</p>` : nothing}`,
    actions: (p) => html`<div class="bc-fixture-actions">
        ${p.back !== undefined ? html`<bc-fixture-button role="button" tabindex="0" style="display:inline-block;padding:.4em 1em;border:1px solid" @click=${() => (p.busy ? undefined : p.back?.())}>${p.backLabel}</bc-fixture-button>` : nothing}
        ${p.next !== undefined ? html`<bc-fixture-action @click=${() => (p.busy ? undefined : p.next?.())}>${p.nextLabel}</bc-fixture-action>` : nothing}
      </div>
      ${p.checking ? html`<p role="status">${p.checking}</p>` : nothing}`
  };

  // The summary's entries are links of that shape: no words in the native anchor, a click on the host moves focus.
  const summary = (entries, state) => html`<div role="alert" tabindex="-1" aria-labelledby=${state.headingId}>
      <h2 id=${state.headingId}>${state.heading}</h2>
      <ul>
        ${state.formEntries.map((entry) => html`<li>${entry.text}</li>`)}${entries.map(
          (entry) => html`<li><bc-fixture-link href=${entry.href} @click=${(event) => { event.preventDefault(); entry.focus(); }}>${entry.text}</bc-fixture-link></li>`
        )}
      </ul>
    </div>`;

  return { ...datum, id: "custom-controls", designSystem: { name: "custom-controls fixture" }, components: { ...datum.components, radio, checkboxes, checkbox, select }, page, summary };
};
