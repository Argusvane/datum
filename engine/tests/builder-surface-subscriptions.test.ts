// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { defineBuilderData, DATUM_BUILDER_DATA_TAG } from "../form-engine/builder/data/data-surface.js";
import { defineLanguagesSurface, DATUM_BUILDER_LANGUAGES_TAG } from "../form-engine/builder/languages/languages-surface.js";
import { defineBuilderLogic, DATUM_BUILDER_LOGIC_TAG } from "../form-engine/builder/logic/logic-surface.js";
import { defineBuilderOverview, DATUM_BUILDER_OVERVIEW_TAG } from "../form-engine/builder/overview/overview-surface.js";
import { languagesController } from "./fixtures/builder-languages.js";

/*
 * A surface the shell drops (the builder was moved on the page and rebuilt its markup) must not
 * stay in its controller's listener list: the controller outlives the element. Each surface lets
 * go of the controller's change events on disconnect and takes them again on connect, while
 * keeping the controller itself (its setter owns the leave guard, which a disconnect must not
 * disturb beyond what each surface already did).
 */

defineBuilderLogic();
defineBuilderData();
defineLanguagesSurface();
defineBuilderOverview();

afterEach(() => {
  document.body.innerHTML = "";
});

/** The controller with a count of the "change" listeners that are live right now. */
function counted(controller: BuilderController): { live: () => number } {
  const on = controller.on.bind(controller) as BuilderController["on"];
  let live = 0;
  controller.on = ((type: Parameters<BuilderController["on"]>[0], listener: never) => {
    const off = on(type, listener);
    if (type !== "change") {
      return off;
    }
    live += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        live -= 1;
      }
      off();
    };
  }) as BuilderController["on"];
  return { live: () => live };
}

type Surface = HTMLElement & { controller: BuilderController | undefined };

describe.each([
  { name: "Logic", tag: DATUM_BUILDER_LOGIC_TAG, paints: true },
  { name: "Data", tag: DATUM_BUILDER_DATA_TAG, paints: true },
  { name: "Overview", tag: DATUM_BUILDER_OVERVIEW_TAG, paints: true },
  // Languages only paints while connected anyway; the listener count is what shows the leak.
  { name: "Languages", tag: DATUM_BUILDER_LANGUAGES_TAG, paints: false }
])("the $name surface and its controller's change events", ({ tag, paints }) => {
  function mount(): { surface: Surface; controller: BuilderController; live: () => number } {
    const controller = languagesController();
    const { live } = counted(controller);
    const surface = document.createElement(tag) as Surface;
    surface.controller = controller;
    document.body.append(surface);
    return { surface, controller, live };
  }

  /** A change the way the controller announces one, without depending on which edit makes it. */
  const announce = (controller: BuilderController): void => {
    (controller as unknown as { emit(type: string, event: { reason: string }): void }).emit("change", { reason: "edit" });
  };

  it("listens once while connected", () => {
    const { live } = mount();
    expect(live()).toBe(1);
  });

  it("lets go when removed and takes the controller again, once, when re-appended", () => {
    const { surface, controller, live } = mount();

    surface.remove();
    expect(live()).toBe(0);
    // The controller stays: only the subscription goes.
    expect(surface.controller).toBe(controller);

    document.body.append(surface);
    expect(live()).toBe(1);

    surface.remove();
    document.body.append(surface);
    expect(live()).toBe(1);
  });

  it.runIf(paints)("is not called into by a change while removed, and is again once back", () => {
    const { surface, controller } = mount();
    const paint = vi.spyOn(surface as unknown as { paint(): void }, "paint");

    surface.remove();
    paint.mockClear();
    announce(controller);
    expect(paint).not.toHaveBeenCalled();

    document.body.append(surface);
    // Coming back repaints once, from the controller's present state.
    expect(paint).toHaveBeenCalledTimes(1);
    paint.mockClear();
    announce(controller);
    expect(paint).toHaveBeenCalled();
  });

  it("does not subscribe before it is on the page, and gets the new controller's events once there", () => {
    const first = languagesController();
    const second = languagesController();
    const countFirst = counted(first);
    const countSecond = counted(second);
    const surface = document.createElement(tag) as Surface;
    surface.controller = first;
    expect(countFirst.live()).toBe(0);

    document.body.append(surface);
    expect(countFirst.live()).toBe(1);

    surface.controller = second;
    expect(countFirst.live()).toBe(0);
    expect(countSecond.live()).toBe(1);

    surface.remove();
    expect(countSecond.live()).toBe(0);
  });
});
