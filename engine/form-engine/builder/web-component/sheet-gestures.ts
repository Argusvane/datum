/**
 * Touch and pointer gestures for a phone's sheets and drawers: a sheet with a handle follows a drag, snaps back under a threshold, goes away over it
 * or on a fling, and rises to full height on a drag up. The handle stays a real button, and
 * the sheet's Close button stays the keyboard path, so nothing here is the only way to do
 * anything.
 *
 * Two inputs feed one drag. A handle is driven by pointer events (the handle says
 * touch-action none, or pan-y for a sideways drawer, so the page does not claim the touch).
 * A sheet's body cannot say that without losing its scroll, so a body is driven by touch
 * events instead, and only while it is scrolled to the top and the finger goes down.
 *
 * Pure DOM, no builder imports: the shell wires it, the tests drive it with dispatched events.
 */

/** Travel (px) under which a press and release is a tap, not a drag. */
const TAP_SLOP_PX = 6;

/** The fewest pixels a drag must cover for a fling to count. */
const FLING_MIN_PX = 12;

/** A drag up this far (px) on release expands the sheet. */
const EXPAND_PX = 24;

/** The dismiss threshold is a third of the sheet, but never under this many px. */
const MIN_THRESHOLD_PX = 80;

/** Only the last stretch of the drag counts toward its speed (ms). */
const VELOCITY_WINDOW_MS = 120;

/** The click the browser raises after a drag or a tap is swallowed for this long (ms). */
const CLICK_SWALLOW_MS = 400;

/** A sideways drawer claims a move only when its travel along the axis beats the cross travel by this factor; otherwise it is scrolling and the gesture lets go. */
const AXIS_RATIO = 1.5;

/** The snap back's length (ms). */
const SNAP_MS = 180;

/** Which way a sheet leaves: a bottom sheet down, a drawer toward its edge. */
export type SheetDismissDirection = "down" | "left" | "right";

export interface SheetGestureOptions {
  /** The element a press starts a drag on: a sheet's handle row, or (touch mode) its scrolling body. */
  handle: HTMLElement;
  /** The drag passed the threshold, or was a fling: put the sheet away (it may refuse, and then it snaps back). */
  onDismiss(): void;
  /** A tap on the grab button, or a drag up, when the sheet is not expanded. */
  onExpand?(): void;
  /** A tap on the grab button when the sheet is expanded; also a slow drag down past the threshold when shrinkOnDrag is set. */
  onCollapse?(): void;
  /** An expanded sheet shrinks on a slow drag past the threshold, and goes only on a second one or a fling; default off: a drag past the threshold puts it away. */
  shrinkOnDrag?: boolean;
  /** Whether the sheet is at full height now. */
  isExpanded?(): boolean;
  /** Travel (px) that dismisses; default a third of the sheet's size, at least 80. */
  dismissThresholdPx?: number;
  /** Speed (px per ms) that dismisses whatever the travel; default 0.5. */
  flingVelocity?: number;
  /** Elements that move with the sheet (the shell's handle row above an inspector sheet). */
  follow?: readonly HTMLElement[];
  /** The elements to move, asked at each frame, for a sheet drawn inside another component's shadow root and redrawn there; replaces the sheet and follow. */
  elements?(): readonly HTMLElement[];
  /** The way the sheet leaves; default down. A drawer from the start edge leaves left (right in a right-to-left page). */
  direction?: SheetDismissDirection;
  /** The button whose tap toggles the height; default the handle when it is a button. */
  grab?: HTMLElement | null;
  /** Whether a press whose path (innermost first) is on the grab button, for a handle that redraws its button; replaces grab for the tap test. */
  isGrab?(path: readonly EventTarget[]): boolean;
  /** `pointer` (default) for a handle; `touch` for a scrolling body, which drags only from its top. */
  input?: "pointer" | "touch";
  /** Whether a press whose path (innermost first) is this may start a drag; default always. */
  startFilter?(path: readonly EventTarget[]): boolean;
  /** Touch input only: whether the body may be dragged now; default when nothing under the finger is scrolled down. */
  canDrag?(path: readonly EventTarget[]): boolean;
  /** The touch-action the handle takes; default none (pan-y for a sideways drawer); null leaves it alone. */
  touchAction?: string | null;
  /** The clock, in ms (a test's); default performance.now. */
  now?(): number;
  /** Whether the person asked for no motion; default the media query. */
  reducedMotion?(): boolean;
}

/** Elements a swipe must not start on: they use the touch themselves. */
const OWN_TOUCH = "input, textarea, select, [contenteditable]:not([contenteditable=false]), [data-no-sheet-drag]";

function pathOf(event: Event): EventTarget[] {
  const path = event.composedPath();
  return path.length > 0 ? path : event.target ? [event.target] : [];
}

/** Whether something under the finger is a box scrolled away from its top, or draws its own touch. */
export function sheetBodyScrolled(path: readonly EventTarget[], root: HTMLElement): boolean {
  for (const node of path) {
    if (node === root) {
      return root.scrollTop > 0;
    }
    if (node instanceof Element) {
      if (node.scrollTop > 0 || node.matches(OWN_TOUCH)) {
        return true;
      }
    }
  }
  return root.scrollTop > 0;
}

/** Makes `sheet` follow a drag on `options.handle`; returns the function that takes it all away again. */
export function attachSheetGestures(sheet: HTMLElement, options: SheetGestureOptions): () => void {
  const handle = options.handle;
  const direction = options.direction ?? "down";
  const vertical = direction === "down";
  const sign = direction === "right" ? 1 : direction === "left" ? -1 : 1;
  const input = options.input ?? "pointer";
  const moved = (): readonly HTMLElement[] => (options.elements ? options.elements() : [sheet, ...(options.follow ?? [])]);
  const now = options.now ?? ((): number => performance.now());
  const grab = options.grab !== undefined ? options.grab : handle instanceof HTMLButtonElement ? handle : null;
  const velocityLimit = options.flingVelocity ?? 0.5;
  const reduced = options.reducedMotion ?? ((): boolean => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  let phase: "idle" | "pending" | "dragging" = "idle";
  let pointerId = -1;
  let startX = 0;
  let startY = 0;
  let onGrab = false;
  let samples: Array<{ t: number; v: number }> = [];
  let along = 0;
  let swallowUntil = 0;
  let snapTimer: ReturnType<typeof setTimeout> | undefined;
  let guardOff: (() => void) | undefined;
  const previousTouchAction = handle.style.getPropertyValue("touch-action");

  if (options.touchAction !== null && input === "pointer") {
    handle.style.setProperty("touch-action", options.touchAction ?? (vertical ? "none" : "pan-y"));
  }

  /** Travel toward the way out, in px (negative the other way). */
  const travel = (x: number, y: number): number => (vertical ? y - startY : sign * (x - startX));
  const sheetSize = (): number => {
    let lo = Infinity;
    let hi = -Infinity;
    let size = 0;
    for (const element of moved()) {
      const rect = element.getBoundingClientRect();
      if (vertical) {
        lo = Math.min(lo, rect.top);
        hi = Math.max(hi, rect.bottom);
        size = hi - lo;
      } else {
        size = Math.max(size, rect.width);
      }
    }
    return Number.isFinite(size) ? size : 0;
  };
  const threshold = (): number => options.dismissThresholdPx ?? Math.max(MIN_THRESHOLD_PX, sheetSize() / 3);
  const expanded = (): boolean => options.isExpanded?.() ?? false;

  const place = (distance: number): void => {
    const value = distance > 0 ? `${vertical ? "translateY" : "translateX"}(${sign * distance}px)` : "";
    for (const element of moved()) {
      element.style.transition = "none";
      element.style.transform = value;
    }
  };

  const settle = (): void => {
    if (snapTimer !== undefined) {
      clearTimeout(snapTimer);
      snapTimer = undefined;
    }
    const elements = moved();
    const animate = !reduced() && elements.some((element) => element.style.transform !== "");
    for (const element of elements) {
      element.style.transition = animate ? `transform ${SNAP_MS}ms ease-out` : "";
      element.style.transform = "";
    }
    if (animate) {
      snapTimer = setTimeout(() => {
        snapTimer = undefined;
        for (const element of elements) {
          element.style.transition = "";
        }
      }, SNAP_MS + 40);
    }
  };

  const velocity = (end: number): number => {
    const recent = samples.filter((sample) => sample.t >= end - VELOCITY_WINDOW_MS);
    if (recent.length < 2) {
      return 0;
    }
    const first = recent[0]!;
    const last = recent[recent.length - 1]!;
    const span = last.t - first.t;
    return span > 0 ? (last.v - first.v) / span : 0;
  };

  /**
   * The click the browser synthesises after a tap lands where the pointer went up, which may be
   * the scrim the sheet's shrinking just uncovered (and so would close the sheet). One document
   * level capture listener swallows the first real click within a moment of the gesture; a
   * keyboard click (detail 0) is never touched.
   */
  const armClickGuard = (): void => {
    guardOff?.();
    const doc = handle.ownerDocument;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = (): void => {
      doc.removeEventListener("click", swallow, true);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (guardOff === off) {
        guardOff = undefined;
      }
    };
    const swallow = (event: MouseEvent): void => {
      if (event.detail === 0) {
        return;
      }
      off();
      event.stopImmediatePropagation();
      event.preventDefault();
    };
    doc.addEventListener("click", swallow, true);
    timer = setTimeout(off, CLICK_SWALLOW_MS);
    guardOff = off;
  };

  const begin = (x: number, y: number, path: readonly EventTarget[]): boolean => {
    if (phase !== "idle" || (options.startFilter && !options.startFilter(path))) {
      return false;
    }
    if (input === "touch" && (options.canDrag ? !options.canDrag(path) : sheetBodyScrolled(path, handle))) {
      return false;
    }
    phase = "pending";
    startX = x;
    startY = y;
    along = 0;
    onGrab = options.isGrab ? options.isGrab(path) : grab !== null && path.includes(grab);
    samples = [{ t: now(), v: 0 }];
    if (snapTimer !== undefined) {
      clearTimeout(snapTimer);
      snapTimer = undefined;
    }
    return true;
  };

  /** Follows the finger; answers whether the move belongs to the drag (a touch body then stops the page scrolling). */
  const move = (x: number, y: number): boolean => {
    if (phase === "idle") {
      return false;
    }
    const dx = x - startX;
    const dy = y - startY;
    if (phase === "pending") {
      if (Math.hypot(dx, dy) < TAP_SLOP_PX) {
        return false;
      }
      // A sideways drawer reads a mostly vertical move as scrolling; a body reads a move up or sideways as its own scroll.
      const mostlyAlong = vertical ? Math.abs(dy) >= Math.abs(dx) : Math.abs(dx) >= Math.abs(dy) * AXIS_RATIO;
      if (!mostlyAlong || (input === "touch" && travel(x, y) <= 0)) {
        phase = "idle";
        return false;
      }
      phase = "dragging";
    }
    along = travel(x, y);
    samples.push({ t: now(), v: along });
    place(along);
    return true;
  };

  const finish = (cancelled: boolean): void => {
    const was = phase;
    phase = "idle";
    if (was === "idle") {
      return;
    }
    const end = now();
    if (was === "pending") {
      if (!cancelled && onGrab) {
        swallowUntil = performance.now() + CLICK_SWALLOW_MS;
        armClickGuard();
        if (expanded()) {
          options.onCollapse?.();
        } else {
          options.onExpand?.();
        }
      }
      return;
    }
    swallowUntil = performance.now() + CLICK_SWALLOW_MS;
    armClickGuard();
    const speed = velocity(end);
    const up = vertical ? -along : 0;
    if (!cancelled) {
      const flungOut = speed >= velocityLimit && along >= FLING_MIN_PX;
      if (along >= threshold() || flungOut) {
        // An expanded sheet that can shrink does that on a slow drag; a fling still puts it away.
        if (expanded() && options.shrinkOnDrag && options.onCollapse && !flungOut) {
          options.onCollapse();
        } else {
          options.onDismiss();
        }
      } else if (vertical && options.onExpand && !expanded() && (up >= EXPAND_PX || (-speed >= velocityLimit && up >= FLING_MIN_PX))) {
        options.onExpand();
      }
    }
    settle();
  };

  const capture = (event: PointerEvent): void => {
    try {
      handle.setPointerCapture?.(event.pointerId);
    } catch {
      // A pointer that is already gone cannot be captured: the drag simply ends where it is.
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.isPrimary === false || (event.pointerType === "mouse" && event.button !== 0)) {
      return;
    }
    if (begin(event.clientX, event.clientY, pathOf(event))) {
      pointerId = event.pointerId;
    }
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) {
      return;
    }
    const before = phase;
    if (move(event.clientX, event.clientY) && before === "pending") {
      // Captured when the drag starts, not at the press: a tap on a button in the row must still reach the button.
      capture(event);
    }
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId === pointerId) {
      finish(false);
    }
  };
  const onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === pointerId) {
      finish(true);
    }
  };

  const onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length !== 1) {
      phase = "idle";
      return;
    }
    const touch = event.touches[0]!;
    begin(touch.clientX, touch.clientY, pathOf(event));
  };
  const onTouchMove = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (!touch || phase === "idle") {
      return;
    }
    if (move(touch.clientX, touch.clientY) && event.cancelable) {
      event.preventDefault();
    }
  };
  const onTouchEnd = (): void => finish(false);
  const onTouchCancel = (): void => finish(true);

  const onClick = (event: MouseEvent): void => {
    // The click after a drag or a tap the gesture already answered; a keyboard click (detail 0) is the button's own.
    if (event.detail > 0 && performance.now() < swallowUntil) {
      event.stopImmediatePropagation();
      event.preventDefault();
      swallowUntil = 0;
    }
  };

  if (input === "pointer") {
    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerCancel);
    handle.addEventListener("click", onClick, true);
  } else {
    handle.addEventListener("touchstart", onTouchStart, { passive: true });
    handle.addEventListener("touchmove", onTouchMove, { passive: false });
    handle.addEventListener("touchend", onTouchEnd);
    handle.addEventListener("touchcancel", onTouchCancel);
  }

  return () => {
    handle.removeEventListener("pointerdown", onPointerDown);
    handle.removeEventListener("pointermove", onPointerMove);
    handle.removeEventListener("pointerup", onPointerUp);
    handle.removeEventListener("pointercancel", onPointerCancel);
    handle.removeEventListener("click", onClick, true);
    handle.removeEventListener("touchstart", onTouchStart);
    handle.removeEventListener("touchmove", onTouchMove);
    handle.removeEventListener("touchend", onTouchEnd);
    handle.removeEventListener("touchcancel", onTouchCancel);
    if (snapTimer !== undefined) {
      clearTimeout(snapTimer);
    }
    // The click guard stays: a sheet that went away on this gesture must not let its click through to what lies under (it runs out on its own).
    phase = "idle";
    for (const element of moved()) {
      element.style.transform = "";
      element.style.transition = "";
    }
    if (options.touchAction !== null && input === "pointer") {
      if (previousTouchAction) {
      handle.style.setProperty("touch-action", previousTouchAction);
    } else {
      handle.style.removeProperty("touch-action");
    }
    }
  };
}
