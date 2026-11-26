// Its own module: a page reads the name eagerly (to allow it in its trusted-types directive), and
// the loader that creates the policy comes with the renderer (assets.ts).

/**
 * The Trusted Types policy a design system's script address (`assets.scripts`) is set through,
 * for a host that enforces Trusted Types. Created on the first script a binding asks for, never
 * when no binding lists one; it passes only the addresses the host listed.
 */
export const ASSETS_TRUSTED_TYPES_POLICY = "datum-assets";
