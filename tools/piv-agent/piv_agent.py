#!/usr/bin/env python3
"""
datum-piv-agent — signs a Datum PDF with the certificate on a YubiKey's PIV applet,
or with a certificate file on this computer.

A browser cannot talk to a smart card, so this small process runs on the person's own
computer, bound to the loopback interface, and does the one thing the page cannot: it holds
the PIV session, asks for the PIN in a native dialog, and signs the bytes the PDF kernel hands
over. The page never sees the PIN and the agent never sees the PDF — only the DER signed
attributes (`toBeSigned`) travel over 127.0.0.1, and the value comes back.

The same holds for a certificate the person keeps in a file — a PKCS#12 (`.p12` / `.pfx`) as
a CA, Keychain or Windows export it, or a PEM key with its PEM certificate: the key is used
inside this process, never in the page; it is read from the file, decrypted and dropped for
each signature, never held between two; and the same native dialog asks for the passphrase,
or for a plain confirmation when the file has none, before anything is signed.

Threat model, in one breath: only listed web origins may talk to the agent (the `Origin`
header is checked on every request, including preflights); it listens on 127.0.0.1 only;
one signature at a time; the dialog names the origin, the document and the certificate,
so the person always knows what they are signing; the PIN or passphrase is never stored or
logged.

Runs on Yubico's own `yubikey-manager` package (`pip install yubikey-manager`) and nothing else
outside the standard library. A certificate file alone needs only PyCA `cryptography`, which
`yubikey-manager` already brings.

    python piv_agent.py --allow-origin https://forms.example --verbose
    python piv_agent.py --p12 ~/Desktop/signer.p12 --allow-origin https://forms.example

HTTP API (JSON, bytes as base64):

    GET  /health        -> { agent, version, slot }
    GET  /certificates  -> { agent, devices: [...], certificates: [...] }
    POST /sign          -> { slot, algorithm, keyType, value }
                            body: { slot, algorithm, toBeSigned, context: { title?, documentId?, field?, reason? } }

`slot` is a PIV slot (`9c`) for the token, or `file` for the certificate file.

Errors are `{ "error": { "code", "message", "attemptsRemaining"? } }` with a matching status.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Optional, Protocol
from urllib.parse import urlsplit

AGENT_NAME = "datum-piv-agent"
AGENT_VERSION = "0.1.0"
DEFAULT_PORT = 7391
# The Vite dev server's origins: allowed only when --dev says so; a page's origin is otherwise always named with --allow-origin.
DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]
DEFAULT_SLOT = "9c"
# The pseudo-slot a certificate file is listed under; a PIV slot is two hex digits, so no clash.
FILE_SLOT = "file"
MAX_BODY = 64 * 1024
DIALOG_TITLE = "Sign with your YubiKey"
FILE_DIALOG_TITLE = "Sign with your certificate"

# PIV key types -> the algorithm ids the PDF kernel derives from the certificate.
KERNEL_ALGORITHMS = {
    "RSA2048": "RSASSA-PKCS1-v1_5-SHA256",
    "RSA3072": "RSASSA-PKCS1-v1_5-SHA256",
    "RSA4096": "RSASSA-PKCS1-v1_5-SHA256",
    "ECCP256": "ECDSA-P256-SHA256",
    "ECCP384": "ECDSA-P384-SHA256",
}
UNUSABLE = {
    "RSA1024": "RSA-1024: the PDF kernel refuses signature values under 128 bytes",
    "ED25519": "Ed25519 is not a signature algorithm the PDF kernel supports",
    "X25519": "X25519 is a key-agreement key, not a signing key",
}
SLOT_NAMES = {
    "9a": "AUTHENTICATION",
    "9c": "SIGNATURE",
    "9d": "KEY_MANAGEMENT",
    "9e": "CARD_AUTH",
    **{"%02x" % code: "RETIRED%d" % (code - 0x81) for code in range(0x82, 0x96)},
    FILE_SLOT: "FILE",
}


class AgentError(Exception):
    """An error the HTTP layer turns into a JSON body; `code` is what the page switches on."""

    STATUS = {
        "bad_request": 400,
        "origin_denied": 403,
        "no_certificate": 404,
        "unusable_key": 422,
        "algorithm_mismatch": 409,
        "pin_invalid": 401,
        "pin_blocked": 401,
        "pin_cancelled": 409,
        "touch_timeout": 408,
        "busy": 423,
        "no_device": 503,
        "device_error": 500,
        "too_large": 413,
        "not_found": 404,
    }

    def __init__(self, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = self.STATUS.get(code, 500)
        self.extra = extra

    def body(self) -> dict:
        error: dict = {"code": self.code, "message": self.message}
        error.update(self.extra)
        return {"error": error}


# --- certificates ------------------------------------------------------------------------------


def key_type_of(public_key: Any) -> str:
    """The PIV key type name of a certificate's public key, by inspection — no yubikit needed."""
    from cryptography.hazmat.primitives.asymmetric import ec, ed25519, rsa, x25519

    if isinstance(public_key, rsa.RSAPublicKey):
        return "RSA%d" % public_key.key_size
    if isinstance(public_key, ec.EllipticCurvePublicKey):
        return {"secp256r1": "ECCP256", "secp384r1": "ECCP384"}.get(public_key.curve.name, "EC-" + public_key.curve.name)
    if isinstance(public_key, ed25519.Ed25519PublicKey):
        return "ED25519"
    if isinstance(public_key, x25519.X25519PublicKey):
        return "X25519"
    return type(public_key).__name__


def describe_certificate(slot: str, cert: Any, metadata: Optional[dict], chain: list[bytes]) -> dict:
    """The `/certificates` entry for one slot: what the page shows, and what the kernel needs."""
    from cryptography.x509.oid import NameOID

    key_type = key_type_of(cert.public_key())
    algorithm = KERNEL_ALGORITHMS.get(key_type)
    reason = UNUSABLE.get(key_type) or (None if algorithm else "%s is not a key type the PDF kernel signs with" % key_type)
    common_names = cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
    entry = {
        "slot": slot,
        "slotName": SLOT_NAMES.get(slot, slot.upper()),
        "subject": cert.subject.rfc4514_string(),
        "subjectCommonName": common_names[0].value if common_names else None,
        "issuer": cert.issuer.rfc4514_string(),
        "serialNumber": "%x" % cert.serial_number,
        "notBefore": cert.not_valid_before_utc.isoformat().replace("+00:00", "Z"),
        "notAfter": cert.not_valid_after_utc.isoformat().replace("+00:00", "Z"),
        "keyType": key_type,
        "algorithm": algorithm,
        "pinPolicy": (metadata or {}).get("pinPolicy"),
        "touchPolicy": (metadata or {}).get("touchPolicy"),
        "usable": reason is None,
        "certificates": [b64(cert.public_bytes(_der_encoding()))] + [b64(der) for der in chain],
    }
    if reason:
        entry["unusableReason"] = reason
    return entry


def _der_encoding() -> Any:
    from cryptography.hazmat.primitives.serialization import Encoding

    return Encoding.DER


def load_chain(path: Optional[str]) -> list[bytes]:
    """The issuer certificates (PEM, any number) the token does not carry, DER, in file order."""
    if not path:
        return []
    from cryptography import x509

    return [cert.public_bytes(_der_encoding()) for cert in x509.load_pem_x509_certificates(read_file(path))]


def read_file(path: str) -> bytes:
    with open(path, "rb") as handle:
        return handle.read()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def unb64(text: Any, what: str) -> bytes:
    if not isinstance(text, str) or not text:
        raise AgentError("bad_request", "%s must be a base64 string" % what)
    try:
        return base64.b64decode(text, validate=True)
    except Exception:
        raise AgentError("bad_request", "%s is not valid base64" % what)


# --- the PIN prompt ------------------------------------------------------------------------------


class Prompter(Protocol):
    def ask_pin(self, text: str, title: str = DIALOG_TITLE) -> Optional[str]: ...

    def confirm(self, text: str, title: str = DIALOG_TITLE) -> bool: ...

    def notify(self, title: str, text: str) -> None: ...


def is_file_entry(entry: dict) -> bool:
    return entry.get("source") == "file"


def needs_secret(entry: dict) -> bool:
    """Whether signing with this entry asks for a PIN or passphrase, or only for a confirmation."""
    return not (is_file_entry(entry) and entry.get("pinPolicy") == "never")


def dialog_title(entry: dict) -> str:
    return FILE_DIALOG_TITLE if is_file_entry(entry) else DIALOG_TITLE


def prompt_text(origin: str, context: dict, entry: dict, digest_prefix: str) -> str:
    """What the dialog says: who is asking, what is being signed, with which certificate."""
    lines = ["%s asks you to sign a PDF." % (origin or "A page on this computer"), ""]
    title = context.get("title")
    document_id = context.get("documentId")
    field_name = context.get("field")
    if isinstance(title, str) and title:
        lines.append("Document: %s" % title)
    if isinstance(document_id, str) and document_id:
        lines.append("Id: %s" % document_id)
    if isinstance(field_name, str) and field_name:
        lines.append("Signature field: %s" % field_name)
    reason = context.get("reason")
    if isinstance(reason, str) and reason.strip():
        # What the page says the person is affirming — the signature's reason or commitment
        # statement — so the dialog shows the statement the key is about to sign.
        lines.extend(["", "You are signing: %s" % reason.strip()[:500], ""])
    name = entry.get("subjectCommonName") or entry.get("subject")
    if is_file_entry(entry):
        file_name = entry.get("file") or "the certificate file"
        lines.append("Certificate: %s (file %s)" % (name, file_name))
        lines.append("Digest: %s…" % digest_prefix)
        if needs_secret(entry):
            lines.extend(["", "Enter the passphrase of %s to sign." % file_name])
        else:
            lines.extend(["", "Click Sign to sign with %s." % file_name])
    else:
        lines.append("Certificate: %s (slot %s)" % (name, entry["slot"]))
        lines.append("Digest: %s…" % digest_prefix)
        lines.extend(["", "Enter the PIV PIN to sign."])
    return "\n".join(lines)


MAC_DIALOG_SCRIPT = """
set promptText to (system attribute "DATUM_PIN_PROMPT")
tell me to activate
set answer to display dialog promptText with title (system attribute "DATUM_PIN_TITLE") default answer "" with hidden answer buttons {"Cancel", "Sign"} default button "Sign" with icon caution
return text returned of answer
"""

MAC_CONFIRM_SCRIPT = """
set promptText to (system attribute "DATUM_PIN_PROMPT")
tell me to activate
display dialog promptText with title (system attribute "DATUM_PIN_TITLE") buttons {"Cancel", "Sign"} default button "Sign" cancel button "Cancel" with icon caution
return "sign"
"""

MAC_NOTIFY_SCRIPT = """
display notification (system attribute "DATUM_NOTE") with title (system attribute "DATUM_NOTE_TITLE")
"""

WINDOWS_DIALOG_SCRIPT = r"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = $env:DATUM_PIN_TITLE
$form.TopMost = $true
$form.StartPosition = 'CenterScreen'
$form.Width = 520
$form.Height = 330
$form.FormBorderStyle = 'FixedDialog'
$label = New-Object System.Windows.Forms.Label
$label.Text = $env:DATUM_PIN_PROMPT
$label.Left = 16
$label.Top = 12
$label.Width = 480
$label.Height = 190
$box = New-Object System.Windows.Forms.TextBox
$box.UseSystemPasswordChar = $true
$box.Left = 16
$box.Top = 208
$box.Width = 480
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Sign'
$ok.Left = 320
$ok.Top = 246
$ok.DialogResult = 'OK'
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Left = 410
$cancel.Top = 246
$cancel.DialogResult = 'Cancel'
$form.Controls.AddRange(@($label, $box, $ok, $cancel))
$form.AcceptButton = $ok
$form.CancelButton = $cancel
if ($form.ShowDialog() -eq 'OK') { [Console]::Out.Write($box.Text); exit 0 } else { exit 1 }
"""

WINDOWS_CONFIRM_SCRIPT = r"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = $env:DATUM_PIN_TITLE
$form.TopMost = $true
$form.StartPosition = 'CenterScreen'
$form.Width = 520
$form.Height = 300
$form.FormBorderStyle = 'FixedDialog'
$label = New-Object System.Windows.Forms.Label
$label.Text = $env:DATUM_PIN_PROMPT
$label.Left = 16
$label.Top = 12
$label.Width = 480
$label.Height = 190
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Sign'
$ok.Left = 320
$ok.Top = 214
$ok.DialogResult = 'OK'
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Left = 410
$cancel.Top = 214
$cancel.DialogResult = 'Cancel'
$form.Controls.AddRange(@($label, $ok, $cancel))
$form.AcceptButton = $ok
$form.CancelButton = $cancel
if ($form.ShowDialog() -eq 'OK') { exit 0 } else { exit 1 }
"""

WINDOWS_TOAST_SCRIPT = r"""
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $nodes = $xml.GetElementsByTagName('text')
  $nodes.Item(0).AppendChild($xml.CreateTextNode($env:DATUM_NOTE_TITLE)) | Out-Null
  $nodes.Item(1).AppendChild($xml.CreateTextNode($env:DATUM_NOTE)) | Out-Null
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Datum').Show([Windows.UI.Notifications.ToastNotification]::new($xml))
} catch { }
"""


class NativePrompter:
    """
    The OS's own password dialog, so the PIN never crosses a terminal or a web page. The text is
    handed to the dialog through environment variables or argv — never spliced into a script.
    Without a graphical prompt the agent falls back to the terminal, after a notification.
    """

    def __init__(self, terminal_only: bool = False, log: Callable[[str], None] = lambda _: None) -> None:
        self.terminal_only = terminal_only
        self.log = log

    def ask_pin(self, text: str, title: str = DIALOG_TITLE) -> Optional[str]:
        if not self.terminal_only:
            asker = self._native_asker()
            if asker:
                try:
                    return asker(text, title)
                except FileNotFoundError:
                    pass
        return self._terminal(text)

    def confirm(self, text: str, title: str = DIALOG_TITLE) -> bool:
        """Sign / Cancel with nothing to type — for a certificate file without a passphrase."""
        if not self.terminal_only:
            confirmer = self._native_confirmer()
            if confirmer:
                try:
                    return confirmer(text, title)
                except FileNotFoundError:
                    pass
        return self._terminal_confirm(text)

    def notify(self, title: str, text: str) -> None:
        try:
            if sys.platform == "darwin":
                self._run(["osascript", "-e", MAC_NOTIFY_SCRIPT], {"DATUM_NOTE": text, "DATUM_NOTE_TITLE": title})
            elif sys.platform.startswith("win"):
                self._run(["powershell", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TOAST_SCRIPT], {"DATUM_NOTE": text, "DATUM_NOTE_TITLE": title})
            elif shutil.which("notify-send"):
                self._run(["notify-send", title, text], {})
        except Exception as error:  # a banner is a courtesy, never a failure
            self.log("notification failed: %s" % error)

    def _native_asker(self) -> Optional[Callable[[str, str], Optional[str]]]:
        if sys.platform == "darwin":
            return self._mac
        if sys.platform.startswith("win"):
            return self._windows
        if shutil.which("zenity"):
            return self._zenity
        if shutil.which("kdialog"):
            return self._kdialog
        if shutil.which("pinentry"):
            return self._pinentry
        return None

    def _native_confirmer(self) -> Optional[Callable[[str, str], bool]]:
        if sys.platform == "darwin":
            return self._mac_confirm
        if sys.platform.startswith("win"):
            return self._windows_confirm
        if shutil.which("zenity"):
            return self._zenity_confirm
        if shutil.which("kdialog"):
            return self._kdialog_confirm
        if shutil.which("pinentry"):
            return self._pinentry_confirm
        return None

    def _run(self, argv: list[str], env: dict, stdin: Optional[str] = None) -> subprocess.CompletedProcess:
        return subprocess.run(argv, input=stdin, capture_output=True, text=True, env={**os.environ, **env}, timeout=600)

    def _mac(self, text: str, title: str) -> Optional[str]:
        done = self._run(["osascript", "-e", MAC_DIALOG_SCRIPT], {"DATUM_PIN_PROMPT": text, "DATUM_PIN_TITLE": title})
        return done.stdout.rstrip("\n") if done.returncode == 0 else None

    def _mac_confirm(self, text: str, title: str) -> bool:
        # osascript exits non-zero when the person cancels the dialog ("User canceled", -128).
        done = self._run(["osascript", "-e", MAC_CONFIRM_SCRIPT], {"DATUM_PIN_PROMPT": text, "DATUM_PIN_TITLE": title})
        return done.returncode == 0 and done.stdout.strip() == "sign"

    def _windows(self, text: str, title: str) -> Optional[str]:
        done = self._run(["powershell", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_DIALOG_SCRIPT], {"DATUM_PIN_PROMPT": text, "DATUM_PIN_TITLE": title})
        return done.stdout if done.returncode == 0 else None

    def _windows_confirm(self, text: str, title: str) -> bool:
        done = self._run(["powershell", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_CONFIRM_SCRIPT], {"DATUM_PIN_PROMPT": text, "DATUM_PIN_TITLE": title})
        return done.returncode == 0

    def _zenity(self, text: str, title: str) -> Optional[str]:
        done = self._run(["zenity", "--entry", "--hide-text", "--title", title, "--text", text], {})
        return done.stdout.rstrip("\n") if done.returncode == 0 else None

    def _zenity_confirm(self, text: str, title: str) -> bool:
        done = self._run(["zenity", "--question", "--title", title, "--text", text, "--ok-label", "Sign", "--cancel-label", "Cancel"], {})
        return done.returncode == 0

    def _kdialog(self, text: str, title: str) -> Optional[str]:
        done = self._run(["kdialog", "--title", title, "--password", text], {})
        return done.stdout.rstrip("\n") if done.returncode == 0 else None

    def _kdialog_confirm(self, text: str, title: str) -> bool:
        done = self._run(["kdialog", "--title", title, "--yes-label", "Sign", "--no-label", "Cancel", "--yesno", text], {})
        return done.returncode == 0

    @staticmethod
    def _assuan(value: str) -> str:
        return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")

    def _pinentry(self, text: str, title: str) -> Optional[str]:
        script = "SETTITLE %s\nSETDESC %s\nSETPROMPT PIN\nGETPIN\nBYE\n" % (self._assuan(title), self._assuan(text))
        done = self._run(["pinentry"], {}, stdin=script)
        for line in done.stdout.splitlines():
            if line.startswith("D "):
                return line[2:].replace("%0A", "\n").replace("%0D", "\r").replace("%25", "%")
        return None

    def _pinentry_confirm(self, text: str, title: str) -> bool:
        # CONFIRM answers OK, or ERR when the person cancels; every earlier command answers OK too.
        script = "SETTITLE %s\nSETDESC %s\nSETOK Sign\nSETCANCEL Cancel\nCONFIRM\nBYE\n" % (self._assuan(title), self._assuan(text))
        done = self._run(["pinentry"], {}, stdin=script)
        answers = [line for line in done.stdout.splitlines() if line.startswith("OK") or line.startswith("ERR")]
        return done.returncode == 0 and len(answers) >= 6 and answers[5].startswith("OK")

    def _terminal(self, text: str) -> Optional[str]:
        if not sys.stdin.isatty():
            return None
        self.notify("Datum", "A page is waiting for your PIN or passphrase in the agent's terminal.")
        print("\n" + text, file=sys.stderr)
        try:
            return getpass.getpass("PIN or passphrase: ")
        except (EOFError, KeyboardInterrupt):
            return None

    def _terminal_confirm(self, text: str) -> bool:
        if not sys.stdin.isatty():
            return False
        self.notify("Datum", "A page is waiting for your confirmation in the agent's terminal.")
        print("\n" + text, file=sys.stderr)
        try:
            return input("Sign? [y/N] ").strip().lower() in ("y", "yes")
        except (EOFError, KeyboardInterrupt):
            return False


# --- the YubiKey ---------------------------------------------------------------------------------


class Backend(Protocol):
    """What holds the certificates: a YubiKey, a certificate file, or both together."""

    def inventory(self) -> dict: ...

    def pin_attempts(self, slot: str) -> Optional[int]: ...

    def sign(self, slot: str, key_type: str, message: bytes, pin: Optional[str]) -> bytes: ...


class YubiKeyBackend:
    """PIV over PC/SC through Yubico's yubikit; every call opens its own connection."""

    def __init__(self, serial: Optional[int] = None, chain: Optional[list[bytes]] = None, log: Callable[[str], None] = lambda _: None) -> None:
        self.serial = serial
        self.chain = chain or []
        self.log = log
        # Deferred so the module (and its tests) import without a YubiKey stack.
        from ykman.device import list_all_devices
        from yubikit.core import NotSupportedError
        from yubikit.core.smartcard import SW, ApduError, SmartCardConnection
        from yubikit.piv import KEY_TYPE, SLOT, InvalidPinError, PivSession

        self._list_all_devices = list_all_devices
        self._NotSupportedError = NotSupportedError
        self._ApduError = ApduError
        self._SW = SW
        self._SmartCardConnection = SmartCardConnection
        self._KEY_TYPE = KEY_TYPE
        self._SLOT = SLOT
        self._InvalidPinError = InvalidPinError
        self._PivSession = PivSession

    def _device(self) -> tuple:
        try:
            devices = self._list_all_devices()
        except Exception as error:
            raise AgentError("no_device", "Could not enumerate YubiKeys (is the smart card service running?): %s" % error)
        for device, info in devices:
            if self.serial is None or info.serial == self.serial:
                return device, info
        if self.serial is not None:
            raise AgentError("no_device", "No YubiKey with serial %d is plugged in" % self.serial)
        raise AgentError("no_device", "No YubiKey is plugged in")

    def _device_entry(self, info: Any) -> dict:
        return {
            "serial": info.serial,
            "name": getattr(info, "form_factor", None) and str(info.form_factor) or "YubiKey",
            "version": str(info.version) if getattr(info, "version", None) else None,
        }

    def inventory(self) -> dict:
        device, info = self._device()
        certificates = []
        with device.open_connection(self._SmartCardConnection) as connection:
            session = self._PivSession(connection)
            for code in [0x9A, 0x9C, 0x9D, 0x9E, *range(0x82, 0x96)]:
                slot = self._SLOT(code)
                try:
                    cert = session.get_certificate(slot)
                except self._ApduError as error:
                    if error.sw == self._SW.FILE_NOT_FOUND:
                        continue
                    self.log("slot %02x: %s" % (code, error))
                    continue
                except Exception as error:
                    self.log("slot %02x: %s" % (code, error))
                    continue
                metadata = None
                try:
                    meta = session.get_slot_metadata(slot)
                    metadata = {"pinPolicy": meta.pin_policy.name.lower(), "touchPolicy": meta.touch_policy.name.lower()}
                except self._NotSupportedError:
                    pass
                except Exception as error:
                    self.log("slot %02x metadata: %s" % (code, error))
                entry = describe_certificate("%02x" % code, cert, metadata, self.chain)
                entry["source"] = "yubikey"
                certificates.append(entry)
        return {"devices": [self._device_entry(info)], "certificates": certificates}

    def owns(self, slot: str) -> bool:
        return slot != FILE_SLOT and slot in SLOT_NAMES

    def pin_attempts(self, slot: str) -> Optional[int]:
        device, _info = self._device()
        with device.open_connection(self._SmartCardConnection) as connection:
            try:
                return self._PivSession(connection).get_pin_attempts()
            except Exception as error:
                self.log("pin attempts: %s" % error)
                return None

    def sign(self, slot: str, key_type: str, message: bytes, pin: Optional[str]) -> bytes:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding

        device, _info = self._device()
        piv_slot = self._SLOT(int(slot, 16))
        piv_key_type = self._KEY_TYPE[key_type]
        with device.open_connection(self._SmartCardConnection) as connection:
            session = self._PivSession(connection)
            try:
                session.verify_pin(pin)
            except self._InvalidPinError as error:
                remaining = getattr(error, "attempts_remaining", None)
                if remaining == 0:
                    raise AgentError("pin_blocked", "The PIN is blocked; unblock it with the PUK (ykman piv access unblock-pin)", attemptsRemaining=0)
                raise AgentError("pin_invalid", "Wrong PIN", attemptsRemaining=remaining)
            try:
                if key_type.startswith("RSA"):
                    return session.sign(piv_slot, piv_key_type, message, hashes.SHA256(), padding.PKCS1v15())
                return session.sign(piv_slot, piv_key_type, message, hashes.SHA256())
            except self._ApduError as error:
                if error.sw == self._SW.SECURITY_CONDITION_NOT_SATISFIED:
                    raise AgentError("touch_timeout", "The YubiKey was not touched in time")
                raise AgentError("device_error", "The YubiKey refused to sign: %s" % error)


# --- a certificate file ----------------------------------------------------------------------------


class FileBackend:
    """
    A certificate the person keeps in a file on this computer: a PKCS#12 bundle
    (`.p12` / `.pfx`, key and certificates together) or a PEM private key beside a PEM
    certificate file. The certificates are read once, at startup; the key is read from the file,
    decrypted with the passphrase the dialog just asked for, used, and dropped — for every
    signature, so the process never holds it between two. An encrypted PKCS#12 keeps its
    certificate behind the passphrase too, so that one is asked once at startup to read it.
    """

    def __init__(
        self,
        p12: Optional[str] = None,
        key: Optional[str] = None,
        cert: Optional[str] = None,
        chain: Optional[list[bytes]] = None,
        prompter: Optional[Prompter] = None,
        log: Callable[[str], None] = lambda _: None,
    ) -> None:
        if bool(p12) == bool(key):
            raise ValueError("give either a PKCS#12 file (--p12) or a PEM key with its certificate (--key and --cert)")
        if key and not cert:
            raise ValueError("--key needs the certificate that goes with it (--cert)")
        self.p12_path = p12
        self.key_path = key
        self.cert_path = cert
        self.name = os.path.basename(p12 or key or "")
        self.extra_chain = chain or []
        self.log = log
        # `None` = the key opens with no passphrase at all; `b""` = with an empty one (PKCS#12
        # exports do that); `True` = a real passphrase, asked per signature.
        self._password: Any = None
        self.encrypted = False
        self._cert, self._issuers = self._read_certificates(prompter)

    # -- reading --

    def _read_certificates(self, prompter: Optional[Prompter]) -> tuple[Any, list[bytes]]:
        from cryptography import x509
        from cryptography.hazmat.primitives.serialization import load_pem_private_key

        if self.p12_path:
            data = read_file(self.p12_path)
            for password in (None, b""):
                loaded = self._open_p12(data, password)
                if loaded is not None:
                    self._password = password
                    break
            else:
                self.encrypted = True
                if prompter is None:
                    raise AgentError("pin_cancelled", "%s is protected by a passphrase and there is no way to ask for it" % self.name)
                passphrase = prompter.ask_pin("Enter the passphrase of %s to read its certificate.\nIt will be asked again for each signature." % self.name, FILE_DIALOG_TITLE)
                if not passphrase:
                    raise AgentError("pin_cancelled", "No passphrase was given for %s" % self.name)
                try:
                    loaded = self._open_p12(data, passphrase.encode("utf-8"))
                finally:
                    del passphrase
                if loaded is None:
                    raise AgentError("pin_invalid", "That is not the passphrase of %s" % self.name)
            key, cert, extra = loaded
            del key
            if cert is None:
                raise ValueError("%s holds no certificate" % self.name)
            return cert, [item.public_bytes(_der_encoding()) for item in extra]

        certificates = x509.load_pem_x509_certificates(read_file(self.cert_path or ""))
        if not certificates:
            raise ValueError("%s holds no certificate" % os.path.basename(self.cert_path or ""))
        cert, issuers = certificates[0], certificates[1:]
        key_data = read_file(self.key_path or "")
        try:
            key = load_pem_private_key(key_data, None)
        except TypeError:
            self.encrypted = True  # "Password was not given but private key is encrypted"
        else:
            try:
                if key.public_key().public_bytes(_encoding("PEM"), _spki()) != cert.public_key().public_bytes(_encoding("PEM"), _spki()):
                    raise ValueError("%s is not the key of the certificate in %s" % (self.name, os.path.basename(self.cert_path or "")))
            finally:
                del key
        return cert, [issuer.public_bytes(_der_encoding()) for issuer in issuers]

    @staticmethod
    def _open_p12(data: bytes, password: Optional[bytes]) -> Optional[tuple]:
        from cryptography.hazmat.primitives.serialization import pkcs12

        try:
            key, cert, extra = pkcs12.load_key_and_certificates(data, password)
        except ValueError:
            return None
        return key, cert, extra or []

    def _load_key(self, pin: Optional[str]) -> Any:
        from cryptography.hazmat.primitives.serialization import load_pem_private_key

        password: Optional[bytes] = pin.encode("utf-8") if self.encrypted and pin is not None else self._password
        try:
            if self.p12_path:
                loaded = self._open_p12(read_file(self.p12_path), password)
                if loaded is None:
                    raise ValueError("bad passphrase")
                key = loaded[0]
            else:
                key = load_pem_private_key(read_file(self.key_path or ""), password)
        except (ValueError, TypeError):
            raise AgentError("pin_invalid", "Wrong passphrase for %s" % self.name)
        finally:
            del password
        if key is None:
            raise AgentError("device_error", "%s holds no private key" % self.name)
        return key

    # -- the Backend protocol --

    def inventory(self) -> dict:
        policy = {"pinPolicy": "passphrase" if self.encrypted else "never", "touchPolicy": "never"}
        entry = describe_certificate(FILE_SLOT, self._cert, policy, self._issuers + self.extra_chain)
        entry["source"] = "file"
        entry["file"] = self.name
        return {"devices": [{"serial": None, "name": self.name, "version": None}], "certificates": [entry]}

    def owns(self, slot: str) -> bool:
        return slot == FILE_SLOT

    def pin_attempts(self, slot: str) -> Optional[int]:
        return None

    def sign(self, slot: str, key_type: str, message: bytes, pin: Optional[str]) -> bytes:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec, padding

        key = self._load_key(pin)
        try:
            if key_type.startswith("RSA"):
                return key.sign(message, padding.PKCS1v15(), hashes.SHA256())
            return key.sign(message, ec.ECDSA(hashes.SHA256()))
        finally:
            del key


def _encoding(name: str) -> Any:
    from cryptography.hazmat.primitives.serialization import Encoding

    return getattr(Encoding, name)


def _spki() -> Any:
    from cryptography.hazmat.primitives.serialization import PublicFormat

    return PublicFormat.SubjectPublicKeyInfo


class CompositeBackend:
    """A YubiKey and a certificate file served together; each slot belongs to one of them."""

    def __init__(self, backends: list[Any], log: Callable[[str], None] = lambda _: None) -> None:
        self.backends = backends
        self.log = log

    def inventory(self) -> dict:
        devices: list[dict] = []
        certificates: list[dict] = []
        for backend in self.backends:
            try:
                found = backend.inventory()
            except AgentError as error:
                if error.code != "no_device":
                    raise
                self.log("%s: %s" % (type(backend).__name__, error.message))  # a token unplugged does not hide the file
                continue
            devices.extend(found.get("devices", []))
            certificates.extend(found.get("certificates", []))
        return {"devices": devices, "certificates": certificates}

    def _owner(self, slot: str) -> Any:
        for backend in self.backends:
            owns = getattr(backend, "owns", None)
            if owns is not None and owns(slot):
                return backend
        for backend in self.backends:
            if not hasattr(backend, "owns"):
                try:
                    if any(entry.get("slot") == slot for entry in backend.inventory().get("certificates", [])):
                        return backend
                except AgentError:
                    continue
        raise AgentError("no_certificate", "Slot %s holds no certificate" % slot)

    def pin_attempts(self, slot: str) -> Optional[int]:
        return self._owner(slot).pin_attempts(slot)

    def sign(self, slot: str, key_type: str, message: bytes, pin: Optional[str]) -> bytes:
        return self._owner(slot).sign(slot, key_type, message, pin)


# --- the HTTP agent ------------------------------------------------------------------------------


@dataclass
class Config:
    port: int = DEFAULT_PORT
    origins: list[str] = field(default_factory=list)
    slot: str = DEFAULT_SLOT
    allow_no_origin: bool = False
    verbose: bool = False


class Agent:
    """Everything above the socket: origin policy, the routes, the one-at-a-time signing flow."""

    def __init__(self, config: Config, backend: Backend, prompter: Prompter, log: Callable[[str], None] = lambda _: None) -> None:
        self.config = config
        self.backend = backend
        self.prompter = prompter
        self.log = log
        self.signing = threading.Lock()
        self.origins = {normalize_origin(origin) for origin in config.origins}

    def origin_allowed(self, origin: Optional[str]) -> bool:
        if origin is None:
            return self.config.allow_no_origin
        return normalize_origin(origin) in self.origins

    def about(self) -> dict:
        return {"name": AGENT_NAME, "version": AGENT_VERSION}

    def health(self) -> dict:
        return {"agent": AGENT_NAME, "version": AGENT_VERSION, "slot": self.config.slot}

    def certificates(self) -> dict:
        found = self.backend.inventory()
        return {"agent": self.about(), "devices": found.get("devices", []), "certificates": found.get("certificates", [])}

    def sign(self, body: Any, origin: str) -> dict:
        if not isinstance(body, dict):
            raise AgentError("bad_request", "The body must be a JSON object")
        slot = body.get("slot") or self.config.slot
        if not isinstance(slot, str) or not slot.strip() or slot.lower() not in SLOT_NAMES:
            raise AgentError("bad_request", "slot must be a PIV slot such as \"9c\", or \"%s\" for a certificate file" % FILE_SLOT)
        slot = slot.lower()
        message = unb64(body.get("toBeSigned"), "toBeSigned")
        context = body.get("context") if isinstance(body.get("context"), dict) else {}
        entry = next((item for item in self.backend.inventory().get("certificates", []) if item["slot"] == slot), None)
        if entry is None:
            raise AgentError("no_certificate", "Slot %s holds no certificate" % slot)
        if not entry.get("usable") or not entry.get("algorithm"):
            raise AgentError("unusable_key", entry.get("unusableReason") or "The key in slot %s cannot sign a PDF" % slot)
        algorithm = body.get("algorithm")
        if algorithm is not None and algorithm != entry["algorithm"]:
            raise AgentError("algorithm_mismatch", "The certificate in slot %s signs with %s, not %s" % (slot, entry["algorithm"], algorithm))
        if not self.signing.acquire(blocking=False):
            raise AgentError("busy", "Another signature is waiting for the PIN; finish or cancel it first")
        try:
            attempts = self.backend.pin_attempts(slot)
            if attempts == 0:
                raise AgentError("pin_blocked", "The PIN is blocked; unblock it with the PUK (ykman piv access unblock-pin)", attemptsRemaining=0)
            digest_prefix = hashlib.sha256(message).hexdigest()[:12]
            text = prompt_text(origin, context, entry, digest_prefix)
            title = dialog_title(entry)
            # The dialog is the consent boundary for every signature: a PIN or passphrase when the
            # key has one, a plain Sign / Cancel when a certificate file has none.
            pin: Optional[str]
            if needs_secret(entry):
                pin = self.prompter.ask_pin(text, title)
                if not pin:
                    raise AgentError("pin_cancelled", "The PIN prompt was cancelled")
            else:
                if not self.prompter.confirm(text, title):
                    raise AgentError("pin_cancelled", "The signing prompt was cancelled")
                pin = None
            try:
                if entry.get("touchPolicy") != "never":
                    self.prompter.notify("Datum", "Touch your YubiKey if it blinks.")
                value = self.backend.sign(slot, entry["keyType"], message, pin)
            finally:
                del pin
        finally:
            self.signing.release()
        return {"slot": slot, "algorithm": entry["algorithm"], "keyType": entry["keyType"], "value": b64(value)}


def normalize_origin(origin: str) -> str:
    parts = urlsplit(origin.strip())
    if not parts.scheme or not parts.netloc:
        return origin.strip().lower().rstrip("/")
    port = parts.port
    host = parts.hostname or ""
    default = {"http": 80, "https": 443}.get(parts.scheme)
    return "%s://%s%s" % (parts.scheme.lower(), host.lower(), "" if port is None or port == default else ":%d" % port)


def parse_allowed_origin(value: str) -> str:
    """An `--allow-origin` value: a web origin, `http(s)://host[:port]`, with no path, query, fragment or credentials.

    The browser sends exactly that form in `Origin`, so anything else (an empty value, the opaque origin `null`,
    a URL with a path) could never match a real page, or would match more than the person meant.
    """
    text = value.strip()
    if text != value or not text or any(ch.isspace() for ch in text):
        raise argparse.ArgumentTypeError("%r is not an origin: give http(s)://host[:port], for example https://forms.example" % value)
    try:
        parts = urlsplit(text)
        port = parts.port
    except ValueError:
        raise argparse.ArgumentTypeError("%r is not an origin: give http(s)://host[:port], for example https://forms.example" % value) from None
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise argparse.ArgumentTypeError("%r is not an origin: give http(s)://host[:port], for example https://forms.example" % value)
    if parts.username is not None or parts.password is not None or parts.path or parts.query or parts.fragment or text.endswith(("/", "?", "#")):
        raise argparse.ArgumentTypeError("%r is not an origin: it has a path, query, fragment or credentials; give only http(s)://host[:port]" % value)
    if port == 0:
        raise argparse.ArgumentTypeError("%r is not an origin: port 0 is not a port a page is served from" % value)
    return text


def build_server(config: Config, backend: Backend, prompter: Prompter, log: Callable[[str], None] = lambda _: None) -> ThreadingHTTPServer:
    """A server on 127.0.0.1 only. `port` 0 picks a free port (tests)."""
    agent = Agent(config, backend, prompter, log)

    class Handler(BaseHTTPRequestHandler):
        server_version = "%s/%s" % (AGENT_NAME, AGENT_VERSION)
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:  # the default writes every request to stderr
            pass

        # -- plumbing --

        def _origin(self) -> Optional[str]:
            return self.headers.get("Origin")

        def _cors(self, origin: str) -> None:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            # For a browser that still sends the Private Network Access preflight; Chrome now asks
            # the person for its loopback permission instead and ignores this header.
            if self.headers.get("Access-Control-Request-Private-Network", "").lower() == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")

        def _send(self, status: int, payload: Optional[dict], origin: Optional[str]) -> None:
            data = json.dumps(payload).encode("utf-8") if payload is not None else b""
            self.send_response(status)
            self.send_header("Cache-Control", "no-store")
            if payload is not None:
                self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            if origin is not None and agent.origin_allowed(origin):
                self._cors(origin)
            self.end_headers()
            if data:
                self.wfile.write(data)

        def _guard(self) -> Optional[str]:
            """The Origin the reply may echo, or an `origin_denied` error already sent."""
            origin = self._origin()
            if not agent.origin_allowed(origin):
                raise AgentError("origin_denied", "Origin %s is not in the agent's allowlist (start it with --allow-origin %s)" % (origin or "(none)", origin or "<origin>"))
            return origin

        def _handle(self, route: Callable[[], tuple[int, Optional[dict]]]) -> None:
            started = time.monotonic()
            origin = self._origin()
            status = 500
            try:
                self._guard()
                status, payload = route()
                self._send(status, payload, origin)
            except AgentError as error:
                status = error.status
                self._send(status, error.body(), origin)
            except Exception as error:  # never let a traceback leak the request
                status = 500
                self._send(status, AgentError("device_error", "%s: %s" % (type(error).__name__, error)).body(), origin)
            finally:
                log("%s %s origin=%s -> %d (%.0f ms)" % (self.command, self.path, origin or "-", status, (time.monotonic() - started) * 1000))

        def _read_body(self) -> Any:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                raise AgentError("too_large", "The request body is over %d bytes" % MAX_BODY)
            raw = self.rfile.read(length) if length else b""
            try:
                return json.loads(raw.decode("utf-8")) if raw else None
            except Exception:
                raise AgentError("bad_request", "The body is not JSON")

        def _not_found(self, path: str) -> tuple[int, Optional[dict]]:
            raise AgentError("not_found", "No such route: %s" % path)

        # -- routes --

        def do_OPTIONS(self) -> None:
            self._handle(lambda: (204, None))

        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            if path == "/health":
                self._handle(lambda: (200, agent.health()))
            elif path == "/certificates":
                self._handle(lambda: (200, agent.certificates()))
            else:
                self._handle(lambda: self._not_found(path))

        def do_POST(self) -> None:
            path = urlsplit(self.path).path
            if path == "/sign":
                self._handle(lambda: (200, agent.sign(self._read_body(), self._origin() or "")))
            else:
                self._handle(lambda: self._not_found(path))

    server = ThreadingHTTPServer(("127.0.0.1", config.port), Handler)
    server.daemon_threads = True
    return server


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog=AGENT_NAME, description="Signs Datum PDFs with the certificate on a YubiKey's PIV applet, or with a certificate file on this computer, for a page on this computer.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="TCP port on 127.0.0.1 (default %d)" % DEFAULT_PORT)
    parser.add_argument("--allow-origin", action="append", default=None, type=parse_allowed_origin, metavar="ORIGIN", help="a web origin, http(s)://host[:port] with no path, that may use the agent; repeat for several (required, unless --dev)")
    parser.add_argument("--dev", action="store_true", help="also allow the Vite dev origins (%s), for working on a page here" % ", ".join(DEV_ORIGINS))
    parser.add_argument("--slot", default=None, help="the slot a request without one signs with (default 9c, Digital Signature; %s when a certificate file is given)" % FILE_SLOT)
    parser.add_argument("--serial", type=int, default=None, help="use the YubiKey with this serial number when several are plugged in")
    parser.add_argument("--chain", default=None, metavar="PEM", help="issuer certificates to send with the leaf (PEM file, any number)")
    parser.add_argument("--p12", default=None, metavar="FILE", help="a PKCS#12 certificate file (.p12 / .pfx) on this computer to sign with, beside or instead of a YubiKey")
    parser.add_argument("--key", default=None, metavar="PEM", help="a PEM private key on this computer to sign with (with --cert)")
    parser.add_argument("--cert", default=None, metavar="PEM", help="the PEM certificate of --key, the leaf first and any issuers after it")
    parser.add_argument("--allow-no-origin", action="store_true", help="answer requests without an Origin header too (curl, scripts)")
    parser.add_argument("--terminal-pin", action="store_true", help="ask for the PIN or passphrase in this terminal instead of a native dialog")
    parser.add_argument("--verbose", "-v", action="store_true", help="log every request to stderr (never the PIN, the passphrase or the bytes)")
    args = parser.parse_args(argv)

    def log(line: str) -> None:
        if args.verbose:
            print("[%s] %s" % (AGENT_NAME, line), file=sys.stderr, flush=True)

    if args.p12 and args.key:
        parser.error("--p12 and --key are two ways to give one certificate file; use one of them")
    if bool(args.key) != bool(args.cert):
        parser.error("--key and --cert go together")
    if not args.allow_origin and not args.dev:
        parser.error("name the page that may use the agent with --allow-origin ORIGIN (repeat it for several), or use --dev for the Vite dev origins")
    has_file = bool(args.p12 or args.key)
    slot = (args.slot or (FILE_SLOT if has_file else DEFAULT_SLOT)).lower()
    config = Config(port=args.port, origins=[*(args.allow_origin or []), *(DEV_ORIGINS if args.dev else [])], slot=slot, allow_no_origin=args.allow_no_origin, verbose=args.verbose)
    if config.slot not in SLOT_NAMES:
        parser.error("--slot must be a PIV slot such as 9c, or %s" % FILE_SLOT)
    prompter = NativePrompter(terminal_only=args.terminal_pin, log=log)
    chain = load_chain(args.chain)
    backends: list[Any] = []
    try:
        backends.append(YubiKeyBackend(serial=args.serial, chain=chain, log=log))
    except ImportError as error:
        if not has_file:
            print("%s: %s\nInstall Yubico's package first: pip install yubikey-manager" % (AGENT_NAME, error), file=sys.stderr)
            return 2
        log("no YubiKey support (%s); serving the certificate file only" % error)
    if has_file:
        try:
            backends.append(FileBackend(p12=args.p12, key=args.key, cert=args.cert, chain=chain, prompter=prompter, log=log))
        except ImportError as error:
            print("%s: %s\nInstall PyCA cryptography first: pip install cryptography" % (AGENT_NAME, error), file=sys.stderr)
            return 2
        except (AgentError, ValueError, OSError) as error:
            print("%s: %s" % (AGENT_NAME, getattr(error, "message", None) or error), file=sys.stderr)
            return 2
    backend: Backend = backends[0] if len(backends) == 1 else CompositeBackend(backends, log)
    server = build_server(config, backend, prompter, log)
    served = ", ".join(["YubiKey PIV"] * (1 if isinstance(backends[0], YubiKeyBackend) else 0) + ["file %s" % os.path.basename(args.p12 or args.key)] * (1 if has_file else 0))
    print("%s %s listening on http://127.0.0.1:%d for %s (%s; default slot %s)" % (AGENT_NAME, AGENT_VERSION, server.server_address[1], ", ".join(config.origins), served, config.slot), file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
