"""
Tests for the agent's HTTP layer and signing flow, with no YubiKey: a fake backend built from
self-signed certificates and a scripted prompter.

    python -m unittest -v          (from tools/piv-agent, with yubikey-manager or just cryptography installed)
"""

from __future__ import annotations

import base64
import contextlib
import datetime
import hashlib
import io
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from typing import Any, Optional
from unittest import mock

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

import piv_agent
from piv_agent import FILE_DIALOG_TITLE, FILE_SLOT, AgentError, CompositeBackend, Config, FileBackend, build_server, describe_certificate, normalize_origin, prompt_text

ORIGIN = "http://localhost:5173"
OTHER = "https://evil.example"


def self_signed(common_name: str, key: Any) -> x509.Certificate:
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name), x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Datum")])
    start = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
    return (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(0x1234ABCD)
        .not_valid_before(start)
        .not_valid_after(start.replace(year=2126))
        .sign(key, hashes.SHA256())
    )


class FakeBackend:
    def __init__(self, entries: list[dict]) -> None:
        self.entries = entries
        self.calls: list[tuple] = []
        self.attempts: Optional[int] = 3
        self.fail_with: list[AgentError] = []
        self.value = b"\x07" * 256

    def inventory(self) -> dict:
        return {"devices": [{"serial": 12345678, "name": "YubiKey 5 NFC", "version": "5.7.1"}], "certificates": list(self.entries)}

    def pin_attempts(self, slot: str) -> Optional[int]:
        return self.attempts

    def sign(self, slot: str, key_type: str, message: bytes, pin: Optional[str]) -> bytes:
        self.calls.append((slot, key_type, message, pin))
        if self.fail_with:
            raise self.fail_with.pop(0)
        return self.value


class FakePrompter:
    def __init__(self) -> None:
        self.answers: list[Optional[str]] = []
        self.texts: list[str] = []
        self.titles: list[str] = []
        self.confirmations: list[bool] = []
        self.confirmed: list[str] = []
        self.notes: list[tuple[str, str]] = []
        self.block: Optional[threading.Event] = None
        self.asked = threading.Event()

    def ask_pin(self, text: str, title: str = piv_agent.DIALOG_TITLE) -> Optional[str]:
        self.texts.append(text)
        self.titles.append(title)
        self.asked.set()
        if self.block is not None:
            self.block.wait(5)
        return self.answers.pop(0) if self.answers else None

    def confirm(self, text: str, title: str = piv_agent.DIALOG_TITLE) -> bool:
        self.confirmed.append(text)
        self.titles.append(title)
        return self.confirmations.pop(0) if self.confirmations else False

    def notify(self, title: str, text: str) -> None:
        self.notes.append((title, text))


# --- certificate files on disk --------------------------------------------------------------------


class CertificateFiles:
    """One temporary directory of every shape the file backend reads, minted once per run."""

    def __init__(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="datum-piv-agent-")
        self.rsa = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.rsa_cert = self_signed("Ada Lovelace (file)", self.rsa)
        self.issuer = self_signed("Datum Demo CA", rsa.generate_private_key(public_exponent=65537, key_size=2048))
        self.p256 = ec.generate_private_key(ec.SECP256R1())
        self.p256_cert = self_signed("Ada Lovelace (ec file)", self.p256)
        self.passphrase = "s3cret passphrase"
        no_encryption = serialization.NoEncryption()
        encryption = serialization.BestAvailableEncryption(self.passphrase.encode())
        self.plain_p12 = self.write("plain.p12", pkcs12.serialize_key_and_certificates(b"ada", self.rsa, self.rsa_cert, [self.issuer], no_encryption))
        self.locked_p12 = self.write("locked.p12", pkcs12.serialize_key_and_certificates(b"ada", self.rsa, self.rsa_cert, None, encryption))
        self.ec_p12 = self.write("ec.p12", pkcs12.serialize_key_and_certificates(None, self.p256, self.p256_cert, None, no_encryption))
        self.key_pem = self.write("signer.key.pem", self.rsa.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, no_encryption))
        self.locked_key_pem = self.write("locked.key.pem", self.rsa.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, encryption))
        self.cert_pem = self.write("signer.cert.pem", self.rsa_cert.public_bytes(serialization.Encoding.PEM) + self.issuer.public_bytes(serialization.Encoding.PEM))
        self.other_cert_pem = self.write("other.cert.pem", self.p256_cert.public_bytes(serialization.Encoding.PEM))
        self.chain_pem = self.write("chain.pem", self.issuer.public_bytes(serialization.Encoding.PEM))

    def write(self, name: str, data: bytes) -> str:
        path = os.path.join(self.dir, name)
        with open(path, "wb") as handle:
            handle.write(data)
        return path


FILES: Optional[CertificateFiles] = None


def files() -> CertificateFiles:
    global FILES
    if FILES is None:
        FILES = CertificateFiles()
    return FILES


def holds_a_private_key(value: Any) -> bool:
    return isinstance(value, (rsa.RSAPrivateKey, ec.EllipticCurvePrivateKey))


class ServerCase(unittest.TestCase):
    """A real `build_server` on a free port, a fake token, a scripted prompter, and urllib to call it."""

    entries: list[dict] = []

    @classmethod
    def setUpClass(cls) -> None:
        rsa2048 = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        rsa1024 = rsa.generate_private_key(public_exponent=65537, key_size=1024)
        p256 = ec.generate_private_key(ec.SECP256R1())
        cls.entries = [
            describe_certificate("9c", self_signed("Ada Lovelace", rsa2048), {"pinPolicy": "always", "touchPolicy": "cached"}, []),
            describe_certificate("9a", self_signed("Ada Lovelace (auth)", rsa1024), None, []),
            describe_certificate("9d", self_signed("Ada Lovelace (ec)", p256), {"pinPolicy": "once", "touchPolicy": "never"}, [b"\x30\x03\x02\x01\x00"]),
        ]

    def start(self, backend: Any, config: Optional[Config] = None) -> None:
        self.server = build_server(config or Config(port=0, origins=[ORIGIN, "https://Forms.Example:443/"]), backend, self.prompter, self.logs.append)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def setUp(self) -> None:
        self.backend = FakeBackend(self.entries)
        self.prompter = FakePrompter()
        self.logs: list[str] = []
        self.start(self.backend)

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    # -- helpers --

    def logged(self, predicate: Any, timeout: float = 2.0) -> bool:
        """Whether a log line matches, waiting for it: the server thread logs a request after its reply is written, so the client can read the reply first."""
        deadline = time.monotonic() + timeout
        while not any(predicate(line) for line in list(self.logs)):
            if time.monotonic() > deadline:
                return False
            time.sleep(0.01)
        return True

    def call(self, method: str, path: str, body: Any = None, origin: Optional[str] = ORIGIN, headers: Optional[dict] = None) -> tuple[int, dict, Any]:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method)
        if origin is not None:
            request.add_header("Origin", origin)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        for name, value in (headers or {}).items():
            request.add_header(name, value)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                raw = response.read()
                return response.status, dict(response.headers), json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            with error:
                raw = error.read()
                return error.code, dict(error.headers), json.loads(raw) if raw else None

    def sign_body(self, **overrides: Any) -> dict:
        body = {"slot": "9c", "algorithm": "RSASSA-PKCS1-v1_5-SHA256", "toBeSigned": base64.b64encode(b"to-be-signed").decode(), "context": {"title": "Customer intake", "documentId": "doc-1", "field": "Signature1", "reason": "I approve this application"}}
        body.update(overrides)
        return body


class AgentTest(ServerCase):
    # -- origin policy --

    def test_requests_without_a_listed_origin_are_refused_on_every_method(self) -> None:
        for method, path, body in [("GET", "/certificates", None), ("POST", "/sign", self.sign_body()), ("OPTIONS", "/sign", None), ("GET", "/health", None)]:
            for origin in [None, OTHER]:
                status, headers, payload = self.call(method, path, body, origin)
                self.assertEqual(status, 403, (method, origin))
                self.assertEqual(payload["error"]["code"], "origin_denied")
                self.assertIn("--allow-origin", payload["error"]["message"])
                self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(self.backend.calls, [])
        self.assertEqual(self.prompter.texts, [])

    def test_origins_are_compared_normalised(self) -> None:
        status, headers, _ = self.call("GET", "/health", origin="https://forms.example")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "https://forms.example")
        self.assertEqual(normalize_origin("HTTP://LocalHost:80/"), "http://localhost")
        self.assertEqual(normalize_origin("http://localhost:5173"), "http://localhost:5173")

    def test_preflight_answers_cors_and_private_network_access(self) -> None:
        status, headers, payload = self.call("OPTIONS", "/sign", headers={"Access-Control-Request-Method": "POST", "Access-Control-Request-Private-Network": "true"})
        self.assertEqual(status, 204)
        self.assertIsNone(payload)
        self.assertEqual(headers["Access-Control-Allow-Origin"], ORIGIN)
        self.assertEqual(headers["Vary"], "Origin")
        self.assertEqual(headers["Access-Control-Allow-Methods"], "GET, POST, OPTIONS")
        self.assertEqual(headers["Access-Control-Allow-Headers"], "Content-Type")
        self.assertEqual(headers["Access-Control-Allow-Private-Network"], "true")
        self.assertEqual(headers["Cache-Control"], "no-store")
        status, headers, _ = self.call("OPTIONS", "/sign")
        self.assertEqual(status, 204)
        self.assertNotIn("Access-Control-Allow-Private-Network", headers)

    # -- certificates --

    def test_health_needs_no_card(self) -> None:
        status, _, payload = self.call("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"agent": "datum-piv-agent", "version": piv_agent.AGENT_VERSION, "slot": "9c"})

    def test_certificates_carry_the_kernel_algorithm_and_flag_unusable_keys(self) -> None:
        status, headers, payload = self.call("GET", "/certificates")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(payload["agent"], {"name": "datum-piv-agent", "version": piv_agent.AGENT_VERSION})
        self.assertEqual(payload["devices"][0]["serial"], 12345678)
        by_slot = {entry["slot"]: entry for entry in payload["certificates"]}
        self.assertEqual(sorted(by_slot), ["9a", "9c", "9d"])
        sig = by_slot["9c"]
        self.assertEqual(sig["slotName"], "SIGNATURE")
        self.assertEqual(sig["subjectCommonName"], "Ada Lovelace")
        self.assertIn("CN=Ada Lovelace", sig["subject"])
        self.assertEqual(sig["keyType"], "RSA2048")
        self.assertEqual(sig["algorithm"], "RSASSA-PKCS1-v1_5-SHA256")
        self.assertEqual((sig["pinPolicy"], sig["touchPolicy"]), ("always", "cached"))
        self.assertTrue(sig["usable"])
        self.assertEqual(sig["serialNumber"], "1234abcd")
        self.assertTrue(sig["notAfter"].startswith("2126-01-01") and sig["notAfter"].endswith("Z"))
        self.assertEqual(len(sig["certificates"]), 1)
        x509.load_der_x509_certificate(base64.b64decode(sig["certificates"][0]))
        auth = by_slot["9a"]
        self.assertEqual(auth["keyType"], "RSA1024")
        self.assertIsNone(auth["algorithm"])
        self.assertFalse(auth["usable"])
        self.assertIn("128 bytes", auth["unusableReason"])
        self.assertIsNone(auth["pinPolicy"])
        ecc = by_slot["9d"]
        self.assertEqual((ecc["keyType"], ecc["algorithm"]), ("ECCP256", "ECDSA-P256-SHA256"))
        self.assertEqual(len(ecc["certificates"]), 2, "the chain follows the leaf")

    # -- signing --

    def test_sign_prompts_with_the_facts_and_returns_the_value(self) -> None:
        self.prompter.answers = ["123456"]
        status, _, payload = self.call("POST", "/sign", self.sign_body())
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["slot"], "9c")
        self.assertEqual(payload["algorithm"], "RSASSA-PKCS1-v1_5-SHA256")
        self.assertEqual(payload["keyType"], "RSA2048")
        self.assertEqual(base64.b64decode(payload["value"]), b"\x07" * 256)
        self.assertEqual(self.backend.calls, [("9c", "RSA2048", b"to-be-signed", "123456")])
        text = self.prompter.texts[0]
        self.assertIn(ORIGIN, text)
        self.assertIn("Document: Customer intake", text)
        self.assertIn("Id: doc-1", text)
        self.assertIn("Signature field: Signature1", text)
        self.assertIn("You are signing: I approve this application", text)
        self.assertIn("Ada Lovelace (slot 9c)", text)
        self.assertIn("Digest: %s…" % hashlib.sha256(b"to-be-signed").hexdigest()[:12], text)
        self.assertEqual(self.prompter.notes, [("Datum", "Touch your YubiKey if it blinks.")])
        self.assertTrue(self.logged(lambda line: "POST /sign" in line and "-> 200" in line))
        self.assertFalse(any("123456" in line or "to-be-signed" in line for line in self.logs))

    def test_sign_defaults_to_the_configured_slot_and_ignores_a_touch_note_when_never(self) -> None:
        self.prompter.answers = ["123456"]
        body = self.sign_body(slot="9d", algorithm="ECDSA-P256-SHA256")
        status, _, payload = self.call("POST", "/sign", body)
        self.assertEqual(status, 200, payload)
        self.assertEqual(self.backend.calls[0][:2], ("9d", "ECCP256"))
        self.assertEqual(self.prompter.notes, [])
        self.prompter.answers = ["123456"]
        body = self.sign_body()
        del body["slot"]
        del body["algorithm"]
        status, _, payload = self.call("POST", "/sign", body)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["slot"], "9c")

    def test_wrong_pin_reports_attempts_then_blocked_then_cancelled(self) -> None:
        self.prompter.answers = ["000000", "000000", None]
        self.backend.fail_with = [AgentError("pin_invalid", "Wrong PIN", attemptsRemaining=2), AgentError("pin_blocked", "Blocked", attemptsRemaining=0)]
        status, _, payload = self.call("POST", "/sign", self.sign_body())
        self.assertEqual((status, payload["error"]["code"], payload["error"]["attemptsRemaining"]), (401, "pin_invalid", 2))
        status, _, payload = self.call("POST", "/sign", self.sign_body())
        self.assertEqual((status, payload["error"]["code"], payload["error"]["attemptsRemaining"]), (401, "pin_blocked", 0))
        status, _, payload = self.call("POST", "/sign", self.sign_body())
        self.assertEqual((status, payload["error"]["code"]), (409, "pin_cancelled"))
        self.assertEqual(len(self.backend.calls), 2, "a cancelled prompt never reaches the card")

    def test_a_blocked_pin_is_reported_before_any_prompt(self) -> None:
        self.backend.attempts = 0
        status, _, payload = self.call("POST", "/sign", self.sign_body())
        self.assertEqual((status, payload["error"]["code"]), (401, "pin_blocked"))
        self.assertEqual(self.prompter.texts, [])

    def test_one_signature_at_a_time(self) -> None:
        self.prompter.block = threading.Event()
        self.prompter.answers = ["123456"]
        first: list = []
        thread = threading.Thread(target=lambda: first.append(self.call("POST", "/sign", self.sign_body())))
        thread.start()
        self.assertTrue(self.prompter.asked.wait(5))
        status, _, payload = self.call("POST", "/sign", self.sign_body())
        self.assertEqual((status, payload["error"]["code"]), (423, "busy"))
        status, _, _ = self.call("GET", "/health")
        self.assertEqual(status, 200, "reads still answer while a signature waits on the dialog")
        self.prompter.block.set()
        thread.join(5)
        self.assertEqual(first[0][0], 200)

    def test_refusals_before_the_pin(self) -> None:
        cases = [
            (self.sign_body(slot="9a", algorithm=None), 422, "unusable_key"),
            (self.sign_body(algorithm="ECDSA-P256-SHA256"), 409, "algorithm_mismatch"),
            (self.sign_body(slot="9e"), 404, "no_certificate"),
            (self.sign_body(slot=FILE_SLOT), 404, "no_certificate"),
            (self.sign_body(slot="zz"), 400, "bad_request"),
            (self.sign_body(toBeSigned="not base64!"), 400, "bad_request"),
            (["not", "an", "object"], 400, "bad_request"),
        ]
        for body, expected_status, code in cases:
            status, _, payload = self.call("POST", "/sign", body)
            self.assertEqual((status, payload["error"]["code"]), (expected_status, code), body)
        self.assertEqual(self.prompter.texts, [])
        self.assertEqual(self.backend.calls, [])

    def test_oversized_bodies_and_unknown_routes(self) -> None:
        status, _, payload = self.call("POST", "/sign", {"toBeSigned": "A" * (piv_agent.MAX_BODY + 10)})
        self.assertEqual((status, payload["error"]["code"]), (413, "too_large"))
        status, _, payload = self.call("GET", "/nope")
        self.assertEqual((status, payload["error"]["code"]), (404, "not_found"))
        status, _, payload = self.call("POST", "/certificates", {})
        self.assertEqual((status, payload["error"]["code"]), (404, "not_found"))

    def test_backend_failures_become_json_not_tracebacks(self) -> None:
        self.prompter.answers = ["123456"]
        self.backend.fail_with = [AgentError("touch_timeout", "The YubiKey was not touched in time")]
        status, _, payload = self.call("POST", "/sign", self.sign_body())
        self.assertEqual((status, payload["error"]["code"]), (408, "touch_timeout"))

        def boom() -> dict:
            raise RuntimeError("reader vanished")

        self.backend.inventory = boom  # type: ignore[assignment]
        status, _, payload = self.call("GET", "/certificates")
        self.assertEqual((status, payload["error"]["code"]), (500, "device_error"))
        self.assertIn("reader vanished", payload["error"]["message"])


class FileBackendTest(unittest.TestCase):
    """The certificate file on its own: what it lists, what it asks, how it signs, what it never keeps."""

    def test_a_plain_pkcs12_lists_under_the_file_slot_with_its_bundled_issuers_then_the_chain(self) -> None:
        backend = FileBackend(p12=files().plain_p12, chain=[b"\x30\x03\x02\x01\x00"])
        found = backend.inventory()
        self.assertEqual(found["devices"], [{"serial": None, "name": "plain.p12", "version": None}])
        [entry] = found["certificates"]
        self.assertEqual((entry["slot"], entry["slotName"], entry["source"], entry["file"]), (FILE_SLOT, "FILE", "file", "plain.p12"))
        self.assertEqual((entry["keyType"], entry["algorithm"], entry["usable"]), ("RSA2048", "RSASSA-PKCS1-v1_5-SHA256", True))
        self.assertEqual((entry["pinPolicy"], entry["touchPolicy"]), ("never", "never"))
        self.assertEqual(entry["subjectCommonName"], "Ada Lovelace (file)")
        self.assertEqual(len(entry["certificates"]), 3, "leaf, the PKCS#12's own issuer, then --chain")
        self.assertEqual(base64.b64decode(entry["certificates"][1]), files().issuer.public_bytes(serialization.Encoding.DER))
        self.assertFalse(backend.encrypted)
        self.assertIsNone(backend.pin_attempts(FILE_SLOT))
        self.assertTrue(backend.owns(FILE_SLOT) and not backend.owns("9c"))

    def test_a_plain_file_signs_with_no_secret_and_the_certificate_verifies_the_value(self) -> None:
        backend = FileBackend(p12=files().plain_p12)
        value = backend.sign(FILE_SLOT, "RSA2048", b"to-be-signed", None)
        files().rsa_cert.public_key().verify(value, b"to-be-signed", padding.PKCS1v15(), hashes.SHA256())
        ec_backend = FileBackend(p12=files().ec_p12)
        [entry] = ec_backend.inventory()["certificates"]
        self.assertEqual(entry["algorithm"], "ECDSA-P256-SHA256")
        value = ec_backend.sign(FILE_SLOT, "ECCP256", b"to-be-signed", None)
        files().p256_cert.public_key().verify(value, b"to-be-signed", ec.ECDSA(hashes.SHA256()))

    def test_an_encrypted_pkcs12_asks_the_passphrase_once_to_read_the_certificate_and_keeps_no_key(self) -> None:
        prompter = FakePrompter()
        prompter.answers = [files().passphrase]
        backend = FileBackend(p12=files().locked_p12, prompter=prompter)
        self.assertEqual(len(prompter.texts), 1)
        self.assertIn("passphrase of locked.p12 to read its certificate", prompter.texts[0])
        self.assertEqual(prompter.titles, [FILE_DIALOG_TITLE])
        self.assertTrue(backend.encrypted)
        [entry] = backend.inventory()["certificates"]
        self.assertEqual(entry["pinPolicy"], "passphrase")
        self.assertFalse(any(holds_a_private_key(value) for value in vars(backend).values()), "the key is not held between signatures")
        # Per signature: the wrong passphrase is refused with no attempt counter, the right one signs.
        with self.assertRaises(AgentError) as refused:
            backend.sign(FILE_SLOT, "RSA2048", b"to-be-signed", "nope")
        self.assertEqual((refused.exception.code, refused.exception.extra), ("pin_invalid", {}))
        value = backend.sign(FILE_SLOT, "RSA2048", b"to-be-signed", files().passphrase)
        files().rsa_cert.public_key().verify(value, b"to-be-signed", padding.PKCS1v15(), hashes.SHA256())

    def test_an_encrypted_pkcs12_refuses_to_start_on_a_wrong_or_missing_passphrase(self) -> None:
        prompter = FakePrompter()
        prompter.answers = ["nope"]
        with self.assertRaises(AgentError) as wrong:
            FileBackend(p12=files().locked_p12, prompter=prompter)
        self.assertEqual(wrong.exception.code, "pin_invalid")
        with self.assertRaises(AgentError) as cancelled:
            FileBackend(p12=files().locked_p12, prompter=FakePrompter())
        self.assertEqual(cancelled.exception.code, "pin_cancelled")

    def test_a_pem_pair_reads_the_leaf_then_the_issuers_and_checks_the_key_matches(self) -> None:
        backend = FileBackend(key=files().key_pem, cert=files().cert_pem)
        [entry] = backend.inventory()["certificates"]
        self.assertEqual((entry["file"], entry["pinPolicy"]), ("signer.key.pem", "never"))
        self.assertEqual(len(entry["certificates"]), 2)
        value = backend.sign(FILE_SLOT, "RSA2048", b"to-be-signed", None)
        files().rsa_cert.public_key().verify(value, b"to-be-signed", padding.PKCS1v15(), hashes.SHA256())
        with self.assertRaises(ValueError) as mismatch:
            FileBackend(key=files().key_pem, cert=files().other_cert_pem)
        self.assertIn("is not the key of the certificate", str(mismatch.exception))

    def test_an_encrypted_pem_key_is_read_without_a_passphrase_at_startup_and_decrypted_per_signature(self) -> None:
        backend = FileBackend(key=files().locked_key_pem, cert=files().cert_pem)
        self.assertTrue(backend.encrypted)
        self.assertEqual(backend.inventory()["certificates"][0]["pinPolicy"], "passphrase")
        with self.assertRaises(AgentError) as refused:
            backend.sign(FILE_SLOT, "RSA2048", b"to-be-signed", "nope")
        self.assertEqual(refused.exception.code, "pin_invalid")
        value = backend.sign(FILE_SLOT, "RSA2048", b"to-be-signed", files().passphrase)
        files().rsa_cert.public_key().verify(value, b"to-be-signed", padding.PKCS1v15(), hashes.SHA256())

    def test_one_file_one_way(self) -> None:
        with self.assertRaises(ValueError):
            FileBackend(p12=files().plain_p12, key=files().key_pem, cert=files().cert_pem)
        with self.assertRaises(ValueError):
            FileBackend(key=files().key_pem)
        with self.assertRaises(ValueError):
            FileBackend()


class FileAgentTest(ServerCase):
    """The agent over a YubiKey (faked) and a certificate file together, the file as the default slot."""

    def setUp(self) -> None:
        self.backend = FakeBackend(self.entries)
        self.prompter = FakePrompter()
        self.file_backend = FileBackend(p12=files().plain_p12)
        self.logs: list[str] = []
        self.start(CompositeBackend([self.backend, self.file_backend], self.logs.append), Config(port=0, origins=[ORIGIN], slot=FILE_SLOT))

    def test_the_file_is_the_default_slot(self) -> None:
        status, _, payload = self.call("GET", "/health")
        self.assertEqual((status, payload["slot"]), (200, FILE_SLOT))
        self.prompter.confirmations = [True]
        body = self.sign_body()
        del body["slot"]
        del body["algorithm"]
        status, _, payload = self.call("POST", "/sign", body)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["slot"], FILE_SLOT)

    def test_the_listing_holds_the_token_and_the_file(self) -> None:
        status, _, payload = self.call("GET", "/certificates")
        self.assertEqual(status, 200)
        self.assertEqual([device["name"] for device in payload["devices"]], ["YubiKey 5 NFC", "plain.p12"])
        self.assertEqual([entry["slot"] for entry in payload["certificates"]], ["9c", "9a", "9d", FILE_SLOT])

    def test_a_file_without_a_passphrase_signs_after_a_confirmation_never_a_pin(self) -> None:
        self.prompter.confirmations = [True]
        status, _, payload = self.call("POST", "/sign", self.sign_body(slot=FILE_SLOT))
        self.assertEqual(status, 200, payload)
        self.assertEqual((payload["slot"], payload["algorithm"], payload["keyType"]), (FILE_SLOT, "RSASSA-PKCS1-v1_5-SHA256", "RSA2048"))
        files().rsa_cert.public_key().verify(base64.b64decode(payload["value"]), b"to-be-signed", padding.PKCS1v15(), hashes.SHA256())
        self.assertEqual(self.prompter.texts, [], "nothing to type")
        self.assertEqual(self.prompter.titles, [FILE_DIALOG_TITLE])
        text = self.prompter.confirmed[0]
        self.assertIn(ORIGIN, text)
        self.assertIn("You are signing: I approve this application", text)
        self.assertIn("Certificate: Ada Lovelace (file) (file plain.p12)", text)
        self.assertTrue(text.endswith("Click Sign to sign with plain.p12."))
        self.assertEqual(self.prompter.notes, [], "no touch banner for a file")
        self.assertEqual(self.backend.calls, [], "the token was not asked")

    def test_a_declined_confirmation_signs_nothing(self) -> None:
        self.prompter.confirmations = [False]
        status, _, payload = self.call("POST", "/sign", self.sign_body(slot=FILE_SLOT))
        self.assertEqual((status, payload["error"]["code"]), (409, "pin_cancelled"))

    def test_an_encrypted_file_asks_its_passphrase_per_signature(self) -> None:
        startup = FakePrompter()
        startup.answers = [files().passphrase]
        locked = FileBackend(p12=files().locked_p12, prompter=startup)
        self.server.shutdown()
        self.server.server_close()
        self.start(CompositeBackend([self.backend, locked]), Config(port=0, origins=[ORIGIN], slot=FILE_SLOT))
        self.prompter.answers = ["nope", files().passphrase]
        status, _, payload = self.call("POST", "/sign", self.sign_body(slot=FILE_SLOT))
        self.assertEqual((status, payload["error"]["code"]), (401, "pin_invalid"))
        self.assertNotIn("attemptsRemaining", payload["error"], "a file has no lockout counter")
        status, _, payload = self.call("POST", "/sign", self.sign_body(slot=FILE_SLOT))
        self.assertEqual(status, 200, payload)
        self.assertTrue(self.prompter.texts[0].endswith("Enter the passphrase of locked.p12 to sign."))
        self.assertEqual(self.prompter.titles, [FILE_DIALOG_TITLE, FILE_DIALOG_TITLE])
        self.assertEqual(self.prompter.confirmed, [])
        self.assertFalse(any(files().passphrase in line for line in self.logs))

    def test_the_token_slots_still_route_to_the_token(self) -> None:
        self.prompter.answers = ["123456"]
        status, _, payload = self.call("POST", "/sign", self.sign_body())
        self.assertEqual(status, 200, payload)
        self.assertEqual(self.backend.calls, [("9c", "RSA2048", b"to-be-signed", "123456")])
        self.assertEqual(self.prompter.titles, [piv_agent.DIALOG_TITLE])

    def test_an_unplugged_token_does_not_hide_the_file(self) -> None:
        def unplugged() -> dict:
            raise AgentError("no_device", "No YubiKey is plugged in")

        self.backend.inventory = unplugged  # type: ignore[assignment]
        status, _, payload = self.call("GET", "/certificates")
        self.assertEqual(status, 200)
        self.assertEqual([entry["slot"] for entry in payload["certificates"]], [FILE_SLOT])
        self.assertTrue(any("No YubiKey is plugged in" in line for line in self.logs))


class PromptTextTest(unittest.TestCase):
    def test_prompt_text_names_only_what_is_known(self) -> None:
        entry = {"slot": "9c", "subject": "CN=Ada", "subjectCommonName": None}
        text = prompt_text("", {"title": 7, "reason": "   "}, entry, "abc123")
        self.assertTrue(text.startswith("A page on this computer asks you to sign a PDF."))
        self.assertNotIn("Document:", text)
        self.assertNotIn("You are signing", text)
        self.assertIn("Certificate: CN=Ada (slot 9c)", text)
        self.assertIn("Digest: abc123…", text)
        self.assertTrue(text.endswith("Enter the PIV PIN to sign."))

    def test_prompt_text_for_a_file_names_the_file_and_what_the_dialog_wants(self) -> None:
        entry = {"slot": FILE_SLOT, "subject": "CN=Ada", "subjectCommonName": "Ada", "source": "file", "file": "signer.p12", "pinPolicy": "passphrase"}
        text = prompt_text(ORIGIN, {}, entry, "abc123")
        self.assertIn("Certificate: Ada (file signer.p12)", text)
        self.assertIn("Digest: abc123…", text)
        self.assertTrue(text.endswith("Enter the passphrase of signer.p12 to sign."))
        text = prompt_text(ORIGIN, {}, {**entry, "pinPolicy": "never"}, "abc123")
        self.assertTrue(text.endswith("Click Sign to sign with signer.p12."))
        self.assertEqual(piv_agent.dialog_title(entry), FILE_DIALOG_TITLE)
        self.assertEqual(piv_agent.dialog_title({"slot": "9c"}), piv_agent.DIALOG_TITLE)


class NativePrompterTest(unittest.TestCase):
    def test_prompt_text_never_enters_the_scripts(self) -> None:
        # The dialogs read the text from the environment; a hostile title cannot become AppleScript or PowerShell.
        for script in [piv_agent.MAC_DIALOG_SCRIPT, piv_agent.MAC_CONFIRM_SCRIPT, piv_agent.MAC_NOTIFY_SCRIPT, piv_agent.WINDOWS_DIALOG_SCRIPT, piv_agent.WINDOWS_CONFIRM_SCRIPT, piv_agent.WINDOWS_TOAST_SCRIPT]:
            self.assertIn("DATUM_", script)
        self.assertIn('with hidden answer', piv_agent.MAC_DIALOG_SCRIPT)
        self.assertNotIn("default answer", piv_agent.MAC_CONFIRM_SCRIPT)
        self.assertIn("UseSystemPasswordChar = $true", piv_agent.WINDOWS_DIALOG_SCRIPT)
        self.assertNotIn("TextBox", piv_agent.WINDOWS_CONFIRM_SCRIPT)

    def test_terminal_fallback_without_a_tty_cancels(self) -> None:
        prompter = piv_agent.NativePrompter(terminal_only=True)
        real = piv_agent.sys.stdin
        piv_agent.sys.stdin = io.StringIO("")
        try:
            self.assertIsNone(prompter.ask_pin("text"))
            self.assertFalse(prompter.confirm("text"))
        finally:
            piv_agent.sys.stdin = real


class MainTest(unittest.TestCase):
    def run_main(self, argv: list[str]) -> tuple[int, str]:
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            try:
                code = piv_agent.main(argv)
            except SystemExit as stop:
                code = int(stop.code or 0)
        return code, err.getvalue()

    def test_the_file_flags_are_checked_before_anything_starts(self) -> None:
        code, err = self.run_main(["--allow-origin", ORIGIN, "--p12", files().plain_p12, "--key", files().key_pem, "--cert", files().cert_pem])
        self.assertEqual(code, 2)
        self.assertIn("--p12 and --key", err)
        code, err = self.run_main(["--allow-origin", ORIGIN, "--key", files().key_pem])
        self.assertEqual(code, 2)
        self.assertIn("--key and --cert go together", err)
        code, err = self.run_main(["--allow-origin", ORIGIN, "--slot", "zz"])
        self.assertEqual(code, 2)
        self.assertIn("--slot must be", err)

    def test_a_mismatched_pem_pair_is_refused_at_startup(self) -> None:
        code, err = self.run_main(["--allow-origin", ORIGIN, "--key", files().key_pem, "--cert", files().other_cert_pem, "--port", "0"])
        self.assertEqual(code, 2)
        self.assertIn("is not the key of the certificate", err)

    def test_an_origin_must_be_a_web_origin(self) -> None:
        for bad in ["", " ", "null", "forms.example", "ftp://forms.example", "file:///tmp/a", "https://", "https://forms.example/",
                    "https://forms.example/path", "https://forms.example?x=1", "https://forms.example#top", "https://user@forms.example",
                    "https://forms.example:abc", "https://forms.example:0", "https://forms.example:99999", " https://forms.example", "https://forms .example"]:
            with self.subTest(origin=bad):
                code, err = self.run_main(["--allow-origin", bad, "--slot", "zz"])
                self.assertEqual(code, 2)
                self.assertIn("is not an origin", err)
                self.assertNotIn("--slot must be", err)

    def test_a_web_origin_passes_the_origin_check(self) -> None:
        for good in ["https://forms.example", "http://forms.example:8080", "HTTPS://Forms.Example", "http://127.0.0.1:5173", "http://[::1]:3000"]:
            with self.subTest(origin=good):
                # Past the origin check the run reaches the next one (here a bad slot).
                code, err = self.run_main(["--allow-origin", good, "--slot", "zz"])
                self.assertEqual(code, 2)
                self.assertIn("--slot must be", err)

    def test_an_origin_is_required_and_dev_names_the_vite_origins(self) -> None:
        code, err = self.run_main([])
        self.assertEqual(code, 2)
        self.assertIn("--allow-origin", err)
        self.assertIn("--dev", err)
        code, err = self.run_main(["--allow-no-origin"])
        self.assertEqual(code, 2)
        self.assertIn("--allow-origin", err)
        # --dev alone passes the origin check, so the run moves on to the next check (here a bad slot).
        code, err = self.run_main(["--dev", "--slot", "zz"])
        self.assertEqual(code, 2)
        self.assertIn("--slot must be", err)
        self.assertNotIn("name the page", err)

    def test_dev_adds_the_vite_origins_to_the_named_ones(self) -> None:
        captured: list[Config] = []

        def stop(config: Config, *_: Any) -> Any:
            captured.append(config)
            raise SystemExit(0)

        with mock.patch.object(piv_agent, "build_server", stop), mock.patch.object(piv_agent, "YubiKeyBackend", return_value=FakeBackend([])):
            self.run_main(["--dev", "--allow-origin", "https://forms.example"])
            self.run_main(["--allow-origin", "https://forms.example"])
        self.assertEqual(captured[0].origins, ["https://forms.example", *piv_agent.DEV_ORIGINS])
        self.assertEqual(captured[1].origins, ["https://forms.example"])


if __name__ == "__main__":
    unittest.main()
