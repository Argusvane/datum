// The kit's extra host module: what the kit page (page/kit-page.js) needs beside the conformance
// suite's host module (packages/conformance-suite/binding-check/host/entry.ts, which the page imports
// too: the runtime, lit and Datum's binding). It is built in the same esbuild run as that module and
// the binding under test, so the three share one copy of the engine and of lit.
//
//   adoptInto, loadScript   the renderer's own asset loading: the reference markup runs in a shadow
//                           root with the design system's files adopted the way a form's are, which is
//                           how the kit separates what a shadow root costs from what a binding costs
//   the element             the real <datum-form-renderer>, for the cases that move it in the DOM
export { adoptInto, loadScript } from "../../../../engine/form-engine/render/live/assets.js";
export { DATUM_FORM_RENDERER_TAG, defineDatumFormRendererElement } from "../../../../engine/form-engine/render/web-component/form-renderer-element.js";
// What the binding lint checks `fallbackTokens` names against.
export { FORM_TOKENS } from "../../../../engine/form-engine/render/live/datum/tokens.js";
