# The Python sandbox library

`argusvane-datum-sandbox` runs Datum's two programs in Python: the sandbox program that validates a submission and the PDF program. It does the hard part of running them once, for every Python host:

- **Choosing the engine.** It finds and starts the WebAssembly engine.
- **Isolating each run.** Each run gets a fresh instance, a read-only file system holding only its own files, a time and memory budget, and capped output.
- **Checking the answer.** Every answer is checked against the run protocol.
- **Proving the programs.** It proves the programs at start.
- **Limiting runs at once.** It caps how many runs go at the same time.
- **Reporting.** It tells you how its runs went.

It needs no framework, so it works in a script, a worker, Django, Flask, Litestar or anything else in Python. The [FastAPI host](/fastapi) is built on it, and on FastAPI you set the same settings as [environment variables](/fastapi-settings#datum-runtime).

## Packages

| Distribution | What it is |
|---|---|
| `argusvane-datum-sandbox` | The library: the settings, the lifecycle, the run protocol, the diagnostics. No engine and no framework. |
| `argusvane-datum-sandbox-wasmtime` | The engine, in-process, on wasmtime. |
| `argusvane-datum-programs` | The two programs, packaged. The library depends on it. |
| `argusvane-datum-qjs-wasm` | The pinned WebAssembly module the engine runs. The engine depends on it. |

The library has two extras: `aio` for the async facade, and `testing` for the contract kit an engine's tests use. The packages are not on PyPI yet: build the workspace as [FastAPI](/fastapi) describes, then add the two you need.

```sh
uv add argusvane-datum-sandbox argusvane-datum-sandbox-wasmtime
```

## Validate a submission

Make a `DatumSandbox`, start it once, and validate as many submissions as you like. With no arguments it uses the default settings, the engine it finds installed, and the packaged programs. Used as a context manager, it starts on entry and stops on exit.

```python
import json
from pathlib import Path

from datum_sandbox import DatumSandbox

definition = json.loads(Path("customer-intake.json").read_text())

with DatumSandbox() as datum:
    context = {
        "form": definition["root"],
        "values": {"fullName": "", "contactMethod": "email"},
        "locale": "en",
    }
    result = datum.sandbox.validate(context, real=True)
    print(result.outcome["errors"])
```

```json
[{"code": "required", "componentId": "fullName", "path": "fullName", "source": "wasm", "stage": "field-constraints"}]
```

The context and the outcome are the ones on [Your own server](/server-programs#the-sandbox-run):

- **The context.** It takes the form's root, the answers and the locale, plus the optional keys listed there.
- **The outcome.** It lists the errors by code. When no error blocks, it also carries the cleaned-up `values`, which is what you store.
- **`real`.** Pass `True` for a real submission, whose run log is passed on, and `False` for a check.

`datum.sandbox` also answers the other questions the sandbox program takes:

- `inspect`, about a definition;
- `check`, whether a definition may be saved;
- `public_copy`, the copy of a definition a browser may be served.

`start()` proves both programs before it returns.

- **When a proof fails.** By default, `start()` raises.
- **Starting down instead.** With `fail_fast=False` in the settings, it starts down: `status()` says why, and every run is refused until `recheck()` passes.
- **Threads.** A validation blocks the calling thread until it answers. The sandbox lets as many run at once as it has slots (one per CPU by default). A call that finds no free slot waits up to `validation_wait` (2 s) and is then refused as busy.

## Settings

`SandboxSettings.build` takes every setting by keyword. A keyword is the setting's key without `datum.runtime.` or `datum.host.`, with its dots as underscores: `validation_time_limit` is `datum.runtime.validation.time_limit`, and `formula_errors` is `datum.host.formula_errors`. A few drop their section:

| Keyword | Setting |
|---|---|
| `sandbox_program`, `pdf_program` | `datum.runtime.programs.sandbox`, `datum.runtime.programs.pdf` |
| `trace`, `report` | `datum.runtime.diagnostics.trace`, `datum.runtime.diagnostics.report` |
| `capture_enabled`, `capture_directory`, `capture_max_runs`, ... | `datum.runtime.diagnostics.capture.*` |

A setting you leave out, or pass as `None`, takes its default. [FastAPI settings](/fastapi-settings#datum-runtime) lists every key with its default and bounds. `unknown_fields` and `log_level` are checked and kept for the host that reads them (the FastAPI host's submission service); the sandbox itself does not.

```python
from datum_sandbox import DatumSandbox, SandboxSettings

settings = SandboxSettings.build(
    validation_time_limit=3.0,
    validation_concurrency=4,
    trace="failures",
)

with DatumSandbox(settings) as datum:
    ...
```

How `build` treats a value:

- **Out of bounds.** It is moved to its bound, and `settings.checks` holds one `datum.W008` warning for it.
- **Cannot work.** It is refused with a `DatumConfigurationError` that names the setting and what to do, such as a trace word that is none of `off`, `failures` and `all`, or a clock tick below 1 ms.

`explain()` says what the sandbox runs with. It lists every setting with its value in force and where that value came from: `default`, `configured`, `clamped` from what was asked, or `replaced` when you passed an input of your own in its place. With `validation_memory=5` added to the settings above, part of it reads:

```text
Datum sandbox settings (value, then where it came from):
  datum.runtime.engine = wasmtime (default)
  datum.runtime.fail_fast = True (default)
  datum.runtime.validation.time_limit = 3.0 (configured)
  datum.runtime.validation.memory = 4194304 (clamped from 5 to the bound 4194304 bytes to 1073741824 bytes)
  datum.runtime.validation.concurrency = 4 (configured)
  datum.runtime.pdf.concurrency = 0 (min(2, CPUs) = 2) (default)
  datum.runtime.diagnostics.trace = failures (configured)
  ...
```

## Status and shutdown

- **`status()`.** It says whether the sandbox is up and why not. `status().is_up` is the readiness answer, and `status().details` gives the state, the engine and its mode as a dict for a health check.
- **`recheck()`.** It proves the programs again without a restart, reading a program override afresh. It never raises: a failure leaves the sandbox down with the reason.
- **`stop()`.** It stops taking runs, ends the runs in flight, and closes the engine. Leaving the `with` block calls it.

In a framework, make the sandbox once at application start, call `start()` from the framework's start hook and `stop()` from its shutdown hook, and serve `status()` as a health check. The FastAPI host does the same, and adds the settings from the environment, the observation and the management routes.

## From async code

The library is synchronous. `datum_sandbox.aio`, from the `aio` extra, runs each call on a worker thread so the event loop never waits:

```python
from datum_sandbox import DatumSandbox
from datum_sandbox.aio import AsyncDatumSandbox

async with AsyncDatumSandbox(DatumSandbox()) as datum:
    result = await datum.sandbox.validate(context, real=True)
```

## PDFs

The PDF program runs on the same sandbox. `datum.pdf_kernel` sends it a request and checks the answer. The fonts ship in `argusvane-datum-programs`:

```python
import base64
from importlib.resources import files

font = files("datum_programs") / "resources" / "fonts" / "DejaVuSans.ttf"

with DatumSandbox() as datum:
    accepted = datum.sandbox.validate(context, real=True).outcome["values"]
    file = datum.pdf_kernel.document({
        "form": definition["root"],
        "values": accepted,
        "locale": "en",
        "fonts": [{
            "id": "sans",
            "family": "sans-serif",
            "data": base64.b64encode(font.read_bytes()).decode(),
        }],
        "env": {"createdAt": "2026-11-23T12:00:00.000Z", "documentId": "submission-1"},
    })
    Path("answers.pdf").write_bytes(file.pdf)
```

- **What it renders.** Render the cleaned-up `values` from a validation, not what was posted.
- **The layout.** With no `layoutId`, the answers choose the layout.
- **The other operations.** `fill`, `sign`, `complete`, `verify` and `inspect` take the requests [Your own server](/server-programs#the-pdf-run) lists. [PDFs](/pdf) and [Signing](/signing) describe them.
- **Limits.** PDF runs have their own time, memory and concurrency settings (`pdf_time_limit`, `pdf_memory`, `pdf_concurrency`).

The FastAPI host's PDF service adds the rest on top: the bold and italic faces, the seal and the server's key, timestamps and trust.

## Diagnostics

All three are settings. None of them can change a run's answer, and none can hold a run's slot.

### The run trace

`trace="failures"` writes one line for each failed run, and `trace="all"` one for every run, including the ones the sandbox makes at start. The line goes at INFO to the logger `datum.sandbox.trace`.

```text
run=cf0f863e0564 program=sandbox op=validate abi=1.0.0 engine=wasmtime mode=cranelift slotWaitMs=0.0 prepareMs=1.3 instantiateMs=0.5 startMs=522.4 totalMs=525.7 termination=budget exit=- outcome=budget stdinBytes=290 stdoutBytes=51 stderrBytes=0 capture=20261123-143359-cf0f863e0564
```

- **What it holds.** How the run went and how long each step took, how it ended, and the sizes of its input and output. It never holds an answer, the definition or the run's output.
- **What counts as failed.** A run that trapped, threw, hit its time or memory budget or an output cap, was stopped, could not start, or gave an answer the protocol could not take.
- **What does not.** A validation that finds errors is a normal answer, and so is the program's own refusal of a request.

To send the records somewhere else, such as metrics, pass a `trace`. It is called with a `TraceRecord`, whose fields are the line's:

```python
records: list[TraceRecord] = []

with DatumSandbox(SandboxSettings.build(trace="all"), trace=records.append) as datum:
    datum.sandbox.validate(context, real=False)

print(records[-1].outcome, records[-1].total)
```

### The failed-run capture

The capture keeps each failed run on disk so you can replay it: its input, its output, the generated run script, and a `meta.json` with the trace fields and the settings report.

```python
SandboxSettings.build(
    capture_enabled=True,
    capture_directory="/var/lib/myapp/datum-captures",
)
```

```text
datum-captures/
  20261123-143359-cf0f863e0564/
    meta.json  run.js  stderr.bin  stdin.bin  stdout.bin
```

::: warning A capture holds personal data
A capture holds the submitted answers and the form definition, in clear text. Turn the capture on to debug a failure and off again after. The sandbox logs a warning saying so at every start while it is on.
:::

The directory must be one only the application's own user can read:

- **Missing.** It is created with mode `700`.
- **Refused at start.** The start is refused if the directory:
  - is a link, or a file;
  - belongs to another user;
  - gives the group or others any permission;
  - is on macOS and has an access control list (`chmod -N` removes it; remove any inherited from its parent too).

  On a file system without POSIX permissions, such as Windows, the capture cannot be used.
- **Checked again.** The same checks run before every write.
- **Files.** Each is created with mode `600`.
- **Complete or absent.** A capture appears whole or not at all.

Bounds and timing:

- **Bounds.** `capture_max_runs` (20) and `capture_max_bytes` (64 MiB) bound what is kept, and the oldest captures go first.
- **The queue.** `capture_queue_bytes` (64 MiB) bounds what waits to be written. A capture that does not fit is dropped and counted.
- **Off the run's path.** The writing happens on a thread of its own, so a run never waits for its capture.
- **At stop.** What is still waiting is written in whatever is left of the shutdown grace.

`status().details` shows `captureDropped` and `captureFailed` while the capture is on. To keep captures elsewhere, such as an object store, pass a `capture_sink`. The bounds and the queue still apply.

### The settings report

At start, before the programs are proved, the sandbox logs one block at INFO on `datum.sandbox.settings`. It holds:

- what `explain()` lists;
- the engine, its release and its mode;
- each program's sha256 and interface version;
- whether the trace and the capture are on.

Any user name and password in a URL is masked, and so are URL query and fragment values. Turn it off with `report=False`.

## Inputs

Each of these is an optional keyword of `DatumSandbox`. Give one only when you need something other than the default.

| Keyword | What it replaces |
|---|---|
| `settings` | The defaults |
| `runtime` | The engine found installed: a `GuestRuntime` of your own. The sandbox closes it at stop. |
| `sandbox` | The sandbox program itself, with a `Sandbox` of your own |
| `engine_settings` | The stop grace and the stray bound of the settings |
| `sandbox_middleware`, `pdf_middleware` | Nothing: wrappers that observe every call, the first one outermost |
| `run_log` | Logging a real submission's run log on `datum.sandbox` |
| `now` | The clock `today()` is read from |
| `trace` | The log line of the run trace |
| `capture_sink` | The capture directory |
| `on_ready` | Nothing: told once the sandbox is up |
