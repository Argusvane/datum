# Submissions example

A FastAPI application that takes submissions over HTTP and keeps them in memory, and a queue consumer that takes the same
handler's submissions outside HTTP, through the same `Datum` object under `async with datum:`. The form is the kit's fixture
form in `forms/`. Settings come from the environment (`DATUM_FORMS__LOCATIONS`, `DATUM_WEB__API__ENDPOINTS__SUBMISSIONS=true`,
`DATUM_WEB__API__ENDPOINTS__DEFINITION=true`). The submissions switch alone loads the forms named in
`DATUM_FORMS__LOCATIONS` (so do `validate`, `test`, `definition`, `pdf`, `fill` and the builder); the definition switch
is here only to serve the form's definition to a page. With no such route on, no form file is read.
The conformance kit's preflight also needs `DATUM_WEB__API__ENDPOINTS__VALIDATE=true` to find the validate route.
Nothing here holds a secret. Install the workspace first (see
[the workspace README](../../README.md)): `npm run fastapi:assets` from the repository root, then
`uv sync --all-packages --all-extras --frozen` in `integrations/fastapi`.

Run the application from this directory:

```sh
export DATUM_FORMS__LOCATIONS='["forms/fixture-form.json"]'
export DATUM_WEB__API__ENDPOINTS__SUBMISSIONS=true
export DATUM_WEB__API__ENDPOINTS__DEFINITION=true
uv run --frozen --package datum-example-submissions uvicorn app:app --port 8000
```

Post a submission (the body is the document and its submit attempt's key; the handler logs one line and answers a
receipt). Post it again with the same key and the first receipt comes back; the same key with other answers is refused
with 409 `submission.keyConflict`, and a body without a key with 400:

```sh
curl -s -X POST localhost:8000/api/submissions -H 'content-type: application/json' \
  -d '{"document":{"versionContext":{"form":{"id":"datum-security-suite","version":"1"},"client":{"runtimeVersion":"example"}},"submission":{"locale":"en","values":{"name":"Ada Lovelace","addr":{"city":"London"}}}},"submissionKey":"'"$(uuidgen)"'"}'
```

Run the queue consumer (it needs the same environment; it stops when its three sample messages are consumed). Each
message is submitted under its broker message id, so the broker's second delivery of a message is answered with the
first receipt:

```sh
uv run --frozen --package datum-example-submissions python consumer.py
```

`routers.management` is mounted behind a placeholder dependency (`permit` in `app.py`); a real application puts its own
authentication there.
