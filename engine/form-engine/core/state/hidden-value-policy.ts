import type { EffectiveNodeState } from "./effective-state.js";
import type { FormValues } from "./form-state.js";

/**
 * Applies hidden-value policy to a value snapshot, producing the view that should be
 * validated / submitted.
 *
 * For each value keyed by component id (flat forms) the effective state decides:
 *  - `submitValue === false`  -> the key is omitted entirely (`exclude-from-submission`)
 *  - `clearValue === true`    -> the key is retained but set to `undefined` (`clear`)
 *  - otherwise                -> the value is passed through unchanged (`retain`)
 *
 * Keys with no matching effective state are passed through unchanged. Nested / collection
 * path keys (`foo[0].bar`) are judged by the repeating section `collectionOwnerOf` names for
 * them — wherever its `collectionPath` puts its entries — else by their leading
 * segment; unmatched keys pass through until the collection runtime supplies per-row
 * effective state. The order — owner, key as an id, section, leading segment — is
 * the submittable fold's (`kernelApplyValuePolicy`), so the browser leaves out exactly what the
 * validation kernel does.
 */
export function applyHiddenValuePolicy(
  values: FormValues,
  effectiveStates: ReadonlyMap<string, EffectiveNodeState>,
  /**
   * Maps a value-path key back to the component that owns it. Needed once a data-scoping
   * `container` moves a datum: `applicant.email` is keyed under the container's id, and
   * falling back to the leading segment would apply the *container's* policy to the field
   * inside it. Omit for a flat form, where the key is the component id.
   */
  componentIdForPath?: (path: string) => string | undefined,
  /**
   * The repeating section whose entries a key belongs to (the runtime orchestrator's
   * `collectionOwnerOf`): `order_lines[0].sku` to the section stored at `order_lines`. Omit
   * for a form whose sections keep their entries under their own id, which the leading
   * segment already finds.
   */
  collectionOwnerOf?: (key: string) => string | undefined
): FormValues {
  const output: FormValues = {};

  for (const [key, value] of Object.entries(values)) {
    const ownerId = componentIdForPath?.(key);
    const sectionId = collectionOwnerOf?.(key);
    const state =
      (ownerId !== undefined ? effectiveStates.get(ownerId) : undefined) ??
      effectiveStates.get(key) ??
      (sectionId !== undefined ? effectiveStates.get(sectionId) : undefined) ??
      effectiveStates.get(leadingSegment(key));
    if (!state) {
      output[key] = value;
      continue;
    }

    if (!state.submitValue) {
      continue;
    }

    output[key] = state.clearValue ? undefined : value;
  }

  return output;
}

function leadingSegment(pathKey: string): string {
  const bracket = pathKey.indexOf("[");
  const dot = pathKey.indexOf(".");
  const cut = [bracket, dot].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  return cut === undefined ? pathKey : pathKey.slice(0, cut);
}
