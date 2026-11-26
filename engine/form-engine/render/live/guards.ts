/**
 * Read-only choice controls. A radio, a checkbox and a select have no
 * `readonly` attribute: the browser's only way to stop a change is `disabled`, which also greys
 * the control out and takes it out of the tab order. Read-only is not disabled: the field looks
 * as it does live, every option can be reached and read, and nothing changes. So the renderer,
 * for every field whatever the binding:
 * - refuses, on the field's wrapper and before the browser acts, what changes such a control
 *   (a click on a radio or a checkbox, or on its label, which clicks it; the keys that move a
 *   radio group's choice or tick a box; the pointer and the keys that open or change a select;
 *   Tab still moves on), while the field is read-only;
 * - says so to assistive technology: `aria-readonly` on the native checkboxes and selects, and
 *   on a radio group (a radio carries no read-only state of its own): an element with the
 *   `radiogroup` role, or a plain `fieldset` that holds the radios, which takes the role while
 *   the field is read-only (ARIA allows `aria-readonly` on a `radiogroup`, not on a `group`), so a
 *   design system whose radios are a plain fieldset (GOV.UK, GC Design System's `gcds-radios`)
 *   needs no role of its own.
 *
 * Controls inside a design-system component's open shadow root are reached too, at any depth (a
 * date component's month select inside its own select component): an event from inside reaches
 * the wrapper retargeted, and cancelling it there still cancels the browser's own response; the
 * marks are put on the controls where they are. A component that is a custom listbox (a button
 * and a list, no native control) adds its own guard (`FieldAdapter.guard`). A change that gets
 * past every guard is refused anyway: the renderer writes nothing for a read-only field and draws
 * the answer back.
 */

/** The keys that change a radio group's choice or a checkbox. */
const CHOICE_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " ", "Spacebar"]);

/** The keys a read-only select still answers: moving on, and nothing else. */
const SELECT_PASS_KEYS: ReadonlySet<string> = new Set(["Tab", "Shift", "Escape"]);

function isChoiceInput(node: EventTarget): node is HTMLInputElement {
  return node instanceof HTMLInputElement && (node.type === "radio" || node.type === "checkbox");
}

/**
 * Installs the guard on a field's wrapper; `readOnly` is asked at each event (the field's state
 * as last drawn). Returns what removes it.
 */
export function installReadOnlyGuard(wrapper: HTMLElement, readOnly: () => boolean): () => void {
  const refuse = (event: Event): void => {
    if (!readOnly()) {
      return;
    }
    const path = event.composedPath();
    const select = path.find((node): node is HTMLSelectElement => node instanceof HTMLSelectElement);
    if (select) {
      if (event.type === "mousedown") {
        // The list does not open; the select still takes focus, so it can be read.
        event.preventDefault();
        select.focus();
      } else if (event.type === "keydown" && !SELECT_PASS_KEYS.has((event as KeyboardEvent).key)) {
        event.preventDefault();
      }
      return;
    }
    if (event.type === "mousedown" || !path.some(isChoiceInput)) {
      return;
    }
    if (event.type === "click" || CHOICE_KEYS.has((event as KeyboardEvent).key)) {
      event.preventDefault();
    }
  };
  const types = ["click", "keydown", "mousedown"] as const;
  for (const type of types) {
    wrapper.addEventListener(type, refuse, true);
  }
  return () => {
    for (const type of types) {
      wrapper.removeEventListener(type, refuse, true);
    }
  };
}

/** The elements `aria-readonly` was put on by {@link markReadOnly}: only these are ever unmarked. */
const marked = new WeakSet<Element>();
/** The plain fieldsets {@link markReadOnly} gave the `radiogroup` role: only these lose it again. */
const roled = new WeakSet<Element>();

/** What carries a choice field's read-only state: native checkboxes and selects, and radio groups. */
const READONLY_TARGETS = 'input[type="checkbox"], select, [role="radiogroup"]';

/** `scope` and every open shadow root under it, at any depth. */
function scopesOf(scope: ParentNode): ParentNode[] {
  const out: ParentNode[] = [scope];
  for (const element of Array.from(scope.querySelectorAll("*"))) {
    if (element.shadowRoot) {
      out.push(...scopesOf(element.shadowRoot));
    }
  }
  return out;
}

/** A fieldset with no role of its own whose radios are its own (not a nested fieldset's): the group a design system's radios stand in. */
function isRadioFieldset(element: Element): boolean {
  if (element.localName !== "fieldset" || (element.hasAttribute("role") && !roled.has(element))) {
    return false;
  }
  return Array.from(element.querySelectorAll('input[type="radio"]')).some((radio) => radio.closest("fieldset") === element);
}

function targetsOf(wrapper: HTMLElement): { targets: Element[]; fieldsets: Element[] } {
  const targets: Element[] = [];
  const fieldsets: Element[] = [];
  for (const scope of scopesOf(wrapper)) {
    targets.push(...Array.from(scope.querySelectorAll(READONLY_TARGETS)).filter((element) => !roled.has(element)));
    fieldsets.push(...Array.from(scope.querySelectorAll("fieldset")).filter(isRadioFieldset));
  }
  return { targets, fieldsets };
}

/**
 * After a draw, and again once the field is ready: `aria-readonly` on the field's choice controls
 * while it is read-only (a plain fieldset of radios taking the `radiogroup` role with it), and
 * both off again (only where this put them) once it is not. Returns whether anything is marked
 * now, so the renderer looks again only at wrappers that are read-only or were.
 */
export function markReadOnly(wrapper: HTMLElement, readOnly: boolean): boolean {
  let any = false;
  const { targets, fieldsets } = targetsOf(wrapper);
  for (const target of targets) {
    if (readOnly) {
      if (!target.hasAttribute("aria-readonly")) {
        target.setAttribute("aria-readonly", "true");
        marked.add(target);
      }
      any = true;
    } else if (marked.has(target)) {
      target.removeAttribute("aria-readonly");
      marked.delete(target);
    }
  }
  for (const fieldset of fieldsets) {
    if (readOnly) {
      if (!fieldset.hasAttribute("role")) {
        fieldset.setAttribute("role", "radiogroup");
        roled.add(fieldset);
      }
      if (!fieldset.hasAttribute("aria-readonly")) {
        fieldset.setAttribute("aria-readonly", "true");
        marked.add(fieldset);
      }
      any = true;
    } else if (roled.has(fieldset)) {
      fieldset.removeAttribute("role");
      roled.delete(fieldset);
      if (marked.has(fieldset)) {
        fieldset.removeAttribute("aria-readonly");
        marked.delete(fieldset);
      }
    }
  }
  return any;
}
