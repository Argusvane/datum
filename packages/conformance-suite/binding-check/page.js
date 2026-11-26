// The page side of the binding tester. window.bc loads one binding module, mounts
// fixture forms through the ENGINE renderer (render/live mountLive) and answers the questions the
// cases ask of the drawn tree.
// Everything here is design-system neutral: it walks open shadow roots and reads roles, ids,
// attributes and text, never a class or a tag of any design system.

const consoleLog = [];
for (const type of ["warn", "error"]) {
  const original = console[type].bind(console);
  console[type] = (...args) => {
    consoleLog.push({ type, text: args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : safe(a))).join(" ").slice(0, 400) });
    original(...args);
  };
}
addEventListener("error", (event) => consoleLog.push({ type: "exception", text: String(event.message ?? event.error).slice(0, 400) }));
addEventListener("unhandledrejection", (event) => consoleLog.push({ type: "exception", text: String(event.reason?.message ?? event.reason).slice(0, 400) }));
function safe(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The events the engine renderer dispatches on the host: a hook that threw or a stage that failed, and a journey/button action.
const EVENTS = ["datum-binding-error", "datum-form-action", "datum-error"];

/** Every element under `root` matching `selector`, through open shadow roots, in document order. */
function deepAll(root, selector, out = []) {
  for (const el of root.querySelectorAll("*")) {
    if (el.matches(selector)) out.push(el);
    if (el.shadowRoot) deepAll(el.shadowRoot, selector, out);
  }
  return out;
}
/** Trimmed, non-empty text nodes of `el`, through open shadow roots (style and script left out). */
/** Whether a text node is rendered: its nearest ancestor with a box (a slot or display:contents element has none) is not display:none or visibility:hidden. */
function rendered(node) {
  let el = node.parentElement ?? node.getRootNode()?.host ?? null;
  while (el && getComputedStyle(el).display === "contents") el = el.parentElement ?? el.getRootNode()?.host ?? null;
  return !el || el.checkVisibility?.({ visibilityProperty: true }) !== false;
}
function textNodes(node, out = [], visibleOnly = false) {
  if (node.nodeType === 3) {
    const t = node.data.replace(/\s+/g, " ").trim();
    // visibleOnly: the text is rendered (not display:none, not visibility:hidden, in the flat tree); screen-reader-only text counts as rendered.
    if (t && (!visibleOnly || rendered(node))) out.push(t);
    return out;
  }
  if (node.nodeType !== 1 && node.nodeType !== 11) return out;
  if (node.nodeType === 1 && /^(style|script)$/i.test(node.localName)) return out;
  if (node.nodeType === 1 && node.localName === "slot") {
    const assigned = node.assignedNodes({ flatten: true });
    for (const child of assigned.length ? assigned : node.childNodes) textNodes(child, out, visibleOnly);
    return out;
  }
  // A component with a shadow root draws what its shadow tree says; its light children appear only through its slots.
  for (const child of node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes) textNodes(child, out, visibleOnly);
  return out;
}
const textOf = (el) => textNodes(el).join(" ");
function contains(outer, el) {
  while (el) {
    if (el === outer) return true;
    el = el.parentNode instanceof ShadowRoot ? el.parentNode.host : el.parentNode;
  }
  return false;
}
function deepActive() {
  let a = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}
const describe = (el) => (el ? el.localName + (el.id ? "#" + el.id : "") + (el.getAttribute?.("data-part") ? "[" + el.getAttribute("data-part") + "]" : "") : null);
/** The element's parent in the composed tree: a shadow root's host stands in for the root. */
const up = (n) => (n.parentNode instanceof ShadowRoot ? n.parentNode.host : n.parentNode);

// ── Controls: by native tag, or by role ───────────────────────────────────────────────────
// A field's controls are its native ones (input, textarea, select) and, where a design system draws
// its own, the elements that carry a control's role: a `role` attribute of radio, checkbox or
// combobox (in the light tree or in any open shadow root, a combobox inside its host's shadow root
// included), or a form-associated custom element with a boolean `checked` (its role lives in
// ElementInternals, which no script outside the element can read: it is a radio under a
// `role="radiogroup"`, else a checkbox). An element found by role that holds a native control, or sits
// inside another one found by role, is not counted again: the native control, or the outer one, is it.
const NATIVE_CONTROL = /^(input|textarea|select)$/;
const CONTROL_ROLES = new Set(["radio", "checkbox", "combobox"]);
const isNative = (el) => NATIVE_CONTROL.test(el.localName) && el.type !== "hidden";
/** Whether a role="radiogroup" holds `el`, up to `wrapper`. */
function inRadioGroup(el, wrapper) {
  for (let n = up(el); n && n !== wrapper; n = up(n)) if (n.nodeType === 1 && n.getAttribute("role") === "radiogroup") return true;
  return false;
}
/** The role of a control that is no native one (radio, checkbox, combobox), or null. */
function controlRole(el, wrapper) {
  if (isNative(el)) return null;
  const role = el.getAttribute("role");
  if (role) return CONTROL_ROLES.has(role) ? role : null;
  if (el.localName.includes("-") && el.constructor?.formAssociated === true && typeof el.checked === "boolean") return inRadioGroup(el, wrapper) ? "radio" : "checkbox";
  return null;
}
/** What kind of control `el` is: a native input's type, "select", "textarea", or the role it was found by. */
const kindOf = (el, wrapper) => (el.localName === "input" ? el.type : NATIVE_CONTROL.test(el.localName) ? el.localName : controlRole(el, wrapper));
/** Whether a control found by role says it is checked: its `checked` property, else `aria-checked`. */
const checkedOf = (el) => (typeof el.checked === "boolean" ? el.checked : el.getAttribute("aria-checked") === "true");
/** Every control under `wrapper` in composed-tree order (see above). */
function controlsUnder(wrapper) {
  const all = deepAll(wrapper, "*");
  const native = all.filter(isNative);
  const out = [];
  const byRole = [];
  for (const el of all) {
    if (isNative(el)) { out.push(el); continue; }
    if (!controlRole(el, wrapper)) continue;
    if (native.some((n) => contains(el, n)) || byRole.some((o) => contains(o, el))) continue;
    byRole.push(el);
    out.push(el);
  }
  return out;
}

const state = { binding: undefined, datum: undefined, host: undefined, bindingUrl: undefined, assets: undefined, cur: undefined };

const FIELD_TYPES = ["text", "textarea", "select", "radio", "checkboxes", "checkbox", "date", "fieldset", "tabs", "dataGrid"];

const bc = {
  /** Imports the host module and the binding module (`createBinding(lit, datum)`) and reports what the binding declares. */
  async load(hostUrl, bindingUrl, assets) {
    state.host = await import(hostUrl);
    const module = await import(bindingUrl);
    if (typeof module.createBinding !== "function") throw new Error(`${bindingUrl} exports no createBinding(lit, datum)`);
    // Datum stands behind a design-system binding as its fallback, and the binding is handed the same
    // object to wrap Datum's adapters from; Datum's own binding is its own.
    const datum = state.host.createDatumBinding();
    state.binding = module.createBinding(state.host.lit, datum);
    state.datum = state.binding.id === "datum" ? state.binding : datum;
    state.assets = assets;
    const b = state.binding;
    const types = {};
    for (const type of FIELD_TYPES) {
      const entry = b.components?.[type];
      if (!entry) continue;
      types[type] = (Array.isArray(entry) ? entry : [entry]).map((adapter) => ({ kind: adapter.kind, capabilities: { ...adapter.capabilities }, when: typeof adapter.when === "function" }));
    }
    return {
      id: b.id,
      designSystem: { name: b.designSystem?.name, selfCheck: typeof b.designSystem?.selfCheck === "function", sideEffects: (b.designSystem?.sideEffects ?? []).map((e) => ({ target: String(e.target), effect: String(e.effect) })) },
      errorFocus: b.errorFocus ?? "summary",
      hasSummary: typeof b.summary === "function",
      hasPage: !!b.page,
      types
    };
  },

  consoleTake() {
    return consoleLog.splice(0);
  },

  /** Mounts a fixture form into a fresh host in #stage through mountLive; resolves once ready and drawn. */
  async mount({ definition, mode, locale, preset, assets, expectFailure, stages }) {
    const dm = state.host;
    const journeys = definition.journey ? await dm.loadJourneyEngine() : undefined;
    const runtime = dm.createFormRuntime(definition, { ...(journeys ? { journeyEngine: journeys.engine } : {}), ...(stages?.length ? { stages } : {}) });
    if (definition.journey) runtime.startJourney(definition.journey.journeys[0].id);
    if (locale) runtime.setLocale(locale);
    for (const [path, value] of Object.entries(preset ?? {})) runtime.setValue(path, value);
    const host = document.createElement("div");
    host.dataset.bcHost = "";
    document.getElementById("stage").append(host);
    const events = [];
    for (const type of EVENTS) host.addEventListener(type, (event) => events.push({ type, detail: safe(event.detail) && JSON.parse(safe(event.detail) ?? "null") }));
    const before = bc.docSnapshot();
    const cur = { host, runtime, events, before, form: undefined, context: undefined, dm, journeys };
    state.cur = cur;
    // A probe module: it keeps the renderer's context, which is how the host's validate() focuses the errors.
    const probe = { id: "checker-probe", start(live) { cur.context = live; } };
    cur.form = dm.mountLive(host.attachShadow({ mode: "open" }), {
      // The builder canvas's hooks (CNV), read at each draw: bc.canvas(true) sets them and draws again.
      get canvasHooks() { return cur.hooks; },
      runtime,
      binding: state.binding,
      datum: state.datum,
      ...((assets ?? state.assets) ? { assets: assets ?? state.assets } : {}),
      ...(mode ? { mode } : {}),
      ...(journeys ? { journeyKit: journeys.renderKit } : {}),
      features: [...dm.createDatumFeatures(), ...(journeys ? [dm.createJourneyPageFeature()] : []), probe]
    });
    try {
      await cur.form.ready;
    } catch (error) {
      // A form that could not be drawn: the renderer rejects ready and draws an alert in its place.
      if (!expectFailure) throw error;
      return { failed: String(error?.message ?? error) };
    }
    await cur.form.updated();
    return { failed: null };
  },

  docSnapshot() {
    return {
      links: document.head.querySelectorAll("link[rel=stylesheet]").length + document.body.querySelectorAll("link[rel=stylesheet]").length,
      styles: document.querySelectorAll("style:not([data-styles])").length,
      // @font-face rules must live in the document (a shadow root cannot register a font): only those are allowed there.
      adopted: document.adoptedStyleSheets.filter((sheet) => [...sheet.cssRules].some((rule) => !(rule instanceof CSSFontFaceRule))).length,
      bodyChildren: document.body.childElementCount
    };
  },
  docLeak() {
    const before = state.cur.before;
    const now = bc.docSnapshot();
    return { before, now, shadowSheets: state.cur.host.shadowRoot.adoptedStyleSheets.length };
  },
  events() {
    return state.cur.events;
  },
  async settle(ms = 150) {
    await sleep(ms);
    await state.cur.form.updated();
    await sleep(100);
  },
  /** What the element's validate() does: the whole-form check, then focus to the errors. */
  async validate() {
    await state.cur.runtime.validate();
    await state.cur.form.updated();
    state.cur.context?.focusErrors();
    await bc.settle(250);
  },
  values() {
    return JSON.parse(JSON.stringify(state.cur.runtime.state().values));
  },
  errors() {
    return state.cur.runtime.errors().map((e) => ({ code: e.code, componentId: e.componentId, message: e.message }));
  },
  setValue(path, value) {
    state.cur.runtime.setValue(path, value);
  },
  /** Answers the async checks a fixture's `remote:` stage holds pending. */
  answerPending() {
    return state.host.answerPending();
  },
  /** The value paths the runtime holds pending: an async stage that declares the path is running for each. */
  pendingPaths() {
    return [...state.cur.runtime.pendingPaths()];
  },
  /** Starts a whole-form check without waiting for it (an async stage keeps it pending). */
  startValidation() {
    void state.cur.runtime.validate();
    return true;
  },
  async runtimeCall(method, ...args) {
    return JSON.parse(safe(await state.cur.runtime[method](...args)) ?? "null");
  },
  unsupported() {
    return state.cur.form.unsupported();
  },
  draws() {
    return state.cur.form.draws();
  },
  unmount() {
    state.cur.form.unmount();
    return true;
  },
  rootChildren() {
    return state.cur.host.shadowRoot.childElementCount;
  },
  /** Whether the first draw is still hidden (the form carries data-settling until ready) and whether the renderer drew a failure alert. */
  readiness() {
    const root = state.cur.host.shadowRoot;
    return { settling: !!root.querySelector("[data-settling]"), alert: root.querySelector(".datum-live-alert")?.textContent ?? null, forms: root.querySelectorAll("form.datum-live").length };
  },

  root: () => state.cur.host.shadowRoot,
  /** The field's wrapper (the renderer's `.datum-live-field`), the `index`th when it is drawn in rows. */
  field(id, index = 0) {
    return [...state.cur.host.shadowRoot.querySelectorAll(`.datum-live-field[data-component-id="${id}"]`)][index] ?? null;
  },
  fieldCount(id) {
    return state.cur.host.shadowRoot.querySelectorAll(`.datum-live-field[data-component-id="${id}"]`).length;
  },
  fieldText(id, index = 0) {
    const w = bc.field(id, index);
    return w ? textOf(w) : null;
  },
  fieldTextNodes(id, index = 0, visibleOnly = false) {
    const w = bc.field(id, index);
    return w ? textNodes(w, [], visibleOnly) : null;
  },
  /** The controls under a field, composed-tree order: native ones (hidden inputs left out) and those found by role (controlsUnder). */
  controlsOf(id, index = 0, wrapper = bc.field(id, index)) {
    if (!wrapper) return [];
    return controlsUnder(wrapper);
  },
  control(id, index = 0, which = 0) {
    return bc.controlsOf(id, index)[which] ?? null;
  },
  /** The checkbox or radio (native, or found by role) for an option value: by its own value, its name, or the value a design-system host element carries (a custom checkbox keeps an empty value until checked). */
  optionControl(id, value, index = 0) {
    const w = bc.field(id, index);
    return bc.controlsOf(id, index).find((el) => {
      const kind = kindOf(el, w);
      if (kind !== "radio" && kind !== "checkbox") return false;
      if (el.value === value || el.name === value) return true;
      for (let n = el; n && n !== w; n = n.parentNode instanceof ShadowRoot ? n.parentNode.host : n.parentNode) if (n.nodeType === 1 && n.getAttribute("value") === value) return true;
      return false;
    }) ?? null;
  },
  /** What each control says about itself. A control found by role carries `role`, its state from `checked` / `aria-checked` and its `value` property. */
  controlInfo(id, index = 0) {
    const w = bc.field(id, index);
    return bc.controlsOf(id, index).map((el) => ({ tag: el.localName, role: controlRole(el, w), type: el.type, value: el.value, checked: isNative(el) ? el.checked : checkedOf(el), name: el.name, optionValue: el.getAttribute("value"), disabled: el.disabled, readOnly: el.readOnly, placeholder: el.getAttribute("placeholder"), autocomplete: el.getAttribute("autocomplete"), inputmode: el.getAttribute("inputmode"), spellcheck: el.spellcheck, rows: el.rows, part: el.getAttribute("data-part") }));
  },
  focusControl(id, index = 0, which = 0) {
    const el = bc.control(id, index, which);
    if (!el) return false;
    el.focus();
    if (el.setSelectionRange && /^(text|search|email|tel|url|number|)$/.test(el.type ?? "")) {
      try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
    }
    // A control found by role may delegate focus into its own shadow root.
    const active = deepActive();
    return active === el || (!isNative(el) && contains(el, active));
  },
  selectAll(id, index = 0, which = 0) {
    bc.control(id, index, which)?.select?.();
  },
  blur() {
    deepActive()?.blur?.();
  },
  active() {
    const a = deepActive();
    return { desc: describe(a), field: bc.fieldOf(a), inSummary: contains(state.cur.host.shadowRoot.querySelector(".datum-live-summary") ?? document.createElement("i"), a) };
  },
  /**
   * The error summary's links, one element per entry. A design system's link may draw its native anchor as an
   * empty, inert proxy `a[href]` in its light DOM while its words are the host's own text and its role is in
   * ElementInternals (a FAST anchor); that proxy stands for its parent when the parent is a custom element with the
   * same `href`, so the host is returned (textOf reads its words, slots flattened) and the proxy is not.
   */
  summaryLinks() {
    const summary = state.cur.host.shadowRoot.querySelector(".datum-live-summary");
    if (!summary) return [];
    return deepAll(summary, "a[href]").map((a) => {
      const host = a.parentNode instanceof ShadowRoot ? null : a.parentElement;
      return host && host.localName.includes("-") && host.getAttribute("href") === a.getAttribute("href") && textOf(a) === "" ? host : a;
    });
  },
  /** The data-component-id and instance of the field wrapper that holds `el`. */
  fieldOf(el) {
    while (el) {
      if (el.nodeType === 1 && el.matches?.(".datum-live-field[data-component-id]")) return { id: el.dataset.componentId, instance: el.dataset.instance ?? null };
      el = el.parentNode instanceof ShadowRoot ? el.parentNode.host : el.parentNode;
    }
    return null;
  },
  /**
   * A journey page's buttons: every `button` or `[role=button]` (a design system's own button host, or
   * the button inside its shadow root) that belongs to no field, the summary or a chrome part
   * (`data-chrome-part`, the language list); of a button inside another, the outer one.
   */
  pageButtons() {
    const root = state.cur.host.shadowRoot;
    const summary = root.querySelector(".datum-live-summary");
    const inChrome = (el) => {
      for (let n = el; n && n !== root; n = up(n)) if (n.nodeType === 1 && n.hasAttribute("data-chrome-part")) return true;
      return false;
    };
    const all = deepAll(root, "button,[role=button]").filter((b) => !bc.fieldOf(b) && !(summary && contains(summary, b)) && !inChrome(b));
    return all.filter((b) => !all.some((o) => o !== b && contains(o, b)));
  },
  deepAll(selector, wrapperId, index = 0) {
    const root = wrapperId ? bc.field(wrapperId, index) : state.cur.host.shadowRoot;
    return root ? deepAll(root, selector) : [];
  },
  /** Starts recording every write to every live region under the form (the announcer included). */
  watchRegions() {
    const writes = [];
    state.writes = writes;
    const t0 = performance.now();
    const regions = deepAll(state.cur.host.shadowRoot, "[role=status],[aria-live]");
    for (const region of regions) new MutationObserver(() => writes.push({ t: Math.round(performance.now() - t0), text: textOf(region) })).observe(region, { childList: true, characterData: true, subtree: true });
    return regions.length;
  },
  regionWrites() {
    return (state.writes ?? []).slice();
  },
  clearWrites() {
    if (state.writes) state.writes.length = 0;
  },
  /** Which of a date's controls is the day, month and year (an index into controlsOf), by what they say about themselves. */
  dateBoxes(id) {
    const out = {};
    bc.controlsOf(id).forEach((el, index) => {
      const key = [el.getAttribute("data-part"), el.name, el.id, el.getAttribute("aria-label"), el.getAttribute("autocomplete"), el.getAttribute("placeholder"), el.labels?.[0]?.textContent].filter(Boolean).join(" ").toLowerCase();
      const part = /year|ann[ée]e|yyyy|aaaa/.test(key) ? "year" : /month|mois|\bmm\b/.test(key) ? "month" : /\bday\b|jour|\bdd\b|\bjj\b/.test(key) ? "day" : null;
      if (part && out[part] === undefined) out[part] = index;
    });
    return out;
  },
  /** Sets a native select or a text box the way a person would: the value, then input and change. */
  setControl(id, which, value, index = 0) {
    const el = bc.control(id, index, which);
    if (!el) return false;
    if (el.localName === "select") {
      const options = [...el.options];
      const found = options.find((o) => o.value === value) ?? options.find((o) => o.textContent.trim().toLowerCase() === String(value).toLowerCase());
      if (!found) return false;
      el.value = found.value;
    } else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return true;
  },
  /**
   * What describes a field for assistive technology: for each of its controls, native or found by
   * role (controlsOf: a custom radio or checkbox host, a combobox in its host's shadow root), and its
   * groups (a fieldset or a group role, inside a component's shadow root too), and each element between it
   * and the field's wrapper, the elements its aria-describedby names in its own tree, the elements
   * of its ariaDescribedByElements (element reflection reaches an ancestor tree), and its
   * aria-description. Each as `{ id, text, alert }`: `alert` when the element or an ancestor up to
   * the wrapper is an alert or an assertive live region.
   */
  descriptions(id, index = 0) {
    const w = bc.field(id, index);
    if (!w) return null;
    const out = [];
    const seen = new Set();
    const up = (n) => (n.parentNode instanceof ShadowRoot ? n.parentNode.host : n.parentNode);
    const alerting = (el) => {
      for (let n = el; n && n !== w; n = up(n)) if (n.nodeType === 1 && (n.getAttribute("role") === "alert" || n.getAttribute("aria-live") === "assertive")) return true;
      return false;
    };
    const take = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      out.push({ id: el.id || null, text: textOf(el), alert: alerting(el) });
    };
    for (const start of [...bc.controlsOf(id, index), ...deepAll(w, "fieldset,[role=group],[role=radiogroup]")]) {
      for (let n = start; n && n !== w; n = up(n)) {
        if (n.nodeType !== 1) continue;
        for (const token of (n.getAttribute("aria-describedby") || "").split(/\s+/)) if (token) take(n.getRootNode().getElementById?.(token));
        for (const el of n.ariaDescribedByElements ?? []) take(el);
        const words = n.getAttribute("aria-description");
        if (words && !seen.has(words)) { seen.add(words); out.push({ id: null, text: words, alert: false }); }
      }
    }
    return out;
  },
  /** Whether a blocking error is marked on the field: the wrapper's data-invalid, or aria-invalid on any element inside it. */
  invalidMarks(id, index = 0) {
    const w = bc.field(id, index);
    if (!w) return null;
    return [...(w.hasAttribute("data-invalid") ? ["data-invalid"] : []), ...deepAll(w, "[aria-invalid=true]").map((el) => el.localName + "[aria-invalid]")];
  },
  /** The elements under the field whose own text holds `needle`, deepest first, and whether one is in an alert. */
  textHolders(id, needle, index = 0) {
    const w = bc.field(id, index);
    if (!w) return null;
    const holders = [w, ...deepAll(w, "*")].filter((el) => textOf(el).includes(needle));
    const deepest = holders.filter((el) => !holders.some((o) => o !== el && contains(el, o)));
    const up = (n) => (n.parentNode instanceof ShadowRoot ? n.parentNode.host : n.parentNode);
    const alert = deepest.some((el) => { for (let n = el; n && n !== w; n = up(n)) if (n.nodeType === 1 && (n.getAttribute("role") === "alert" || n.getAttribute("aria-live") === "assertive")) return true; return false; });
    return { count: deepest.length, alert };
  },
  /**
   * PRT: a fixture through the renderer's print path (answers, letter) under the binding's print
   * theme (the one PrintTheme the module exports) and under the basic theme. Its self-check runs on
   * the document loaded in a frame with the host's stylesheets, as print runs it.
   */
  async printFixture(printUrl, definition, preset, assets) {
    const dm = state.host;
    const themes = Object.values(await import(printUrl)).filter((v) => v && typeof v === "object" && typeof v.id === "string" && typeof v.css === "string" && v.draw && typeof v.draw === "object");
    if (themes.length !== 1) return { error: `the print module exports ${themes.length} print themes (one expected)` };
    const theme = themes[0];
    const runtime = dm.createFormRuntime(definition);
    for (const [path, value] of Object.entries(preset ?? {})) runtime.setValue(path, value);
    const source = await dm.readPrintSource(runtime, { rendition: "answers", mode: "interactive", page: { size: "letter" } });
    // The host's relative URLs resolve against the page, as the element's print does.
    const themed = dm.preparePrint(source, { theme, assets, base: document.baseURI });
    const basic = dm.preparePrint(source, { theme: dm.basicPrintTheme });
    // Words as read: every text node on its own, so neighbouring elements' words never run together.
    const words = (html) => {
      const body = new DOMParser().parseFromString(html, "text/html").body;
      const out = new Set();
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest("style,script")) continue;
        for (const word of node.data.replace(/[^\p{L}\p{N}]+/gu, " ").split(" ")) if (word) out.add(word);
      }
      return out;
    };
    const printed = words(themed.html);
    let selfCheck = [];
    if (themed.selfCheck) {
      const frame = document.createElement("iframe");
      frame.style.cssText = "position:absolute;left:-10000px;top:0;width:816px;height:1056px;border:0";
      await new Promise((resolve) => { frame.addEventListener("load", resolve, { once: true }); frame.srcdoc = themed.html; document.body.append(frame); });
      await frame.contentDocument.fonts?.ready;
      selfCheck = [...themed.selfCheck(frame.contentDocument)];
      frame.remove();
    }
    return { theme: theme.id, used: themed.theme, fellBack: themed.fellBack ?? null, selfCheck, lost: [...words(basic.html)].filter((w) => !printed.has(w)) };
  },
  /**
   * CNV: lays the builder canvas's hooks over the mounted fixture (or takes them off, as the builder does for
   * Try it and Preview) and draws again. Every container the definition declares slots for is a container to
   * the canvas, empty or not.
   */
  async canvas(on, definition) {
    const cur = state.cur;
    if (on) {
      const declaredSlots = new Map();
      const walk = (node) => {
        if (node.children) declaredSlots.set(node.id, Object.keys(node.children));
        for (const list of Object.values(node.children ?? {})) for (const child of list) walk(child);
      };
      walk(definition.root);
      cur.hooks = cur.dm.buildCanvasHooks({ selectedId: undefined, rootId: definition.root.id, declaredSlots });
      // The canvas's selection rule (builder-panels, the click handler): the nearest node on the click's path.
      if (!cur.clicks) {
        cur.clicks = [];
        cur.host.shadowRoot.addEventListener("click", (event) => {
          const path = event.composedPath();
          cur.clicks.push({ target: describe(path[0]), node: path.find((el) => el?.classList?.contains?.("db-node"))?.dataset?.componentId ?? null, prevented: event.defaultPrevented });
        }, true);
      }
    } else cur.hooks = undefined;
    cur.form.redraw();
    await cur.form.updated();
    await sleep(100);
    return true;
  },
  /** CNV: what the canvas drew for component `id`: its node, whether it is a container, and whether its leaf is inert. */
  canvasNode(id) {
    const nodes = [...state.cur.host.shadowRoot.querySelectorAll(`.db-node[data-component-id="${id}"]`)];
    const node = nodes[0];
    if (!node) return { count: 0 };
    const leaf = [...node.children].find((el) => el.classList.contains("db-leaf"));
    const wrapper = node.closest(".datum-live-field, [data-container-id]");
    return {
      count: nodes.length,
      container: node.classList.contains("db-node--container"),
      grip: !!node.querySelector(":scope > .db-handle"),
      leaf: !!leaf,
      inert: !!leaf?.inert,
      nodeInert: node.inert,
      wrapperId: wrapper?.dataset?.componentId ?? wrapper?.dataset?.containerId ?? null,
      zone: !!node.querySelector(`[data-dropzone][data-parent-id="${id}"]`)
    };
  },
  /** CNV: the centre of the control a person would aim at in the node of `id` (the first interactive element with a box, else the leaf). */
  canvasAim(id) {
    const node = state.cur.host.shadowRoot.querySelector(`.db-node[data-component-id="${id}"]`);
    const leaf = node && [...node.children].find((el) => el.classList.contains("db-leaf"));
    if (!leaf) return null;
    // A design system may park a native radio or checkbox off screen behind its own tile: only a control whose box sits inside the leaf's is aimed at.
    leaf.scrollIntoView?.({ block: "center" });
    const within = leaf.getBoundingClientRect();
    const box = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.left >= within.left - 1 && r.right <= within.right + 1 && r.top >= within.top - 1 && r.bottom <= within.bottom + 1 ? r : null; };
    const control = deepAll(leaf, "input, select, textarea, button, [role=combobox], [role=radio], [role=checkbox]").find(box) ?? leaf;
    const r = box(control) ?? box(leaf);
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2, control: describe(control) } : null;
  },
  /**
   * CNV: the centre of a container's own heading in its node: the rendered text `label` the binding drew for the group
   * (its legend, wherever the design system puts it), never inside a nested component's node or the node's chrome.
   * Of several matches, the largest box (a visually hidden copy has none to click). Null when the heading has no box.
   */
  canvasHeadingAim(id, label) {
    const node = state.cur.host.shadowRoot.querySelector(`.db-node[data-component-id="${id}"]`);
    if (!node) return null;
    node.scrollIntoView?.({ block: "center" });
    const up = (el) => (el.parentNode instanceof ShadowRoot ? el.parentNode.host : el.parentNode);
    const own = (text) => {
      for (let el = up(text); el && el !== node; el = up(el)) if (el.classList?.contains("db-node") || el.classList?.contains("db-handle") || el.classList?.contains("db-tag")) return false;
      return true;
    };
    const found = [];
    const walk = (n) => {
      if (n.nodeType === 3) {
        if (n.data.replace(/\s+/g, " ").trim() === label && rendered(n) && own(n)) found.push(n);
        return;
      }
      if (n.nodeType !== 1 && n.nodeType !== 11) return;
      if (n.nodeType === 1 && /^(style|script)$/i.test(n.localName)) return;
      if (n.nodeType === 1 && n.localName === "slot") {
        const assigned = n.assignedNodes({ flatten: true });
        for (const child of assigned.length ? assigned : n.childNodes) walk(child);
        return;
      }
      for (const child of n.shadowRoot ? n.shadowRoot.childNodes : n.childNodes) walk(child);
    };
    walk(node);
    let best = null;
    for (const text of found) {
      const range = document.createRange();
      range.selectNodeContents(text);
      const r = range.getBoundingClientRect();
      if (r.width > 2 && r.height > 2 && (!best || r.width * r.height > best.r.width * best.r.height)) best = { r, text };
    }
    return best ? { x: best.r.x + best.r.width / 2, y: best.r.y + best.r.height / 2, control: describe(best.text.parentElement ?? best.text.getRootNode()?.host ?? null) } : null;
  },
  /** CNV: the clicks the canvas heard since the last call: where each landed and which node it selects. */
  canvasClicks() {
    return state.cur.clicks.splice(0);
  },
  /** CNV: whether a script's focus() reaches any control of the leaf of `id` (an inert leaf refuses it). */
  canvasFocusReaches(id) {
    const node = state.cur.host.shadowRoot.querySelector(`.db-node[data-component-id="${id}"]`);
    const leaf = node && [...node.children].find((el) => el.classList.contains("db-leaf"));
    if (!leaf) return null;
    for (const el of deepAll(leaf, "input, select, textarea, button")) {
      el.focus?.();
      if (contains(leaf, deepActive())) { deepActive()?.blur?.(); return true; }
    }
    return false;
  },
  /** PDF: the binding's `pdfTheme` suggestion through the engine's ladder, with the PDF themes the module exports registered (and with none). */
  async pdfSuggestion(pdfUrl) {
    const dm = state.host;
    const b = state.binding;
    const suggestion = b.pdfTheme;
    if (suggestion === undefined) return { none: true };
    const wanted = typeof suggestion === "string" ? suggestion : suggestion?.id;
    const themes = pdfUrl ? Object.values(await import(pdfUrl)).filter((v) => v && typeof v === "object" && v.target === "pdf" && typeof v.id === "string") : [];
    if (typeof suggestion === "string" && themes.length === 0) return { error: `the binding suggests the PDF theme "${wanted}" but no PDF theme module supplies one (the assets file's "pdf")` };
    const registry = new dm.PdfThemeRegistry();
    for (const theme of new Set(themes)) if (!registry.has(theme.id)) registry.register(theme);
    const ask = (lookup) => dm.selectPdfTheme({ binding: { id: b.id, pdfTheme: suggestion }, resolveTheme: lookup });
    const found = ask(dm.pdfThemeLookup(registry));
    const unregistered = ask(() => undefined);
    let resolved;
    try { resolved = found.theme ? dm.resolvePdfTheme(found.theme) : undefined; } catch (error) { return { error: `the theme does not resolve: ${error?.message ?? error}` }; }
    return { wanted, source: found.source, id: found.theme?.id ?? null, warnings: found.warnings.map((w) => w.code), body: resolved ? { family: resolved.typography?.body?.family ?? null, size: resolved.typography?.body?.size ?? null } : null, unregistered: { source: unregistered.source, warnings: unregistered.warnings.map((w) => w.code) }, objectSuggestion: typeof suggestion !== "string" };
  },
  info() {
    return { pageLang: document.documentElement.lang, doc: bc.docSnapshot() };
  }
};
window.bc = bc;
Object.assign(window, { deepAll, textNodes, textOf, contains, deepActive, sleep });
