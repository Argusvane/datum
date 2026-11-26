# argusvane-datum-sandbox

Datum's two programs (the sandbox program that validates a submission and the PDF program) run here, in a hardened
WebAssembly sandbox, for any Python framework or none. The package holds:

- `datum_sandbox.wasi`: the generic hardened WASI run (a thread per run, slots, a private read-only `/app`, bounded
  output, the stop grace and the stray bound, engine discovery). It imports nothing but the standard library.
- `datum_sandbox.protocol`: the Datum run protocol (the run script, the nonce frame, the ABI gate, the strict answer
  reading, `SandboxService`, `PdfKernelService`, the decorator seams).
- `datum_sandbox.runtime`: `SandboxSettings` (every clamp, `explain()`) and `DatumSandbox` (start, status, recheck,
  stop; a context manager).
- `datum_sandbox.diagnostics`: the run trace, the failed-run capture and the settings report.
- `datum_sandbox.aio`: the async facade (the `aio` extra).
- `datum_sandbox.testing`: the contract kit an engine's tests bind (the `testing` extra).

An engine is a separate distribution: `argusvane-datum-sandbox-wasmtime`.

```python
from datum_sandbox import DatumSandbox, SandboxSettings

with DatumSandbox(SandboxSettings.build(validation_time_limit=2.0)) as sandbox:
    result = sandbox.sandbox.validate(context, real=False)
```

Part of the Datum for FastAPI workspace; see `integrations/fastapi/` in the repository.
