import { describe, expect, it } from "vitest";

import { FormStateStore } from "../form-engine/core/state/form-state.js";
import { parseComponentPath } from "../form-engine/core/tree/component-path.js";

describe("form state store", () => {
  it("tracks values, touched, and dirty", () => {
    const store = new FormStateStore("en-CA");
    const path = parseComponentPath("firstName");

    store.setValue(path, "Ada");
    store.markTouched(path);

    const state = store.snapshot();
    expect(state.values.firstName).toBe("Ada");
    expect(state.dirty.has("firstName")).toBe(true);
    expect(state.touched.has("firstName")).toBe(true);
  });

  it("changes locale without resetting values", () => {
    const store = new FormStateStore("en-CA");
    const path = parseComponentPath("postalCode");

    store.setValue(path, "H2Y 1C6");
    store.setLocale("fr-CA");

    const state = store.snapshot();
    expect(state.locale).toBe("fr-CA");
    expect(state.values.postalCode).toBe("H2Y 1C6");
  });

  it("readView is live and snapshot is an independent copy", () => {
    const store = new FormStateStore("en");
    const path = parseComponentPath("a");
    store.setValue(path, 1);
    const view = store.readView();
    const copy = store.snapshot();
    store.setValue(path, 2);
    expect(view.values.a).toBe(2);
    expect(copy.values.a).toBe(1);
    expect(view.dirty).toBe(store.readView().dirty);
    expect(copy.dirty).not.toBe(view.dirty);
  });

  it("abandonSubmission settles an attempt back to idle and keeps the attempt counted", () => {
    const store = new FormStateStore("en");
    store.beginSubmission();
    expect(store.snapshot().submission).toMatchObject({ status: "submitting", attempts: 1 });
    store.abandonSubmission();
    expect(store.snapshot().submission).toMatchObject({ status: "idle", attempts: 1 });
    expect(store.readView().submission.status).toBe("idle");
    // A later attempt counts on from there.
    store.beginSubmission();
    expect(store.snapshot().submission).toMatchObject({ status: "submitting", attempts: 2 });
  });
});
