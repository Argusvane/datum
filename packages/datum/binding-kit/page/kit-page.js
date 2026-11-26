// The page side of the binding kit (window.kit), loaded into the conformance suite's host page
// (packages/conformance-suite/binding-check/host.html, which also holds window.bc). Design-system
// neutral: it draws reference markup three ways, measures and reads what is drawn, and mounts the
// real <datum-form-renderer> for the behaviour cases. It never names a class or tag of a design system.
//
//   plain    the reference markup in the document, with the design system's files loaded the way its
//            own page loads them (stylesheets as links, scripts run, its init called)
//   shadow   the same markup inside a shadow root, the files adopted by the renderer's own adoptInto
//   (the binding is drawn through window.bc.mount, the suite's path, and measured by kit.useDatumRoot)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let K; // the kit host module (adoptInto, loadScript, the element)
let S; // the suite's host module (runtime, lit, Datum's binding)
let binding;
let rootEl = null;
const events = [];

/** Resolves when `link` has loaded or failed (a design system's @import of a web font never holds a reference back). */
function linkLoaded(link, timeout = 20000) {
  return new Promise((resolve) => {
    const done = () => resolve();
    link.addEventListener("load", done, { once: true });
    link.addEventListener("error", done, { once: true });
    setTimeout(done, timeout);
  });
}

async function loadAssetsIntoDocument(assets) {
  const links = [];
  for (const source of [...(assets.fonts ?? []), ...(assets.stylesheets ?? [])]) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = source.url;
    document.head.append(link);
    links.push(linkLoaded(link));
  }
  await Promise.all(links);
  for (const script of assets.scripts ?? []) await K.loadScript(script, document);
}

async function settleFonts() {
  await document.fonts.ready;
  await sleep(300);
}

function blurDeep() {
  let a = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  a?.blur?.();
  document.activeElement?.blur?.();
}

function newPane(width) {
  document.body.replaceChildren();
  const pane = document.createElement("div");
  pane.id = "kit-pane";
  pane.style.cssText = `width:${width}px;margin:0;background:#fff`;
  document.body.append(pane);
  return pane;
}

// ── Reading the drawn tree ────────────────────────────────────────────────────────────────

/** Every element under `el` in the flat tree (shadow roots entered, slots followed), document order. */
function* flatElements(el) {
  yield el;
  if (el.shadowRoot) {
    for (const child of el.shadowRoot.children) yield* flatElements(child);
    return;
  }
  if (el.localName === "slot") {
    const assigned = el.assignedElements({ flatten: true });
    for (const child of assigned.length ? assigned : el.children) yield* flatElements(child);
    return;
  }
  for (const child of el.children) yield* flatElements(child);
}

/** The native controls under `root`, through open shadow roots, hidden inputs left out. */
function deepControls(root, out = []) {
  for (const el of root.querySelectorAll("*")) {
    if (/^(input|select|textarea)$/.test(el.localName) && el.type !== "hidden") out.push(el);
    if (el.shadowRoot) deepControls(el.shadowRoot, out);
  }
  return out;
}

const CONTROLS = new Set(["input", "select", "textarea", "button", "img", "svg", "hr", "progress", "meter"]);

/** One record per element that shows text or is a control: tag, box relative to the root, font, colours, border. */
function measure(root = rootEl) {
  if (!root) throw new Error("kit: no root to measure (draw something first)");
  const origin = root.getBoundingClientRect();
  const out = [];
  for (const el of flatElements(root)) {
    if (/^(style|script|template|link|slot)$/.test(el.localName)) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim() !== "");
    if (!own && !CONTROLS.has(el.localName)) continue;
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    out.push({
      el: el.localName + (el.localName === "input" ? `[${el.type}]` : ""),
      text: (el.value ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24),
      x: Math.round(box.x - origin.x),
      y: Math.round(box.y - origin.y),
      w: Math.round(box.width),
      h: Math.round(box.height),
      font: `${cs.fontSize} ${cs.fontWeight} ${cs.fontStyle} ${cs.fontFamily.split(",")[0].trim()} / ${cs.lineHeight}`,
      color: cs.color,
      background: cs.backgroundColor,
      border: `${cs.borderTopWidth} ${cs.borderRightWidth} ${cs.borderBottomWidth} ${cs.borderLeftWidth} ${cs.borderBottomStyle} ${cs.borderBottomColor}`
    });
  }
  return out;
}

/**
 * Every text a form shows or reads out, in document order, through shadow roots and slots, as the
 * browser renders it. Lines are marked:
 *   (none)    seen and read
 *   [visual]  seen, hidden from assistive technology (aria-hidden)
 *   [sr]      read only (visually hidden, clipped or moved off screen)
 *   [live]    inside a polite live region (role=status, aria-live=polite)
 *   value: / checked: / placeholder:   what a control holds
 */
function texts(start = rootEl) {
  const lines = [];
  const visuallyHidden = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const out = cs.position === "absolute" || cs.position === "fixed";
    return (out && ((r.width <= 1 && r.height <= 1) || r.right < -100 || r.bottom < -100)) || cs.clipPath === "inset(50%)" || /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(cs.clip);
  };
  const push = (text, f) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t || (f.sr && f.ah)) return;
    lines.push((f.lv ? "[live] " : "") + (f.ah ? "[visual] " : f.sr ? "[sr] " : "") + t);
  };
  const walk = (node, f) => {
    if (node.nodeType === 3) return push(node.textContent, f);
    if (node.nodeType === 11) {
      for (const c of node.childNodes) walk(c, f);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.localName;
    if (tag === "style" || tag === "script" || tag === "template") return;
    if (tag !== "slot" && getComputedStyle(el).display !== "contents" && !el.checkVisibility({ visibilityProperty: true })) return;
    const g = {
      sr: f.sr || visuallyHidden(el),
      ah: f.ah || el.getAttribute("aria-hidden") === "true",
      lv: f.lv || el.getAttribute("aria-live") === "polite" || el.getAttribute("role") === "status"
    };
    if (tag === "input" || tag === "textarea") {
      if (el.type === "radio" || el.type === "checkbox") {
        if (el.checked) lines.push("checked: " + (el.value || "on"));
        return;
      }
      if (el.value) lines.push("value: " + el.value);
      if (el.placeholder) lines.push("placeholder: " + el.placeholder);
      return;
    }
    if (tag === "select") {
      const chosen = el.selectedOptions?.[0];
      if (chosen && chosen.value !== "") lines.push("selected: " + chosen.textContent.trim());
      return;
    }
    if (tag === "abbr" && el.title) {
      push(el.textContent, g);
      lines.push("[sr] (abbr) " + el.title);
      return;
    }
    if (el.shadowRoot) {
      for (const c of el.shadowRoot.childNodes) walk(c, g);
      return;
    }
    if (tag === "slot") {
      const assigned = el.assignedNodes({ flatten: true });
      for (const c of assigned.length ? assigned : el.childNodes) walk(c, g);
      return;
    }
    for (const c of el.childNodes) walk(c, g);
  };
  walk(start, { sr: false, ah: false, lv: false });
  return lines;
}

/** The accessible structure the form's own markup sets: role, name-bearing attributes and references, by element, for the flat tree. */
function structure(start = rootEl) {
  const out = [];
  for (const el of flatElements(start)) {
    const roleAttr = el.getAttribute("role");
    const interesting = roleAttr || /^(input|select|textarea|button|fieldset|legend|label|a|form|ul|ol|h[1-6]|table)$/.test(el.localName) || el.hasAttribute("aria-label") || el.hasAttribute("aria-live");
    if (!interesting) continue;
    const entry = { el: el.localName + (el.localName === "input" ? `[${el.type}]` : ""), role: roleAttr ?? undefined };
    for (const name of ["aria-invalid", "aria-required", "aria-readonly", "aria-disabled", "aria-live", "aria-current", "aria-hidden", "disabled", "readonly", "required", "checked"]) {
      if (el.hasAttribute(name)) entry[name] = el.getAttribute(name);
    }
    out.push(entry);
  }
  return out;
}

// ── Pictures ───────────────────────────────────────────────────────────────────────────────

async function decode(base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: "image/png" }));
}

/**
 * Compares two PNGs (base64) over the union of their sizes: a pixel differs when any channel is
 * more than `threshold` apart, or lies outside the smaller picture. Resolves to
 * `{ width, height, total, differing, fraction, diff }`; `diff` is a PNG (base64) of the first
 * picture greyed with the differing pixels in red.
 */
async function diffPng(a, b, threshold = 8) {
  const [ia, ib] = await Promise.all([decode(a), decode(b)]);
  const width = Math.max(ia.width, ib.width);
  const height = Math.max(ia.height, ib.height);
  const pixels = (img) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, width, height).data;
  };
  const da = pixels(ia);
  const db = pixels(ib);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const octx = out.getContext("2d");
  octx.filter = "grayscale(1) opacity(0.3)";
  octx.drawImage(ia, 0, 0);
  octx.filter = "none";
  octx.fillStyle = "#e0002a";
  let differing = 0;
  for (let i = 0; i < da.length; i += 4) {
    const px = i / 4;
    const x = px % width;
    const y = Math.floor(px / width);
    const outside = x >= ia.width || y >= ia.height || x >= ib.width || y >= ib.height;
    if (outside || Math.abs(da[i] - db[i]) > threshold || Math.abs(da[i + 1] - db[i + 1]) > threshold || Math.abs(da[i + 2] - db[i + 2]) > threshold || Math.abs(da[i + 3] - db[i + 3]) > threshold) {
      differing += 1;
      octx.fillRect(x, y, 1, 1);
    }
  }
  const total = width * height;
  return { width, height, total, differing, fraction: total === 0 ? 0 : differing / total, diff: out.toDataURL("image/png").split(",")[1] };
}

// ── The kit ───────────────────────────────────────────────────────────────────────────────

const ADAPTER_KINDS = new Set(["field", "group", "tabs", "grid", "steps"]);

/**
 * What the renderer would ignore or never reach in the binding, as a list of problems: each is a
 * mistake that draws nothing, silently (a token without its leading dashes, an adapter with no
 * template, a kind the renderer does not know). Reads the binding object only.
 */
function lintBinding(binding) {
  const problems = [];
  const text = (key) => typeof binding[key] === "string" && binding[key].trim() !== "";
  if (!text("id")) problems.push("the binding has no id");
  if (!text("label")) problems.push("the binding has no label");
  if (binding.css !== undefined && typeof binding.css !== "string") problems.push("css must be a string");
  const known = new Set(K.FORM_TOKENS.map((token) => token.name));
  for (const [name, value] of Object.entries(binding.fallbackTokens ?? {})) {
    if (!/^--[A-Za-z0-9_-]+$/.test(name)) problems.push(`fallbackTokens "${name}": a token name starts with two dashes ("--color-text"); the renderer drops this one`);
    else if (!known.has(name.slice(2))) problems.push(`fallbackTokens "${name}": not a Datum token (the list is FORM_TOKENS in render/live/datum/tokens.ts); nothing reads it`);
    if (typeof value !== "string" || /[;{}]/.test(value)) problems.push(`fallbackTokens "${name}": the value must be one CSS value with no ; { }; the renderer drops it`);
  }
  for (const [type, entry] of Object.entries(binding.components ?? {})) {
    for (const adapter of Array.isArray(entry) ? entry : [entry]) {
      if (adapter === null || typeof adapter !== "object" || !ADAPTER_KINDS.has(adapter.kind)) problems.push(`components "${type}": an adapter needs a kind of field, group, tabs, grid or steps`);
      else if (typeof adapter.template !== "function") problems.push(`components "${type}": the ${adapter.kind} adapter has no template function`);
    }
  }
  if (binding.errorFocus !== undefined && binding.errorFocus !== "summary" && binding.errorFocus !== "field") problems.push(`errorFocus must be "summary" or "field"`);
  return problems;
}

const kit = {
  /** Imports the modules and the binding; resolves to what the cases need to know about it. */
  async init({ kitUrl, hostUrl, bindingUrl }) {
    K = await import(kitUrl);
    S = await import(hostUrl);
    const module = await import(bindingUrl);
    binding = module.createBinding(S.lit, S.createDatumBinding());
    return { id: binding.id, rootFontSize: binding.designSystem?.rootFontSize, problems: lintBinding(binding) };
  },

  /** The reference markup in the document, the design system's files loaded as its own page loads them. */
  async plain({ html, assets = {}, bodyClass, lang, width = 560, root, init, focus }) {
    if (lang) document.documentElement.lang = lang;
    document.body.className = bodyClass ?? "";
    const pane = newPane(width);
    await loadAssetsIntoDocument(assets);
    pane.innerHTML = html;
    if (init) await new Function("root", `return (async () => { ${init} })();`)(pane);
    await settleFonts();
    rootEl = (root ? pane.querySelector(root) : null) ?? pane.firstElementChild ?? pane;
    if (focus) pane.querySelector(focus)?.focus();
    await sleep(100);
    return kit.paneInfo();
  },

  /** The same markup in a shadow root, the files adopted by the renderer's adoptInto (rem rewritten where the binding declares an expectation). */
  async shadow({ html, assets = {}, bodyClass, lang, width = 560, root, init, focus, bindingId = "kit-reference", rootFontSize }) {
    if (lang) document.documentElement.lang = lang;
    document.body.className = bodyClass ?? "";
    const pane = newPane(width);
    const host = document.createElement("div");
    pane.append(host);
    const shadowRoot = host.attachShadow({ mode: "open" });
    await K.adoptInto(shadowRoot, assets, { bindingId, ...(rootFontSize ? { expectedRootFontSize: rootFontSize } : {}) });
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    shadowRoot.append(wrap);
    if (init) await new Function("root", `return (async () => { ${init} })();`)(wrap);
    await settleFonts();
    rootEl = (root ? wrap.querySelector(root) : null) ?? wrap.firstElementChild ?? wrap;
    if (focus) wrap.querySelector(focus)?.focus();
    await sleep(100);
    return kit.paneInfo();
  },

  /** The form the suite's bc.mount drew is the thing to measure: its <form> in the host's shadow root. */
  async useDatumRoot() {
    await settleFonts();
    const host = document.querySelector("[data-bc-host]");
    rootEl = host.shadowRoot.querySelector("form.datum-live") ?? host.shadowRoot.firstElementChild ?? host;
    return kit.paneInfo();
  },

  paneInfo() {
    const box = rootEl.getBoundingClientRect();
    return { width: Math.round(box.width), height: Math.round(box.height) };
  },

  /** The page rectangle (with scroll) of the thing under measurement, for a clipped screenshot. */
  clip() {
    const box = rootEl.getBoundingClientRect();
    return { x: box.x + scrollX, y: box.y + scrollY, width: Math.max(1, Math.ceil(box.width)), height: Math.max(1, Math.ceil(box.height)) };
  },

  blur: blurDeep,
  measure: () => measure(),
  texts: () => texts(),
  structure: () => structure(),
  diffPng,
  events: () => events.splice(0),
  sleep,

  /** How a field's first control looks (for "styled the same after a move or a reload"). */
  async look(id) {
    const host = document.querySelector("[data-kit-element],[data-bc-host]");
    const wrapper = host?.shadowRoot?.querySelector(`[data-component-id="${id}"]`);
    const el = wrapper ? deepControls(wrapper)[0] : undefined;
    if (!el) return null;
    // A design system's colour transition (a focus ring fading) is not a look: read the settled one.
    await Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)));
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return { font: `${cs.fontSize} ${cs.fontFamily.split(",")[0]}`, color: cs.color, background: cs.backgroundColor, border: `${cs.borderTopWidth} ${cs.borderTopColor}`, height: Math.round(box.height) };
  },

  // ── The real element, for the behaviour cases ──

  /**
   * Mounts <datum-form-renderer> in #stage with the binding and the assets. With `persistKey` the
   * answers are kept in sessionStorage as they change and restored on the next mount (a page that
   * remembers a form across a reload, which is what back/forward without the page cache does).
   */
  async mountElement({ definition, preset = {}, mode, assets, persistKey, locale }) {
    K.defineDatumFormRendererElement();
    const runtime = S.createFormRuntime(definition);
    if (locale) runtime.setLocale(locale);
    let kept = {};
    if (persistKey) {
      try { kept = JSON.parse(sessionStorage.getItem(persistKey) ?? "{}"); } catch { kept = {}; }
    }
    for (const [path, value] of Object.entries({ ...preset, ...kept })) runtime.setValue(path, value);
    const el = document.createElement(K.DATUM_FORM_RENDERER_TAG);
    el.setAttribute("data-kit-element", "");
    for (const type of ["datum-binding-error", "datum-error", "datum-form-action"]) {
      el.addEventListener(type, (event) => events.push({ type, detail: JSON.parse(JSON.stringify(event.detail ?? null)) }));
    }
    if (persistKey) {
      // A page that keeps a form across a reload keeps the settled answers: the runtime says when one is final.
      const keep = () => {
        try { sessionStorage.setItem(persistKey, JSON.stringify(runtime.state().values)); } catch { /* storage refused */ }
      };
      for (const type of ["COMPONENT_COMMITTED", "COMPONENT_CHANGED"]) {
        runtime.events().subscribe(type, (event) => { if (!event?.data?.interim) keep(); });
      }
    }
    el.runtime = runtime;
    el.binding = binding;
    if (assets) el.assets = assets;
    if (mode) el.mode = mode;
    document.getElementById("stage").append(el);
    kit.element = el;
    kit.runtime = runtime;
    await el.painted();
    return true;
  },

  /** Whether the element is drawn: a form in its shadow root, not the loading line or an alert. */
  elementState() {
    const root = kit.element?.shadowRoot;
    return { connected: !!kit.element?.isConnected, forms: root?.querySelectorAll("form.datum-live").length ?? 0, alert: root?.querySelector(".datum-live-alert")?.textContent ?? null, loading: !!root?.querySelector("[data-datum-loading]"), values: kit.runtime ? JSON.parse(JSON.stringify(kit.runtime.state().values)) : null };
  },

  /** Takes the element out of the DOM and puts it back, `delay` ms apart (0: in the same task). */
  async moveElement({ delay = 0, into } = {}) {
    const el = kit.element;
    const target = into ? document.querySelector(into) : el.parentNode;
    el.remove();
    if (delay > 0) await sleep(delay);
    target.append(el);
    await el.painted();
  },

  async painted() {
    await kit.element?.painted();
  },

  /** A bare mountLive host in #stage is moved to another parent: the host keeps its shadow root, the binding its listeners. */
  moveHost(selector) {
    const host = document.querySelector("[data-bc-host]");
    document.querySelector(selector).append(host);
    return true;
  },
  addContainer(id) {
    const div = document.createElement("div");
    div.id = id;
    document.body.append(div);
  },

  /** Dispatches the events a browser's autofill sends to the field's first control: the value set, then input (insertReplacementText) and change; no key events. */
  autofill({ id, value }) {
    const host = document.querySelector("[data-kit-element],[data-bc-host]");
    const wrapper = host?.shadowRoot?.querySelector(`[data-component-id="${id}"]`);
    const el = wrapper ? deepControls(wrapper)[0] : undefined;
    if (!el) return false;
    if (el.localName === "select") el.value = value;
    else Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return true;
  },

  /** Focuses the field's first control (the element's form, else the suite's host); true when focus landed on it. */
  focus(id, index = 0) {
    const host = document.querySelector("[data-kit-element],[data-bc-host]");
    const wrapper = host?.shadowRoot?.querySelector(`[data-component-id="${id}"]`);
    const el = wrapper ? deepControls(wrapper)[index] : undefined;
    if (!el) return false;
    el.focus();
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active === el;
  },

  /** The control attributes a field carries (autofill reads these). */
  controlAttributes(id) {
    const host = document.querySelector("[data-kit-element],[data-bc-host]");
    const wrapper = host?.shadowRoot?.querySelector(`[data-component-id="${id}"]`);
    const el = wrapper ? deepControls(wrapper)[0] : undefined;
    return el ? { tag: el.localName, autocomplete: el.getAttribute("autocomplete"), name: el.getAttribute("name"), type: el.getAttribute("type") } : null;
  },

  /** The value a field's first control shows, and what the runtime holds for it. */
  shown(id) {
    const host = document.querySelector("[data-kit-element],[data-bc-host]");
    const wrapper = host?.shadowRoot?.querySelector(`[data-component-id="${id}"]`);
    const el = wrapper ? deepControls(wrapper)[0] : undefined;
    return el ? { shown: el.value, tag: el.localName } : null;
  },

  pageshow(persisted) {
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted }));
  },

  navigationType: () => performance.getEntriesByType("navigation")[0]?.type ?? null
};

window.kit = kit;
