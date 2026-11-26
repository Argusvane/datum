// Injected at the very top of the bundled program (see scripts/build-program.mjs): the byte
// libraries construct a TextEncoder at module load, so the polyfills must exist before any
// module body runs — not only before the first request.
import { installPdfProgramPolyfills } from "./polyfills.js";

installPdfProgramPolyfills();
