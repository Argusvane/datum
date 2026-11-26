// Text imports of the kit's fixture files (`./file?raw`). Vitest (Vite) reads them natively; the
// bundle reads them through the raw-text plugin in scripts/host-check-bundle.mjs. Kept as text, not
// parsed JSON, so `datum-host-check fixtures` writes the very bytes the Java kit packages
// (TckFixtures.formBytes reads the file, never a re-serialisation).
declare module "*?raw" {
  const text: string;
  export default text;
}
