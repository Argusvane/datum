import type { Plugin } from "vite";
import { argusvaneSprite } from "./src/argusvane";
import { NON_AFFILIATION } from "./src/non-affiliation";

/**
 * What every marketing page shares and the page files do not repeat: a "Skip to content" link as the
 * first thing a keyboard reader reaches, the `id` it points at on `<main>`, and, on the binding pages,
 * the static fallback for the copy their script draws. The binding pages are shells that
 * `src/render-bindings.ts` fills; without JavaScript the shell says so and still carries the sentence
 * about the design systems' owners (`NON_AFFILIATION`, the one the drawn pages use), so a reader or a
 * crawler that runs no script finds it in the HTML. A page whose header or footer draws the Argusvane credit
 * (`<use href="#av-mark">`) gets the one hidden sprite those references point at, right after the skip link.
 */

const SHELL_FALLBACK = '<noscript><p class="binding-demo__fallback container">This page needs JavaScript.</p></noscript>';
const BINDING_FALLBACK = `<noscript><p class="binding-demo__fallback container">This page needs JavaScript to draw its content. ${NON_AFFILIATION}</p></noscript>`;

/** One page's HTML with the shared parts added; a page that already has a skip link or a main id keeps it. */
export function pageShell(html: string): string {
  let out = html;
  if (!out.includes('id="main"')) out = out.replace("<main>", '<main id="main" tabindex="-1">');
  if (!out.includes("skip-link")) out = out.replace(/<body>/, '<body>\n    <a class="skip-link" href="#main">Skip to content</a>');
  if (out.includes('href="#av-') && !out.includes('id="av-mark"')) {
    const skip = /<a\b[^>]*\bclass="skip-link"[^>]*>[\s\S]*?<\/a>/;
    out = skip.test(out) ? out.replace(skip, (link) => `${link}\n    ${argusvaneSprite()}`) : out.replace(/<body[^>]*>/, (body) => `${body}\n    ${argusvaneSprite()}`);
  }
  return out.replace(SHELL_FALLBACK, BINDING_FALLBACK);
}

export function pageShellPlugin(): Plugin {
  return {
    name: "datum-page-shell",
    transformIndexHtml: { order: "pre", handler: pageShell }
  };
}
