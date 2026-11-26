/**
 * Harness for markup-injection tests. A marker payload that, if it reaches innerHTML unescaped, creates
 * an element carrying `data-pwn="<origin>"` plus an event-handler attribute; `scan` walks every
 * shadow root and reports what it finds.
 */
export const payload = (origin: string): string => `"><img data-pwn="${origin}" src=x onerror="window.__pwn=1"><b data-pwn="${origin}-b">`;
/** Breaks out of a single-quoted attribute (escapeHtml leaves `'` alone). */
export const sq = (origin: string): string => `' data-pwn='${origin}' onfocus='window.__pwn=1' autofocus x='`;
/** Breaks out of text context only. */
export const txt = (origin: string): string => `<img data-pwn="${origin}" src=x onerror="window.__pwn=1">`;

export interface Hit {
  kind: "marker" | "on-attr" | "script" | "js-url" | "style";
  origin: string;
  tag: string;
  attr?: string;
  value?: string;
}

export function scan(root: ParentNode, hits: Hit[] = []): Hit[] {
  const walk = (node: Element): void => {
    const tag = node.tagName.toLowerCase();
    if (node.hasAttribute("data-pwn")) {
      hits.push({ kind: "marker", origin: node.getAttribute("data-pwn")!, tag });
    }
    if (tag === "script") {
      hits.push({ kind: "script", origin: node.textContent ?? "", tag });
    }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        hits.push({ kind: "on-attr", origin: node.getAttribute("data-pwn") ?? "?", tag, attr: name, value: attr.value });
      }
      if (/^\s*(javascript|vbscript):/i.test(attr.value.replace(/[\u0000- ]/g, "")) && ["href", "src", "action", "formaction", "xlink:href", "data"].includes(name)) {
        hits.push({ kind: "js-url", origin: "?", tag, attr: name, value: attr.value });
      }
      if (name === "style" && /PWN|url\(|expression\(|javascript:/i.test(attr.value)) {
        hits.push({ kind: "style", origin: "?", tag, attr: name, value: attr.value });
      }
    }
    if (node.shadowRoot) {
      for (const child of Array.from(node.shadowRoot.children)) walk(child);
    }
    for (const child of Array.from(node.children)) walk(child);
  };
  for (const child of Array.from((root as Element).shadowRoot?.children ?? [])) walk(child);
  for (const child of Array.from(root.children ?? [])) walk(child);
  return hits;
}

/** Distinct "kind:origin" lines, for a compact report. */
export function summary(hits: Hit[]): string[] {
  return [...new Set(hits.map((h) => `${h.kind}:${h.origin}${h.attr ? `[${h.attr}=${h.value?.slice(0, 40)}]` : ""}<${h.tag}>`))].sort();
}

import type { FormDefinition } from "@argusvane/datum-engine";

/** A tagged payload for every text-like configuration key, on every component type. */
export function hostileConfig(origin: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const p = (key: string): string => payload(`${origin}.${key}`);
  return {
    label: p("label"),
    description: p("description"),
    tooltip: p("tooltip"),
    placeholder: p("placeholder"),
    prefix: p("prefix"),
    suffix: p("suffix"),
    title: p("title"),
    content: txt(`${origin}.content`) + sq(`${origin}.content-sq`),
    alt: p("alt"),
    patternMessage: p("patternMessage"),
    messages: { required: p("msg.required"), pattern: p("msg.pattern"), rule: p("msg.rule"), minLength: p("msg.minLength"), maxLength: p("msg.maxLength") },
    cssClass: `${p("cssClass")} "onmouseover="window.__pwn=1" ' onclick='x`,
    ...extra
  };
}

export function hostileDefinition(): FormDefinition {
  const opt = (origin: string) => [
    { value: payload(`${origin}.v1`), label: payload(`${origin}.l1`) },
    { value: sq(`${origin}.v2`), label: sq(`${origin}.l2`) }
  ];
  let n = 0;
  const leaf = (type: string, extra: Record<string, unknown> = {}) => ({
    id: payload(`${type}${n++}.id`),
    type,
    configuration: hostileConfig(type, { required: true, ...extra })
  });
  return {
    id: payload("form.id"),
    version: "1.0.0",
    schemaVersion: "1",
    metadata: { name: payload("meta.name"), description: payload("meta.description") },
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: payload("loc.en") }, { code: payload("loc.code"), label: payload("loc.label") }] },
    root: {
      id: "root",
      type: "form",
      configuration: hostileConfig("root", { chrome: undefined }),
      children: {
        content: [
          leaf("text", { pattern: "(" }),
          leaf("textarea"),
          leaf("number"),
          leaf("date"),
          leaf("checkbox"),
          leaf("select", { options: opt("select") }),
          leaf("radio", { options: opt("radio") }),
          leaf("checkboxes", { options: opt("checkboxes") }),
          leaf("file"),
          leaf("button", { action: payload("button.action"), variant: payload("button.variant"), size: payload("button.size") }),
          { id: payload("html.id"), type: "html", configuration: hostileConfig("html", { tag: payload("html.tag") }) },
          { id: payload("image.id"), type: "image", configuration: hostileConfig("image", { src: "javascript:window.__pwn=1", width: 10, height: 10 }) },
          {
            id: payload("fieldset.id"),
            type: "fieldset",
            configuration: hostileConfig("fieldset"),
            children: { body: [leaf("text")] }
          },
          {
            id: payload("panel.id"),
            type: "panel",
            configuration: hostileConfig("panel"),
            children: { body: [leaf("text")] }
          },
          {
            id: payload("tabs.id"),
            type: "tabs",
            configuration: hostileConfig("tabs", { tabs: [{ id: payload("tab1.id"), label: payload("tab1.label") }] }),
            children: { [payload("tabslot")]: [leaf("text")], tab2: [leaf("text")] }
          },
          {
            id: payload("steps.id"),
            type: "steps",
            configuration: hostileConfig("steps"),
            children: { steps: [{ id: payload("step.id"), type: "step", configuration: hostileConfig("step"), children: { body: [leaf("text")] } }] }
          },
          {
            id: payload("grid.id"),
            type: "grid",
            configuration: hostileConfig("grid", { columns: payload("grid.columns"), widths: [payload("grid.w"), "6;background:url(x)"] }),
            children: { [payload("gridcol")]: [leaf("text")], col2: [leaf("text")] }
          },
          { id: payload("row.id"), type: "fieldset", configuration: hostileConfig("row"), children: { cells: [leaf("text")] } }
        ]
      }
    }
  } as unknown as FormDefinition;
}

/** Origins whose payload text is DISPLAYED (as text or attribute value) anywhere: proves the field reached the page. */
export function coverage(root: ParentNode, seen: Set<string> = new Set()): Set<string> {
  const re = /data-pwn=(?:"|&quot;)([^"&]*)/g;
  const take = (s: string) => { for (const m of s.matchAll(re)) seen.add(m[1]!); };
  const walk = (node: Element): void => {
    for (const attr of Array.from(node.attributes)) take(attr.value);
    for (const t of Array.from(node.childNodes)) if (t.nodeType === 3) take(t.nodeValue ?? "");
    if (node.tagName === "TEXTAREA" || node.tagName === "INPUT") take((node as HTMLInputElement).value ?? "");
    if (node.shadowRoot) for (const c of Array.from(node.shadowRoot.children)) walk(c);
    for (const c of Array.from(node.children)) walk(c);
  };
  for (const c of Array.from((root as Element).shadowRoot?.children ?? [])) walk(c);
  for (const c of Array.from(root.children ?? [])) walk(c);
  return seen;
}

/** Quote-free marker for contexts (formulas) where `"` ends a string. */
export const raw = (origin: string): string => `<img data-pwn=${origin} src=x onerror=window.__pwn=1>`;

export function hostileFull(): FormDefinition {
  const def: any = hostileDefinition();
  const ids: string[] = [];
  const walk = (n: any) => { ids.push(n.id); for (const g of Object.values(n.children ?? {})) for (const c of g as any[]) walk(c); };
  walk(def.root);
  const textIds = ids.filter((i) => /text\d+\.id|textarea\d/.test(i));
  def.root.children.content[0].rules = { visibleWhen: `1 = 1 and "${raw("rule.str")}" != "x"`, requiredWhen: `true` };
  def.root.children.content.push({ id: "selSrc", type: "select", configuration: { label: "Src", data: { sourceId: payload("src.id"), valueField: payload("src.vf"), labelField: payload("src.lf") } } });
  def.journey = {
    defaultJourneyId: payload("j.id"),
    journeys: [
      {
        id: payload("j.id"),
        name: payload("j.name"),
        pages: [
          { id: payload("page1.id"), title: payload("page1.title"), description: payload("page1.desc"), components: [textIds[0], textIds[1]], routes: [{ to: payload("page2.id"), when: `1 = 1` }] },
          { id: payload("page2.id"), title: payload("page2.title"), components: [textIds[2] ?? textIds[0]], routes: [{ to: "$end" }], texts: { continue: payload("page2.text.continue") } }
        ],
        texts: { back: payload("j.text.back"), continue: payload("j.text.continue"), submit: payload("j.text.submit"), pageOf: payload("j.text.pageOf") }
      }
    ]
  };
  def.pdf = {
    defaultLayoutId: payload("layout.id"),
    layouts: [
      {
        id: payload("layout.id"),
        kind: "generated",
        name: payload("layout.name"),
        root: {
          id: "document", type: "pdf-document", configuration: {},
          children: {
            body: [
              { id: payload("pdf.text.id"), type: "pdf-text", configuration: { text: payload("pdf.text.text") } },
              { id: payload("pdf.section.id"), type: "pdf-section", configuration: { title: payload("pdf.section.title"), heading: payload("pdf.section.heading") } },
              { id: payload("pdf.field.id"), type: "pdf-field", configuration: { componentId: textIds[0], label: payload("pdf.field.label") } }
            ],
            header: [], footer: []
          }
        }
      },
      {
        id: payload("layout2.id"),
        kind: "template",
        name: payload("layout2.name"),
        template: { storage: "base64", name: payload("tpl.name"), type: "application/pdf", size: 5, data: "JVBERi0=" },
        fields: [{ pdfField: payload("tpl.pdfField"), source: { kind: "component", componentId: textIds[0] } }],
        areas: [{ id: payload("area.id"), label: payload("area.label"), page: 1, rect: { x: 1, y: 1, width: 50, height: 20 }, source: { kind: "template", text: payload("area.text") }, field: { name: payload("area.field"), tooltip: payload("area.tooltip") } }]
      }
    ]
  };
  def.root.configuration.chrome = {
    frame: "outlined",
    header: [
      { type: "heading", text: payload("chrome.heading") },
      { type: "text", text: payload("chrome.text") },
      { type: "html", html: txt("chrome.html") },
      { type: "image", src: "javascript:window.__pwn=1", alt: payload("chrome.alt"), href: "javascript:window.__pwn=2" },
      { type: "group", parts: [{ type: "text", text: payload("chrome.group.text") }] }
    ],
    footer: [{ type: "text", text: payload("chrome.footer") }]
  };
  return def;
}
