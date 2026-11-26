/**
 * The home page's hero: slides in one place ("What it is", "Why it matters", "In and out",
 * "Journeys") taking turns.
 * The clock is the line under the chosen tab, a CSS animation over `--hero-hold`; when it ends the
 * next slide shows. Picking a tab (click or arrow keys) stops the turning, and the pause button
 * stops or restarts it. It holds while the pointer is over a slide's words, while a link in a
 * slide has keyboard focus and while the hero is scrolled out of view. With reduced motion it
 * never starts on its own.
 */
export function wireHero(): void {
  // Scoped to the deck: <html> also carries data-hero (the stored hero choice) once it is "classic".
  const deck = document.querySelector<HTMLElement>(".hero__deck[data-hero]");
  const stack = deck?.querySelector<HTMLElement>("[data-hero-slides]");
  const controls = deck?.querySelector<HTMLElement>("[data-hero-controls]");
  const pause = deck?.querySelector<HTMLButtonElement>("[data-hero-pause]");
  if (!deck || !stack || !controls || !pause) return;
  const slides = [...deck.querySelectorAll<HTMLElement>("[data-hero-slide]")];
  const tabs = [...deck.querySelectorAll<HTMLButtonElement>("[data-hero-tab]")];
  if (slides.length < 2 || tabs.length !== slides.length) return;

  let current = Math.max(0, slides.findIndex((slide) => slide.hasAttribute("data-active")));
  const holds = new Set<string>();

  function show(index: number): void {
    current = (index + slides.length) % slides.length;
    slides.forEach((slide, i) => {
      slide.toggleAttribute("data-active", i === current);
      // Out of reach at once, while it still fades.
      slide.inert = i !== current;
    });
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === current));
      tab.tabIndex = i === current ? 0 : -1;
    });
  }

  const rotate = (on: boolean): void => {
    deck.toggleAttribute("data-rotating", on);
    pause.setAttribute("aria-label", on ? "Pause the slides" : "Play the slides");
    // Announce a slide only when someone chose it, never while the slides turn on their own.
    stack.setAttribute("aria-live", on ? "off" : "polite");
  };

  const hold = (reason: string, on: boolean): void => {
    if (on) holds.add(reason);
    else holds.delete(reason);
    deck.toggleAttribute("data-held", holds.size > 0);
  };

  deck.addEventListener("animationend", (event) => {
    if (event.animationName === "heroHold") show(current + 1);
  });

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => {
      rotate(false);
      show(i);
    });
    tab.addEventListener("keydown", (event) => {
      const to =
        event.key === "ArrowRight" ? current + 1
        : event.key === "ArrowLeft" ? current - 1
        : event.key === "Home" ? 0
        : event.key === "End" ? tabs.length - 1
        : null;
      if (to === null) return;
      event.preventDefault();
      rotate(false);
      show(to);
      tabs[current].focus();
    });
  });

  pause.addEventListener("click", () => rotate(!deck.hasAttribute("data-rotating")));

  // Only the words hold the slides: a pointer resting on the tabs or the pause button would make
  // Play look broken.
  deck.querySelectorAll<HTMLElement>(".hero__copy").forEach((copy) => {
    copy.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "mouse") hold("pointer", true);
    });
    copy.addEventListener("pointerleave", () => hold("pointer", false));
  });
  stack.addEventListener("focusin", (event) => {
    hold("focus", event.target instanceof Element && event.target.matches(":focus-visible"));
  });
  stack.addEventListener("focusout", (event) => {
    if (!(event.relatedTarget instanceof Node && stack.contains(event.relatedTarget))) hold("focus", false);
  });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([entry]) => hold("away", !entry.isIntersecting)).observe(deck);
  }

  slides.forEach((slide) => slide.removeAttribute("hidden"));
  controls.hidden = false;
  deck.toggleAttribute("data-ready", true);
  show(current);
  rotate(!matchMedia("(prefers-reduced-motion: reduce)").matches);
}
