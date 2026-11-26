/**
 * Everything, for a TypeScript or bundler consumer of the package itself: both elements and
 * the API behind them. Pages loading the built bundles use `dist/datum-form.js` or
 * `dist/datum-builder.js` instead (see `form.ts` and `builder.ts`).
 */
export * from "./builder.js";
