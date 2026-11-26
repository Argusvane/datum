# ADR 0181: A fresh sandbox for every server call

## Status

Accepted.

## Context

The sandbox program (ADR 0029) is built so that no plugin can reach the kernel's state: one closure,
three non-configurable entry points, a frozen language. That protects the program from its plugin
modules. It does not make one sandbox instance safe to share between submissions. A sandbox that
serves many submissions of many forms is one place where a single armed run (a global it defined,
state a plugin module kept, a prototype patched where the freeze is off, memory it grew) can change
every verdict after it, and the freeze has a documented opt-out.

On the page the question does not arise: one sandbox serves the session's runs, since the answers
there are the filler's own. On a server each call judges another person's submission.

The sandbox's deadline is a QuickJS interrupt handler, polled every few thousand VM operations. A
native call that runs long (a `split` of a megabyte string, a `repeat`) outlasts it, and on the
calling thread the whole process waits.

## Decision

1. **Every server call runs in a sandbox no other call has run in.** The Spring Boot and FastAPI
   hosts start each run in a new instance of `qjs-wasi.wasm` (ADR 0176 holds the per-language
   detail), and the Node hosts do the same with the engine's own module. A sandbox is a new
   WebAssembly instance of the engine with its own linear memory, a runtime and context in it, the
   program evaluated, the entry points captured before the freeze and any plugin, and the plugin
   modules registered. It serves one call, whatever the call is (a run, an inspect, the question
   that sizes the scaled time budget, the ABI probe), and is thrown away. There is no pool of warm
   instances that carry state from one call to the next.

2. **The state a sandbox would keep lives outside it.** The prepared-definition cache has nothing
   to keep (the host sizes it to 0) and the heap recycler nothing to replace. The scaled time
   budgets are remembered on the host's side, under a hash of the definition.

3. **A Node server builds the next sandbox ahead.** `QuickJsWorkerHost` builds the next sandbox as
   soon as a call's answer is posted and says `ready`; the host sends a call only after that and
   forgets the readiness as it sends. The worker takes the sandbox and clears it in one step and
   marks its memory spent, so it refuses a call in a memory it has seen. A build that fails after a
   call fails the call waiting for it, as any startup failure is, and the thread is replaced.

4. **A server runs the sandbox on its own thread, with a second clock.** `QuickJsWorkerHost`
   (`@argusvane/datum-quickjs-wasm-host/worker`, Node only) keeps one `node:worker_threads` worker
   for its whole life and a fresh sandbox per call inside it. The host terminates the worker at
   `maxEvalMs` plus `killSlackMs`, answers `interrupted`, and starts a new worker for the next call.
   A call whose instance grows its WebAssembly memory past `maxWasmHeapBytes` is interrupted
   (checked at the interrupt poll, inside the worker); a thread past its V8 heap ceiling is ended
   by Node and replaced, and the call fails as `runtime_error`. `@argusvane/datum-submissions/node` binds the
   worker host by default (ADR 0064, decision 15).

5. **The calling-thread host is the same fresh sandbox without the second clock.** With
   `worker: false` the submissions package binds `QuickJsFreshSandboxHost`: a fresh sandbox per
   call on the calling thread, with no kill and no ceiling on the instance's WebAssembly memory.

6. **A sandbox a host-side error unwound through is never freed.** The worker drops a sandbox whole,
   unfreed, when a host-side error poisoned its runtime or a job is still queued in it, because
   freeing such a runtime aborts the instance. A queued job never runs, so a plugin that queues a
   spinning job costs the call nothing. The calling-thread host settles queued jobs under the call's
   own deadline and, on `dispose`, runs what is left for a short grace before freeing the runtime;
   only a poisoned runtime is dropped whole.

7. **One worker, one queue, and admission is the host's.** Calls run one at a time, first in first
   out, for every form. A slow or killed call delays every form behind it, so a host admits requests
   (a rate, a queue depth) before the sandbox.

The settings of each runner, the worker's options and their defaults are in
`docs/reference/server-runs.md`, "In process on Node: a fresh sandbox per call".

## Reasoning

- **A fresh sandbox for every call.** What a run can leave behind (a global it defined, state a
  plugin module kept, a prototype a plugin patched with the freeze off, memory it grew) cannot
  reach the next call, because the next call runs in an instance that never held it. That does not
  depend on the freeze, the closure or the plugin being well behaved, and the freeze can be turned
  off.
- **The thread is kept and the sandbox goes.** Starting a worker thread costs more than building a
  sandbox, so a thread per call would make the cost of isolation the dominant cost. Isolating the
  state per call and the clock per thread are two separate properties, and each is bought where it
  is cheap.
- **A thread and a kill clock, not a longer interrupt handler.** An interrupt handler cannot stop a
  native call, so the host must be able to end the thread.
- **Build ahead.** Evaluating the program is most of a sandbox's cost. Building the next sandbox
  while the host is idle means a lone call finds one ready, and the isolation costs nothing the
  caller waits for.
- **The calling-thread host exists for hosts without a worker.** It has the same state isolation and
  lacks the second clock, which is why a server keeps the worker.

## Consequences

- Nothing one submission's run did reaches the next.
- Each call pays for the program's evaluation. Calls back to back wait for each build in turn.
- A plugin that queues a spinning job holds the calling-thread host for the call's whole budget and
  its grace. The worker host avoids it.
- A filler who can make calls run into the kill (a native-heavy answer) slows the whole service while
  they keep sending, which is why admission sits in front of the sandbox.
- The page keeps one sandbox for a session and its synchronous adapter.
