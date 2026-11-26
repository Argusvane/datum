"""Contract kits and helpers for tests (behind the testing extra).

`TsaSerialAllocatorContract`, `TsaLogContract` and `TsaClientStoreContract` bind the timestamp server's stores the same
way (a store's test module overrides the `allocator`, `log` or `store_factory` fixture); `requires_openssl` marks a test
that needs the openssl binary and skips it, with a reason, when there is none (`DATUM_OPENSSL` names another binary).
`datum_core.testing.tsa_pki` builds a throwaway timestamp PKI at test time (it is not exported here: it needs the
`timestamp` extra, which this package must import without). `datum_core.testing.otel` installs the process's one
in-memory OpenTelemetry SDK for observation tests (not exported either: the SDK is the testing extra's, and the product
imports only the API).

`IdempotencyStoreContract` binds a `SubmissionIdempotencyStore` the same way (an overridden `store` fixture); so do
`FormRepositoryContract`, `SnapshotStoreContract` and `TranslationStoreContract` for the forms stores. The runtime
contracts an engine binds are argusvane-datum-sandbox's (`datum_sandbox.testing`).
"""

from datum_core.testing.forms_contract import FormRepositoryContract, SnapshotStoreContract, TranslationStoreContract
from datum_core.testing.idempotency_contract import IdempotencyStoreContract
from datum_core.testing.openssl import openssl_binary, requires_openssl, skip_openssl_under_xdist
from datum_core.testing.tsa_contract import TsaClientStoreContract, TsaLogContract, TsaSerialAllocatorContract

__all__ = [
    "FormRepositoryContract",
    "IdempotencyStoreContract",
    "SnapshotStoreContract",
    "TranslationStoreContract",
    "TsaClientStoreContract",
    "TsaLogContract",
    "TsaSerialAllocatorContract",
    "openssl_binary",
    "requires_openssl",
    "skip_openssl_under_xdist",
]
