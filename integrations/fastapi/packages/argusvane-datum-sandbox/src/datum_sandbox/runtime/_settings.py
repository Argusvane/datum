"""`SandboxSettings`: one immutable value holding every clamp of the `datum.runtime.*` and `datum.host.*` keys.

`SandboxSettings.build(**values)` is the one place a value is held to its bound. A budget outside its bound is moved to
the nearest bound with one `datum.W008` check (`checks`); what cannot be clamped refuses the build with a
`DatumConfigurationError` naming the key: a digest with no module path, a diagnostics word that is none of the three, a
capture bound below 1. Every value keeps where it came from, so `explain()` answers each key's value and its source
(default, configured, clamped from a value to a bound). A host maps its own configuration onto the keyword names: the
key without `datum.runtime.` or `datum.host.`, dots as underscores (`validation_time_limit`, `formula_errors`), except
`programs.*` (`sandbox_program`, `pdf_program`) and `diagnostics.*` (`trace`, `report`, `capture_*`), which drop their
section; `None` means "not set". `defaults` lets a host give its own default for a key (the process time zone), still
reported as a default.

| Key (`datum.runtime.`) | Bound | Default |
|---|---|---|
| `validation.time_limit` | 0.001 s to 60 s | 5 s |
| `validation.memory` | 4 MiB to 1 GiB | 32 MiB |
| `validation.concurrency` | 0 to 64 slots (0: one per CPU) | 0 |
| `validation.wait` | 0 s to 10 s | 2 s |
| `pdf.time_limit` | 0.001 s to 300 s | 60 s |
| `pdf.memory` | 32 MiB to 4 GiB | 256 MiB |
| `pdf.concurrency` | 0 to 64 slots (0: `min(2, CPUs)`) | 0 |
| `pdf.wait` | 0 s to 10 s | 2 s |
| `verify_max_bytes` | 1 MiB to 100 MiB | 20 MiB |
| `max_strays` | 0 or more (0: one per CPU, at least 2) | 0 |
| `diagnostics.capture.max_runs`, `max_bytes`, `queue_bytes` | at least 1 (refused below) | 20, 64 MiB, 64 MiB |
"""

import enum
import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Final, cast

from datum_sandbox.checks import DatumCheck, DatumConfigurationError, budget_clamped, memory_below_floor, raise_errors
from datum_sandbox.diagnostics._report import ReportEntry, SettingsReport, Source
from datum_sandbox.protocol import (
    Bounds,
    FormulaErrors,
    ProgramLimits,
    RiskyPatterns,
)
from datum_sandbox.protocol._limits import BOUNDS, INTEGERS, cpus
from datum_sandbox.wasi import EngineSettings, default_stray_bound

MIB: Final = 1024 * 1024
RUNTIME: Final = "datum.runtime."
HOST: Final = "datum.host."


_SMALLEST_SECONDS: Final = 0.001
"""The least `tick` and `startup_budget` take (seconds), as the host's configuration states."""


class UnknownFields(enum.StrEnum):
    """What a host does with an answer that names no component (`datum.host.unknown_fields`)."""

    STRIP = "strip"
    KEEP = "keep"
    REJECT = "reject"


class LogLevel(enum.StrEnum):
    """How much of a run's log a host keeps and relays (`datum.host.log_level`)."""

    OFF = "off"
    ERROR = "error"
    WARN = "warn"
    INFO = "info"
    DEBUG = "debug"


class TraceMode(enum.StrEnum):
    """Which runs the trace writes a line for (`datum.runtime.diagnostics.trace`)."""

    OFF = "off"
    FAILURES = "failures"
    ALL = "all"


@dataclass(frozen=True, slots=True)
class EngineSection:
    """Which engine, and how it is built: `datum.runtime.engine`, `stop_grace`, `max_strays`, `tick`, the module."""

    id: str = "wasmtime"
    stop_grace: float = 5.0
    max_strays: int = 0
    tick: float = 0.05
    work_dir: str | None = None
    qjs_path: str | None = None
    qjs_sha256: str | None = None
    allow_unguarded_stack: bool = False

    @property
    def stray_bound(self) -> int:
        """The stray bound in force: `max_strays`, or one per CPU (at least 2) when it is 0."""
        return self.max_strays or default_stray_bound()

    def engine_settings(self) -> EngineSettings:
        """Return the engine-independent settings an engine is built with."""
        return EngineSettings(stop_grace=self.stop_grace, stray_bound=self.stray_bound)


@dataclass(frozen=True, slots=True)
class LifecycleSection:
    """How the sandbox starts and stops: `fail_fast`, `warm_up_runs`, `startup_budget`, `shutdown_grace` (seconds)."""

    fail_fast: bool = True
    warm_up_runs: int = 3
    startup_budget: float = 30.0
    shutdown_grace: float = 10.0


@dataclass(frozen=True, slots=True)
class ProgramsSection:
    """The program overrides (`datum.runtime.programs.*`): a path each, unset for the packaged program."""

    sandbox: str | None = None
    pdf: str | None = None


@dataclass(frozen=True, slots=True)
class HostSection:
    """The context words the host decides (`datum.host.*`).

    The sandbox itself reads `formula_errors`, `risky_patterns` and `time_zone` (they are set over every validation
    context). `unknown_fields` and `log_level` are checked here and kept for the host, whose submission service reads
    them; the sandbox does not.
    """

    formula_errors: FormulaErrors = FormulaErrors.FAIL
    risky_patterns: RiskyPatterns = RiskyPatterns.REFUSE
    time_zone: str = "UTC"
    unknown_fields: str = "strip"
    log_level: str = "warn"


@dataclass(frozen=True, slots=True)
class CaptureSection:
    """The failed-run capture (`datum.runtime.diagnostics.capture.*`); off by default, it holds personal data."""

    enabled: bool = False
    directory: str | None = None
    max_runs: int = 20
    max_bytes: int = 64 * MIB
    queue_bytes: int = 64 * MIB


@dataclass(frozen=True, slots=True)
class DiagnosticsSection:
    """The run trace, the settings report and the failed-run capture (`datum.runtime.diagnostics.*`)."""

    trace: TraceMode = TraceMode.OFF
    report: bool = True
    capture: CaptureSection = field(default_factory=CaptureSection)


@dataclass(frozen=True, slots=True)
class _Key:
    """One keyword of `build`: its report key, its default, and whether it names a host path."""

    key: str
    default: object
    path: bool = False


_KEYS: Final[dict[str, _Key]] = {
    "engine": _Key(RUNTIME + "engine", "wasmtime"),
    "stop_grace": _Key(RUNTIME + "stop_grace", 5.0),
    "max_strays": _Key(RUNTIME + "max_strays", 0),
    "tick": _Key(RUNTIME + "tick", 0.05),
    "work_dir": _Key(RUNTIME + "work_dir", None, path=True),
    "qjs_path": _Key(RUNTIME + "qjs_path", None, path=True),
    "qjs_sha256": _Key(RUNTIME + "qjs_sha256", None),
    "allow_unguarded_stack": _Key(RUNTIME + "allow_unguarded_stack", False),
    "fail_fast": _Key(RUNTIME + "fail_fast", True),
    "warm_up_runs": _Key(RUNTIME + "warm_up_runs", 3),
    "startup_budget": _Key(RUNTIME + "startup_budget", 30.0),
    "shutdown_grace": _Key(RUNTIME + "shutdown_grace", 10.0),
    **{name: _Key(bounds.setting, bounds.default) for name, bounds in BOUNDS.items()},
    "sandbox_program": _Key(RUNTIME + "programs.sandbox", None, path=True),
    "pdf_program": _Key(RUNTIME + "programs.pdf", None, path=True),
    "formula_errors": _Key(HOST + "formula_errors", FormulaErrors.FAIL),
    "risky_patterns": _Key(HOST + "risky_patterns", RiskyPatterns.REFUSE),
    "time_zone": _Key(HOST + "time_zone", "UTC"),
    "unknown_fields": _Key(HOST + "unknown_fields", "strip"),
    "log_level": _Key(HOST + "log_level", "warn"),
    "trace": _Key(RUNTIME + "diagnostics.trace", TraceMode.OFF),
    "report": _Key(RUNTIME + "diagnostics.report", True),
    "capture_enabled": _Key(RUNTIME + "diagnostics.capture.enabled", False),
    "capture_directory": _Key(RUNTIME + "diagnostics.capture.directory", None, path=True),
    "capture_max_runs": _Key(RUNTIME + "diagnostics.capture.max_runs", 20),
    "capture_max_bytes": _Key(RUNTIME + "diagnostics.capture.max_bytes", 64 * MIB),
    "capture_queue_bytes": _Key(RUNTIME + "diagnostics.capture.queue_bytes", 64 * MIB),
}
"""Every keyword `build` takes, in report order."""

_CAPTURE_BOUNDS: Final = ("capture_max_runs", "capture_max_bytes", "capture_queue_bytes")
_MEMORIES: Final = frozenset({"validation_memory", "pdf_memory"})


def _text(value: float, unit: str) -> str:
    number = str(int(value)) if float(value).is_integer() else f"{value:g}"
    return f"{number} {unit}"


def _bound_text(bounds: Bounds) -> str:
    return f"{_text(bounds.low, bounds.unit)} to {_text(bounds.high, bounds.unit)}"


class _Builder:
    """One `build` call: the values asked, the entries and checks written, the refusals gathered."""

    def __init__(self, values: Mapping[str, object], defaults: Mapping[str, object], memory_floor: int) -> None:
        self.values = values
        self.defaults = defaults
        self.memory_floor = memory_floor
        self.errors: list[DatumCheck] = []
        self.entries: dict[str, ReportEntry] = {}
        self.checks: list[DatumCheck] = []
        self.chosen: dict[str, object] = {}

    def plain(self, name: str) -> object:
        """Take a value that has no bound: configured when given, else the (host's) default."""
        spec = _KEYS[name]
        asked = self.values.get(name)
        if asked is None:
            value = self.defaults.get(name, spec.default)
            self.entries[name] = ReportEntry(spec.key, value, Source.DEFAULT, path=spec.path)
        else:
            value = asked
            self.entries[name] = ReportEntry(spec.key, value, Source.CONFIGURED, path=spec.path)
        self.chosen[name] = value
        return value

    def bounded(self, name: str) -> float:
        """Take a budget: the nearest bound (W008) when it is outside."""
        bounds = BOUNDS[name]
        spec = _KEYS[name]
        asked = self.values.get(name)
        if asked is None:
            used = cast("float", self.defaults.get(name, bounds.default))
            self.entries[name] = ReportEntry(spec.key, _typed(name, used), Source.DEFAULT)
        else:
            number = _finite(name, asked)
            if name in INTEGERS and number != int(number):
                raise TypeError(f"{spec.key} ({name}) must be a whole number, not {asked!r}")
            used = bounds.nearest(number)
            if name in _MEMORIES and min(number, used) < self.memory_floor:
                # Below the module's floor (or moved below it by the clamp): never clamped up to pass, an E003.
                self.errors.append(memory_below_floor(bounds.setting, int(min(number, used)), self.memory_floor))
                self.entries[name] = ReportEntry(spec.key, _typed(name, used), Source.CONFIGURED)
                self.chosen[name] = _typed(name, used)
                return used
            if used != number:
                bound = _bound_text(bounds)
                check = budget_clamped(bounds.setting, _text(number, bounds.unit), _text(used, bounds.unit), bound)
                self.checks.append(check)
                self.entries[name] = ReportEntry(spec.key, _typed(name, used), Source.CLAMPED, asked=asked, bound=bound)
            else:
                self.entries[name] = ReportEntry(spec.key, _typed(name, used), Source.CONFIGURED)
        self.chosen[name] = _typed(name, used)
        return used


def _finite(name: str, value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise TypeError(f"{_KEYS[name].key} ({name}) must be a finite number, not {value!r}")
    return float(value)


def _typed(name: str, value: float) -> float | int:
    return int(value) if name in INTEGERS else float(value)


@dataclass(frozen=True, slots=True)
class SandboxSettings:
    """Every setting of the sandbox, clamped; build it with `SandboxSettings.build` (`defaults()` for none set).

    The sections are plain records; `limits` holds the nine budgets as the protocol reads them. `checks` are the clamp's
    `datum.W008` warnings (a host logs them with its own start-up checks). Equality compares the values only.
    """

    engine: EngineSection = field(default_factory=EngineSection)
    lifecycle: LifecycleSection = field(default_factory=LifecycleSection)
    limits: ProgramLimits = field(default_factory=ProgramLimits)
    programs: ProgramsSection = field(default_factory=ProgramsSection)
    host: HostSection = field(default_factory=HostSection)
    diagnostics: DiagnosticsSection = field(default_factory=DiagnosticsSection)
    checks: tuple[DatumCheck, ...] = field(default=(), compare=False)
    _entries: tuple[ReportEntry, ...] = field(default=(), compare=False, repr=False)

    @classmethod
    def defaults(cls) -> "SandboxSettings":
        """Return the settings with nothing set."""
        return cls.build()

    @classmethod
    def build(
        cls,
        *,
        defaults: Mapping[str, object] | None = None,
        memory_floor: int = 0,
        engine: str | None = None,
        stop_grace: float | None = None,
        max_strays: int | None = None,
        tick: float | None = None,
        work_dir: str | None = None,
        qjs_path: str | None = None,
        qjs_sha256: str | None = None,
        allow_unguarded_stack: bool | None = None,
        fail_fast: bool | None = None,
        warm_up_runs: int | None = None,
        startup_budget: float | None = None,
        shutdown_grace: float | None = None,
        validation_time_limit: float | None = None,
        validation_memory: int | None = None,
        validation_concurrency: int | None = None,
        validation_wait: float | None = None,
        pdf_time_limit: float | None = None,
        pdf_memory: int | None = None,
        pdf_concurrency: int | None = None,
        pdf_wait: float | None = None,
        verify_max_bytes: int | None = None,
        sandbox_program: str | None = None,
        pdf_program: str | None = None,
        formula_errors: str | None = None,
        risky_patterns: str | None = None,
        time_zone: str | None = None,
        unknown_fields: str | None = None,
        log_level: str | None = None,
        trace: str | None = None,
        report: bool | None = None,
        capture_enabled: bool | None = None,
        capture_directory: str | None = None,
        capture_max_runs: int | None = None,
        capture_max_bytes: int | None = None,
        capture_queue_bytes: int | None = None,
    ) -> "SandboxSettings":
        """Clamp and check every value; raise `DatumConfigurationError` for what cannot be clamped (see the module).

        `memory_floor` is the engine module's initial pages times 64 KiB when it is known before the start: a memory
        below it (or one the clamp would move below it) is never clamped up to pass; every such value is raised together
        as `datum.E003`. The engine refuses the same at start whatever is given here.
        """
        values = {name: value for name, value in locals().items() if name in _KEYS}
        given_defaults = dict(defaults or {})
        unknown = set(given_defaults) - set(_KEYS)
        if unknown:
            raise TypeError(f"SandboxSettings has no key named {', '.join(sorted(unknown))}")
        b = _Builder(values, given_defaults, memory_floor)

        engine_id = str(b.plain("engine")).strip().lower()
        b.chosen["engine"] = engine_id
        grace = _non_negative(b, "stop_grace")
        strays = b.plain("max_strays")
        if isinstance(strays, bool) or not isinstance(strays, int) or strays < 0:
            raise DatumConfigurationError(
                f"{RUNTIME}max_strays is {strays!r}: a count of 0 or more", hint=f"set {RUNTIME}max_strays to 0 or more"
            )
        if strays == 0:
            b.entries["max_strays"] = _with_resolved(b.entries["max_strays"], f"one per CPU = {default_stray_bound()}")
        tick_value = _at_least(b, "tick", _SMALLEST_SECONDS)
        work = b.plain("work_dir")
        module_path = b.plain("qjs_path")
        module_digest = b.plain("qjs_sha256")
        if module_digest is not None and module_path is None:
            raise DatumConfigurationError(
                "datum.runtime.qjs_sha256 is the digest of an own qjs-wasi.wasm, but datum.runtime.qjs_path is not set",
                hint="set datum.runtime.qjs_path to the copy, or unset the digest to use the packaged, pinned module",
            )
        engine_section = EngineSection(
            id=engine_id,
            stop_grace=grace,
            max_strays=strays,
            tick=tick_value,
            work_dir=cast("str | None", work),
            qjs_path=cast("str | None", module_path),
            qjs_sha256=None if module_digest is None else str(module_digest).lower(),
            allow_unguarded_stack=bool(b.plain("allow_unguarded_stack")),
        )

        lifecycle = LifecycleSection(
            fail_fast=bool(b.plain("fail_fast")),
            warm_up_runs=_count(b, "warm_up_runs"),
            startup_budget=_at_least(b, "startup_budget", _SMALLEST_SECONDS),
            shutdown_grace=_non_negative(b, "shutdown_grace"),
        )

        budgets = {name: b.bounded(name) for name in BOUNDS}
        raise_errors(b.errors)
        limits = ProgramLimits(**{name: _typed(name, value) for name, value in budgets.items()})  # type: ignore[arg-type]
        validation_slots = limits.validation_slots()
        pdf_slots = limits.pdf_slots()
        if limits.validation_concurrency == 0:
            b.entries["validation_concurrency"] = _with_resolved(
                b.entries["validation_concurrency"], f"one per CPU = {validation_slots}"
            )
        if limits.pdf_concurrency == 0:
            b.entries["pdf_concurrency"] = _with_resolved(b.entries["pdf_concurrency"], f"min(2, CPUs) = {pdf_slots}")

        programs = ProgramsSection(
            sandbox=cast("str | None", b.plain("sandbox_program")),
            pdf=cast("str | None", b.plain("pdf_program")),
        )

        host = HostSection(
            formula_errors=FormulaErrors(_word(b, "formula_errors", FormulaErrors)),
            risky_patterns=RiskyPatterns(_word(b, "risky_patterns", RiskyPatterns)),
            time_zone=str(b.plain("time_zone")),
            unknown_fields=_word(b, "unknown_fields", UnknownFields).value,
            log_level=_word(b, "log_level", LogLevel).value,
        )

        trace_word = TraceMode(_word(b, "trace", TraceMode))
        report_on = bool(b.plain("report"))
        capture_on = bool(b.plain("capture_enabled"))
        directory = b.plain("capture_directory")
        bounds_given = {name: b.plain(name) for name in _CAPTURE_BOUNDS}
        for name, value in bounds_given.items():
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise DatumConfigurationError(
                    f"{_KEYS[name].key} is {value!r}: the capture's bounds are at least 1",
                    hint=f"set {_KEYS[name].key} to 1 or more, or leave it unset",
                )
        capture = CaptureSection(
            enabled=capture_on,
            directory=cast("str | None", directory),
            max_runs=cast("int", bounds_given["capture_max_runs"]),
            max_bytes=cast("int", bounds_given["capture_max_bytes"]),
            queue_bytes=cast("int", bounds_given["capture_queue_bytes"]),
        )
        diagnostics = DiagnosticsSection(trace=trace_word, report=report_on, capture=capture)

        entries = tuple(b.entries[name] for name in _KEYS)
        return cls(
            engine=engine_section,
            lifecycle=lifecycle,
            limits=limits,
            programs=programs,
            host=host,
            diagnostics=diagnostics,
            checks=tuple(b.checks),
            _entries=entries,
        )

    @property
    def validation_slots(self) -> int:
        """The validation slots in force: the setting, or one per CPU."""
        return self.limits.validation_slots()

    @property
    def pdf_slots(self) -> int:
        """The PDF slots in force: the setting, or `min(2, CPUs)`."""
        return self.limits.pdf_slots()

    def explain(self) -> SettingsReport:
        """Return every key with its effective value and its source (default, configured, clamped from X to a bound)."""
        return SettingsReport(self._entries)


def _with_resolved(entry: ReportEntry, resolved: str) -> ReportEntry:
    return ReportEntry(entry.key, entry.value, entry.source, entry.asked, entry.bound, resolved, entry.path)


def _non_negative(b: _Builder, name: str) -> float:
    value = b.plain(name)
    number = _finite(name, value)
    if number < 0:
        raise DatumConfigurationError(
            f"{_KEYS[name].key} is {value!r}: it must not be negative", hint=f"set {_KEYS[name].key} to 0 or more"
        )
    return number


def _at_least(b: _Builder, name: str, floor: float) -> float:
    value = b.plain(name)
    number = _finite(name, value)
    if number < floor:
        raise DatumConfigurationError(
            f"{_KEYS[name].key} is {value!r}: it must be at least {floor:g} s",
            hint=f"set {_KEYS[name].key} to {floor:g} s or more",
        )
    return number


def _count(b: _Builder, name: str) -> int:
    value = b.plain(name)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise DatumConfigurationError(
            f"{_KEYS[name].key} is {value!r}: a count of 0 or more", hint=f"set {_KEYS[name].key} to 0 or more"
        )
    return value


def _word[E: enum.StrEnum](b: _Builder, name: str, words: type[E]) -> E:
    value = b.plain(name)
    text = str(value.value if isinstance(value, enum.Enum) else value).strip().casefold()
    for member in words:
        if member.value == text:
            b.chosen[name] = member
            entry = b.entries[name]
            b.entries[name] = ReportEntry(entry.key, member, entry.source, path=entry.path)
            return member
    allowed = ", ".join(member.value for member in words)
    raise DatumConfigurationError(
        f"{_KEYS[name].key} is {value!r}, which is none of {allowed}", hint=f"set {_KEYS[name].key} to one of {allowed}"
    )


__all__ = [
    "CaptureSection",
    "DiagnosticsSection",
    "EngineSection",
    "HostSection",
    "LifecycleSection",
    "ProgramsSection",
    "SandboxSettings",
    "TraceMode",
    "cpus",
]
