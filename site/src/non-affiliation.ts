/**
 * The one sentence every binding page and the index carry about the design systems' owners. It lives
 * apart from src/render-bindings.ts, which needs the browser, so the build's page shell (page-shell.ts)
 * can write it into each page's static HTML: a reader without JavaScript sees it too.
 */
export const NON_AFFILIATION = "Datum is not affiliated with or endorsed by the owner of any design system named here.";
