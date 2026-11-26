Result: `{ locale, previous, locales, title }` beside the envelope. The answers do not change;
labels, options, messages and display text come back in the new language from then on. Asking
for the language already shown answers `ok: true` with a note.

Failure modes: `bad-input`, `form-required`, `form-unknown`, `form-not-ready`, `agent-off`, `feature-off`, `locale-unsupported`, `stopped`, `busy`, `stale`, `cancelled`, `internal`.

Example, a language the form does not have:

```json
// call set_locale
{"locale": "xx"}
// result
{
  "ok": false,
  "tool": "set_locale",
  "code": "locale-unsupported",
  "message": "This form is not available in 'xx'.",
  "hint": "Use one of the listed locale codes.",
  "retryable": false,
  "details": {"locale": "xx", "supported": [{"code": "en", "label": "English"}, {"code": "fr", "label": "Français"}]},
  "form": "form-1",
  "revision": 11
}
```
