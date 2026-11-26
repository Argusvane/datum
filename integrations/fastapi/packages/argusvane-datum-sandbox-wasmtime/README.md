# argusvane-datum-sandbox-wasmtime

The wasmtime engine of argusvane-datum-sandbox: the pinned QuickJS-ng guest (`qjs-wasi.wasm` from `argusvane-datum-qjs-wasm`) run on
[wasmtime-py](https://github.com/bytecodealliance/wasmtime-py) under the sandbox's run harness (`datum_sandbox.wasi`, the only part of the library it imports). It registers the engine
`wasmtime` in the `datum.guest_runtimes` entry-point group, which `datum.runtime.engine` selects by default.

Part of the Datum for FastAPI workspace; see `integrations/fastapi/` in the repository.

## What it does

- **At start, once per process.** Imports wasmtime (an unsupported platform is refused by name, see below), reads the
  guest and re-hashes it against the pin (or `datum.runtime.qjs_path` against `datum.runtime.qjs_sha256`), builds one
  `Engine` (epoch interruption on, fuel off, the memory settings below), compiles one `Module`, links WASI once and
  instantiates one throwaway store, so an address-space refusal stops the start rather than the first run. Compiling
  takes about half a second to 1.4 s on a laptop and 4 to 7 s on a 1-vCPU Linux VM: build the runtime off the event
  loop and report the runtime as down until it returns. Leftover run directories older than six minutes are swept.
- **One store per run**, created, run and closed on the run's worker thread (never shared): `set_limits(memory_size=
  <the run's budget>, instances=1, memories=1, tables=1)`, an epoch deadline of `ceil(budget / tick) + 1` ticks, the
  run's private `app/` preopened read-only as `/app`, stdin from a sibling file, no environment. The store and its
  `WasiConfig` are closed by the run's context stack, never by a finalizer, before the directory is removed.
- **One epoch clock thread** (`datum-epoch-clock`) advances the engine's epoch every `datum.runtime.tick` (50 ms). A
  looping guest ends within two ticks of its wall budget; there is no timer per run.
- **Output caps.** The stdout and stderr callbacks are the harness's bounded sinks: they keep bytes up to the cap
  (32 MiB and 64 KiB by default), then set the cap flag and discard, return the full count, never raise and never touch
  the store. A finite producer ends by itself; an endless one is ended by its wall budget. Any run with a cap flag set
  ends as `output-cap`.
- **How a run ended.** A plain return from `_start` (or exit 0, even with memory filled to the cap) is clean;
  `ExitTrap` is an exit with its code; a `Trap` is read by its code (`INTERRUPT` is the wall budget); a
  `WasmtimeError` is a trap. The engine reports `memory` only when the guest's memory ended at the store's limit, and
  that is the only memory stop: QuickJS's `InternalError: out of memory` exit below the limit (an allocation larger
  than the room left), like the same words thrown by a rule, is an exit the sandbox reads as a throw.
- **Recursion ends at the shadow stack.** QuickJS-ng checks no stack under WASI, and its C stack (64 KiB, between the
  module's static data and its heap) runs out at about 190 plain JavaScript frames, well before wasmtime's 512 KiB
  wasm stack. Nothing traps there: the guest goes on over its own overwritten statics. So each run writes a canary over
  the stack's lowest 4 KiB before `_start`, and after the guest ends, however it ended, a changed canary or a changed
  `.rodata` segment makes the run a trap (`the guest's shadow stack reached its floor`). A runaway recursion can
  therefore take its whole wall budget before it is read as a trap. The layout is read from the module's name section;
  `engine_info().notes` says whether the guard is on.
- **One harness per pool, one `run()`.** A run's `RunBudget.pool` (`validation` or `pdf`, set by
  `ProgramLimits.validation_budget()` and `pdf_budget()`) picks its slots among `EngineLimits.pools`, over the same
  engine; the runtime's `pools` names them, and a run naming another pool is refused.
- **Sleeps end at the budget.** The epoch cannot interrupt a guest waiting inside a host call, and a rule module can
  reach `os.sleep` and `os.setTimeout` through `import('qjs:os')`. The runtime therefore shadows the one WASI import
  that waits, `poll_oneoff(in, out, nsubscriptions, nevents) -> errno`: a clock wait is cut to the run's remaining
  wall budget and woken by its stop, then held until the store's epoch deadline has passed, so a sleeping run ends
  `budget` within its wall (or `interrupted` at shutdown), with no stuck run and no stray thread. Descriptor
  subscriptions are ready at once (every descriptor the guest has is a regular file or a bounded sink). No other
  import waits: stdin and `/app` are regular files, the outputs are the harness's sinks, `proc_exit` ends the guest.
- **Shutdown.** `close()` refuses new runs, marks every run in flight as interrupted, advances the epoch past every
  armed deadline (the one global bump), waits the stop grace and stops the clock. Interrupted runs end as
  `interrupted` (the sandbox answers 503 `server.unavailable`). The application's own drain (`datum.runtime.
  shutdown_grace`) comes before it.

A run that does not end within its wall budget plus the stop grace all the same is answered `stuck` and its thread
counted as a stray that keeps its slot until it ends; at `EngineSettings.stray_bound` strays new runs are refused
`server.busy`.

## Memory settings and sizing

wasmtime's defaults reserve 4 GiB of address space plus a 64 MiB guard region per linear memory, whatever the guest
uses: eight run slots then need about 33 GB of address space and fail under `ulimit -v`, in address-space-limited
containers and on hardened hosts. Datum sets instead, from the two caps the runtime is built with (`EngineLimits.memory_bytes`, the validation memory, and `max_memory_bytes`, the PDF memory,
which the binding fills once from the clamped `datum.runtime.validation.memory` and `datum.runtime.pdf.memory` through
`ProgramLimits.runtime_limits()`; 32 MiB and 256 MiB by default; the provider has no memory settings of its own):

| Engine setting | Value |
|---|---|
| `memory_guard_size` | 0 |
| `memory_reservation` | `EngineLimits.memory_bytes` (32 MiB) rounded up to whole 64 KiB pages |
| `memory_reservation_for_growth` | `EngineLimits.max_memory_bytes` (256 MiB) minus the reservation, in whole pages |
| per store, `set_limits(memory_size=..., instances=1, memories=1, tables=1)` | the run's own memory budget |

A run whose budget is above the reservation plus the growth room is still limited to its budget, but its store is
moved to a new address-space reservation as it grows, which the sizing below does not cover: the runtime logs one
`WARNING` on `datum.runtime` the first time it happens in the process. Build the runtime with the largest budget you
give as `max_memory_bytes`.

A validation store never grows past its reservation; a PDF store that grows past it is moved once into a region that
holds its whole cap. A reservation below the guest's cap makes growth reserve a far larger region, which `ulimit -v`
refuses, and the guest then dies with `InternalError: out of memory` before reaching its cap: keep the settings as they
are. The memory budget cannot go below the module's initial pages (256 KiB for QuickJS-ng 0.16.2): below it the engine
raises `MemoryFloorError`, which the sandbox's start reports as `datum.E003`.

Sizing (measured on Linux x86_64; macOS reports and enforces no address-space limit):

- address space: about 50 MiB, plus per validation slot (validation memory + 1 MiB), plus per PDF slot (PDF memory +
  validation memory + 1 MiB) while PDF runs are live;
- resident memory: about 35 MiB on Linux (about 100 MiB on macOS) with the compiled module, plus per live run 2.7 MiB
  plus what the guest uses.

When the throwaway store at start cannot reserve its memory, wasmtime says `mmap failed to reserve ...`, and the start
is refused naming `datum.runtime.validation.memory`, the bytes asked for and the address-space limit (`ulimit -v`).
The throwaway store is also grown to the PDF cap's room (address space only, nothing touched); a limit that admits one
validation reservation but not that grow refuses the start naming `datum.runtime.pdf.memory`.

## Platforms

wasmtime-py ships native libraries for 64-bit Linux (glibc and musl), macOS and Windows on x86_64 and arm64; the
requirement's environment marker installs wasmtime only there. Elsewhere `pip` can still install the `py3-none-any`
wheel, which carries only the Windows library, and `import wasmtime` fails with a bare `OSError`: Datum turns that into
the start-up refusal naming the platform and `platform.machine()`, and the provider reports itself unavailable.

On Alpine and other musl systems the wheel needs `libgcc_s.so.1`:

```dockerfile
FROM python:3.12-alpine
RUN apk add --no-cache libgcc
```

## Versions

wasmtime-py releases a major about monthly; this distribution allows one tested major at a time, `>=50,<51`. The floor
is the first release that ships the thread-safe handle table of upstream PR #344 (50.0.1). The test suite's slab canary is two tests: a
deterministic shape test, a strict expected failure on 49.0.0's free-list table, and the 16 x 200 stress test, skipped
on that table (a known race decides nothing) and a hard requirement on #344's.
