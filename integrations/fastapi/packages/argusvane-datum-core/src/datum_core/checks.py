"""Start-up checks: the record, the stable ids, the refusal error and the configuration constructors."""

import logging
import os
import sys
from collections.abc import Collection, Iterable
from pathlib import Path
from typing import Final, Protocol

from datum_core.loggers import CHECKS
from datum_sandbox.checks import SANDBOX_CHECK_LEVELS, CheckLevel, DatumCheck

# The ids are stable and documented. Each is a constant so no module spells one twice.
I001: Final = "datum.I001"  # the Datum routes that are on
I002: Final = "datum.I002"  # a PDF timestamp client URL or credentials unused beside the application's Timestamper
W001: Final = "datum.W001"  # a router was included and every switch it reads is off
W002: Final = "datum.W002"  # slots times memory exceeds the container limit
W003: Final = "datum.W003"  # the default logging submission handler is in use
W004: Final = "datum.W004"  # a per-process store in memory
W005: Final = "datum.W005"  # an engine over in-memory SQLite
W007: Final = "datum.W007"  # an unknown DATUM_ environment key
W009: Final = "datum.W009"  # a trust-state memory store acknowledged
W010: Final = "datum.W010"  # the process time zone could not be read; UTC is used
W011: Final = "datum.W011"  # the PDF seal asks a timestamp and no timestamper is set up
W012: Final = "datum.W012"  # a PDF timestamp policy unused beside the application's Timestamper
W013: Final = "datum.W013"  # the PDF seal is on and the server has no signing key
E001: Final = "datum.E001"  # a trust-state store in memory and not acknowledged
E002: Final = "datum.E002"  # the builder on with an in-memory store and more than one worker
E005: Final = "datum.E005"  # a shared throttle storage and no datum.web.throttle.key_salt
E006: Final = "datum.E006"  # the throttle storage cannot be built (a missing client library, an unusable URI)

CHECK_LEVELS: Final[dict[str, CheckLevel]] = {
    I001: CheckLevel.INFO,
    I002: CheckLevel.INFO,
    W001: CheckLevel.WARNING,
    W002: CheckLevel.WARNING,
    W003: CheckLevel.WARNING,
    W004: CheckLevel.WARNING,
    W005: CheckLevel.WARNING,
    W007: CheckLevel.WARNING,
    W009: CheckLevel.WARNING,
    W010: CheckLevel.WARNING,
    W011: CheckLevel.WARNING,
    W012: CheckLevel.WARNING,
    W013: CheckLevel.WARNING,
    E001: CheckLevel.ERROR,
    E002: CheckLevel.ERROR,
    E005: CheckLevel.ERROR,
    E006: CheckLevel.ERROR,
    **SANDBOX_CHECK_LEVELS,
}
"""Every documented id and its level."""


def silence(checks: Iterable[DatumCheck], silenced: Collection[str]) -> tuple[DatumCheck, ...]:
    """Drop the INFO and WARNING checks whose id is silenced; an ERROR is never dropped."""
    return tuple(c for c in checks if c.level is CheckLevel.ERROR or c.id not in silenced)


def log_checks(checks: Iterable[DatumCheck], logger: logging.Logger | None = None) -> None:
    """Write each check to ``datum.checks`` as ``(id) msg`` plus ``HINT: hint`` at its level."""
    target = logger or logging.getLogger(CHECKS)
    levels = {CheckLevel.INFO: logging.INFO, CheckLevel.WARNING: logging.WARNING, CheckLevel.ERROR: logging.ERROR}
    for check in checks:
        target.log(levels[check.level], "(%s) %s", check.id, check.msg, extra={"datum_check_id": check.id})
        if check.hint:
            target.log(levels[check.level], "HINT: %s", check.hint, extra={"datum_check_id": check.id})


# ---------------------------------------------------------------------------------------------------------------------
# The refusals and warnings the configuration layer can state on its own. Each returns a check; none raises.
# ---------------------------------------------------------------------------------------------------------------------
def unknown_env_key(name: str, suggestion: str | None = None) -> DatumCheck:
    """``datum.W007``: an environment key under the DATUM_ prefix that names no setting."""
    hint = "set datum.strict_env=true to refuse the start on an unknown key"
    if suggestion:
        hint = f"did you mean {suggestion}? {hint}"
    return DatumCheck(CheckLevel.WARNING, W007, f"the environment key {name} matches no Datum setting", hint)


def throttle_storage_unusable(error_class: str) -> DatumCheck:
    """``datum.E006``: the throttle storage cannot be built; names the failure's class, never its words."""
    return DatumCheck(
        CheckLevel.ERROR,
        E006,
        f"throttle storage cannot be built ({error_class}): datum.web.throttle.storage names a store this process "
        "cannot open",
        "install the storage's client library (for example the redis extra of limits), or fix "
        "datum.web.throttle.storage",
    )


def process_zone_unresolved() -> DatumCheck:
    """``datum.W010``: the process time zone could not be read, so UTC is used."""
    return DatumCheck(
        CheckLevel.WARNING,
        W010,
        "the process time zone could not be read; UTC is used for datum.host.time_zone",
        "set datum.host.time_zone (DATUM_HOST__TIME_ZONE) to an IANA zone name",
    )


# ---------------------------------------------------------------------------------------------------------------------
# The memory the slots may take (W002) and the default submission handler (W003).
# ---------------------------------------------------------------------------------------------------------------------
CGROUP_ROOT: Path = Path("/sys/fs/cgroup")
"""Where the container's cgroup files are read from (a test points it at a scratch directory)."""

_UNLIMITED: Final = 2**63 - 65536
"""The kernel states "no limit" as 2^63 - 1 rounded down to its page size (up to 64 KiB pages): this and above."""


def _cgroup_number(path: Path) -> int | None:
    """Read one cgroup file as a positive number of bytes below the unlimited value, else None. Never raises."""
    try:
        text = path.read_text(encoding="ascii").strip()
    except (OSError, ValueError):
        return None
    if not (text.isascii() and text.isdecimal()):
        return None  # "max", an empty file, a sign, a hex number or two numbers: no limit stated
    number = int(text)
    return number if 0 < number < _UNLIMITED else None


def container_memory_limit(root: Path | None = None) -> int | None:
    """Return the container's memory limit in bytes: cgroup v2 `memory.max`, else v1 `memory.limit_in_bytes`, else None.

    Plain files read with `pathlib` (no command is run). `max`, a missing or unreadable file, a value that is no number
    and the page-rounded 2^63 - 1 all mean no limit. `root` defaults to `CGROUP_ROOT`.
    """
    base = CGROUP_ROOT if root is None else root
    limit = _cgroup_number(base / "memory.max")
    if limit is None:
        limit = _cgroup_number(base / "memory" / "memory.limit_in_bytes")
    return limit


def physical_memory() -> int | None:
    """Return the host's RAM in bytes where the platform says so, else None."""
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError, AttributeError):
        return None


def resident_set_bytes() -> int:
    """Return the process's resident memory in bytes (`/proc/self/statm`, else the peak the OS reports)."""
    try:
        fields = Path("/proc/self/statm").read_text(encoding="ascii").split()
        return int(fields[1]) * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError):
        try:
            import resource  # noqa: PLC0415 - POSIX only: Windows has neither /proc nor this module
        except ImportError:
            return 0
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return peak if sys.platform == "darwin" else peak * 1024


class SlotBudgets(Protocol):
    """What the memory check reads of the runtime's budgets (`datum_sandbox.protocol.ProgramLimits` is one)."""

    @property
    def validation_memory(self) -> int:
        """Return the sandbox's memory per slot, in bytes."""
        ...

    @property
    def pdf_memory(self) -> int:
        """Return the PDF program's memory per slot, in bytes."""
        ...

    def validation_slots(self) -> int:
        """Return the sandbox slots."""
        ...

    def pdf_slots(self) -> int:
        """Return the PDF slots."""
        ...


def memory_budget_check(limits: SlotBudgets, *, workers: int, limit: int | None, rss: int) -> DatumCheck | None:
    """`datum.W002`: slots times memory, for the sandbox and PDF pools and every worker, against the limit less the RSS.

    `limit` is the container's (or the host's) memory; `None` means none is known and nothing is said.
    """
    if limit is None:
        return None
    needed = (limits.validation_slots() * limits.validation_memory + limits.pdf_slots() * limits.pdf_memory) * max(
        1, workers
    )
    available = limit - rss
    if needed <= available:
        return None
    mib = 1024 * 1024
    return DatumCheck(
        CheckLevel.WARNING,
        W002,
        f"the runtime's slots may take up to {needed // mib} MiB ({max(1, workers)} worker(s) of"
        f" {limits.validation_slots()} validation and {limits.pdf_slots()} PDF slots), but only"
        f" {max(0, available) // mib} MiB of the {limit // mib} MiB memory limit is free at start",
        "lower datum.runtime.validation.concurrency, datum.runtime.pdf.concurrency or the memory budgets, raise the"
        " container memory, or state datum.workers_expected",
    )


def startup_memory_check(limits: SlotBudgets, workers: int) -> DatumCheck | None:
    """Read the limit (cgroup, else the host's RAM) and the RSS now, and answer `memory_budget_check`."""
    limit = container_memory_limit()
    return memory_budget_check(
        limits, workers=workers, limit=limit if limit is not None else physical_memory(), rss=resident_set_bytes()
    )


def default_handler_in_use() -> DatumCheck:
    """``datum.W003``: the logging submission handler keeps nothing."""
    return DatumCheck(
        CheckLevel.WARNING,
        W003,
        "submissions are served with the default logging handler, which keeps nothing",
        "pass your own to Datum(handler=...): it stores or delivers an accepted submission and answers a receipt",
    )


# ---------------------------------------------------------------------------------------------------------------------
# A capability's trust-state store in memory (E001) and the flag that acknowledges it (W009).
# ---------------------------------------------------------------------------------------------------------------------
def trust_store_refused(
    capability: str, *, store: str, table: str, consequence: str, protocol: str, flag: str
) -> DatumCheck:
    """``datum.E001``: a trust-state store the start would keep in memory, with the memory-store policy's three parts.

    The text is the store (`capability` has no SQL store for `store`, kept in `table`), the consequence (why the
    in-memory one is refused) and the three ways out (an engine and the table, the application's own `protocol`, or the
    `flag` that acknowledges a single instance). One check per store, so a start with two names both.
    """
    return DatumCheck(
        CheckLevel.ERROR,
        E001,
        f"{capability} has no SQL store for {store} ({table}), and the in-memory one is refused because {consequence}",
        f"Pass an engine and create the {table} table with your migration, provide your own"
        f" {protocol}, or set {flag}=true to acknowledge a single instance.",
    )


def trust_store_acknowledged(capability: str, *, store: str, flag: str) -> DatumCheck:
    """``datum.W009``: a trust-state store kept in memory because `flag` acknowledges it (health says so too)."""
    return DatumCheck(
        CheckLevel.WARNING,
        W009,
        f"{capability} keeps {store} in memory, as {flag}=true acknowledges: it holds within this process only",
        "run one instance, or give Datum a SQL store or your own to share it between instances and restarts",
    )


# ---------------------------------------------------------------------------------------------------------------------
# The PDF seal's key (W013) and the sources of its timestamps (W011, W012, I002).
# ---------------------------------------------------------------------------------------------------------------------
def pdf_seal_without_key() -> DatumCheck:
    """``datum.W013``: the seal is on and the server has no signing key, so only the test seal can sign."""
    return DatumCheck(
        CheckLevel.WARNING,
        W013,
        "datum.pdf.seal is enabled and the server has no signing key: posted answers carry the test seal;"
        " render_submission answers 500 until a key is configured",
        "name a key in datum.pdf.signing (a PKCS#12 store, or a PEM key and certificate), or pass"
        " Datum(pdf_signer=...)",
    )


def pdf_timestamp_without_source() -> DatumCheck:
    """``datum.W011``: the seal asks a timestamp and nothing can issue one, so seals carry ``sealing.timestamp``."""
    return DatumCheck(
        CheckLevel.WARNING,
        W011,
        "seal timestamps asked, a server key present, and no timestamp source: sealed PDFs carry the sealing.timestamp"
        " warning and no token",
        "pass Datum(timestamper=...), set datum.pdf.signing.tsa.url, or enable the in-process authority with"
        " datum.tsa.enabled; or set datum.pdf.seal.timestamp to false",
    )


def pdf_tsa_policy_unused() -> DatumCheck:
    """``datum.W012``: a timestamp policy is set and the application's timestamper takes the place of the client."""
    return DatumCheck(
        CheckLevel.WARNING,
        W012,
        "datum.pdf.signing.tsa.policy is set and unused: the Timestamper the application gave issues the seal's"
        " tokens, not the client of datum.pdf.signing.tsa",
        "unset datum.pdf.signing.tsa.policy, or do not pass Datum(timestamper=...)",
    )


def pdf_tsa_client_unused() -> DatumCheck:
    """``datum.I002``: the timestamp client's address or credentials are set and unused; neither is named here."""
    return DatumCheck(
        CheckLevel.INFO,
        I002,
        "datum.pdf.signing.tsa names an address or credentials and they are unused: the Timestamper the application"
        " gave issues the seal's tokens",
        "unset them, or do not pass Datum(timestamper=...)",
    )
