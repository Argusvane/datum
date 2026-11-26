/**
 * The live renderer as a host mounts it: the draw loop, the Datum binding and the one list of
 * the renderer's modules (`createDatumFeatures`). A host takes the feature list from here
 * rather than assembling its own, so the element, the builder canvas and the binding checks
 * never drift apart in what they draw; a journey form adds the journey kit's page module, which
 * lives in the journeys chunk.
 *
 * This module reaches lit-html (the renderer's one copy, `lit.ts`). The engine surface a binding
 * reads without lit is `index.ts`; the contract types are `contract.ts`.
 */
export { mountLive, type CanvasHooks, type DrawnBy, type FormRegion, type LiveFeature, type LiveForm, type LiveMountOptions, type LiveRuntime, type LiveSelfCheck } from "./mount.js";
export {
  createDatumBinding,
  createDatumFeatures,
  DATUM_BINDING_ID,
  type DatumBinding,
  type DatumBindingOptions,
  type DatumFeatureOptions
} from "./datum/options.js";
