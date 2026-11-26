"""`datum_core.aio.AsyncPdfService`: the PDF service on the runner, one tracked call per operation.

Each of `render`, `fill`, `sign`, `verify`, `render_submission` and `certificate_chain` is ONE tracked task with the
sync service's arguments: a caller cancelled natively leaves the effect (the seal, the event) to finish and the drain
waits for it. The work, the customizers, the signature and the revocation check run on a worker thread and never on the
loop; an async hook is resolved through the awaiter on the loop. The revocation adapter owns an `asyncio.Runner` for its
call, which only works because it is on a thread with no running loop: this module proves it while the loop runs. The
runner's busy and closed errors reach the caller as raised.
"""

import asyncio
import inspect
import threading
from typing import TYPE_CHECKING

import anyio
import anyio.lowlevel
import anyio.to_thread
import pytest
from pdf_support import (
    PdfRig,
    accepted_submission,
    envelope,
    fake_pdf,
    signature_report,
    started_pdf,
    verify_reply,
)
from submissions_support import bus

from datum_core.aio import AsyncPdfService, AsyncRunner, anyio_awaiter
from datum_core.pdf import PdfService, PdfTrustPolicy
from datum_core.pdf.outcomes import Printed, Verified
from datum_core.pdf.protocols import PdfRequestDraft
from datum_core.submissions import FormRef
from datum_core.testing.tsa_pki import DocumentPki, build_document_pki
from datum_sandbox.wasi import EngineBusyError, EngineClosedError

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

pytestmark = pytest.mark.anyio

DATA = fake_pdf("signed") + b"x" * 32
SEAL = {"pdf": {"seal": {"enabled": True, "timestamp": False}}}


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(scope="module")
def pki() -> DocumentPki:
    return build_document_pki()


def runner(threads: int = 4) -> AsyncRunner:
    return AsyncRunner(worker_threads=threads, wait=1.0, shutdown_grace=2.0)


def facade(rig: PdfRig, pool: AsyncRunner | None = None) -> AsyncPdfService:
    return AsyncPdfService(rig.service, pool or runner())


async def test_an_async_render_is_what_the_sync_service_answers() -> None:
    with started_pdf({"pdf": {"seal": {"enabled": False}}}) as rig:
        answer = await facade(rig).render(FormRef.from_document(), envelope(), bus())
    assert isinstance(answer, Printed)
    assert answer.data.startswith(b"%PDF-")
    assert [type(event).__name__ for event in rig.events] == ["PdfRenderedEvent"]


async def test_every_operation_has_an_async_twin_with_the_sync_signature() -> None:
    for name in ("render", "fill", "sign", "verify", "render_submission", "certificate_chain"):
        sync = inspect.signature(getattr(PdfService, name))
        wrapped = inspect.signature(getattr(AsyncPdfService, name))
        assert [(p.name, p.kind) for p in wrapped.parameters.values()] == [
            (p.name, p.kind) for p in sync.parameters.values()
        ], name
        assert inspect.iscoroutinefunction(getattr(AsyncPdfService, name)), name


async def test_the_facade_exposes_the_service_it_wraps() -> None:
    with started_pdf() as rig:
        assert facade(rig).service is rig.service


async def test_the_other_operations_answer_too(pki: DocumentPki) -> None:
    with started_pdf(SEAL, signer=pki.signer) as rig:
        service = facade(rig)
        assert isinstance(await service.sign(FormRef.from_document(), envelope(), bus()), Printed)
        assert isinstance(await service.render_submission(accepted_submission()), Printed)
        rig.runtime.on("verify", lambda _r: verify_reply(signature_report(pki.signer)))
        assert isinstance(await service.verify(DATA, bus()), Verified)
        assert "BEGIN CERTIFICATE" in str(await service.certificate_chain())


@pytest.mark.parametrize("operation", ["sign", "render_submission"])
async def test_the_work_and_the_signature_run_on_a_worker_thread_not_the_loop(pki: DocumentPki, operation: str) -> None:
    seen: list[int] = []

    def customize(draft: PdfRequestDraft) -> None:
        seen.append(threading.get_ident())

    with started_pdf(SEAL, signer=pki.signer, pdf_request_customizers=[customize]) as rig:
        assert rig.signer is not None
        original = rig.signer.sign

        def spying(to_be_signed: bytes) -> bytes:
            seen.append(threading.get_ident())
            return original(to_be_signed)

        rig.signer.sign = spying  # type: ignore[method-assign]
        service = facade(rig)
        if operation == "sign":
            await service.sign(FormRef.from_document(), envelope(), bus())
        else:
            await service.render_submission(accepted_submission())
    assert len(seen) >= 2
    assert threading.get_ident() not in seen


async def test_a_verify_runs_on_a_worker_thread_not_the_loop(pki: DocumentPki) -> None:
    seen: list[int] = []

    def answer(_request: dict[str, object]) -> dict[str, object]:
        seen.append(threading.get_ident())
        return verify_reply(signature_report(pki.signer))

    with started_pdf(SEAL, signer=pki.signer) as rig:
        rig.runtime.on("verify", answer)
        assert isinstance(await facade(rig).verify(DATA, bus()), Verified)
    assert seen
    assert threading.get_ident() not in seen


async def test_an_async_hook_is_resolved_through_the_anyio_awaiter_on_the_loop() -> None:
    loop_thread = threading.get_ident()
    ran_on: list[int] = []

    async def customize(draft: PdfRequestDraft) -> None:
        ran_on.append(threading.get_ident())
        await anyio.lowlevel.checkpoint()

    with started_pdf(
        {"pdf": {"seal": {"enabled": False}}}, awaiter=anyio_awaiter, pdf_request_customizers=[customize]
    ) as rig:
        await facade(rig).render(FormRef.from_document(), envelope(), bus())
    assert ran_on == [loop_thread]


# -- the revocation adapter on a worker thread, with the loop running --------------------------------------------------
async def test_a_revocation_check_runs_on_the_worker_thread_while_the_applications_loop_runs(pki: DocumentPki) -> None:
    pytest.importorskip("pyhanko_certvalidator", reason="the revocation extra is not installed")
    from cryptography.hazmat.primitives import serialization  # noqa: PLC0415 - tests only

    from datum_core.pdf import CertvalidatorRevocationChecker  # noqa: PLC0415
    from datum_core.testing.tsa_pki import INSTANT, make_crl  # noqa: PLC0415

    crl = make_crl(pki.signer.root, pki.signer.root_key, []).public_bytes(serialization.Encoding.DER)
    checker = CertvalidatorRevocationChecker(roots=(pki.signer.root_der,), crls=(crl,))
    policy = PdfTrustPolicy(anchors=(pki.signer.root_der,), revocation=checker)
    before = {thread.ident for thread in threading.enumerate()}
    with started_pdf(pdf_trust_policy=policy) as rig:
        rig.runtime.on("verify", lambda _r: verify_reply(signature_report(pki.signer)))
        answer = await facade(rig).verify(DATA, bus())
    assert isinstance(answer, Verified)
    assert answer.report.signatures[0].trust == "trusted"
    assert answer.report.signatures[0].trusted_at == INSTANT
    assert answer.report.trust_policy.revocation_checking is True
    leftover = {thread for thread in threading.enumerate() if thread.ident not in before and thread.is_alive()}
    assert not [t for t in leftover if "asyncio" in t.name.lower() or "loop" in t.name.lower()]


# -- the runner --------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("operation", ["render", "fill", "sign", "verify", "render_submission", "certificate_chain"])
async def test_a_call_that_the_runner_refuses_after_the_drain_began_raises_engine_closed_and_runs_nothing(
    operation: str,
) -> None:
    with started_pdf({"pdf": {"seal": {"enabled": False}}}) as rig:
        pool = runner()
        service = facade(rig, pool)
        await pool.drain()
        calls: dict[str, Callable[[], Awaitable[object]]] = {
            "render": lambda: service.render(FormRef.from_document(), envelope(), bus()),
            "fill": lambda: service.fill(FormRef.from_document(), envelope(), bus(), layout_id="t1"),
            "sign": lambda: service.sign(FormRef.from_document(), envelope(), bus()),
            "verify": lambda: service.verify(DATA, bus()),
            "render_submission": lambda: service.render_submission(accepted_submission()),
            "certificate_chain": service.certificate_chain,
        }
        with pytest.raises(EngineClosedError):
            await calls[operation]()
        assert rig.runtime.ops() == []
        assert rig.events == []


async def test_a_call_that_finds_no_free_worker_thread_raises_engine_busy_and_runs_nothing_more() -> None:
    gate, entered = threading.Event(), threading.Event()

    def hold(draft: PdfRequestDraft) -> None:
        entered.set()
        gate.wait(10)

    with started_pdf({"pdf": {"seal": {"enabled": False}}}, pdf_request_customizers=[hold]) as rig:
        pool = AsyncRunner(worker_threads=1, wait=0.05, shutdown_grace=2.0)
        service = facade(rig, pool)
        first = asyncio.create_task(service.render(FormRef.from_document(), envelope(), bus()))
        assert await anyio.to_thread.run_sync(entered.wait, 10)
        with pytest.raises(EngineBusyError):
            await service.render(FormRef.from_document(), envelope(), bus())
        gate.set()
        assert isinstance(await first, Printed)
        assert rig.runtime.ops() == ["document"]


async def test_a_native_cancel_of_the_caller_still_seals_publishes_and_the_drain_waits(pki: DocumentPki) -> None:
    gate, entered = threading.Event(), threading.Event()

    def hold(draft: PdfRequestDraft) -> None:
        entered.set()
        gate.wait(10)

    with started_pdf(SEAL, signer=pki.signer, pdf_request_customizers=[hold]) as rig:
        pool = runner()
        call = asyncio.create_task(facade(rig, pool).render_submission(accepted_submission()))
        assert await anyio.to_thread.run_sync(entered.wait, 10)
        call.cancel()  # what uvicorn does at --timeout-graceful-shutdown
        with pytest.raises(asyncio.CancelledError):
            await call
        assert pool.in_flight == 1
        gate.set()
        result = await pool.drain()
        assert result.abandoned == 0
        assert rig.signer is not None
        assert len(rig.signer.signs) == 1
        assert rig.kinds() == ["PdfRenderedEvent"]
        assert rig.runtime.ops() == ["document", "complete"]


async def test_concurrent_renders_each_seal_once_with_their_own_document_id(pki: DocumentPki) -> None:
    with started_pdf(SEAL, signer=pki.signer) as rig:
        service = facade(rig, runner(8))
        answers = await asyncio.gather(
            *(service.render_submission(accepted_submission(digest=f"{i:064x}")) for i in range(8))
        )
        ids = {call.request["env"]["documentId"] for call in rig.runtime.calls if call.op == "document"}
    assert all(isinstance(a, Printed) for a in answers)
    assert len(ids) == 8
    assert rig.signer is not None
    assert len(rig.signer.signs) == 8
