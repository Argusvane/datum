// Its own module: a page reads the name eagerly (to allow it in its trusted-types directive), and
// the frame that parses through it loads with print() (print-pipeline.ts).

/** The Trusted Types policy the print document is parsed through, for a host that enforces them. */
export const PRINT_TRUSTED_TYPES_POLICY = "datum-print";
