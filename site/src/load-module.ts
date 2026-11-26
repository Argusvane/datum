/**
 * Loads a bundle the way the docs say a page loads it: a module script tag. Not
 * `import()`: in development Vite routes dynamic imports through its module pipeline with an
 * `?import` query, and its static middleware refuses that for files under `public/`; a
 * script element is left alone in both modes.
 */
export function loadModule(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = url;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => {
        script.remove();
        reject(new Error(`could not load ${url}`));
      },
      { once: true }
    );
    document.head.append(script);
  });
}
