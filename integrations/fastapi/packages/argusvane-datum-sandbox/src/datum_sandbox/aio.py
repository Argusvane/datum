"""The async facade (the `aio` extra): `DatumSandbox` and its two programs awaited from an event loop.

The library is synchronous: a start compiles the guest (about a second) and a run blocks its thread for up to its
budget. Each call here runs the synchronous call on a worker thread (`anyio.to_thread.run_sync`), so the loop never
blocks; the answer, every refusal and the slot rules are the synchronous call's own. A host that also bounds its worker
threads or drains them at shutdown (a web framework's binding) passes its own `limiter`.
"""

from collections.abc import Callable, Mapping, Sequence
from functools import partial
from types import TracebackType
from typing import Self

import anyio
import anyio.to_thread
from anyio import CapacityLimiter

from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import (
    PdfCapabilities,
    PdfCompleted,
    PdfInspected,
    PdfKernel,
    PdfProduced,
    PdfSigned,
    PdfVerified,
    RuleModule,
    Sandbox,
    SandboxResult,
)
from datum_sandbox.runtime import DatumSandbox, SandboxStatus

__all__ = ["AsyncDatumSandbox", "AsyncPdfKernel", "AsyncSandbox"]


class _OffTheLoop:
    """Runs a synchronous call on a worker thread, under the host's limiter when it gave one."""

    __slots__ = ("_limiter",)

    def __init__(self, limiter: CapacityLimiter | None) -> None:
        self._limiter = limiter

    async def call[T](self, function: Callable[[], T]) -> T:
        return await anyio.to_thread.run_sync(function, limiter=self._limiter)


class AsyncSandbox(_OffTheLoop):
    """A `Sandbox` awaited: each operation on a worker thread."""

    __slots__ = ("_sandbox",)

    def __init__(self, sandbox: Sandbox, *, limiter: CapacityLimiter | None = None) -> None:
        """Wrap `sandbox`; `limiter` bounds the worker threads (anyio's default limiter when `None`)."""
        super().__init__(limiter)
        self._sandbox = sandbox

    async def validate(
        self, context: Mapping[str, JsonValue], rules: Sequence[RuleModule] = (), *, real: bool
    ) -> SandboxResult:
        """Run one validation (see `Sandbox.validate`)."""
        return await self.call(partial(self._sandbox.validate, context, rules, real=real))

    async def inspect(
        self,
        op: str,
        definition: Mapping[str, JsonValue],
        *,
        formula_errors: str | None = None,
        extra: Mapping[str, JsonValue] | None = None,
        rules: Sequence[RuleModule] = (),
    ) -> dict[str, JsonValue]:
        """Ask the program about a definition (see `Sandbox.inspect`)."""
        return await self.call(
            partial(self._sandbox.inspect, op, definition, formula_errors=formula_errors, extra=extra, rules=rules)
        )

    async def check(
        self, definition: Mapping[str, JsonValue], types: Sequence[str], rules: Sequence[RuleModule] = ()
    ) -> dict[str, JsonValue]:
        """Ask whether a definition may be saved (see `Sandbox.check`)."""
        return await self.call(partial(self._sandbox.check, definition, types, rules))

    async def public_copy(self, definition: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        """Return the definition a browser may be served (see `Sandbox.public_copy`)."""
        return await self.call(partial(self._sandbox.public_copy, definition))


class AsyncPdfKernel(_OffTheLoop):
    """A `PdfKernel` awaited: each operation on a worker thread."""

    __slots__ = ("_kernel",)

    def __init__(self, kernel: PdfKernel, *, limiter: CapacityLimiter | None = None) -> None:
        """Wrap `kernel`; `limiter` bounds the worker threads (anyio's default limiter when `None`)."""
        super().__init__(limiter)
        self._kernel = kernel

    async def capabilities(self) -> PdfCapabilities:
        """Ask the program for its ABI and features."""
        return await self.call(self._kernel.capabilities)

    async def document(self, request: Mapping[str, JsonValue]) -> PdfProduced:
        """Render a form's answers to a PDF."""
        return await self.call(partial(self._kernel.document, request))

    async def fill(self, request: Mapping[str, JsonValue]) -> PdfProduced:
        """Fill a template PDF."""
        return await self.call(partial(self._kernel.fill, request))

    async def sign(self, request: Mapping[str, JsonValue]) -> PdfSigned:
        """Prepare a signature."""
        return await self.call(partial(self._kernel.sign, request))

    async def complete(self, request: Mapping[str, JsonValue]) -> PdfCompleted:
        """Embed the host's signature value."""
        return await self.call(partial(self._kernel.complete, request))

    async def verify(self, request: Mapping[str, JsonValue]) -> PdfVerified:
        """Read every signature of a PDF."""
        return await self.call(partial(self._kernel.verify, request))

    async def inspect(self, request: Mapping[str, JsonValue]) -> PdfInspected:
        """Describe a PDF."""
        return await self.call(partial(self._kernel.inspect, request))


class AsyncDatumSandbox(_OffTheLoop):
    """A `DatumSandbox` awaited: start, recheck and stop off the loop; `async with` starts and stops it."""

    __slots__ = ("_inner",)

    def __init__(self, sandbox: DatumSandbox, *, limiter: CapacityLimiter | None = None) -> None:
        """Wrap `sandbox`; `limiter` bounds the worker threads of the calls (anyio's default limiter when `None`)."""
        super().__init__(limiter)
        self._inner = sandbox

    @property
    def inner(self) -> DatumSandbox:
        """The synchronous sandbox (its `status()`, `explain()` and properties are cheap and loop-safe)."""
        return self._inner

    @property
    def sandbox(self) -> AsyncSandbox:
        """The composed sandbox, awaited; `ProgramUnavailableError` while it is not up."""
        return AsyncSandbox(self._inner.sandbox, limiter=self._limiter)

    @property
    def pdf_kernel(self) -> AsyncPdfKernel | None:
        """The PDF kernel, awaited, or `None` while PDFs are unavailable or off."""
        kernel = self._inner.pdf_kernel
        return None if kernel is None else AsyncPdfKernel(kernel, limiter=self._limiter)

    def status(self) -> SandboxStatus:
        """Return the status (no run is made: cheap enough for the loop)."""
        return self._inner.status()

    async def start(self) -> None:
        """Start the sandbox on a worker thread (the guest compiles there)."""
        await self.call(self._inner.start)

    async def recheck(self) -> SandboxStatus:
        """Re-prove or rebuild the sandbox on a worker thread."""
        return await self.call(self._inner.recheck)

    async def stop(self, *, deadline: float | None = None) -> None:
        """Stop the sandbox on a worker thread (its runs end interrupted; the capture drains to the deadline)."""
        await self.call(partial(self._inner.stop, deadline=deadline))

    async def __aenter__(self) -> Self:
        """Start the sandbox; a start that is cancelled or fails is stopped again before the error goes on.

        The worker thread finishes the start whatever the cancel (a compile cannot be cut short), so the stop after
        it is shielded: a cancelled `async with` never leaves an engine running.
        """
        try:
            await self.start()
        except BaseException:
            with anyio.CancelScope(shield=True):
                await self.stop()
            raise
        return self

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, traceback: TracebackType | None
    ) -> None:
        """Stop the sandbox, shielded from a cancel of the enclosing scope (the stop always runs to its end)."""
        with anyio.CancelScope(shield=True):
            await self.stop()
