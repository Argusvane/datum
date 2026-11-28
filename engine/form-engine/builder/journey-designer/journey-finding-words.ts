/**
 * The words of the journey's findings as the builder says them.
 *
 * `diagnoseJourney` writes each finding for every host that reads a journey: a file's
 * page ids and a form's component ids are its names, and it says "page". The builder's author
 * knows a journey by its steps and a form by its labels, so the message is said again
 * here, from the diagnostic's own params and the words the author gave: a quoted page id becomes
 * the step's name (its title, else the label of what it asks first, else its id), a quoted
 * component id or the diagnostic's own `componentId` becomes the field's label, "page" reads
 * "step" and `journey "<id>"` reads "this journey". The codes and the params stay the diagnostic's
 * (a host keying on them is unaffected); only the sentence changes, and only in the builder.
 *
 * A rewrite of the sentence rather than a table of one sentence per code: the diagnostics hold
 * some seventy messages, several with more than one variant under one code, and a table would
 * drift from them. What the rewrite leaves alone is what is not a name: a quoted word that is
 * neither a page id nor a component id (`"page"` as the value of `validation.continue`, a route's
 * unknown target), and an id with no label (said as it is, the fall back).
 *
 * In the designer's lazy chunk. Pure: nothing here runs at import.
 */
import type { JourneyDiagnostic } from "../../core/journey/journey-diagnostics.js";

/** What the author called things: what the check is told to say them as. */
export interface FindingNames {
  /** A step's name by its written page id; `undefined` for an id no step has. */
  step(pageId: string): string | undefined;
  /** A form field's label by its component id; `undefined` for an id the form does not have, or one with no label to say. */
  field(componentId: string): string | undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A name as a sentence quotes it: curly, as the inspector's own findings quote an id. */
function quoted(name: string): string {
  return `“${name}”`;
}

/**
 * `text` with each match of the global `pattern` replaced by `say(found, ...groups)`, but only outside its quotes:
 * a quoted id is a name, looked up as it is written (`"About page 2"`), so a match inside one is left as it is.
 */
function replaceOutsideQuotes(text: string, pattern: RegExp, say: (found: string, ...groups: string[]) => string): string {
  const quotes = [...text.matchAll(/"[^"\n]+"/g)].map((quote) => [quote.index, quote.index + quote[0].length] as const);
  return text.replace(pattern, (found: string, ...rest: unknown[]) => {
    const at = rest.findIndex((part) => typeof part === "number");
    const offset = rest[at] as number;
    return quotes.some(([start, end]) => offset > start && offset < end) ? found : say(found, ...(rest.slice(0, at) as string[]));
  });
}

/** "Page" and "page", "pages", as words: not a hyphened or dotted part of an id, and not a quoted value (`"page"`). */
const PAGE_WORD = /(?<![\w\-.“"])(Page|page)(s?)(?![\w\-]|\.\w|["”])/g;

/** The words the diagnostics' own sentences are made of that a component could also be called: left as words. */
const MESSAGE_WORDS: ReadonlySet<string> = new Set(["form", "page", "pages", "step", "steps", "journey", "default", "required", "rule", "rules", "host", "server", "answer", "answers", "field", "fields", "browser", "path", "value", "title", "label", "hidden", "id"]);

/** The words of `diagnostic` for the builder's author (see the module comment). */
export function wordDiagnostic(diagnostic: JourneyDiagnostic, names: FindingNames): string {
  let text = diagnostic.message;
  if (diagnostic.journeyId !== "") {
    text = text.replace(new RegExp(`([Jj])ourney "${escapeRegExp(diagnostic.journeyId)}"`, "g"), (_found, initial: string) => `${initial === "J" ? "This" : "this"} journey`);
  }
  // Outside the quotes: a quoted id is looked up below as it is written, and may hold the word itself.
  text = replaceOutsideQuotes(text, PAGE_WORD, (_found, word, plural) => `${word === "Page" ? "Step" : "step"}${plural}`);
  // The fields the finding is about, said bare in most messages ("fullName is on no page"): wherever they stand outside
  // the quotes, but not as a call (`age()`) and not an id that is also a word of the messages themselves.
  for (const id of new Set([diagnostic.componentId, diagnostic.requiredField])) {
    const label = id !== undefined ? names.field(id) : undefined;
    if (id !== undefined && label !== undefined && label !== id && !MESSAGE_WORDS.has(id)) {
      const bare = new RegExp(`(?<![\\w\\-.\u201c"])${escapeRegExp(id)}(?![\\w\\-\u201d"(]|\\.\\w)`, "g");
      text = replaceOutsideQuotes(text, bare, () => label);
    }
  }
  // Every quoted id: a step's after the word step or steps (a list of them too), else a step's when the form has no
  // such field, else a field's.
  return text.replace(/"([^"\n]+)"/g, (found, id: string, at: number) => {
    const before = text.slice(0, at);
    if (/validation\.\w+ is\s*$/.test(before)) {
      return found;
    }
    const step = names.step(id);
    const field = names.field(id);
    const afterStep = /[Ss]teps?\s+(?:"[^"\n]*"(?:,\s+|\s+and\s+|\s+or\s+))*$/.test(before);
    if (step !== undefined && (afterStep || field === undefined)) {
      return step === id ? found : quoted(step);
    }
    return field !== undefined && field !== id ? quoted(field) : found;
  });
}
