import { pillars, type Pillar } from "./pillars";

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

function number(index: number): string {
  return String(index + 1).padStart(2, "0");
}

function section(pillar: Pillar, index: number): HTMLElement {
  const node = el("section", "pillar");
  node.id = pillar.id;
  const head = el("div", "pillar__head");
  head.append(el("span", "pillar__num", number(index)), el("h3", "pillar__title", pillar.title));
  const body = el("div", "pillar__body");
  const points = el("ul", "pillar__points");
  points.append(...pillar.points.map((point) => el("li", undefined, point)));
  body.append(el("p", "pillar__blurb", pillar.blurb), points);
  node.append(head, body);
  // The features page carries one <template id="scene-<id>"> per capability: a small
  // CSS-only animation in the hero's visual language. A pillar without one gets no column.
  const template = document.getElementById(`scene-${pillar.id}`);
  if (template instanceof HTMLTemplateElement) {
    const scene = el("div", "pillar__scene");
    scene.append(template.content.cloneNode(true));
    node.append(scene);
  }
  return node;
}

/**
 * Fills every `[data-pillars]` container on the page from the one content source: every
 * capability as a section with its specifics. Only the features page has one; the home page
 * links there from under its Overview grid instead of repeating the list.
 */
export function renderPillars(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-pillars]").forEach((container) => {
    container.replaceChildren(...pillars.map((pillar, index) => section(pillar, index)));
  });
}
