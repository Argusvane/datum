import { describe, expect, it } from "vitest";

import { EventBus } from "../form-engine/core/events/event-bus.js";

describe("event bus", () => {
  it("publishes events to exact and wildcard listeners", () => {
    const bus = new EventBus();
    const seen: string[] = [];

    bus.subscribe("FORM_LOADED", () => seen.push("exact"));
    bus.subscribe("*", () => seen.push("wildcard"));

    bus.publish({
      id: "e1",
      type: "FORM_LOADED",
      timestamp: 1,
      source: "runtime",
      formId: "f1"
    });

    expect(seen).toEqual(["exact", "wildcard"]);
  });

  it("supports unsubscribe", () => {
    const bus = new EventBus();
    const seen: string[] = [];

    const off = bus.subscribe("FORM_LOADED", () => seen.push("hit"));
    off();

    bus.publish({
      id: "e1",
      type: "FORM_LOADED",
      timestamp: 1,
      source: "runtime",
      formId: "f1"
    });

    expect(seen).toEqual([]);
  });
});
