/**
 * What a plugin package's bundle entry imports: the page's shared plugin registry
 * and nothing else, so the bundle does not pull in the renderer or the builder. Not an export of the published package: a module of this package's source, which only the test fixture `tests/fixtures/acme-components-bundle.ts` imports (by path).
 */
export { plugins, type DatumPluginRegistry } from "./plugins.js";
