/**
 * Colours an example's code the way the docs' own code blocks are coloured: the same highlighter
 * and themes VitePress runs at build time, loaded in the browser the first time an example needs
 * it, because an example's code follows the reader's choices.
 */
type Highlighter = { codeToHtml(code: string, options: object): string };

let highlighter: Promise<Highlighter> | undefined;

function load(): Promise<Highlighter> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([import("shiki/core"), import("shiki/engine/javascript")]);
    return createHighlighterCore({
      themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
      langs: [import("shiki/langs/html.mjs"), import("shiki/langs/javascript.mjs"), import("shiki/langs/json.mjs"), import("shiki/langs/css.mjs")],
      engine: createJavaScriptRegexEngine()
    });
  })();
  return highlighter;
}

/** The code as the markup of a VitePress code block's `pre`, in both colour schemes. */
export async function highlight(code: string, lang: string): Promise<string> {
  const shiki = await load();
  return shiki
    .codeToHtml(code, { lang, themes: { light: "github-light", dark: "github-dark" }, defaultColor: false })
    .replace('class="shiki', 'class="vp-code shiki');
}
