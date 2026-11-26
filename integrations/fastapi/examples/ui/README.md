# UI example

A FastAPI application that serves the form builder and the forms it edits, over in-memory stores. The application seeds a
writable form repository from the kit's fixture form in `forms/`, mounts `routers.forms`, `routers.assets` and
`routers.builder`, and opens the builder at `/builder`, a page that loads the shipped page glue (`/datum/assets/datum-host.js`)
and calls `DatumHost.builder` on the form `datum-security-suite`; saves go out with `If-Match`. The builder and its
author's copy sit behind a placeholder dependency (`permit` in `app.py`), so any caller may build; a real application puts
its own authentication there. Every store is in memory: a restart forgets the saves. Nothing here holds a secret.
Install the workspace first (see [the workspace README](../../README.md)): `npm run fastapi:assets` from the repository root,
then `uv sync --all-packages --all-extras --frozen` in `integrations/fastapi`.

Run the application from this directory:

```sh
export DATUM_BUILDER__ENABLED=true
export DATUM_WEB__ASSETS__ENABLED=true
export DATUM_WEB__API__ENDPOINTS__DEFINITION=true
uv run --frozen --package datum-example-ui uvicorn app:app --port 8000
```

Open the builder at <http://localhost:8000/builder>. The form's definition is at `/api/forms/datum-security-suite/definition`.
