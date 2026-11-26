// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { attachSheetGestures, type SheetGestureOptions } from "../form-engine/builder/web-component/sheet-gestures.js";

/**
 * The phone sheets' gestures. jsdom has no touch and no
 * layout, so the tests dispatch pointer and touch events at a handle, drive the clock by hand,
 * and read the sheet's inline transform and the callbacks.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

interface Rig {
  sheet: HTMLElement;
  head: HTMLElement;
  grab: HTMLButtonElement;
  close: HTMLButtonElement;
  clock: { t: number };
  calls: string[];
  dispose: () => void;
}

/** Every rig's dispose, run after each test so a click guard cannot leak into the next one. */
const rigs: Array<() => void> = [];
afterEach(() => {
  for (const dispose of rigs.splice(0)) {
    dispose();
  }
  // A click guard outlives its sheet on purpose; one real click in a moment spends it.
  for (let i = 0; i < 6; i += 1) {
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  }
});

function rig(extra: Partial<SheetGestureOptions> = {}, options: { expanded?: boolean; height?: number } = {}): Rig {
  const sheet = document.createElement("div");
  const head = document.createElement("div");
  const grab = document.createElement("button");
  const close = document.createElement("button");
  head.append(grab, close);
  sheet.append(head);
  document.body.append(sheet);
  sheet.getBoundingClientRect = () => ({ top: 400, bottom: 400 + (options.height ?? 300), left: 0, right: 390, width: 390, height: options.height ?? 300, x: 0, y: 400, toJSON: () => ({}) }) as DOMRect;
  const clock = { t: 0 };
  const calls: string[] = [];
  const dispose = attachSheetGestures(sheet, {
    handle: head,
    grab,
    follow: [],
    onDismiss: () => calls.push("dismiss"),
    onExpand: () => calls.push("expand"),
    onCollapse: () => calls.push("collapse"),
    isExpanded: () => options.expanded ?? false,
    now: () => clock.t,
    reducedMotion: () => false,
    ...extra
  });
  rigs.push(dispose);
  return { sheet, head, grab, close, clock, calls, dispose };
}

interface PointerExtra {
  pointerId?: number;
  isPrimary?: boolean;
  pointerType?: string;
  button?: number;
}

/** jsdom has no PointerEvent: a mouse event with the pointer fields the code reads. */
function pointer(type: string, target: Element, x: number, y: number, extra: PointerExtra = {}): void {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, composed: true, cancelable: true, button: extra.button ?? 0 });
  Object.defineProperties(event, {
    pointerId: { value: extra.pointerId ?? 7 },
    isPrimary: { value: extra.isPrimary ?? true },
    pointerType: { value: extra.pointerType ?? "touch" }
  });
  target.dispatchEvent(event);
}

/** A finger down on `target`, then `steps` moves of `dy` px spaced `ms` apart, then up. */
function drag(r: Rig, target: Element, dy: number, ms: number, steps = 8, dx = 0): void {
  pointer("pointerdown", target, 100, 500);
  for (let i = 1; i <= steps; i += 1) {
    r.clock.t += ms / steps;
    pointer("pointermove", target, 100 + (dx * i) / steps, 500 + (dy * i) / steps);
  }
  pointer("pointerup", target, 100 + dx, 500 + dy);
}

describe("sheet gestures: a handle dragged with pointer events", () => {
  it("follows the finger down, never above its rest position", () => {
    const r = rig();
    pointer("pointerdown", r.head, 100, 500);
    r.clock.t = 50;
    pointer("pointermove", r.head, 100, 560);
    expect(r.sheet.style.transform).toBe("translateY(60px)");
    expect(r.sheet.style.transition).toBe("none");
    // Back up past where it started: at rest, not above.
    r.clock.t = 100;
    pointer("pointermove", r.head, 100, 497);
    expect(r.sheet.style.transform).toBe("");
    pointer("pointerup", r.head, 100, 497);
    expect(r.calls).toEqual([]);
  });

  it("snaps back under the threshold with a short transition", () => {
    const r = rig();
    drag(r, r.head, 40, 400);
    expect(r.calls).toEqual([]);
    expect(r.sheet.style.transform).toBe("");
    expect(r.sheet.style.transition).toContain("transform");
  });

  it("dismisses over the threshold", () => {
    const r = rig();
    drag(r, r.head, 200, 800);
    expect(r.calls).toEqual(["dismiss"]);
  });

  it("dismisses on a fast fling that is under the threshold", () => {
    const r = rig();
    drag(r, r.head, 60, 50);
    expect(r.calls).toEqual(["dismiss"]);
  });

  it("does not fling on a slow drag, nor after the finger rests before it lifts", () => {
    const r = rig();
    pointer("pointerdown", r.head, 100, 500);
    r.clock.t = 20;
    pointer("pointermove", r.head, 100, 560);
    // Held still for half a second, then lifted: the speed is gone.
    r.clock.t = 520;
    pointer("pointerup", r.head, 100, 560);
    expect(r.calls).toEqual([]);
  });

  it("takes a third of the sheet as the threshold, at least 80 px", () => {
    const tall = rig({}, { height: 600 });
    drag(tall, tall.head, 150, 900);
    expect(tall.calls).toEqual([]);
    drag(tall, tall.head, 210, 1200);
    expect(tall.calls).toEqual(["dismiss"]);
    const short = rig({}, { height: 120 });
    drag(short, short.head, 70, 900);
    expect(short.calls).toEqual([]);
    drag(short, short.head, 90, 900);
    expect(short.calls).toEqual(["dismiss"]);
  });

  it("honours a threshold the caller gives", () => {
    const r = rig({ dismissThresholdPx: 30, flingVelocity: 99 });
    drag(r, r.head, 40, 800);
    expect(r.calls).toEqual(["dismiss"]);
  });

  it("expands on a drag up, once, and not when already expanded", () => {
    const r = rig();
    drag(r, r.head, -60, 400);
    expect(r.calls).toEqual(["expand"]);
    expect(r.sheet.style.transform).toBe("");
    const open = rig({}, { expanded: true });
    drag(open, open.head, -60, 400);
    expect(open.calls).toEqual([]);
  });

  it("expands on a short fast flick up", () => {
    const r = rig();
    drag(r, r.head, -30, 40);
    expect(r.calls).toEqual(["expand"]);
  });

  it("toggles on a tap of the grab button: under 6 px of travel", () => {
    const r = rig();
    pointer("pointerdown", r.grab, 100, 500);
    pointer("pointerup", r.grab, 102, 503);
    expect(r.calls).toEqual(["expand"]);
    const open = rig({}, { expanded: true });
    pointer("pointerdown", open.grab, 100, 500);
    pointer("pointerup", open.grab, 100, 500);
    expect(open.calls).toEqual(["collapse"]);
  });

  it("a tap on the grabber of a tall sheet collapses it, and the click that follows lands on a scrim that does not hear it", () => {
    const r = rig({}, { expanded: true });
    const scrim = document.createElement("div");
    document.body.append(scrim);
    const scrimClicked = vi.fn();
    scrim.addEventListener("click", scrimClicked);
    pointer("pointerdown", r.grab, 100, 500);
    pointer("pointerup", r.grab, 100, 500);
    expect(r.calls).toEqual(["collapse"]);
    expect(r.calls).not.toContain("dismiss");
    // The synthesised click lands on the scrim now the sheet has shrunk.
    scrim.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(scrimClicked).not.toHaveBeenCalled();
    // One click only: the next one reaches the scrim.
    scrim.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(scrimClicked).toHaveBeenCalledTimes(1);
    scrim.remove();
  });

  it("the scrim guard lets a keyboard click through and runs out after a moment", () => {
    vi.useFakeTimers();
    try {
      const r = rig({}, { expanded: true });
      const scrim = document.createElement("div");
      document.body.append(scrim);
      const scrimClicked = vi.fn();
      scrim.addEventListener("click", scrimClicked);
      pointer("pointerdown", r.grab, 100, 500);
      pointer("pointerup", r.grab, 100, 500);
      scrim.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
      expect(scrimClicked).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(500);
      scrim.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      expect(scrimClicked).toHaveBeenCalledTimes(2);
      scrim.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a tap on another button of the row alone, and does not swallow its click", () => {
    const r = rig();
    const clicked = vi.fn();
    r.close.addEventListener("click", clicked);
    pointer("pointerdown", r.close, 100, 500);
    pointer("pointerup", r.close, 100, 500);
    r.close.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(r.calls).toEqual([]);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("swallows the click that follows a tap on the grab or a drag, but not a keyboard click", () => {
    const r = rig();
    const seen = vi.fn();
    r.sheet.addEventListener("click", seen);
    pointer("pointerdown", r.grab, 100, 500);
    pointer("pointerup", r.grab, 100, 500);
    r.grab.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(seen).not.toHaveBeenCalled();
    // Enter or Space on the focused handle: detail 0, the button's own click.
    r.grab.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(seen).toHaveBeenCalledTimes(1);
    drag(r, r.grab, 30, 400);
    r.grab.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("captures the pointer when the drag starts, not at the press", () => {
    const r = rig();
    const capture = vi.fn();
    r.head.setPointerCapture = capture;
    pointer("pointerdown", r.head, 100, 500);
    expect(capture).not.toHaveBeenCalled();
    pointer("pointermove", r.head, 100, 503);
    expect(capture).not.toHaveBeenCalled();
    pointer("pointermove", r.head, 100, 520);
    expect(capture).toHaveBeenCalledWith(7);
  });

  it("puts the sheet back when the pointer is cancelled", () => {
    const r = rig();
    pointer("pointerdown", r.head, 100, 500);
    r.clock.t = 20;
    pointer("pointermove", r.head, 100, 700);
    expect(r.sheet.style.transform).toBe("translateY(200px)");
    pointer("pointercancel", r.head, 100, 700);
    expect(r.calls).toEqual([]);
    expect(r.sheet.style.transform).toBe("");
  });

  it("ignores another pointer, a right mouse button and a non-primary touch", () => {
    const r = rig();
    pointer("pointerdown", r.head, 100, 500, { pointerType: "mouse", button: 2 });
    pointer("pointermove", r.head, 100, 700, { pointerType: "mouse" });
    expect(r.sheet.style.transform).toBe("");
    pointer("pointerdown", r.head, 100, 500, { isPrimary: false, pointerId: 9 });
    pointer("pointermove", r.head, 100, 700, { pointerId: 9 });
    expect(r.sheet.style.transform).toBe("");
  });

  it("takes a mouse drag the same way", () => {
    const r = rig();
    drag(r, r.head, 200, 800);
    expect(r.calls).toEqual(["dismiss"]);
    const m = rig();
    pointer("pointerdown", m.head, 100, 500, { pointerType: "mouse" });
    m.clock.t = 700;
    pointer("pointermove", m.head, 100, 700, { pointerType: "mouse" });
    pointer("pointerup", m.head, 100, 700, { pointerType: "mouse" });
    expect(m.calls).toEqual(["dismiss"]);
  });

  it("snaps back when the sheet refuses to go, and moves the followers with it", () => {
    const follower = document.createElement("div");
    document.body.append(follower);
    const r = rig({ follow: [follower], onDismiss: () => undefined });
    pointer("pointerdown", r.head, 100, 500);
    r.clock.t = 20;
    pointer("pointermove", r.head, 100, 650);
    expect(follower.style.transform).toBe("translateY(150px)");
    pointer("pointerup", r.head, 100, 650);
    expect(follower.style.transform).toBe("");
    expect(r.sheet.style.transform).toBe("");
  });

  it("shrinks an expanded sheet on a slow drag only when asked, and a fling still dismisses", () => {
    const keep = rig({ shrinkOnDrag: true }, { expanded: true });
    drag(keep, keep.head, 200, 1600);
    expect(keep.calls).toEqual(["collapse"]);
    const fling = rig({ shrinkOnDrag: true }, { expanded: true });
    drag(fling, fling.head, 200, 60);
    expect(fling.calls).toEqual(["dismiss"]);
    const plain = rig({}, { expanded: true });
    drag(plain, plain.head, 200, 1600);
    expect(plain.calls).toEqual(["dismiss"]);
  });

  it("has no transition under reduced motion", () => {
    const r = rig({ reducedMotion: () => true });
    drag(r, r.head, 40, 400);
    expect(r.sheet.style.transform).toBe("");
    expect(r.sheet.style.transition).toBe("");
  });

  it("reads the media query for reduced motion by default", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    const sheet = document.createElement("div");
    const head = document.createElement("div");
    sheet.append(head);
    document.body.append(sheet);
    const clock = { t: 0 };
    attachSheetGestures(sheet, { handle: head, onDismiss: () => undefined, now: () => clock.t });
    pointer("pointerdown", head, 100, 500);
    clock.t = 400;
    pointer("pointermove", head, 100, 540);
    pointer("pointerup", head, 100, 540);
    expect(window.matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(sheet.style.transition).toBe("");
    // @ts-expect-error put back for the other tests
    delete window.matchMedia;
  });

  it("says touch-action none on a vertical handle, pan-y on a drawer, none of it on a body, and gives it back on dispose", () => {
    // jsdom's style object drops touch-action: watch the calls instead.
    const set = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");
    const remove = vi.spyOn(CSSStyleDeclaration.prototype, "removeProperty");
    const r = rig();
    expect(set).toHaveBeenCalledWith("touch-action", "none");
    set.mockClear();
    rig({ direction: "left" });
    expect(set).toHaveBeenCalledWith("touch-action", "pan-y");
    set.mockClear();
    rig({ touchAction: null });
    expect(set).not.toHaveBeenCalledWith("touch-action", expect.anything());
    r.dispose();
    expect(remove).toHaveBeenCalledWith("touch-action");
  });

  it("stops listening and clears the sheet on dispose", () => {
    const r = rig();
    pointer("pointerdown", r.head, 100, 500);
    r.clock.t = 20;
    pointer("pointermove", r.head, 100, 700);
    r.dispose();
    expect(r.sheet.style.transform).toBe("");
    drag(r, r.head, 300, 100);
    expect(r.calls).toEqual([]);
  });

  it("starts a drag only where the filter allows", () => {
    const r = rig({ startFilter: (path) => path.includes(r.grab) });
    drag(r, r.close, 300, 100);
    expect(r.calls).toEqual([]);
    drag(r, r.grab, 300, 100);
    expect(r.calls).toEqual(["dismiss"]);
  });
});

describe("sheet gestures: a drawer swiped toward its edge", () => {
  it("follows a swipe left and dismisses over a third of its width", () => {
    const r = rig({ direction: "left" });
    pointer("pointerdown", r.head, 300, 500);
    r.clock.t = 100;
    pointer("pointermove", r.head, 240, 502);
    expect(r.sheet.style.transform).toBe("translateX(-60px)");
    r.clock.t = 800;
    pointer("pointermove", r.head, 100, 504);
    pointer("pointerup", r.head, 100, 504);
    expect(r.calls).toEqual(["dismiss"]);
  });

  it("leaves a mostly vertical move to the page's scroll, and a swipe the other way alone", () => {
    const r = rig({ direction: "left" });
    drag(r, r.head, 200, 300, 8, -10);
    expect(r.calls).toEqual([]);
    expect(r.sheet.style.transform).toBe("");
    drag(r, r.head, 4, 300, 8, 200);
    expect(r.calls).toEqual([]);
    expect(r.sheet.style.transform).toBe("");
  });

  it("claims a mostly horizontal swipe and releases a diagonal one (axis lock)", () => {
    const r = rig({ direction: "left" });
    // 200 left, 40 down: clearly horizontal.
    drag(r, r.head, 40, 800, 8, -200);
    expect(r.calls).toEqual(["dismiss"]);
    const diagonal = rig({ direction: "left" });
    // 100 left, 90 down: not by the margin, so the page scrolls instead.
    drag(diagonal, diagonal.head, 90, 800, 8, -100);
    expect(diagonal.calls).toEqual([]);
    expect(diagonal.sheet.style.transform).toBe("");
  });

  it("starts from a row inside the drawer and swallows the click that follows the swipe", () => {
    const r = rig({ direction: "left" });
    const row = document.createElement("button");
    r.head.append(row);
    const clicked = vi.fn();
    row.addEventListener("click", clicked);
    drag(r, row, 0, 800, 8, -200);
    expect(r.calls).toEqual(["dismiss"]);
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(clicked).not.toHaveBeenCalled();
  });

  it("goes the other way in a right-to-left page", () => {
    const r = rig({ direction: "right" });
    drag(r, r.head, 0, 800, 8, 200);
    expect(r.calls).toEqual(["dismiss"]);
  });
});

/** A touch event, which jsdom does not build: a plain event with the touches the code reads. */
function touch(type: string, target: Element, x: number, y: number): Event {
  const event = new Event(type, { bubbles: true, composed: true, cancelable: true });
  const point = { clientX: x, clientY: y };
  Object.defineProperty(event, "touches", { value: type === "touchend" || type === "touchcancel" ? [] : [point] });
  target.dispatchEvent(event);
  return event;
}

describe("sheet gestures: a body swiped down with touch events", () => {
  function body(): Rig & { body: HTMLElement; inner: HTMLElement } {
    const r = rig({}, {});
    r.dispose();
    const scroller = document.createElement("div");
    const inner = document.createElement("p");
    scroller.append(inner);
    r.sheet.append(scroller);
    const calls: string[] = [];
    const dispose = attachSheetGestures(r.sheet, {
      handle: scroller,
      input: "touch",
      follow: [],
      onDismiss: () => calls.push("dismiss"),
      now: () => r.clock.t,
      reducedMotion: () => false
    });
    return { ...r, calls, dispose, body: scroller, inner };
  }

  it("follows a swipe down from the top of the body and stops the page scrolling", () => {
    const r = body();
    touch("touchstart", r.inner, 100, 500);
    r.clock.t = 100;
    const first = touch("touchmove", r.inner, 100, 520);
    expect(first.defaultPrevented).toBe(true);
    expect(r.sheet.style.transform).toBe("translateY(20px)");
    r.clock.t = 700;
    touch("touchmove", r.inner, 100, 700);
    touch("touchend", r.inner, 100, 700);
    expect(r.calls).toEqual(["dismiss"]);
  });

  it("does nothing once the body is scrolled down, or on a swipe up", () => {
    const r = body();
    r.body.scrollTop = 40;
    touch("touchstart", r.inner, 100, 500);
    const moved = touch("touchmove", r.inner, 100, 700);
    expect(moved.defaultPrevented).toBe(false);
    touch("touchend", r.inner, 100, 700);
    expect(r.calls).toEqual([]);
    r.body.scrollTop = 0;
    touch("touchstart", r.inner, 100, 500);
    const up = touch("touchmove", r.inner, 100, 300);
    expect(up.defaultPrevented).toBe(false);
    touch("touchend", r.inner, 100, 300);
    expect(r.calls).toEqual([]);
  });

  it("does not start on a text box or an element that scrolled itself", () => {
    const r = body();
    const box = document.createElement("textarea");
    r.body.append(box);
    touch("touchstart", box, 100, 500);
    expect(touch("touchmove", box, 100, 700).defaultPrevented).toBe(false);
    touch("touchend", box, 100, 700);
    const inside = document.createElement("div");
    const deep = document.createElement("span");
    inside.append(deep);
    r.body.append(inside);
    inside.scrollTop = 10;
    touch("touchstart", deep, 100, 500);
    expect(touch("touchmove", deep, 100, 700).defaultPrevented).toBe(false);
    touch("touchend", deep, 100, 700);
    expect(r.calls).toEqual([]);
  });

  it("ignores a second finger", () => {
    const r = body();
    const event = new Event("touchstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: [{ clientX: 1, clientY: 1 }, { clientX: 5, clientY: 5 }] });
    r.inner.dispatchEvent(event);
    expect(touch("touchmove", r.inner, 100, 700).defaultPrevented).toBe(false);
  });
});

describe("the phone styles the gestures rely on", () => {
  it("keeps the page from taking the touch of a scrim or a handle", async () => {
    const { PHONE_SHELL_STYLES, RESULTS_SHEET_STYLES } = await import("../form-engine/builder/web-component/phone-styles.js");
    expect(PHONE_SHELL_STYLES).toMatch(/\.db-scrim \{[^}]*touch-action: none/);
    expect(PHONE_SHELL_STYLES).toMatch(/\.sheet-grab \{[^}]*touch-action: none/);
    expect(PHONE_SHELL_STYLES).toMatch(/\.sheet-head \{ touch-action: none/);
    expect(PHONE_SHELL_STYLES).toMatch(/\.more-head \{[^}]*touch-action: none/);
    expect(PHONE_SHELL_STYLES).toMatch(/\.menu-drawer, [^{]*\.menu-drawer \* \{ touch-action: pan-y/);
    expect(PHONE_SHELL_STYLES).toMatch(/\[data-sheet\] \{ overscroll-behavior: contain/);
    expect(RESULTS_SHEET_STYLES).toMatch(/\.try-grab \{[^}]*touch-action: none/);
    expect(RESULTS_SHEET_STYLES).toContain("::before");
    // Both are template literals: no backtick inside.
    expect(RESULTS_SHEET_STYLES).not.toContain("`");
    expect(PHONE_SHELL_STYLES).not.toContain("`");
  });
});
