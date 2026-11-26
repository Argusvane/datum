// The parts of binding-package.mjs that TypeScript files of the kit use (conformance.ts).
export const BINDINGS_ROOT: string;
export interface BindingPackage {
  id: string;
  isDatum: boolean;
  dir: string | undefined;
  entry: string | undefined;
  assetsFile: string | undefined;
}
/** `datum`, `bindings/<id>`, or the path of a binding package; throws a message that says what is missing. */
export function resolveBinding(id: string): BindingPackage;
