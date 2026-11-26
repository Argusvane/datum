/**
 * What a form definition may weigh when it is loaded again, and the words for a file the
 * builder would embed in it. An uploaded PDF template or an ICC profile travels inside the
 * definition as base64; a definition past the load limit (`src`, Open: 2 MiB unless the page
 * raises `max-definition-bytes`) saves and can never be opened again, so the builder asks before
 * it embeds a file and refuses, with the numbers, the one that would tip the form over.
 */
import { builderText, type BuilderTextKey, type BuilderTextOptions } from "./logic/builder-texts.js";

/**
 * The serialized weight a definition would have, and the most one may weigh when it is loaded:
 * both in UTF-8 bytes of its JSON, the way the load path counts them.
 */
export interface DefinitionBudget {
  size: number;
  limit: number;
}

const KIB = 1024;
const MIB = KIB * KIB;

/**
 * A size in the words of the message: kilobytes below a megabyte, else megabytes to two places.
 * `up` rounds a weight up and `down` rounds a limit down, so a weight over its limit never
 * reads as equal to it ("2.01 MB" against "2 MB", not "2 MB" against "2 MB").
 */
export function sizeWords(bytes: number, direction: "up" | "down"): string {
  const round = direction === "up" ? Math.ceil : Math.floor;
  if (bytes < MIB) {
    return `${Math.max(1, round(bytes / KIB))} KB`;
  }
  return `${String(round((bytes / MIB) * 100) / 100)} MB`;
}

/**
 * The refusal for a file of `bytes` bytes, said under `key`, when the form would weigh more than
 * `budget.limit` with it in; `undefined` when it fits or when nothing says what the form would weigh.
 */
export function embeddedBytesProblem(key: BuilderTextKey, name: string, bytes: number, budget: DefinitionBudget | undefined, text?: BuilderTextOptions): string | undefined {
  if (budget === undefined || budget.size <= budget.limit) {
    return undefined;
  }
  return builderText(key, { name, size: sizeWords(bytes, "up"), total: sizeWords(budget.size, "up"), limit: sizeWords(budget.limit, "down") }, text);
}
