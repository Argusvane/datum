import { CANONICAL_VECTORS } from "./canonical.js";
import { CONTEXT_VECTORS } from "./context.js";
import { FILE_VECTORS } from "./files.js";
import { OPTIONS_VECTORS } from "./options.js";
import { RESOURCE_VECTORS } from "./resources.js";
import { SECRECY_VECTORS } from "./secrecy.js";
import type { Vector } from "./schema.js";

/** The program-side packs, in report order (resources, options, files, context, canonical, secrecy). */
export const PROGRAM_PACK_VECTORS: Vector[] = [...RESOURCE_VECTORS, ...OPTIONS_VECTORS, ...FILE_VECTORS, ...CONTEXT_VECTORS, ...CANONICAL_VECTORS, ...SECRECY_VECTORS];
