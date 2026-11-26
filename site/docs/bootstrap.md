# Bootstrap with your own CSS

A site built on Bootstrap can have its forms drawn in Bootstrap's own markup: `form-control`, `form-select`, `btn btn-primary`, alerts for the error summary. The Bootstrap binding does the drawing, and the stylesheet it draws against is the site's to supply. That is the hook for a site's own look: hand the form the same Bootstrap CSS the rest of the site uses.

The binding is one of the reference bindings in the repository. It is a starting point, pinned to Bootstrap 5.3.8, with no support promise: see [Design-system bindings](/bindings) for what that means.

## The whole page

<LiveExample name="bootstrap" />

Turn the brand sheet off for Bootstrap as released, or change its colour and corners and open the `brand.css` tab to see what changed.

## How the stylesheets reach the form

The form draws inside a shadow root, so a stylesheet linked in the page's `<head>` does not style it. - The page lists its stylesheets in `assets.stylesheets` when it registers the binding, and the form fetches each one and adopts it, in the order listed.
- Rules written for `:root` and `body` are applied to the form itself, so a sheet that sets Bootstrap's `--bs-*` variables on `:root` works unchanged.

Each file must be on the page's origin or served with CORS. One that cannot be fetched stops the form from drawing: an error takes its place and the element raises `datum-binding-error`.

## Three ways to bring your own look

**A layer over Bootstrap.** List Bootstrap's stylesheet, then one of your own that sets the variables you want changed. This is what the example does. It suits a site that uses Bootstrap from a package and keeps its brand in one small file.

**Your own build of Bootstrap.** A site that compiles Bootstrap from Sass with its own variables already has one stylesheet with the brand in it. List that file alone:

```js
bindings.register(bindings.fromFactory(createBinding), {
  assets: { stylesheets: [{ url: "/css/site.css" }] }
});
```

Build it from the Bootstrap release the binding is pinned to. The binding writes that release's class names, so a build from another major version may not match.

**A ready-made theme.** A drop-in replacement for `bootstrap.min.css`, such as a Bootswatch theme for the same release, is listed the same way.

## What a brand sheet needs to set

Bootstrap does not derive everything from `--bs-primary`. Its buttons, focus rings and checked boxes carry colours of their own, so a brand sheet sets those too. The example's `brand.css` is the short list:

| To change | Set |
|---|---|
| The accent, links and focus ring | `--bs-primary`, `--bs-primary-rgb`, `--bs-link-color`, `--bs-focus-ring-color` on `:root` |
| The primary button | `--bs-btn-bg`, `--bs-btn-border-color` and their hover and active forms on `.btn-primary` |
| The focus outline of a field | `border-color` and `box-shadow` on `.form-control:focus`, `.form-select:focus`, `.form-check-input:focus` |
| A checked box or radio | `background-color` and `border-color` on `.form-check-input:checked` |
| Corners | `--bs-border-radius` on `:root`, `--bs-btn-border-radius` on `.btn-primary` |
| The typeface | `--bs-body-font-family` on `:root` |

The parts Bootstrap has no component for, such as file upload and the signature pad, are drawn by Datum and tinted from the same `--bs-*` variables, so they follow the brand without more work.

## Limits

- Bootstrap's script is not used. The form draws Bootstrap's markup and runs the behaviour itself, so tabs and steps work without `bootstrap.bundle.min.js`. If the page loads it for its own use, the form is untouched.
- Bootstrap's dark mode, set with `data-bs-theme` on an ancestor, does not reach into the form.
- Datum makes no accessibility claim for a design-system binding. Check contrast for the colours you choose.

## Next

- Registering a binding, and the other design systems: [Design-system bindings](/bindings).
- The headers a page with a binding needs: [Security headers](/security-headers).
- Datum's own look and its tokens: [Look and chrome](/look).
