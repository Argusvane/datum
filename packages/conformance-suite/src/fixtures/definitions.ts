import { BASE_DEFINITION } from "./base-form.js";
import type { Fixture } from "../vectors/schema.js";

/**
 * Hostile FORM DEFINITIONS for the DEF vectors (program `check`/`public` rows) and the builder
 * profile's save rows. Everything returns JSON TEXT or a plain object that is turned into text by
 * the caller: a `__proto__` key, a duplicate key or a lone surrogate only survives as text.
 * The base definition's id is the fixture's (`datum-security-suite`); the builder runner rewrites
 * it to the suite form's id when it saves one of these (see `retargetDefinitionText`).
 */
export type Def = Record<string, any>;
type Node = Record<string, any>;

export const SUITE_MARKER = "ZZSECRETZZ";
export const DECOY_MARKER = "ZZDECOYZZ";
export const BASE_DEFINITION_ID = BASE_DEFINITION.id;

/** A deep copy of the whole fixture definition (id, version, schemaVersion, root, journey). */
export function baseDefinition(): Def {
  return structuredClone(BASE_DEFINITION) as unknown as Def;
}

/** The component types the base fixture uses plus `form`: what a host passes as `types`. */
export function baseTypes(): string[] {
  const types = new Set<string>();
  const walk = (node: Node): void => {
    types.add(String(node["type"]));
    for (const list of Object.values((node["children"] ?? {}) as Record<string, Node[]>)) {
      list.forEach(walk);
    }
  };
  walk(BASE_DEFINITION.root as Node);
  return [...types].sort();
}

/** The definition text a fixture describes: its `definitionText`, else the base definition. */
export function resolveDefinitionText(fixture: Pick<Fixture, "definitionText">): string {
  const source = fixture.definitionText;
  if (source === undefined) {
    return JSON.stringify(BASE_DEFINITION);
  }
  return typeof source === "string" ? source : source(baseDefinition());
}

const contentOf = (def: Def): Node[] => def["root"]["children"]["content"] as Node[];

/** The base definition with `edit` applied. */
export function edited(edit: (def: Def) => void): string {
  const def = baseDefinition();
  edit(def);
  return JSON.stringify(def);
}

export const textComponent = (id: string, configuration: Node = {}): Node => ({ id, type: "text", configuration });

/**
 * Rewrites the id of a definition TEXT to `formId` when it starts with the fixture's id, the one
 * edit a save needs (a host refuses a definition whose id is not the form's). Any other
 * text is returned as it is: a definition whose id is the attack (DEF-14) is not rewritten.
 */
export function retargetDefinitionText(text: string, formId: string): string {
  const prefix = `{"id":${JSON.stringify(BASE_DEFINITION_ID)}`;
  return text.startsWith(prefix) ? `{"id":${JSON.stringify(formId)}${text.slice(prefix.length)}` : text;
}

// ---- DEF-02: shapes that are not a definition -----------------------------------------------

export const NOT_A_DEFINITION = { array: "[]", string: '"x"', null: "null", number: "5" } as const;

/** A definition whose `root` is not a component record (or is missing). */
export function badRoot(root: "[]" | '"x"' | "null" | "missing"): string {
  const parts = [`"id":${JSON.stringify(BASE_DEFINITION_ID)}`, '"version":"1"', '"schemaVersion":"1"'];
  if (root !== "missing") {
    parts.push(`"root":${root}`);
  }
  return `{${parts.join(",")}}`;
}

export const rootOfType = (type: string): string => edited((def) => void (def["root"]["type"] = type));

// ---- DEF-03: duplicate ids ------------------------------------------------------------------

export const dupIdSiblings = (): string => edited((def) => contentOf(def).push(textComponent("dup"), textComponent("dup")));

export const dupIdParentChild = (): string =>
  edited((def) => contentOf(def).push({ id: "dup", type: "container", configuration: {}, children: { default: [textComponent("dup")] } }));

/** A journey page's own node with the id of a FORM component: not a duplicate (own nodes live in their page's namespace; the form's tree is a different one). */
export const dupIdAcrossJourneyIsFine = (): string =>
  edited((def) => {
    def["journey"]["journeys"][0]["pages"][0]["components"].push({ id: "ownNode", type: "text", configuration: {} });
    contentOf(def).push(textComponent("ownNode2"));
  });

/** n components, every id different. */
export const wideForm = (n: number): string =>
  edited((def) => {
    const content = contentOf(def);
    for (let at = 0; at < n; at += 1) {
      content.push(textComponent(`w${at}`));
    }
  });

/** n components that all carry the id `dup` (DEF-13: the answer lists at most 200 of them). */
export const manyDuplicateIds = (n: number): string =>
  edited((def) => {
    const content = contentOf(def);
    for (let at = 0; at < n; at += 1) {
      content.push(textComponent("dup"));
    }
  });

// ---- DEF-04: data keys and paths ------------------------------------------------------------

export const dupDataKeys = (): string =>
  edited((def) =>
    contentOf(def).push(
      { id: "a1", type: "text", configuration: { dataKey: "shared" } },
      { id: "b1", type: "select", configuration: { dataKey: "shared", options: [{ value: "x", label: "X" }] }, data: { sourceId: "countries" } }
    )
  );

/** A field storing one answer at `fa`, and a repeating group whose entries would live at `fa.items[]`: a place nested under one that cannot hold it. */
export const fieldUnderFieldPath = (): string =>
  edited((def) =>
    contentOf(def).push(textComponent("fa"), { id: "gb", type: "group", configuration: {}, collection: { collectionPath: "fa.items" }, children: { content: [textComponent("it")] } })
  );

/** Two data-scoping containers that share a key: legal (their fields land under one object), so it must NOT be flagged. */
export const containersSharingKey = (): string =>
  edited((def) =>
    contentOf(def).push(
      { id: "c1", type: "container", configuration: { dataKey: "grp" }, children: { default: [textComponent("f1")] } },
      { id: "c2", type: "container", configuration: { dataKey: "grp" }, children: { default: [textComponent("f2")] } }
    )
  );

// ---- DEF-05: size caps ----------------------------------------------------------------------

export const manyOptions = (options: number): string =>
  edited((def) => contentOf(def).push({ id: "big", type: "select", configuration: { options: Array.from({ length: options }, (_, at) => ({ value: `v${at}`, label: `V${at}` })) } }));

/** n distinct, well-formed language tags (letters only: `aa`, `ab`, ...). */
export const manyLocales = (n: number): string =>
  edited((def) => {
    const letter = (at: number): string => String.fromCharCode(97 + (at % 26));
    def["localization"] = { supportedLocales: Array.from({ length: n }, (_, at) => ({ code: `${letter(Math.floor(at / 26))}${letter(at)}` })) };
  });

export const manyJourneys = (n: number): string =>
  edited((def) => {
    def["journey"]["journeys"] = Array.from({ length: n }, (_, at) => ({ id: `j${at}`, pages: [{ id: "p1", components: ["name"] }] }));
  });

export const manyPages = (n: number): string =>
  edited((def) => {
    def["journey"]["journeys"][0]["pages"] = Array.from({ length: n }, (_, at) => ({ id: `p${at}`, components: ["name"] }));
  });

export const manyRoutes = (n: number): string =>
  edited((def) => {
    def["journey"]["journeys"][0]["pages"] = [
      { id: "p1", components: ["name"], routes: Array.from({ length: n }, () => ({ to: "p2" })) },
      { id: "p2", components: ["code"] }
    ];
  });

// ---- DEF-06: depth --------------------------------------------------------------------------

/**
 * The TEXT of a chain of containers so that the deepest component sits at `depth` (the root is level 1).
 * Built by string concatenation: V8's recursive JSON.stringify overflows a ~1 MB stack (the Linux
 * runners) on a 3,000-deep object, so no deep object is ever built or serialised.
 */
function chainText(depth: number): string {
  const leaf = JSON.stringify(textComponent("leaf"));
  const open: string[] = [];
  let close = "";
  for (let level = depth - 1; level >= 2; level -= 1) {
    open.push(`{"id":"d${level}","type":"container","configuration":{},"children":{"default":[`);
    close += "]}}";
  }
  // The outermost wrapper is level 2, so the prefix is written from level 2 inwards.
  return open.reverse().join("") + leaf + close;
}

const SPLICE = "\u0000SPLICE\u0000";

/** The base definition with `edit` applied, then every SPLICE placeholder string replaced by `text` (verbatim). */
function editedSplicing(edit: (def: Def) => void, text: string): string {
  const out = edited(edit);
  const marker = JSON.stringify(SPLICE);
  const at = out.indexOf(marker);
  return out.slice(0, at) + text + out.slice(at + marker.length);
}

/** Components nest `depth` levels deep on the form tree (root = 1). Text-built, so 3,000 costs nothing and cannot overflow the stack. */
export const deepForm = (depth: number): string => editedSplicing((def) => contentOf(def).push(SPLICE as unknown as Node), chainText(depth));

/** The same chain inside a journey page's OWN node. */
export const deepOwnNode = (depth: number): string =>
  editedSplicing((def) => {
    def["journey"]["journeys"][0]["pages"][0]["components"].push(SPLICE as unknown as string);
  }, chainText(depth + 1));

// ---- DEF-07: prototype names ----------------------------------------------------------------

/**
 * Own `__proto__` keys as a top-level key, a rules key, a data key and a children slot, as text.
 * A literal would set the prototype; the text keeps them as the keys they are.
 */
export function protoKeys(): string {
  const base = JSON.stringify(baseDefinition());
  // After the id member, so the text still starts with the fixture's id (a save retargets it to the form's).
  const withTop = base.replace(',"version"', ',"__proto__":{"polluted":"yes"},"version"');
  return withTop.replace(
    '"children":{"content":[',
    '"children":{"__proto__":[{"id":"slot","type":"text","configuration":{}}],"content":[{"id":"pk","type":"text","configuration":{"dataKey":"__proto__"},"rules":{"__proto__":{"run":"both","formula":"1=1"},"requiredWhen":"name = \\"x\\""}},'
  );
}

/** `constructor`, `toString` and `hasOwnProperty` as ids and data keys (warnings, never a refusal, never a crash). */
export const prototypeNamesAsIds = (): string =>
  edited((def) =>
    contentOf(def).push(textComponent("constructor"), textComponent("toString"), { id: "hasOwnProperty", type: "text", configuration: { dataKey: "valueOf" } })
  );

/** The words a rule reads as a scope, as component ids: each is reserved. */
export const scopeWordsAsIds = (): string =>
  edited((def) => contentOf(def).push(textComponent("component"), textComponent("host"), { id: "row", type: "fieldset", configuration: {}, children: { content: [textComponent("ancestor")] } }));

// ---- DEF-08: types --------------------------------------------------------------------------

export const typeOf = (type: unknown): string => edited((def) => contentOf(def).push({ id: "t1", type, configuration: {} }));
export const typeMissing = (): string => edited((def) => contentOf(def).push({ id: "t1", configuration: {} }));

// ---- DEF-09 / DEF-10: secrets ---------------------------------------------------------------

const secret = (formula = `name = "${SUITE_MARKER}"`, extra: Node = {}): Node => ({ run: "server-secret", formula, ...extra });

/**
 * A secret rule under each of the six server rule keys, beside decoys that must NOT be stripped:
 * `run: "server"`, a wrong-cased `Server-Secret`, a browser-only key (`defaultValue`) marked
 * server-secret, and a secret rule on a journey page's own node (journeys are served as written).
 * `depth` puts the secret field that many levels down (the root is 1).
 */
export function secretRulesMatrix(depth = 2): string {
  const field: Node = {
    id: "sf",
    type: "text",
    configuration: {},
    rules: {
      visibleWhen: secret(),
      requiredWhen: secret(),
      enabledWhen: secret(),
      readonlyWhen: secret(),
      validWhen: secret(),
      value: secret(`concat(name, "${SUITE_MARKER}")`)
    }
  };
  const decoy: Node = {
    id: "df",
    type: "text",
    configuration: {},
    rules: {
      visibleWhen: { run: "server", formula: `name = "${DECOY_MARKER}"` },
      requiredWhen: { run: "Server-Secret", formula: `name = "${DECOY_MARKER}"` },
      defaultValue: { run: "server-secret", formula: `"${DECOY_MARKER}"` }
    }
  };
  return edited((def) => {
    let place: Node = field;
    for (let level = depth - 1; level >= 2; level -= 1) {
      place = { id: `s${level}`, type: "container", configuration: {}, children: { default: [place] } };
    }
    contentOf(def).push(place, decoy);
    // The decoys include rules a strict host would refuse (a browser-only key with a server scope): under "warn" the form saves, and the public copy can be read.
    def["root"]["configuration"]["formulaErrors"] = "warn";
    def["journey"]["journeys"][0]["pages"][0]["components"].push({ id: "ownSecret", type: "text", configuration: {}, rules: { requiredWhen: { run: "server-secret", formula: `name = "${DECOY_MARKER}"` } } });
  });
}

/** One secret rule written as an object with extra keys; still secret. */
export const secretObjectForm = (): string =>
  edited((def) => contentOf(def).push({ id: "sf", type: "text", configuration: {}, rules: { requiredWhen: secret(`name = "${SUITE_MARKER}"`, { note: "extra", params: { a: 1 } }) } }));

/** A secret rule in a children slot that is not a list: not read as a component (a structure finding), left as written by `public`. */
export const secretInNonListSlot = (): string =>
  edited((def) => {
    def["root"]["children"]["weird"] = { id: "sf", type: "text", configuration: {}, rules: { requiredWhen: secret(`name = "${DECOY_MARKER}"`) } };
  });

/** DEF-10: a secret rule on a component that also has a structure problem (a duplicate id). */
export const secretRuleOnDuplicateId = (): string =>
  edited((def) =>
    contentOf(def).push(
      { id: "sf", type: "text", configuration: {}, rules: { requiredWhen: secret(`${SUITE_MARKER}secretfn(name) = 1`) } },
      { id: "sf", type: "text", configuration: {} }
    )
  );

// ---- DEF-11: journeys -----------------------------------------------------------------------

export const journeyLoops = (): string =>
  edited((def) => {
    def["journey"]["journeys"] = [
      {
        id: "main",
        pages: [
          { id: "a", components: ["name", "code"], routes: [{ to: "b" }] },
          { id: "b", components: ["addr", "tags"], routes: [{ to: "a" }, { to: "b" }, { to: "nowhere" }, { to: "$end" }] },
          { id: "c", components: ["name", "missing-component"] }
        ]
      }
    ];
  });

export const journeyChain = (pages: number): string =>
  edited((def) => {
    def["journey"]["journeys"] = [
      { id: "main", pages: Array.from({ length: pages }, (_, at) => ({ id: `p${at}`, components: ["name"], routes: [{ to: at + 1 < pages ? `p${at + 1}` : "$end" }] })) }
    ];
  });

export const journeyPagesNotAList = (): string =>
  edited((def) => {
    def["journey"]["journeys"] = [{ id: "main", pages: { id: "p1" } }];
  });

export const journeyDuplicatePageId = (): string =>
  edited((def) => {
    def["journey"]["journeys"][0]["pages"] = [
      { id: "p1", components: ["name"] },
      { id: "p1", components: ["code"] }
    ];
  });

/** A journey and a page whose ids the translations map cannot key: both reserved. */
export const journeyReservedIds = (): string =>
  edited((def) => {
    def["journey"]["journeys"].push({ id: "constructor", pages: [{ id: "first", components: ["name"] }] });
    def["journey"]["journeys"][0]["pages"].push({ id: "prototype", components: ["code"] });
  });

// ---- DEF-12: formulas -----------------------------------------------------------------------

const withRule = (key: string, source: unknown, id = "fx"): string => edited((def) => contentOf(def).push({ id, type: "text", configuration: {}, rules: { [key]: source } }));

export const unparsableVisibleWhen = (): string => withRule("visibleWhen", "name = = 1");
export const unknownBrowserFunction = (): string => withRule("visibleWhen", { run: "browser", formula: "nosuchfn(name) = 1" });
export const unknownServerFunction = (): string => withRule("requiredWhen", { run: "server", formula: "nosuchfn(name) = 1" });
export const riskyMatches = (): string => withRule("visibleWhen", { run: "both", formula: 'matches(name, "(a|a?)+")' });

/** The formulas above with a structure problem beside them (a duplicate id), for the structure-refusal-under-warn variant. */
export const unparsableWithStructureProblem = (): string =>
  edited((def) => {
    contentOf(def).push({ id: "fx", type: "text", configuration: {}, rules: { visibleWhen: "name = = 1" } }, textComponent("dup"), textComponent("dup"));
    def["root"]["configuration"]["formulaErrors"] = "warn";
  });

// ---- DEF-14: hostile identifiers ------------------------------------------------------------

export const hostileId = (id: string): string => edited((def) => contentOf(def).push(textComponent(id)));
export const versionOfLength = (n: number): string => edited((def) => void (def["version"] = "v".repeat(n)));
export const definitionIdOfLength = (n: number): string => edited((def) => void (def["id"] = "i".repeat(n)));

/** A component id holding a lone surrogate, as JSON text (an escape the parser accepts and a JS string cannot encode to UTF-8). */
export function loneSurrogateId(): string {
  return JSON.stringify(baseDefinition()).replace('"children":{"content":[', '"children":{"content":[{"id":"lone\\ud800id","type":"text","configuration":{}},');
}

// ---- DEF-16: localization, pdf, sections ----------------------------------------------------

export const badLocalization = (value: unknown): string => edited((def) => void (def["localization"] = value));
export const badPdf = (value: unknown): string => edited((def) => void (def["pdf"] = value));
export const badSections = (): string =>
  edited((def) => {
    def["journey"] = "x";
    def["metadata"] = 1;
    def["accessibility"] = [];
  });
