Twelve tools act on a form; the session pair (`begin_session`, `end_session`) is registered once
per page and serves a builder too. The descriptions and schemas below are rendered from the tool
catalogue the browser registers. The examples are real results from the engine's fixture forms
(`engine/tests/fixtures/agent-form.ts`): a journey of five pages (`intro`, `contact`, `details`,
`review` and the exit page `stop`) and a single-page form with a table `grid`; the drafts, PDF and provenance examples use the
`travel-claim` form of the same fixtures (a traveller, a trip date, an amount, an expenses table,
a hidden case reference and a declaration) with a draft the site keeps and a PDF the page makes.
A field row like
`describe_form`'s is a `Field`, described under "Shared shapes" at the end of this section.

A typical run: `describe_form` → `set_answers` → `check` → `navigate { to: "next" }` → … →
`check { scope: "form" }` → `submit`, inside `begin_session` / `end_session` when it takes more
than a couple of writes. `drafts` and `download_pdf` are for the person's explicit asks.
