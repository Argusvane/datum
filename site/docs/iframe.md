# In an iframe

This page is for showing a form on a site other than the one that serves it: how to size the frame, how the two pages talk, and what changes inside a frame.

The form is a custom element with a shadow root, so on most pages it needs no frame: the page's styles do not leak into it and its styles do not leak out. An iframe is for the cases where the form has to be a page of its own:

- The form is served by one site and shown on another.
- The host page's content policy cannot be loosened for the form's files.
- The host is a content system that accepts an embed address and nothing else.

## The whole page

Two files: the host page, and the page it frames. The framed page holds the form and delivers the answers itself. It tells the host two things through `postMessage`: how tall it is, and that the form was sent.

<LiveExample name="iframe" />

## Sizing the frame

A frame does not grow with its content. The framed page watches its own height and reports it, and the host sets the frame's height from the message. Set `body { margin: 0; }` in the framed page so the reported height is exact, and a validation error or a receipt that lengthens the form resizes the frame with it.

## Talking across the frame

Keep the messages few and plain. In the example the answers never cross the frame: the framed page posts them to its own server and tells the host only the confirmation number.

Both sides name the other's origin:

- The framed page passes the host's origin as the second argument of `postMessage`, so the message is delivered to that site and no other.
- The host checks `event.source` against the frame and `event.origin` against the site the form is served from, and ignores everything else.

In the example both pages are on one site, so both use `location.origin`. Across two sites, write each site's origin out.

## What the server of the framed page sends

A page can be framed only where its server allows it. On the framed page's responses, name the hosts that may frame it:

```
Content-Security-Policy: frame-ancestors https://www.example.org
```

Without that header a browser frames the page anywhere, which is rarely what a form wants.

## What changes inside a frame

- **Drafts.** A draft kept in the browser belongs to the framed page's origin. When that origin differs from the host's, browsers partition or block its storage, so a draft may not survive a return visit. Keep drafts on the server instead: see [Drafts](/drafts).
- **Passkeys.** Signing a submission with a passkey from inside a cross-origin frame needs `allow="publickey-credentials-get"` on the `<iframe>`. See [Signing a form with a passkey](/passkey-signing).
- **Browser assistants.** The assistant tools need `allow="tools"` on the frame: see [Browser assistants](/assistants).
- **Printing and PDFs.** Both work from the framed page as they do on a page of its own.
- **The language.** The host cannot set an attribute on a form in another page. Pass the locale in the frame's address and read it in the framed page, or let the form's own switcher do it.

## Next

- The headers the framed page needs for its own files: [Security headers](/security-headers).
- Everything the framed page can set on the form: [The form on your page](/form-on-your-page).
