"""What a finished sandbox run means, and the strict reading of its answer.

Only a clean end whose stdout is exactly this run's frame is an answer. The runtime's own stops come first, because a
stopped run is never an answer whatever its stdout holds (a frame written before the cap included): the output cap
whenever either stream was capped, whatever ended the run (the capped flag decides, read from the result, never from
stderr words); then the time budget, a stuck run and a run the closing runtime stopped (`INTERRUPTED`, nothing
judged); then the byte counts are checked again against the caps, so a runtime that kept more than a cap is refused
too; then the end is read. A stop counts as the guest's own (`guest_stopped`) only when its started marker is in stdout:
before that, nothing the run did says anything about what was asked of it. The same marker splits a nonzero exit: after
it the program threw (`THREW`), before it the run gave no outcome (`NO_OUTCOME`).

The memory stop (`MEMORY`) is the engine's word only: `RunEnd.MEMORY`, reported when the engine saw the store's limit
reached. No stderr text makes a run the memory stop: QuickJS's `InternalError: out of memory` is a nonzero exit like
any other (`THREW` after the started marker), because a rule module can write or throw those very words
(`throw new InternalError('out of memory')`), and a forged memory stop would read as the guest's own (a check would
answer `definition.tooCostly`). An allocation QuickJS is refused below the limit (one larger than the room left) is
therefore a throw; the engine's limit is what the budget promises.
"""

import codecs
from typing import Final

from datum_sandbox.json import BadDocumentError, JsonValue, read
from datum_sandbox.protocol._errors import SandboxError, SandboxFailure
from datum_sandbox.protocol._frame import framed, has_stray_output, started
from datum_sandbox.wasi import RunBudget, RunEnd, RunResult

MAX_OUTCOME_UNITS: Final = 8 * 1024 * 1024
"""The longest outcome a validation may answer, in UTF-16 code units (not code points)."""
MAX_ANSWER_DEPTH: Final = 512
"""The deepest an answer may be nested (containers), above the program's own request bound."""

_CHUNK: Final = 1 << 16
_BMP_LAST: Final = 0xFFFF


def stderr_text(result: RunResult) -> str:
    """Return stderr as text for the log: decoded with replacement, without leading and trailing ASCII controls."""
    return result.stderr.strip(bytes(range(33))).decode("utf-8", "replace")


def _output_cap(budget: RunBudget, stderr: str) -> SandboxError:
    return SandboxError(
        SandboxFailure.OUTPUT_CAP,
        f"The sandbox run wrote more than its output limit ({budget.stdout_cap} bytes to stdout, "
        f"{budget.stderr_cap} to stderr).",
        stderr=stderr,
    )


def sandbox_answer(result: RunResult, nonce: str, budget: RunBudget) -> bytes:
    """Return the framed answer of a sandbox run (bytes, not yet decoded), or raise `SandboxError` with the reason."""
    stderr = stderr_text(result)
    was_started = started(result.stdout, nonce)
    if result.end is RunEnd.OUTPUT_CAP or result.stdout_capped or result.stderr_capped:
        raise _output_cap(budget, stderr)
    if result.end is RunEnd.BUDGET:
        raise SandboxError(
            SandboxFailure.BUDGET,
            f"The sandbox run passed its {budget.wall_seconds:g} s budget.",
            stderr=stderr,
            guest_stopped=was_started,
        )
    if result.end is RunEnd.STUCK:
        # It passed its budget and did not stop within the grace: a budget stop, but the engine's failure to stop it
        # proves nothing about the definition.
        raise SandboxError(
            SandboxFailure.BUDGET,
            f"The sandbox run passed its {budget.wall_seconds:g} s budget and did not stop.",
            stderr=stderr,
        )
    if result.end is RunEnd.INTERRUPTED:
        # The runtime was closed under the run (shutdown): a host stop that judges nothing.
        raise SandboxError(
            SandboxFailure.INTERRUPTED, "The sandbox runtime stopped the run while closing.", stderr=stderr
        )
    if len(result.stdout) > budget.stdout_cap or len(result.stderr) > budget.stderr_cap:
        raise _output_cap(budget, stderr)
    if result.end is RunEnd.CLEAN or (result.end is RunEnd.EXIT and result.exit_code == 0):
        answer = framed(result.stdout, nonce)
        if answer is None:
            if has_stray_output(result.stdout, nonce):
                raise SandboxError(SandboxFailure.FRAME, "The sandbox wrote outside its answer frame.", stderr=stderr)
            raise SandboxError(SandboxFailure.NO_OUTCOME, "The sandbox printed no outcome.", stderr=stderr)
        return answer
    if result.end is RunEnd.MEMORY:
        raise SandboxError(
            SandboxFailure.MEMORY,
            "The sandbox run passed its memory budget.",
            stderr=stderr,
            guest_stopped=was_started,
        )
    if result.end is RunEnd.TRAP:
        raise SandboxError(SandboxFailure.TRAP, "The sandbox program trapped.", stderr=stderr)
    if not was_started:
        # A nonzero exit before this run's started marker: the run script never reached the guest.
        raise SandboxError(SandboxFailure.NO_OUTCOME, "The sandbox exited before it started.", stderr=stderr)
    # Every other end is handled above: what is left is a nonzero exit after the started marker, whatever its stderr
    # says (QuickJS's own out-of-memory report included: only the engine's `RunEnd.MEMORY` is the memory stop).
    raise SandboxError(SandboxFailure.THREW, "The sandbox program threw.", stderr=stderr)


def utf16_units(answer: bytes) -> int:
    """Return the UTF-16 length of strict UTF-8 bytes, decoded in chunks so no text of the answer's size is built.

    Raises `UnicodeDecodeError` when the bytes are not UTF-8.
    """
    decoder = codecs.getincrementaldecoder("utf-8")("strict")
    units = 0
    view = memoryview(answer)
    for at in range(0, len(answer), _CHUNK):
        text = decoder.decode(view[at : at + _CHUNK], final=at + _CHUNK >= len(answer))
        units += len(text) + sum(1 for char in text if ord(char) > _BMP_LAST)
    if not answer:
        decoder.decode(b"", final=True)
    return units


def _strict(answer: bytes, stderr: str) -> JsonValue:
    try:
        return read(answer, max_depth=MAX_ANSWER_DEPTH)
    except BadDocumentError:
        raise SandboxError(
            SandboxFailure.NOT_JSON, "The sandbox printed something that is not JSON.", stderr=stderr
        ) from None


def read_outcome(answer: bytes, stderr: str = "") -> dict[str, JsonValue]:
    """Read a validation's outcome: at most 8 Mi UTF-16 units, strict JSON, an object with an `errors` list.

    An answer of at most `MAX_OUTCOME_UNITS` bytes is under the cap without counting (UTF-16 units never outnumber
    UTF-8 bytes); a longer one is counted before it is parsed, and nothing of a refused one is kept.
    """
    if len(answer) > MAX_OUTCOME_UNITS:
        try:
            units = utf16_units(answer)
        except UnicodeDecodeError:
            raise SandboxError(
                SandboxFailure.NOT_JSON, "The sandbox printed something that is not JSON.", stderr=stderr
            ) from None
        if units > MAX_OUTCOME_UNITS:
            raise SandboxError(
                SandboxFailure.OUTCOME_TOO_LARGE,
                f"outcome.tooLarge: the sandbox answered with {units} UTF-16 code units; a run's outcome is at most "
                f"{MAX_OUTCOME_UNITS}.",
                stderr=stderr,
            )
    outcome = _strict(answer, stderr)
    if not isinstance(outcome, dict) or not isinstance(outcome.get("errors"), list):
        raise SandboxError(SandboxFailure.NO_OUTCOME, "The sandbox printed no outcome.", stderr=stderr)
    return outcome


def read_inspect(answer: bytes, op: str, stderr: str = "") -> dict[str, JsonValue]:
    """Read an inspect answer: strict JSON, an object whose `ok` is a boolean; `ok` other than `true` is a refusal."""
    reply = _strict(answer, stderr)
    if not isinstance(reply, dict) or not isinstance(reply.get("ok"), bool):
        raise SandboxError(SandboxFailure.NO_OUTCOME, "The sandbox printed no inspect answer.", stderr=stderr)
    if reply["ok"] is not True:
        error = reply.get("error")
        code = error.get("code") if isinstance(error, dict) else None
        message = error.get("message") if isinstance(error, dict) else None
        program_code = code if isinstance(code, str) else "unknown"
        raise SandboxError(
            SandboxFailure.REFUSED,
            f"The sandbox refused the {op} request ({program_code}).",
            stderr=stderr,
            program_code=program_code,
            program_message=message if isinstance(message, str) else "",
        )
    return reply
