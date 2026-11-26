import type { LiveContext, LiveFeature } from "./mount.js";

/**
 * The live renderer's assets feature: before the first draw it adopts the host's `assets` for the
 * mount's binding (its font sheet keyed by the binding's id, its rem expectation from
 * `designSystem.rootFontSize`), and gives them back on unmount. A file that cannot be had fails
 * the mount (the renderer draws the alert and emits `datum-binding-error {hook: "assets", url}`);
 * a font sheet that cannot be had is reported with the same event and the form still draws.
 * Datum's own binding has no host files and never takes this path, so the loader and rewriter
 * (`assets.ts`) load only when a mount has files to adopt: a bundler splits them into their own
 * chunk, and a chunk that cannot be had fails the mount as a file would.
 */
export function assetsFeature(): LiveFeature {
  return {
    id: "assets",
    async prepare(live: LiveContext) {
      const assets = live.options.assets;
      if (!assets || ((assets.stylesheets?.length ?? 0) === 0 && (assets.fonts?.length ?? 0) === 0 && (assets.scripts?.length ?? 0) === 0)) {
        return undefined;
      }
      const { adoptInto } = await import("./assets.js");
      const expected = live.binding.designSystem?.rootFontSize;
      const adopted = await adoptInto(live.root, assets, {
        bindingId: live.binding.id,
        ...(expected !== undefined ? { expectedRootFontSize: expected } : {}),
        onFontError: (failure) => live.error({ hook: "assets", message: failure.message, ...(failure.url !== undefined ? { url: failure.url } : {}) })
      });
      return () => adopted.release();
    }
  };
}
