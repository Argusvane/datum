/**
 * The phone sheet of a workspace surface: Logic's rule editor and
 * Data's row editor draw as a bottom sheet at the phone tier. The sheet announces as a dialog,
 * takes focus when it opens and gives it back to the row or rule it came from, sits on a scrim
 * a tap closes, closes on Escape, and carries a grabber wired through attachSheetGestures
 * (swipe down dismisses, a tap toggles tall). The surfaces keep their own Close buttons.
 *
 * The surfaces repaint their whole shadow root, so `sync` runs after every paint and puts the
 * dialog attributes, the scrim and the grabber back on the new markup.
 */
import { attachSheetGestures } from "./sheet-gestures.js";

export interface SurfaceSheetOptions {
  /** The surface element: the shell sets data-phone on it. */
  host: HTMLElement;
  /** The editor section, when one is drawn. */
  sheet(): HTMLElement | null;
  /** Puts the sheet away, asking about a draft first when the surface does. */
  dismiss(): void;
  /** What the grabber says, for the sheet's height now. */
  grabLabel(tall: boolean): string;
  /** The row or rule the sheet came from, to give focus back to. */
  opener(): HTMLElement | null;
  /** The first control to focus on open. */
  firstControl(sheet: HTMLElement): HTMLElement | null;
}

/** Styles a surface adds to its own: the grabber and the scrim only exist at the phone tier. */
export const SURFACE_SHEET_STYLES = `
  .sheet-grab-btn, .sheet-scrim { display: none; }
  :host([data-phone]) .sheet-scrim { display: block; position: absolute; inset: 0; z-index: 29; background: var(--db-scrim); touch-action: none; }
  :host([data-phone]) .sheet-grab-btn {
    display: grid; place-items: center; position: sticky; top: 0; z-index: 2; inline-size: 100%; min-block-size: 44px;
    margin: 0; padding: 0; border: 0; background: var(--db-surface); cursor: grab; touch-action: none;
  }
  :host([data-phone]) .sheet-grab-btn::before { content: ""; inline-size: 40px; block-size: 5px; border-radius: var(--db-radius-pill); background: var(--db-line-card); }
  :host([data-phone]) .sheet-grab-btn:focus-visible { outline: 2px solid var(--db-focus); outline-offset: -2px; }
  :host([data-phone]) [data-sheet-surface][data-tall] { inset-block-start: 0; }
  :host([data-phone]) [data-sheet-surface] { overscroll-behavior: contain; }
`;

export class SurfaceSheet {
  private off: (() => void) | undefined;
  private tall = false;
  private active = false;

  public constructor(private readonly o: SurfaceSheetOptions) {}

  /** Whether the sheet is up as a phone sheet now. */
  public get isActive(): boolean {
    return this.active;
  }

  /** Runs after each paint; `open` says whether the surface has an editor to show. */
  public sync(open: boolean): void {
    this.off?.();
    this.off = undefined;
    const sheet = this.o.sheet();
    const phone = this.o.host.hasAttribute("data-phone");
    const active = open && phone && sheet !== null;
    if (sheet) {
      sheet.toggleAttribute("data-sheet-surface", true);
      if (active) {
        sheet.setAttribute("role", "dialog");
        sheet.setAttribute("aria-modal", "true");
      } else {
        sheet.removeAttribute("role");
        sheet.removeAttribute("aria-modal");
      }
      sheet.toggleAttribute("data-tall", active && this.tall);
    }
    if (active && sheet) {
      this.draw(sheet);
    }
    const was = this.active;
    this.active = active;
    if (active && !was) {
      this.o.firstControl(sheet!)?.focus();
    } else if (!active && was && phone) {
      this.o.opener()?.focus();
    }
    if (!active) {
      this.tall = false;
    }
  }

  /** Escape: closes the sheet unless something inside has already used the key. */
  public onEscape(event: KeyboardEvent): boolean {
    if (!this.active || event.key !== "Escape" || event.defaultPrevented) {
      return false;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("dialog, [data-import-dialog]")) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    this.o.dismiss();
    return true;
  }

  public dispose(): void {
    this.off?.();
    this.off = undefined;
    this.active = false;
  }

  private draw(sheet: HTMLElement): void {
    const parent = sheet.parentElement;
    if (parent && !parent.querySelector(":scope > .sheet-scrim")) {
      const scrim = document.createElement("div");
      scrim.className = "sheet-scrim";
      scrim.setAttribute("data-sheet-scrim", "");
      scrim.setAttribute("aria-hidden", "true");
      scrim.addEventListener("click", () => this.o.dismiss());
      parent.insertBefore(scrim, sheet);
    }
    let grab = sheet.querySelector<HTMLButtonElement>(":scope > .sheet-grab-btn");
    if (!grab) {
      grab = document.createElement("button");
      grab.type = "button";
      grab.className = "sheet-grab-btn";
      grab.setAttribute("data-sheet-grab", "");
      sheet.insertBefore(grab, sheet.firstChild);
    }
    grab.setAttribute("aria-expanded", String(this.tall));
    grab.setAttribute("aria-label", this.o.grabLabel(this.tall));
    const toggle = (tall: boolean): void => {
      this.tall = tall;
      sheet.toggleAttribute("data-tall", tall);
      grab!.setAttribute("aria-expanded", String(tall));
      grab!.setAttribute("aria-label", this.o.grabLabel(tall));
    };
    // A keyboard (or assistive) click toggles too; a tap the gesture answered is swallowed before it gets here.
    grab.addEventListener("click", () => toggle(!this.tall));
    const common = {
      onDismiss: () => this.o.dismiss(),
      onExpand: () => toggle(true),
      onCollapse: () => toggle(false),
      isExpanded: () => this.tall
    };
    const offHandle = attachSheetGestures(sheet, { ...common, handle: grab, grab });
    const offBody = attachSheetGestures(sheet, { ...common, handle: sheet, input: "touch", grab: null });
    this.off = () => {
      offHandle();
      offBody();
    };
  }
}
