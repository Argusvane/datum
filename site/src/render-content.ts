import {
  advantages,
  CONTACT_EMAIL,
  evidence,
  evidenceLabels,
  evidenceRegions,
  evidenceSectors,
  evidenceTopics,
  GITHUB_URL,
  partnerLabels,
  partners,
  partnerStandards
} from "./pillars";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Label, title and text cells: the Overview's. */
function renderAdvantages(container: HTMLElement, items: typeof advantages = advantages): void {
  container.replaceChildren(
    ...items.map((item) => {
      const node = el("article", "adv");
      node.append(el("span", "label", item.label), el("h3", "adv__title", item.title), el("p", "adv__text", item.text));
      return node;
    })
  );
}

/**
 * The "By the numbers" section under the hero: topic chips and a sector dropdown over a grid of
 * findings that shows six at a time (three columns by two rows on a wide screen, fewer per row
 * on narrow ones) and scrolls a row at a time for the rest, with a count and Previous / Next
 * under it. The three filters combine: a finding shows when it carries the chosen topic (or the
 * topic is "All"), the chosen sector and the chosen region (or none is chosen). Each cell: the
 * source as a link, the figure, what it counts, then "With Datum" and the answer pinned to the
 * cell's foot.
 */
function renderEvidence(container: HTMLElement): void {
  const filters = el("div", "numbers__filters");
  filters.setAttribute("role", "group");
  filters.setAttribute("aria-label", evidenceLabels.filters);
  const chips = [{ id: "all", label: evidenceLabels.all }, ...evidenceTopics].map((topic) => {
    const chip = el("button", "chip numbers__chip", topic.label);
    chip.type = "button";
    chip.dataset.topic = topic.id;
    chip.setAttribute("aria-pressed", topic.id === "all" ? "true" : "false");
    return chip;
  });
  filters.append(...chips);

  const sectorField = el("label", "numbers__sector");
  const sector = el("select", "demo__select numbers__select");
  sector.append(
    new Option(evidenceLabels.allSectors, ""),
    ...evidenceSectors.map((item) => new Option(item.label, item.id))
  );
  sectorField.append(el("span", "label", evidenceLabels.sector), sector);

  const regionField = el("label", "numbers__sector");
  const region = el("select", "demo__select numbers__select");
  region.append(
    new Option(evidenceLabels.allRegions, ""),
    ...evidenceRegions.map((item) => new Option(item.label, item.id))
  );
  regionField.append(el("span", "label", evidenceLabels.regionFilter), region);

  const selects = el("div", "numbers__selects");
  selects.append(sectorField, regionField);

  const controls = el("div", "numbers__controls");
  controls.append(filters, selects);

  const grid = el("div", "ruled numbers__grid");
  grid.tabIndex = 0;
  grid.setAttribute("role", "region");
  grid.setAttribute("aria-label", evidenceLabels.region);
  const cells = evidence.map((item) => {
    const node = el("article", "fact");
    node.dataset.topics = item.topics.join(" ");
    const source = el("a", "label fact__source", item.source.name);
    source.href = item.source.href;
    source.target = "_blank";
    source.rel = "noopener";
    node.append(
      source,
      el("p", "fact__figure", item.figure),
      el("p", "fact__claim", item.claim),
      el("span", "fact__with", "With Datum"),
      el("p", "fact__answer", item.answer)
    );
    return node;
  });
  grid.append(...cells);

  const empty = el("p", "numbers__empty", evidenceLabels.none);
  empty.hidden = true;

  const bar = el("div", "numbers__bar");
  const count = el("span", "numbers__count");
  count.setAttribute("aria-live", "polite");
  const nav = el("div", "numbers__nav");
  const previous = el("button", "btn btn--small", evidenceLabels.previous);
  previous.type = "button";
  const next = el("button", "btn btn--small", evidenceLabels.next);
  next.type = "button";
  nav.append(previous, next);
  bar.append(count, nav);

  container.replaceChildren(controls, grid, empty, bar);

  const shown = (): HTMLElement[] => cells.filter((cell) => !cell.hidden);
  const behavior = (): ScrollBehavior => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth");
  /** One row: the first shown cell's height plus the rule between rows. */
  const row = (): number => {
    const first = shown()[0];
    return first ? first.offsetHeight + parseFloat(getComputedStyle(grid).borderTopWidth) : 0;
  };
  function update(): void {
    const list = shown();
    const top = grid.scrollTop;
    const bottom = top + grid.clientHeight;
    const visible = list.filter((cell) => cell.offsetTop >= top - 2 && cell.offsetTop + cell.offsetHeight <= bottom + 2);
    count.textContent =
      list.length && visible.length
        ? evidenceLabels.showing(list.indexOf(visible[0]) + 1, list.indexOf(visible[visible.length - 1]) + 1, list.length)
        : "";
    previous.disabled = top <= 1;
    next.disabled = bottom >= grid.scrollHeight - 1;
    // When every shown cell fits there is nothing to page through.
    bar.hidden = grid.scrollHeight <= grid.clientHeight + 1;
  }
  let topic = "all";
  // A link may name a view (`./?topic=problem&sector=healthcare#numbers`, as the partners page's
  // do); an id the lists do not have is ignored.
  const params = new URLSearchParams(location.search);
  const known = (list: readonly { id: string }[], id: string | null): string | undefined =>
    id !== null && list.some((item) => item.id === id) ? id : undefined;
  topic = known(evidenceTopics, params.get("topic")) ?? topic;
  sector.value = known(evidenceSectors, params.get("sector")) ?? "";
  region.value = known(evidenceRegions, params.get("region")) ?? "";
  /** The view into the address bar, so a link copied from it opens the same figures. */
  function remember(): void {
    try {
      const url = new URL(location.href);
      const view: Array<[string, string]> = [
        ["topic", topic === "all" ? "" : topic],
        ["sector", sector.value],
        ["region", region.value]
      ];
      for (const [key, value] of view) {
        if (value) url.searchParams.set(key, value);
        else url.searchParams.delete(key);
      }
      url.hash = "numbers";
      history.replaceState(history.state, "", url);
    } catch {
      // A sandboxed frame may refuse history writes: the filters still work, the address stays.
    }
  }
  function apply(): void {
    chips.forEach((chip) => chip.setAttribute("aria-pressed", chip.dataset.topic === topic ? "true" : "false"));
    cells.forEach((cell) => {
      const tags = (cell.dataset.topics ?? "").split(" ");
      cell.hidden =
        (topic !== "all" && !tags.includes(topic)) ||
        (sector.value !== "" && !tags.includes(sector.value)) ||
        (region.value !== "" && !tags.includes(region.value));
    });
    const any = shown().length > 0;
    grid.hidden = !any;
    empty.hidden = any;
    grid.scrollTo({ top: 0, behavior: "instant" });
    update();
  }
  chips.forEach((chip) =>
    chip.addEventListener("click", () => {
      topic = chip.dataset.topic ?? "all";
      apply();
      remember();
    })
  );
  const choose = (): void => {
    apply();
    remember();
  };
  sector.addEventListener("change", choose);
  region.addEventListener("change", choose);
  previous.addEventListener("click", () => grid.scrollBy({ top: -row(), behavior: behavior() }));
  next.addEventListener("click", () => grid.scrollBy({ top: row(), behavior: behavior() }));
  let frame = 0;
  grid.addEventListener("scroll", () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => update()).observe(grid);
  else window.addEventListener("resize", update);
  if (topic !== "all" || sector.value !== "" || region.value !== "") apply();
  else update();
}

/**
 * The partners page: one block per route (run it, embed it, deliver it), each under the id the
 * home page's hero rows link to. Start links carry `data-contact` / `data-github` as the nav's
 * do, so main.ts fills them with the same addresses.
 */
function renderPartners(container: HTMLElement): void {
  container.replaceChildren(
    ...partners.map((route) => {
      const node = el("article", "partner");
      node.id = route.id;
      const main = el("div", "partner__main");
      const facts = el("dl", "partner__facts");
      facts.append(
        el("dt", "label", partnerLabels.who),
        el("dd", undefined, route.who),
        el("dt", "label", partnerLabels.today)
      );
      const today = el("dd", undefined, route.today);
      // The figures behind it, on the home page's "By the numbers", filtered to the route's topic.
      const figures = el("a", "section-link partner__evidence", `${route.evidence.label} \u2192`);
      figures.href = `./?topic=${encodeURIComponent(route.evidence.topic)}#numbers`;
      today.append(figures);
      facts.append(today);
      main.append(el("span", "eyebrow", route.label), el("h2", "partner__title", route.title), facts);
      const aside = el("div", "partner__aside");
      const list = el("ul", "partner__list");
      list.append(...route.gives.map((item) => el("li", undefined, item)));
      const start = el("p", "partner__start");
      start.append(el("span", "label", partnerLabels.start));
      for (const link of route.start) {
        const anchor = el("a", "section-link", `${link.label} \u2192`);
        if (link.href === "contact") {
          anchor.href = `mailto:${CONTACT_EMAIL}`;
          anchor.dataset.contact = "";
        } else if (link.href === "github") {
          anchor.href = GITHUB_URL;
          anchor.dataset.github = "";
        } else anchor.href = link.href;
        start.append(anchor);
      }
      aside.append(el("span", "label", partnerLabels.gives), list, start);
      node.append(main, aside);
      return node;
    })
  );
}

/** The partners page's "Works with" cells: the standards Datum speaks, not companies. */
function renderStandards(container: HTMLElement): void {
  container.replaceChildren(
    ...partnerStandards.map((item) => {
      const node = el("article", "assure");
      node.append(el("span", "label", item.label), el("h3", "assure__title", item.title), el("p", "assure__text", item.text));
      return node;
    })
  );
}

/** Fills the content blocks a page declares. Each page uses the ones it has. */
export function renderContent(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-evidence]").forEach(renderEvidence);
  root.querySelectorAll<HTMLElement>("[data-advantages]").forEach((container) => renderAdvantages(container));
  root.querySelectorAll<HTMLElement>("[data-partners]").forEach(renderPartners);
  root.querySelectorAll<HTMLElement>("[data-standards]").forEach(renderStandards);
}
