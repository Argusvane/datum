"""The ABI gate: the program itself is asked whether it answers for the floor the host needs.

A manifest's ABI is a string from the build that wrote it, so it is never trusted: `__datum_inspect` refuses
(`abi_mismatch`) a request of another major or newer than its own, so a stale program file (assets not rebuilt, a
partial update, a restore) fails here and no submission is judged by it. A proof is kept against the program's SHA-256,
its kind and the floor it was proved for, so it costs one run per program; a refusal is never kept, so the next call
proves a repaired program at once.
"""

import re
import threading
from typing import Final

from datum_sandbox.json import JsonValue
from datum_sandbox.protocol._errors import ProgramUnavailableError

SANDBOX_ABI_MIN: Final = "4.1.0"
"""The sandbox ABI floor: a program that does not answer for it is refused at start. 4.1.0 is the first that reads
`hostContext`: an older program would ignore a host's context and judge every `host.` rule leniently. It is also
the first that judges journeys as the browser does now: a page with a `when` refused, Check answers pages, and
Continue checking deferred to the end by default."""
PDF_ABI_MIN: Final = "4.0.0"
"""The PDF ABI floor: a PDF program that reports an older ABI (or another major) is refused at start."""
PDF_REQUIRED_FEATURES: Final = ("signature", "verify-detail", "output-safety", "render-caps", "attachment-types")
"""The feature words of the `capabilities` reply the host needs; a program missing one is refused naming it."""

_VERSION: Final = re.compile(r"([0-9]{1,9})\.([0-9]{1,9})\.([0-9]{1,9})")
_ERROR_CODE: Final = re.compile(r"[A-Za-z0-9_.-]{1,64}")
_REBUILD: Final = (
    "Rebuild the program assets (npm run fastapi:assets) or install a argusvane-datum-programs release that ships them."
)


def sandbox_probe_request() -> dict[str, JsonValue]:
    """Return the probe: ``{abi: SANDBOX_ABI_MIN, op: "inspect", definition}`` over a form with no components."""
    return {
        "abi": SANDBOX_ABI_MIN,
        "op": "inspect",
        "definition": {
            "id": "datum-abi-probe",
            "root": {"id": "root", "type": "form", "configuration": {}, "children": {"content": []}},
        },
    }


def require_probe_answer(answer: JsonValue) -> None:
    """Accept only an object whose `ok` is the boolean `true` (strict truthiness); refuse anything else.

    Raises `ProgramUnavailableError` naming the program's error code (`unknown` when it gave none).
    """
    if isinstance(answer, dict) and answer.get("ok") is True:
        return
    code = "unknown"
    if isinstance(answer, dict):
        error = answer.get("error")
        if isinstance(error, dict) and isinstance(error.get("code"), str):
            code = str(error["code"])
    raise ProgramUnavailableError(
        f"The sandbox program does not answer for ABI {SANDBOX_ABI_MIN} ({code}). Rebuild the program assets "
        "(npm run fastapi:assets) or install a argusvane-datum-programs release that ships them."
    )


def semver(text: str) -> tuple[int, int, int] | None:
    """Return ``(major, minor, patch)`` of a plain ``N.N.N`` version (ASCII digits, no suffix), else `None`.

    Versions are compared by these numbers, never as text (``3.100.0`` is newer than ``3.18.0``).
    """
    match = _VERSION.fullmatch(text)
    if match is None:
        return None
    major, minor, patch = match.groups()
    return int(major), int(minor), int(patch)


def program_error_code(answer: JsonValue) -> str:
    """Return the `error.code` of a refusing reply when it is a plain code word, else ``unknown``."""
    if isinstance(answer, dict):
        error = answer.get("error")
        if isinstance(error, dict):
            code = error.get("code")
            if isinstance(code, str) and _ERROR_CODE.fullmatch(code):
                return code
    return "unknown"


def read_pdf_capabilities(answer: JsonValue) -> tuple[str, tuple[str, ...], str | None]:
    """Read a `capabilities` reply strictly into ``(abi, features, kernel_version)``.

    The reply must be an object whose `ok` is the boolean `true`, whose `abi` is text, whose `features` is a list of
    text, and whose `kernelVersion`, when present, is text; its `op` must be `capabilities`.
    Raises `ProgramUnavailableError` for anything else.
    """
    if not isinstance(answer, dict) or answer.get("ok") is not True or answer.get("op") != "capabilities":
        raise ProgramUnavailableError(
            f"The PDF program does not answer for ABI {PDF_ABI_MIN} ({program_error_code(answer)}). {_REBUILD}"
        )
    abi = answer.get("abi")
    features = answer.get("features")
    kernel_version = answer.get("kernelVersion")
    if (
        not isinstance(abi, str)
        or not isinstance(features, list)
        or not all(isinstance(item, str) for item in features)
        or not (kernel_version is None or isinstance(kernel_version, str))
    ):
        raise ProgramUnavailableError(
            f"The PDF program's capabilities reply is not well formed, so ABI {PDF_ABI_MIN} cannot be proved. "
            f"{_REBUILD}"
        )
    return abi, tuple(str(item) for item in features), kernel_version


def require_pdf_capabilities(answer: JsonValue) -> None:
    """Accept a `capabilities` reply only when its ABI answers for the floor and it lists every feature the host needs.

    The PDF program accepts any request of its own major, so the request proves nothing: the reply's `abi` is read as
    ``N.N.N`` numbers, must be in the floor's major and at least the floor, and every word of
    `PDF_REQUIRED_FEATURES` must be among the `features`. Raises `ProgramUnavailableError` with the rebuild hint.
    """
    abi, features, _ = read_pdf_capabilities(answer)
    floor = semver(PDF_ABI_MIN)
    found = semver(abi)
    if floor is None or found is None:
        raise ProgramUnavailableError(
            f"The PDF program reports an ABI that is not a version, so ABI {PDF_ABI_MIN} cannot be proved. {_REBUILD}"
        )
    if found[0] != floor[0] or found < floor:
        raise ProgramUnavailableError(
            f"The PDF program reports ABI {abi}, and the host needs {PDF_ABI_MIN} or a later minor of the same major. "
            f"{_REBUILD}"
        )
    missing = [word for word in PDF_REQUIRED_FEATURES if word not in features]
    if missing:
        raise ProgramUnavailableError(
            f"The PDF program lacks the features the host needs ({', '.join(missing)}). {_REBUILD}"
        )


class AbiProbe:
    """The memory of the ABI gate: which programs (by SHA-256 and kind) have proved which floor; one per program store.

    The kind keeps the two contracts apart: the sandbox and PDF floors can be the same version string, and a PDF
    program's proof is never a sandbox program's.
    """

    __slots__ = ("_lock", "_proved")

    def __init__(self) -> None:
        """Start with nothing proved."""
        self._lock = threading.Lock()
        self._proved: set[tuple[str, str, str]] = set()

    def proved(self, sha256: str, floor: str = SANDBOX_ABI_MIN, kind: str = "sandbox") -> bool:
        """Say whether the program of this kind with this SHA-256 has proved `floor`."""
        with self._lock:
            return (sha256, kind, floor) in self._proved

    def remember(self, sha256: str, floor: str = SANDBOX_ABI_MIN, kind: str = "sandbox") -> None:
        """Keep a successful proof (a refusal is never kept)."""
        with self._lock:
            self._proved.add((sha256, kind, floor))

    def forget(self, sha256: str | None = None) -> None:
        """Drop the proofs of one program, or of all when `sha256` is None (a recheck re-proves them)."""
        with self._lock:
            if sha256 is None:
                self._proved.clear()
            else:
                self._proved = {key for key in self._proved if key[0] != sha256}
