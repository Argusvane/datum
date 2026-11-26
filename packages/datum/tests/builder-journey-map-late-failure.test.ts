import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/*
 * A Journeys map whose chunk fails after the builder has left the page. Its own file,
 * and the first thing in it, for the reason the Map view's first case is first in its file: the
 * map's chunk must not have loaded yet, so the mock is what the designer's first load meets.
 *
 * A failure reported on a host that is off the page must not throw. In a run that is ending (a test
 * file finishing while the chunk is still on its way) the page's realm is going: an event built
 * after that is refused by `dispatchEvent`, and the throw would come out of the load's handler as
 * an unhandled rejection that ends the whole run with exit 1.
 */

const MAP_MODULE = "../../../engine/form-engine/builder/journey-map/journey-map.js";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("<datum-form-builder> journeys: a map chunk that fails once the builder is gone", () => {
  it("reports nothing and redraws nothing: a host off the page has nobody to tell", async () => {
    let fail: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      fail = resolve;
    });
    const element = document.createElement("datum-form-builder");
    element.setAttribute("pdf", "off");
    element.definition = {
      ...sampleDefinition(),
      journey: { journeys: [{ id: "map", name: "Map", pages: [{ id: "start", title: "Start", components: ["fullName"] }] }] }
    };
    const errors: string[] = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    document.body.append(element);
    vi.doMock(MAP_MODULE, async () => {
      await gate;
      throw new Error("chunk missing");
    });
    try {
      await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
      element.mode = "journeys";
      await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
      // The map is wanted and its chunk is on its way; the builder leaves the page; then the chunk fails.
      expect(element.journeyMode!.view).toBe("map");
      element.remove();
      fail();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(errors).toEqual([]);
      expect(unhandled).toEqual([]);
      expect(element.journeyMode!.view).toBe("map");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      vi.doUnmock(MAP_MODULE);
    }
  });
});
