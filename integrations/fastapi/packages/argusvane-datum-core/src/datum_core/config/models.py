"""The DatumConfig tree: frozen, extra forbidden, validated defaults, every field described.

Validation only: environment, TOML and application sources belong to the binding's settings class, which has the
same fields. Durations are ``Seconds``, sizes ``Size``, words ``DatumWord`` enums, secrets ``SecretStr``.
"""

import re
import warnings
from collections.abc import Mapping
from datetime import timedelta
from typing import Annotated, Any, Final, Self
from urllib.parse import urlsplit, urlunsplit

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, PlainSerializer, SecretStr, field_validator

from datum_core.checks import CHECK_LEVELS
from datum_core.config._types import Count, DatumWord, LimitOrOff, Seconds, Size, closest
from datum_core.config._zone import is_zone_name, process_zone_name
from datum_sandbox.checks import CheckLevel

_OID = re.compile(r"^[0-2](\.(0|[1-9][0-9]*))+$")
_SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")
_HEADER = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")
_MIN_SECRET_BYTES = 32

KIB = 1024
MIB = 1024 * KIB


def _bounds(low: object, high: object, unit: str) -> str:
    if low is not None and high is not None:
        return f" {low} to {high} {unit}."
    if low is not None:
        return f" At least {low} {unit}."
    if high is not None:
        return f" At most {high} {unit}."
    return ""


def seconds(
    default: float | str, description: str, *, ge: float = 0.0, le: float | None = None, positive: bool = False
) -> Any:  # noqa: ANN401
    """Build a ``Seconds`` field with its bounds stated in the description; ``positive`` refuses 0 (ge is ignored)."""
    if positive:
        return Field(default=default, description=description + " More than 0 s.", gt=timedelta(0))
    text = description + _bounds(ge or None, le, "s")
    return Field(
        default=default,
        description=text,
        ge=timedelta(seconds=ge),
        le=None if le is None else timedelta(seconds=le),
    )


def size(default: int | str, description: str, *, ge: int = 1, le: int | None = None) -> Any:  # noqa: ANN401
    """Build a ``Size`` field with its bounds stated in the description."""
    return Field(default=default, description=description + _bounds(ge, le, "bytes"), ge=ge, le=le)


def count(default: int, description: str, *, ge: int | None = None, le: int | None = None) -> Any:  # noqa: ANN401
    """Build an integer field with its bounds stated in the description."""
    return Field(default=default, description=description + _bounds(ge, le, ""), ge=ge, le=le)


def flag(default: bool, description: str) -> Any:  # noqa: ANN401
    """Build a boolean field."""
    return Field(default=default, description=description)


def text(default: str | None, description: str) -> Any:  # noqa: ANN401
    """Build a string field, unset when the default is None."""
    return Field(default=default, description=description, min_length=1)


def words(description: str) -> Any:  # noqa: ANN401
    """Build a tuple-of-strings field defaulting to empty."""
    return Field(default=(), description=description)


def _oid(value: str | None) -> str | None:
    if value is not None and not _OID.fullmatch(value):
        message = "must be an object identifier such as 1.2.3.4"
        raise ValueError(message)
    return value


def _secret(value: SecretStr | None) -> SecretStr | None:
    # Reports the length only: the pydantic message would echo the input, which is hidden on every model.
    if value is not None and len(value.get_secret_value().encode()) < _MIN_SECRET_BYTES:
        message = f"must be at least {_MIN_SECRET_BYTES} bytes (got {len(value.get_secret_value().encode())})"
        raise ValueError(message)
    return value


def _digest(value: str) -> str:
    if not _SHA256.fullmatch(value):
        message = "must be 64 hexadecimal characters (a SHA-256)"
        raise ValueError(message)
    return value.lower()


def _zone(value: str) -> str:
    if not is_zone_name(value):
        message = "must be an IANA time zone name such as America/Toronto or UTC"
        raise ValueError(message)
    return value


def _header(value: str) -> str:
    if not _HEADER.fullmatch(value):
        message = "must be an HTTP header name"
        raise ValueError(message)
    return value


def _without_userinfo(value: str) -> str:
    # The user-info of a URI carries the credentials (redis://:password@host, https://token@host): it goes whole.
    try:
        parts = urlsplit(value)
    except ValueError:  # an unparseable URI (a broken IPv6 literal) is hidden whole when it may hold user-info
        return "**********" if "@" in value else value
    if "@" not in parts.netloc:
        return value
    return urlunsplit(parts._replace(netloc="**********@" + parts.netloc.rpartition("@")[2]))


Oid = Annotated[str, AfterValidator(_oid)]
CredentialUri = Annotated[str, PlainSerializer(_without_userinfo, when_used="json")]
"""A URI that may carry credentials: hidden from repr (``repr=False`` on the field) and the JSON dump drops its
user-info; the Python value (and ``model_dump()``) keeps it, as a ``SecretStr`` keeps its secret."""
TimeZone = Annotated[str, AfterValidator(_zone)]
HeaderName = Annotated[str, AfterValidator(_header)]
Sha256 = Annotated[str, AfterValidator(_digest)]
MinBytesSecret = Annotated[SecretStr, AfterValidator(_secret)]


class _Section(BaseModel):
    """Common rules of every section."""

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        validate_default=True,
        # The default error text echoes the offending input; a secret field would then appear in a message.
        hide_input_in_errors=True,
    )

    def model_copy(self, *, update: Mapping[str, Any] | None = None, deep: bool = False) -> Self:  # noqa: ARG002
        """Refused: ``model_copy(update=)`` skips validation. Build a new model instead."""
        message = "DatumConfig sections have no copy method; build a new model so every value is validated"
        raise TypeError(message)

    def copy(self, **_: Any) -> Self:  # noqa: ANN401
        """Refused, as ``model_copy``."""
        return self.model_copy()


# ---------------------------------------------------------------------------------------------------------------------
# Words
# ---------------------------------------------------------------------------------------------------------------------
class FormulaErrors(DatumWord):
    """What a formula that cannot be evaluated does."""

    FAIL = "fail"
    WARN = "warn"


class RiskyPatterns(DatumWord):
    """What a regular expression that repeats a repeat does."""

    REFUSE = "refuse"
    ALLOW = "allow"


class UnknownFields(DatumWord):
    """What an answer with no component in the form does."""

    STRIP = "strip"
    KEEP = "keep"
    REJECT = "reject"


class LogLevel(DatumWord):
    """How much of a run's log is kept and relayed."""

    OFF = "off"
    ERROR = "error"
    WARN = "warn"
    INFO = "info"
    DEBUG = "debug"


class PdfFonts(DatumWord):
    """Which font faces a PDF embeds."""

    DEFAULT = "default"
    STANDARD = "standard"
    ALL = "all"


class Certify(DatumWord):
    """The kind of signature the seal makes: a DocMDP permission, or ``none`` for an approval signature.

    Other spellings are read too (case, hyphens and underscores ignored): ``formFilling``, ``annotations`` (the
    program's words), ``false`` or ``approval`` for ``none``, and 1, 2, 3 or 0.
    """

    NO_CHANGES = "noChanges"
    FORM_FILL = "formFill"
    ANNOTATE = "annotate"
    NONE = "none"

    @classmethod
    def _missing_(cls, value: object) -> Self | None:
        if isinstance(value, str):
            plain = value.strip().casefold().replace("-", "").replace("_", "")
            member = _CERTIFY_ALIASES.get(plain)
            if member is not None:
                return cls(member)
        return super()._missing_(value)

    @property
    def program_word(self) -> str | bool:
        """The word the PDF program reads in a signature request: ``False`` for an approval signature."""
        return _CERTIFY_PROGRAM_WORDS.get(self, False)


_CERTIFY_ALIASES: Final = {
    "nochanges": "noChanges", "1": "noChanges",
    "formfill": "formFill", "formfilling": "formFill", "2": "formFill",
    "annotate": "annotate", "annotations": "annotate", "3": "annotate",
    "none": "none", "false": "none", "approval": "none", "0": "none",
}  # fmt: skip
_CERTIFY_PROGRAM_WORDS: Final = {
    Certify.NO_CHANGES: "noChanges",
    Certify.FORM_FILL: "formFilling",
    Certify.ANNOTATE: "annotations",
}


class KeyType(DatumWord):
    """The key file format of a signer."""

    PKCS12 = "PKCS12"
    PEM = "PEM"


class TsaAccess(DatumWord):
    """Who may call the timestamp server."""

    CLIENTS = "clients"
    OPEN = "open"


class TsaClientStore(DatumWord):
    """Where timestamp clients are kept."""

    SETTINGS = "settings"
    SQL = "sql"


class ThrottleBy(DatumWord):
    """What a throttle key is made of."""

    IP = "ip"
    FORM = "form"
    PRINCIPAL = "principal"


class ThrottleKind(DatumWord):
    """The kinds of request a throttle limits."""

    SUBMIT = "submit"
    VALIDATE = "validate"
    TEST = "test"
    PDF = "pdf"
    REGISTER = "register"


# ---------------------------------------------------------------------------------------------------------------------
# datum.runtime
# ---------------------------------------------------------------------------------------------------------------------
class Programs(_Section):
    """Paths of the sandbox and PDF programs."""

    sandbox: str | None = text(None, "Path of the sandbox program; unset uses the packaged program (still probed).")
    pdf: str | None = text(None, "Path of the PDF program; unset uses the packaged program (still probed).")


# The datum.runtime.* budgets keep type sanity only (positive, finite, whole where whole): their bounds live in one
# place, SandboxSettings.build, which moves a value outside them to the nearest bound with datum.W008.
class ValidationBudget(_Section):
    """Budgets of a validation run; SandboxSettings.build holds each to its bounds with datum.W008."""

    time_limit: Seconds = seconds(5, "Time limit of a run; clamped to 0.001 s to 60 s with datum.W008.", positive=True)
    memory: Size = size(
        "32MiB",
        "Memory of a run; below the module's initial pages is an error; clamped to 4 MiB to 1 GiB with datum.W008.",
    )
    concurrency: Count = count(
        0, "Concurrent runs; 0 means one per CPU; clamped to at most 64 slots with datum.W008.", ge=0
    )
    wait: Seconds = seconds(2, "How long a run waits for a slot before 503; clamped to at most 10 s with datum.W008.")


class PdfBudget(_Section):
    """Budgets of a PDF run; SandboxSettings.build holds each to its bounds with datum.W008."""

    time_limit: Seconds = seconds(
        60, "Time limit of a run; clamped to 0.001 s to 300 s with datum.W008.", positive=True
    )
    memory: Size = size(
        "256MiB",
        "Memory of a run; below the module's initial pages is an error; clamped to 32 MiB to 4 GiB with datum.W008.",
    )
    concurrency: Count = count(
        0, "Concurrent runs; 0 means min(2, CPUs); clamped to at most 64 slots with datum.W008.", ge=0
    )
    wait: Seconds = seconds(2, "How long a run waits for a slot before 503; clamped to at most 10 s with datum.W008.")


class TraceWords(DatumWord):
    """Which runs the run trace writes a line for."""

    OFF = "off"
    FAILURES = "failures"
    ALL = "all"


class Capture(_Section):
    """The failed-run capture: the bytes of a failed run kept on disk to replay it (personal data: off by default)."""

    enabled: bool = flag(
        False,
        "Keep the stdin, stdout, stderr, run.js and meta.json of every failed run; they hold the submitted answers and"
        " the form definition in clear text.",
    )
    directory: str | None = text(
        None,
        "An owner-only directory (mode 0700, owned by this process's user, no ACL) for the captures; created 0700 when"
        " missing; required when enabled.",
    )
    max_runs: Count = count(20, "Captures kept; the oldest go first. At least 1.", ge=1)
    max_bytes: Size = size("64MiB", "Bytes of captures kept; a capture larger than this is dropped.", ge=1)
    queue_bytes: Size = size("64MiB", "Bytes of captures waiting to be written; past it a capture is dropped.", ge=1)


class Diagnostics(_Section):
    """The run trace, the effective-settings report and the failed-run capture."""

    trace: TraceWords = Field(
        default=TraceWords.OFF,
        description="One line per run on datum.sandbox.trace: off, failures (failed runs only) or all.",
    )
    report: bool = flag(True, "Log the effective settings, where each came from, at start on datum.sandbox.settings.")
    capture: Capture = Field(default_factory=Capture, description="The failed-run capture.")


class Runtime(_Section):
    """The program runtime."""

    engine: str = text("wasmtime", "Id of the engine provider; an unknown or unavailable id stops the start.")
    fail_fast: bool = flag(True, "Stop the start when the runtime cannot be brought up.")
    warm_up_runs: Count = count(3, "Runs made at start to warm the engine.", ge=0)
    shutdown_grace: Seconds = seconds(10, "Wait for runs in flight at shutdown; below the process manager's timeout.")
    startup_budget: Seconds = seconds(30, "Time allowed for the runtime to start.", ge=0.001)
    tick: Seconds = seconds(0.05, "Resolution of the shared run clock.", ge=0.001)
    work_dir: str | None = text(None, "Container-local working directory; unset uses the temp dir.")
    stop_grace: Seconds = seconds(5, "The engine's own wait when stopping a run.")
    max_strays: Count = count(0, "Stray runs tolerated; 0 means one per CPU, at least 2.", ge=0)
    worker_threads: Count = count(
        0,
        "Worker threads the binding's limiter allows for runs plus in-flight hooks; 0 means 2 * slots + 2, where slots"
        " are the validation plus the PDF slots. Size it as slots + ceil(slots * hook_time_on_thread / run_time) + 2;"
        " blocking work on the worker thread (sync stores, the TSA client) counts as hook time. A call that gets no"
        " thread within datum.runtime.validation.wait answers 503 server.busy.",
        ge=0,
    )
    qjs_path: str | None = text(None, "An own copy of qjs-wasi.wasm; unset uses the packaged, pinned module.")
    qjs_sha256: Sha256 | None = Field(default=None, description="SHA-256 of the own qjs-wasi.wasm copy.")
    validation: ValidationBudget = Field(default_factory=ValidationBudget, description="Validation run budgets.")
    pdf: PdfBudget = Field(default_factory=PdfBudget, description="PDF run budgets.")
    verify_max_bytes: Size = size(
        "20MiB",
        "The largest PDF the verify route reads (413 over it); clamped to 1 MiB to 100 MiB with datum.W008.",
        ge=1,
    )
    programs: Programs = Field(default_factory=Programs, description="Program locations.")
    diagnostics: Diagnostics = Field(default_factory=Diagnostics, description="The run trace, report and capture.")


# ---------------------------------------------------------------------------------------------------------------------
# datum.host, submissions, forms
# ---------------------------------------------------------------------------------------------------------------------
class Host(_Section):
    """Options the program reads."""

    formula_errors: FormulaErrors = Field(
        default=FormulaErrors.FAIL, description="A formula that cannot be evaluated: fail or warn."
    )
    risky_patterns: RiskyPatterns = Field(
        default=RiskyPatterns.REFUSE, description="A pattern that repeats a repeat: refuse or allow."
    )
    time_zone: TimeZone = Field(
        default_factory=process_zone_name,
        description=(
            "IANA zone for today() and clock rules; the default is the process zone, resolved once"
            " (UTC with datum.W010 when it cannot be read)."
        ),
    )
    unknown_fields: UnknownFields = Field(
        default=UnknownFields.STRIP, description="An answer with no component: strip, keep or reject."
    )
    log_level: LogLevel = Field(default=LogLevel.WARN, description="How much of a run's log is kept and relayed.")


class Idempotency(_Section):
    """The in-memory receipt store."""

    memory_size: Count = count(10000, "Receipts kept in memory.", ge=16, le=10_000_000)


class Submissions(_Section):
    """Submission handling."""

    idempotency: Idempotency = Field(default_factory=Idempotency, description="Idempotency receipts.")


class Snapshots(_Section):
    """Snapshot store sizes."""

    max_entries: Count = count(500, "Snapshots kept.", ge=1)
    public_copy_cache_size: Count = count(256, "Public copies cached by hash.", ge=1)


class Translations(_Section):
    """Translation store sizes."""

    max_entries: Count = count(1000, "Forms the in-memory translation store holds catalogs for.", ge=1)


class DataSources(_Section):
    """Data-source calls while building a snapshot."""

    timeout: Seconds = seconds(15, "One deadline for the whole snapshot.", ge=0.001)
    max_threads: Count = count(16, "Threads for sync data-source providers.", ge=1)


class FormCache(_Section):
    """Cache-Control of form answers."""

    definition: str = text("no-store", "Cache-Control of a definition answer.")


class Forms(_Section):
    """Form definitions."""

    locations: tuple[str, ...] = Field(
        default=("datum/forms/*.json",),
        description="Paths and glob patterns, or package:<pkg>/<glob>.",
    )
    snapshots: Snapshots = Field(default_factory=Snapshots, description="Snapshot store sizes.")
    translations: Translations = Field(default_factory=Translations, description="Translation store sizes.")
    data_sources: DataSources = Field(default_factory=DataSources, description="Data-source limits.")
    cache: FormCache = Field(default_factory=FormCache, description="Cache-Control values.")


# ---------------------------------------------------------------------------------------------------------------------
# datum.web
# ---------------------------------------------------------------------------------------------------------------------
# `validate` is a documented endpoint switch and shadows pydantic's deprecated BaseModel.validate; pydantic warns
# once at class creation, and the shadowed classmethod is unused (model_validate is the API).
with warnings.catch_warnings():
    warnings.simplefilter("ignore", UserWarning)

    class Endpoints(_Section):
        """One switch per endpoint; every endpoint is off until its switch is set."""

        submissions: bool = flag(False, "POST /api/submissions.")
        validate: bool = flag(False, "POST /api/submissions/validate.")  # type: ignore[assignment]
        test: bool = flag(False, "POST /api/submissions/test.")
        inspect: bool = flag(False, "Definition inspection.")
        definition: bool = flag(False, "GET /api/forms/{key}/definition.")
        data_sources: bool = flag(False, "GET /api/data-sources/{id}.")
        pdf: bool = flag(False, "POST /api/pdf.")
        fill: bool = flag(False, "POST /api/pdf/fill.")
        sign: bool = flag(False, "POST /api/pdf/sign.")
        verify: bool = flag(False, "POST /api/pdf/verify.")
        certificate: bool = flag(False, "The signing certificate route.")


class Api(_Section):
    """The JSON API."""

    max_body_size: Size = size("1MiB", "Largest request body; also the services' max_document_bytes.")
    problem_details: bool = flag(False, "Answer errors as RFC 9457 problem details.")
    busy_retry_after: Count = count(5, "Retry-After of a busy answer, in whole seconds.", ge=1, le=3600)
    correlation_header: HeaderName = Field(default="X-Request-ID", description="Request correlation header name.")
    endpoints: Endpoints = Field(default_factory=Endpoints, description="Endpoint switches.")


class Throttle(_Section):
    """Request throttling."""

    enabled: bool = flag(True, "Throttle requests.")
    limit: Count = count(60, "Requests per window.", ge=1)
    address_limit: LimitOrOff = Field(
        default=600,
        ge=1,
        description=(
            "Requests per window from one client address (an IPv6 client by its /64), counted on every throttled "
            "route before the body is read; at least 1; None or off turns it off."
        ),
    )
    window: Seconds = seconds(60, "Length of the window.", ge=1)
    by: tuple[ThrottleBy, ...] = Field(
        default=(ThrottleBy.IP, ThrottleBy.FORM),
        min_length=1,
        description="What a throttle key is made of: ip, form, principal; at least one.",
    )
    max_keys: Count = count(10000, "Cap on distinct keys held.", ge=1)
    limits: dict[ThrottleKind, int] = Field(
        default={}, description="Requests per window for a kind: submit, validate, test, pdf, register."
    )
    storage: CredentialUri = Field(
        default="async+memory://",
        description="A limits storage URI; async+redis://... in production.",
        min_length=1,
        repr=False,
    )
    key_salt: MinBytesSecret | None = Field(
        default=None,
        description=(
            "Secret that salts the throttle's storage keys; at least 32 bytes. Required when the storage is not "
            "memory (every worker on one storage must share it); memory storage uses a random salt per process."
        ),
    )

    @field_validator("limits")
    @classmethod
    def _limits(cls, value: dict[ThrottleKind, int]) -> dict[ThrottleKind, int]:
        if any(limit < 1 for limit in value.values()):
            message = "every limit must be at least 1"
            raise ValueError(message)
        return value


class Assets(_Section):
    """The packaged browser assets."""

    enabled: bool = flag(False, "Serve the packaged assets.")
    cache_period: Seconds = seconds(31_536_000, "Cache lifetime of an asset.")
    omit_features: tuple[str, ...] = words("Feature bundles left out of the assets.")


class Csrf(_Section):
    """Names written into host.json."""

    header_name: str = text("X-XSRF-TOKEN", "Header that carries the token.")
    cookie_name: str = text("XSRF-TOKEN", "Cookie that carries the token.")
    meta_name: str = text("_csrf", "Meta tag that carries the token.")


class OpenApi(_Section):
    """OpenAPI output."""

    enabled: bool = flag(True, "Describe Datum routes in the OpenAPI document.")
    tag_prefix: str = Field(default="datum-", description="Prefix of Datum's OpenAPI tags.")
    group_documents: bool = flag(False, "Group the document routes under one tag.")


class Management(_Section):
    """Management routes."""

    recheck: bool = flag(False, "The recheck route.")


class Web(_Section):
    """The web surface."""

    api: Api = Field(default_factory=Api, description="The JSON API.")
    throttle: Throttle = Field(default_factory=Throttle, description="Request throttling.")
    assets: Assets = Field(default_factory=Assets, description="Packaged assets.")
    csrf: Csrf = Field(default_factory=Csrf, description="CSRF names.")
    openapi: OpenApi = Field(default_factory=OpenApi, description="OpenAPI output.")
    management: Management = Field(default_factory=Management, description="Management routes.")


class Builder(_Section):
    """The form builder."""

    enabled: bool = flag(False, "Serve the builder routes.")
    max_definition_size: Size = size("1MiB", "Largest definition a save accepts.", le=64 * MIB)


# ---------------------------------------------------------------------------------------------------------------------
# datum.pdf, tsa
# ---------------------------------------------------------------------------------------------------------------------
class Seal(_Section):
    """The seal preset applied to every PDF the application issues."""

    enabled: bool = flag(False, "Seal issued PDFs.")
    layouts: tuple[str, ...] = words("Layouts sealed; empty means all.")
    certify: Certify = Field(
        default=Certify.NO_CHANGES,
        description="Kind of signature: noChanges, formFill, annotate or none (an approval signature).",
    )
    timestamp: bool = flag(
        True,
        "Ask a timestamp token for each seal made with the server's key when a timestamp source is set up"
        " (datum.W011 otherwise); the test seal of posted answers is never timestamped.",
    )
    reason: str | None = text(None, "Signature reason.")
    location: str | None = text(None, "Signature location.")
    visible: bool | None = Field(default=None, description="Draw a visible signature; unset leaves it to the layout.")
    posted_answers: bool = flag(False, "Seal PDFs of posted, unstored answers with the real certificate.")


class TsaClientOptions(_Section):
    """Timestamp client of a PDF signature."""

    url: CredentialUri | None = Field(default=None, description="Timestamp authority URL.", min_length=1, repr=False)
    policy: Oid | None = Field(default=None, description="Policy OID requested.")
    bearer_token: SecretStr | None = Field(default=None, description="Bearer token for the authority.")
    basic_user: str | None = text(None, "Basic-auth user for the authority.")
    basic_password: SecretStr | None = Field(default=None, description="Basic-auth password for the authority.")
    timeout: Seconds = seconds(10, "Bound on one request.", ge=0.001)


class Signing(_Section):
    """Signing key of PDF signatures."""

    type: KeyType = Field(default=KeyType.PKCS12, description="Key format: PKCS12 or PEM.")
    pkcs12_file: str | None = text(None, "PKCS12 key store path.")
    pkcs12_password: SecretStr | None = Field(default=None, description="PKCS12 store password.")
    friendly_name: str | None = text(None, "Friendly name of the key in the store.")
    key_password: SecretStr | None = Field(default=None, description="Password of the key.")
    key_file: str | None = text(None, "PEM private key path.")
    cert_file: str | None = text(None, "PEM certificate chain path.")
    retired_certificates: tuple[str, ...] = words("PEM locations of replaced certificates.")
    trust_anchors: tuple[str, ...] = words("PEM locations of trust anchors.")
    tsa: TsaClientOptions = Field(default_factory=TsaClientOptions, description="Timestamp client.")


class Pdf(_Section):
    """PDF output."""

    enabled: bool = flag(True, "PDF capability.")
    fonts: PdfFonts = Field(default=PdfFonts.DEFAULT, description="Font set: default, standard or all.")
    seal: Seal = Field(default_factory=Seal, description="Seal preset.")
    signing: Signing = Field(default_factory=Signing, description="Signing key.")


class RegisteredBinding(_Section):
    """A binding this host registers on its pages, added to the catalog."""

    label: str | None = text(None, "Shown where bindings are listed; the id when unset.")
    pdf_theme: str | None = text(
        None, "The PDF theme a PDF of a route drawn by this binding prints under; unset suggests none."
    )


class Bindings(_Section):
    """Which design-system binding each form route is drawn by, and the PDF theme its PDF prints under."""

    default: str = text("datum", "The binding of a route with no override; an id of the catalog.")
    routes: dict[str, str] = Field(
        default_factory=dict, description="Per-route overrides: a form key and the binding it is drawn by."
    )
    catalog: dict[str, RegisteredBinding] = Field(
        default_factory=dict,
        description="Bindings this host registers on its pages, by id, added to the bundles' own (datum).",
    )
    pdf_themes: dict[str, str] = Field(
        default_factory=dict,
        description="PDF theme id to the path of its JSON object, for every suggested PDF theme but datum-pdf.",
    )


class Flood(_Section):
    """Flood control of the timestamp server."""

    limit: Count = count(1000, "Requests per window; 0 turns it off.", ge=0)
    window: Seconds = seconds(3600, "Length of the window.", ge=1)
    failed_keys: Count = count(10, "Failed authentications tolerated per window; 0 turns the lockout off.", ge=0)


class TsaSigner(_Section):
    """Signing key of the timestamp server."""

    type: KeyType = Field(default=KeyType.PKCS12, description="Key format: PKCS12 or PEM.")
    pkcs12_file: str | None = text(None, "PKCS12 key store path.")
    pkcs12_password: SecretStr | None = Field(default=None, description="PKCS12 store password.")
    friendly_name: str | None = text(
        None,
        "Friendly name of the key's certificate in the store: "
        "checked against the certificate, never used to choose it.",
    )
    key_password: SecretStr | None = Field(default=None, description="Password of the key.")
    key_file: str | None = text(None, "PEM private key path.")
    cert_file: str | None = text(None, "PEM certificate chain path.")
    self_signed: bool = flag(False, "Use a throwaway self-signed key; for development only.")


class Tsa(_Section):
    """The timestamp server."""

    enabled: bool = flag(False, "Serve the timestamp route.")
    access: TsaAccess = Field(default=TsaAccess.CLIENTS, description="Who may call: clients or open.")
    policy: Oid | None = Field(default=None, description="Issuing policy OID.")
    accepted_policies: tuple[Oid, ...] = Field(default=(), description="Policy OIDs a request may ask for.")
    accuracy: Seconds = seconds(1, "Stated accuracy.", le=60)
    max_request_size: Size = size("16KiB", "Largest request.", le=MIB)
    session_cookies: tuple[str, ...] = Field(
        default=("*",),
        description='Refuse a request carrying a Cookie header: "*" any cookie, or the cookie names that count.',
    )
    allow_memory_stores: bool = flag(False, "Acknowledge trust-state stores kept in memory.")
    client_store: TsaClientStore = Field(default=TsaClientStore.SETTINGS, description="Client store: settings or sql.")
    clients: tuple[Sha256, ...] = Field(default=(), description="SHA-256 of each client key.")
    retired_certificates: tuple[str, ...] = words("PEM locations of replaced certificates.")
    flood: Flood = Field(default_factory=Flood, description="Flood control.")
    signer: TsaSigner = Field(default_factory=TsaSigner, description="Signing key.")


# ---------------------------------------------------------------------------------------------------------------------
# The tree
# ---------------------------------------------------------------------------------------------------------------------
class DatumConfig(_Section):
    """Every Datum setting, nested as ``datum.<area>.<name>`` (environment ``DATUM_<AREA>__<NAME>``)."""

    enabled: bool = flag(True, "False: every Datum router adds no routes.")
    strict_env: bool = flag(False, "True: an unknown DATUM_* environment key refuses the start instead of datum.W007.")
    silenced_checks: tuple[str, ...] = words("Check ids to silence; INFO and WARNING only.")
    workers_expected: int | None = Field(
        default=None, ge=1, description="Workers the deployment states; unset uses WEB_CONCURRENCY as a hint, else 1."
    )
    runtime: Runtime = Field(default_factory=Runtime, description="The program runtime.")
    host: Host = Field(default_factory=Host, description="Options the program reads.")
    submissions: Submissions = Field(default_factory=Submissions, description="Submission handling.")
    forms: Forms = Field(default_factory=Forms, description="Form definitions.")
    web: Web = Field(default_factory=Web, description="The web surface.")
    builder: Builder = Field(default_factory=Builder, description="The form builder.")
    pdf: Pdf = Field(default_factory=Pdf, description="PDF output.")
    bindings: Bindings = Field(default_factory=Bindings, description="Design-system bindings per form route.")
    tsa: Tsa = Field(default_factory=Tsa, description="The timestamp server.")

    @field_validator("silenced_checks")
    @classmethod
    def _silenced(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        for check_id in value:
            level = CHECK_LEVELS.get(check_id)
            if level is None:
                near = closest(check_id, CHECK_LEVELS, cutoff=0.7)
                message = f"{check_id!r} is no check id" + (f"; did you mean {near!r}?" if near else "")
                raise ValueError(message)
            if level is CheckLevel.ERROR:
                message = f"{check_id!r} is an ERROR check; only INFO and WARNING checks can be silenced"
                raise ValueError(message)
        return value
