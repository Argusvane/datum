/**
 * Places a `position: fixed` popover (a mode's Add popover) under the control that opened it,
 * inside the builder's own box.
 *
 * A fixed box counts its top and left from the viewport only until an ancestor transforms,
 * filters or contains it — a host page's frame, a scaled demo box. Then they count from that
 * ancestor, and an anchor's viewport coordinates put the box off by the ancestor's offset, out
 * of the builder's frame. So the box is set at 0, read back to learn where that 0 lands, and
 * moved by the difference.
 *
 * With no anchor drawn (a control hidden at this width, or one that went with the page it was
 * on), the box sits centred near the top of the builder.
 */
export function placePopover(host: HTMLElement, anchor: HTMLElement | undefined): void {
  const wasHidden = host.hidden;
  host.hidden = false;
  host.style.top = "0px";
  host.style.left = "0px";
  const origin = host.getBoundingClientRect();
  const width = origin.width;
  const frame = builderFrame(host);
  const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : undefined;
  const drawn = rect !== undefined && (rect.width > 0 || rect.height > 0);
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 0;
  // The room the box may take: the builder's box, within the viewport.
  const start = Math.max(8, (frame?.left ?? 0) + 8);
  const end = Math.min(viewportWidth > 0 ? viewportWidth - 8 : Infinity, frame ? frame.right - 8 : Infinity);
  let top: number;
  let left: number;
  if (drawn) {
    top = rect.bottom + 4;
    left = rect.left;
  } else {
    top = (frame?.top ?? 0) + 64;
    left = frame ? frame.left + (frame.width - width) / 2 : 8;
  }
  left = Number.isFinite(end) ? Math.max(start, Math.min(left, end - width)) : Math.max(start, left);
  host.style.top = `${Math.round(top - origin.top)}px`;
  host.style.left = `${Math.round(left - origin.left)}px`;
  host.hidden = wasHidden;
}

/** The builder the popover is mounted in: the element whose shadow root holds it. */
function builderFrame(host: HTMLElement): DOMRect | undefined {
  const root = host.getRootNode?.();
  const shell = root && "host" in root ? (root as ShadowRoot).host : undefined;
  const rect = shell?.getBoundingClientRect();
  return rect && rect.width > 0 ? rect : undefined;
}
