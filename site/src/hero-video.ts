/**
 * The home page's two heroes: a product video in a framed window (the default) and the slide deck
 * it replaced (src/hero.ts). One button in each swaps them and remembers the choice.
 *
 * The video has two tabs ("Build a form", "Build a journey") and a Pause/Play button. With reduced
 * motion it never starts on its own and the poster shows. It is paused whenever the deck is the
 * hero on show, so nothing plays unseen.
 */

const HERO_KEY = "datum-hero";
type Hero = "video" | "classic";

const CLIPS = {
  form: {
    file: "datum-demo",
    label: "Datum: a form built in the builder, then filled in and submitted"
  },
  journey: {
    file: "datum-journey",
    label: "Datum: the same form built as a journey with a conditional page, then filled in on an organization's own web page"
  }
} as const;

function storedHero(): Hero {
  try {
    // Anything but the one known alternative is the default.
    return localStorage.getItem(HERO_KEY) === "classic" ? "classic" : "video";
  } catch {
    return "video";
  }
}

export function wireHeroVideo(): void {
  const variants = [...document.querySelectorAll<HTMLElement>("[data-hero-variant]")];
  const videoVariant = variants.find((variant) => variant.dataset.heroVariant === "video");
  const classicVariant = variants.find((variant) => variant.dataset.heroVariant === "classic");
  if (!videoVariant || !classicVariant) return;

  const win = videoVariant.querySelector<HTMLElement>("[data-hero-video]");
  const video = win?.querySelector<HTMLVideoElement>("video") ?? null;
  const toggle = win?.querySelector<HTMLButtonElement>("[data-hero-video-toggle]") ?? null;
  const tabs = win ? [...win.querySelectorAll<HTMLButtonElement>("[data-hero-video-tab]")] : [];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Set when the visitor presses Pause, so coming back from the deck does not start it again.
  let userPaused = false;
  // Whether the clip was running when the deck took over (a reduced-motion visitor may have pressed Play).
  let wasPlaying = false;

  if (win && video && toggle) {
    const base = import.meta.env.BASE_URL;
    const sync = (): void => {
      toggle.textContent = video.paused ? "Play" : "Pause";
    };

    if (reduced) {
      video.removeAttribute("autoplay");
      video.pause();
      video.load();
    }
    video.addEventListener("play", sync);
    video.addEventListener("pause", sync);
    toggle.addEventListener("click", () => {
      if (video.paused) {
        userPaused = false;
        video.play().catch(() => {});
      } else {
        userPaused = true;
        video.pause();
      }
    });

    const select = (tab: HTMLButtonElement, focus: boolean): void => {
      const name = tab.dataset.heroVideoTab as keyof typeof CLIPS | undefined;
      const clip = name ? CLIPS[name] : undefined;
      if (!clip) return;
      const wasSelected = tab.getAttribute("aria-selected") === "true";
      for (const other of tabs) {
        const on = other === tab;
        other.setAttribute("aria-selected", String(on));
        other.tabIndex = on ? 0 : -1;
      }
      if (focus) tab.focus();
      if (wasSelected) return;
      video.pause();
      video.querySelectorAll("source").forEach((old) => old.remove());
      for (const [ext, type] of [
        ["webm", "video/webm"],
        ["mp4", "video/mp4"]
      ] as const) {
        const source = document.createElement("source");
        source.src = `${base}video/${clip.file}.${ext}`;
        source.type = type;
        video.appendChild(source);
      }
      video.poster = `${base}video/${clip.file}-poster.jpg`;
      video.setAttribute("aria-label", clip.label);
      video.load();
      userPaused = false;
      if (!reduced) video.play().catch(() => {});
      sync();
    };

    for (const tab of tabs) {
      tab.addEventListener("click", () => select(tab, false));
      tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        event.preventDefault();
        const step = event.key === "ArrowRight" ? 1 : -1;
        select(tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length], true);
      });
    }
    sync();
  }

  // The switch: the page script in the head has already set data-hero for the first paint; this
  // makes the two wrappers agree with it and keeps them agreeing.
  function show(hero: Hero): void {
    document.documentElement.setAttribute("data-hero", hero);
    if (videoVariant) videoVariant.hidden = hero !== "video";
    if (classicVariant) classicVariant.hidden = hero !== "classic";
    if (!video) return;
    if (hero === "classic") {
      wasPlaying = !video.paused;
      // The attribute only serves the page without script; dropping it stops a hidden clip loading.
      video.removeAttribute("autoplay");
      video.pause();
    } else if (!userPaused && (wasPlaying || !reduced)) {
      video.play().catch(() => {});
    }
  }

  show(storedHero());
  document.querySelectorAll<HTMLButtonElement>("[data-hero-switch]").forEach((button) => {
    button.hidden = false;
    button.addEventListener("click", () => {
      const next: Hero = document.documentElement.getAttribute("data-hero") === "classic" ? "video" : "classic";
      show(next);
      try {
        localStorage.setItem(HERO_KEY, next);
      } catch {
        // Storage may be unavailable (private window, blocked site data); the choice lasts the page view.
      }
      // The button that was pressed is now hidden: the shown version's own switch takes the focus.
      const shown = next === "classic" ? classicVariant : videoVariant;
      shown?.querySelector<HTMLButtonElement>("[data-hero-switch]")?.focus();
      shown?.scrollIntoView({ block: "start", behavior: "instant" });
    });
  });
}
