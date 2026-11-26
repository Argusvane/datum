/**
 * Labels that follow a media query, written once for every binding.
 *
 * A control whose accessible name depends on the pointer (USWDS names its file input "Drag file
 * here or choose from folder" where a fine, hovering pointer can drag, "Choose from folder"
 * elsewhere) carries `data-label-media` (the query), `data-label-matches` and
 * `data-label-otherwise` (the names). After every draw, and whenever a query changes, the
 * renderer sets `aria-label` to the name that matches. The attributes alone stand where there is
 * no `matchMedia` (jsdom, a server): the control keeps the name its markup gave it.
 *
 * A {@link LiveFeature} the host lists in `features`; one object per mount.
 */
import type { LiveContext, LiveFeature } from "./mount.js";

/** The attribute naming the media query. */
export const LABEL_MEDIA_ATTRIBUTE = "data-label-media";

export function createMediaLabelsFeature(): LiveFeature {
  const queries = new Map<string, MediaQueryList>();
  let current: LiveContext | undefined;

  const apply = (live: LiveContext): void => {
    if (!live.mounted() || typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    for (const element of Array.from(live.root.querySelectorAll<HTMLElement>(`[${LABEL_MEDIA_ATTRIBUTE}]`))) {
      const query = element.dataset.labelMedia;
      if (!query) {
        continue;
      }
      let media = queries.get(query);
      if (!media) {
        try {
          media = window.matchMedia(query);
        } catch {
          continue;
        }
        media.addEventListener?.("change", onChange);
        queries.set(query, media);
      }
      const name = media.matches ? element.dataset.labelMatches : element.dataset.labelOtherwise;
      if (name !== undefined) {
        element.setAttribute("aria-label", name);
      }
    }
  };

  function onChange(): void {
    if (current) {
      apply(current);
    }
  }

  return {
    id: "media-labels",
    start(live) {
      current = live;
      return () => {
        for (const media of queries.values()) {
          media.removeEventListener?.("change", onChange);
        }
        queries.clear();
        current = undefined;
      };
    },
    afterDraw(_report, live) {
      apply(live);
    }
  };
}
