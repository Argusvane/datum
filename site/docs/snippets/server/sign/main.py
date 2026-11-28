# main.py — the endpoint the page delivers to: the submission validated, rendered as a PDF, and signed.
#   pip install fastapi uvicorn wasmtime cryptography
#   curl -LO https://github.com/quickjs-ng/quickjs/releases/download/v0.16.2/qjs-wasi.wasm
#   the signing key, a self-signed certificate to try with (production uses the organisation's):
#   mkdir -p keys
#   openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 -subj "/CN=Intake service/O=Datum" \
#       -keyout keys/signer.key.pem -out keys/signer.cert.pem
#   uvicorn main:app
#
# The PDF is signed the way ISO 32000 and PAdES ask — a signature field, /ByteRange, a CMS
# SignedData — by datum-pdf-program.js, the kernel behind the browser's PDF button, in a QuickJS of
# this process's own. The kernel never sees the key: it prepares the bytes to sign, this process
# signs them with its platform crypto, the kernel embeds the value. Any viewer validates the
# result; the verify endpoint below is how this server tells its own sealed records apart.
import base64
import hashlib
import json
import math
import shutil
import tempfile
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from wasmtime import Config, Engine, ExitTrap, Linker, Module, Store, Trap, WasiConfig

FORM = json.loads(Path("forms/customer-intake.json").read_text())


# The journey the answers were given through, from this server's own copy of the form: the
# envelope names it (submission.journey.id) and nothing more. Handed to the sandbox, it has the
# kernel work the path out again from the values, as the browser did: an answer on a page the
# path skipped is judged hidden, and a form field one of the journey's own fields fills or works
# out counts as asked on that page. None named, or one the form does not have: null, and the
# answers are judged as the whole form, which asks for every required field.
def journey_of(submission: dict):
    named = (submission.get("journey") or {}).get("id")
    return next((j for j in FORM.get("journey", {}).get("journeys", []) if j["id"] == named), None)


# The engine: qjs-wasi.wasm, QuickJS-ng's own WebAssembly build from its release page, compiled
# once and shared. Every request runs it afresh in a store of its own, so requests need no lock.
config = Config()
config.epoch_interruption = True  # the time budget: a run past its deadline traps
engine = Engine(config)
# The file is checked before it is compiled: only the release this server names may run.
QJS_SHA256 = "d2939e98c808e8b9f4164cd0d7b0398cbc0121ddf52862bcd92157d923e461cc"  # v0.16.2
wasm = Path("qjs-wasi.wasm").read_bytes()
if hashlib.sha256(wasm).hexdigest() != QJS_SHA256:
    raise SystemExit("qjs-wasi.wasm is not the release this server names")
QJS = Module(engine, wasm)
linker = Linker(engine)
linker.define_wasi()

# What a run can reach: one directory holding the two programs, and nothing else — not this
# directory, not the disk. Made as the server starts, removed as it stops.
APP = tempfile.TemporaryDirectory(prefix="datum-")
for name in ("datum-sandbox-program.js", "datum-pdf-program.js"):
    shutil.copy(name, APP.name)

# The clock every budget is kept by, one for all the runs at once: a tick every 50 ms; a run's
# deadline is its budget in ticks, plus one for the tick already under way when it started. The
# epoch it advances is the engine's, shared by every store on it, so no run may bump it for
# itself: a timer of the run's own, fired when its budget was spent, would advance the epoch under
# every other run in flight too, and cut short one that had set its deadline a tick earlier — a
# wrong verdict for a submission that was never judged. One clock, and no run can touch another.
TICK = 0.05


def clock() -> None:
    while True:
        time.sleep(TICK)
        engine.increment_epoch()


threading.Thread(target=clock, daemon=True).start()


class SandboxError(Exception):
    """A run that ended without an outcome: a limit cut it off, or a program or rule module would not load."""


def qjs(argv: list, request: str, seconds: float, memory: int) -> str:
    # One run: the programs' directory mounted read-only as /app, the request on stdin, the
    # answer on stdout — all the run can reach; wasmtime hands it nothing else. The limits are
    # wasmtime's, at the browser's profile: the budget in seconds, the memory in bytes. Runaway
    # recursion exhausts the instance's own stack and traps, which ends the run too.
    out, err = [], []
    with tempfile.NamedTemporaryFile("w", suffix=".json") as stdin:
        stdin.write(request)
        stdin.flush()
        store = Store(engine)
        store.set_limits(memory_size=memory)
        store.set_epoch_deadline(math.ceil(seconds / TICK) + 1)
        wasi = WasiConfig()
        wasi.argv = ["qjs", "--std", *argv]  # --std: the std module, which reads stdin
        wasi.preopen_dir(APP.name, "/app", fs_mutable=False)
        wasi.stdin_file = stdin.name
        wasi.stdout_custom = out.append
        wasi.stderr_custom = err.append
        store.set_wasi(wasi)
        try:
            linker.instantiate(store, QJS).exports(store)["_start"](store)
        except ExitTrap as exit:  # a throw: qjs printed it to stderr and exited 1
            if exit.code != 0:
                raise SandboxError(b"".join(err).decode().strip()) from exit
        except Trap as trap:  # "interrupt": the budget; "stack_overflow": the recursion
            raise SandboxError(f"{trap.trap_code}") from trap
    return b"".join(out).decode().rstrip("\n")


# Validation first, so the PDF prints the sanitized values: what the form defines, nothing else.
VALIDATE = ["-I", "/app/datum-sandbox-program.js", "-e", "print(__datum_run(std.in.readAsString()));"]

# The PDF program, under the document profile; __datum_pdf's promise settles before qjs exits.
RENDER = ["-I", "/app/datum-pdf-program.js", "-e", "__datum_pdf(std.in.readAsString()).then((json) => print(json));"]


# The fonts to embed: the signature's appearance is drawn with the first of them.
def font(id, family, weight, file):
    data = base64.b64encode(Path("fonts", file).read_bytes()).decode("ascii")
    return {"id": id, "family": family, "weight": weight, "style": "normal", "data": data}


FONTS = [font("dejavu-sans", "sans-serif", 400, "DejaVuSans.ttf"), font("dejavu-sans-bold", "sans-serif", 700, "DejaVuSans-Bold.ttf")]

# What the Country select shows, resolved here: the program never fetches a data source.
COUNTRIES = [{"value": "CA", "label": "Canada"}, {"value": "US", "label": "United States"}, {"value": "MX", "label": "Mexico"}]

# The server's key and certificate chain. The key stays in this process; the chain rides with the
# request (DER, base64, the signer's certificate first) and ends up in the PDF for any viewer to check.
KEY = serialization.load_pem_private_key(Path("keys/signer.key.pem").read_bytes(), password=None)
CHAIN = x509.load_pem_x509_certificates(Path("keys/signer.cert.pem").read_bytes())
CERTIFICATES = [base64.b64encode(cert.public_bytes(serialization.Encoding.DER)).decode("ascii") for cert in CHAIN]

# The layout says how the record is sealed — which signature block, certified or not, the reason —
# and the request may override any of it. None keeps the layout's say (certify, no changes).
CERTIFY = None

# A timestamp authority (RFC 3161), for a signature that proves when it was made by a third party's
# clock (PAdES-B-T). Empty: none. With a URL, the kernel builds the request, this process posts it,
# and the token goes into the signature; give the layout "timestamp": true so the placeholder has room.
TSA_URL = ""

app = FastAPI()


# The one cryptographic step this server keeps for itself: the DER attributes the kernel prepared,
# signed with the key. An HSM or a cloud KMS signs the same bytes (or "toBeSignedDigest", their SHA-256).
def sign_bytes(data: bytes) -> bytes:
    if isinstance(KEY, ec.EllipticCurvePrivateKey):
        return KEY.sign(data, ec.ECDSA(hashes.SHA256()))
    return KEY.sign(data, padding.PKCS1v15(), hashes.SHA256())


def verify_bytes(public_key_der: bytes, data: bytes, signature: bytes) -> bool:
    key = serialization.load_der_public_key(public_key_der)
    try:
        if isinstance(key, ec.EllipticCurvePublicKey):
            key.verify(signature, data, ec.ECDSA(hashes.SHA256()))
        else:
            key.verify(signature, data, padding.PKCS1v15(), hashes.SHA256())
        return True
    except InvalidSignature:
        return False


@app.post("/api/submissions/sign")
def submit(envelope: dict):
    submission = envelope["submission"]
    locale = submission.get("locale", "en")
    # The journey, if the answers came through one: the path is worked out again from the values (see journey_of).
    context = {"formId": FORM["id"], "form": FORM["root"], "values": submission["values"], "locale": locale, "journey": journey_of(submission), "optionSnapshot": {"countries": COUNTRIES}}
    outcome = json.loads(qjs(VALIDATE, json.dumps(context), 0.25, 32 * 1024 * 1024))
    if outcome["errors"]:  # 422 with codes and fields, never text; the page's messages word them
        errors = [{"field": e.get("componentId"), "code": e["code"]} for e in outcome["errors"]]
        return JSONResponse(status_code=422, content={"errors": errors})
    # The record, rendered and prepared for signing in one call: the layout's signature settings
    # plus these certificates. The answer's "bytes" carry the placeholder; "signing" says what to sign.
    signature = {"certificates": CERTIFICATES}
    if CERTIFY is not None:
        signature["certify"] = CERTIFY
    prepared = render({
        "abi": "1.0.0",
        "op": "document",
        "form": FORM["root"],
        "pdf": FORM["pdf"],  # the sealed layout, as designed in the builder's PDF mode
        "values": outcome["values"],
        "locale": locale,
        "optionSnapshot": {"country": COUNTRIES},
        "fonts": FONTS,
        "signature": signature,
        # The only time and identity the program ever sees; the signature's /M is this instant.
        "env": {"createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"), "documentId": str(uuid.uuid4())},
    })
    if not prepared["ok"]:  # {"code": "signature" | "font" | "layout" | "internal", "message": ...}
        return JSONResponse(status_code=500, content={"error": prepared["error"]})
    handoff = prepared["signing"]
    value = sign_bytes(base64.b64decode(handoff["toBeSigned"]))
    signing = {"certificates": CERTIFICATES, "value": base64.b64encode(value).decode("ascii"), "toBeSignedDigest": handoff["toBeSignedDigest"]}
    if TSA_URL:
        signing["timestamp"] = {"token": timestamp(value)}
    completed = render({"abi": "1.0.0", "op": "complete", "pdf": {"data": prepared["bytes"]}, "signing": signing})
    if not completed["ok"]:
        return JSONResponse(status_code=500, content={"error": completed["error"]})
    return Response(
        content=base64.b64decode(completed["bytes"]),
        media_type="application/pdf",
        headers={
            "Content-Disposition": 'attachment; filename="customer-intake-signed.pdf"',
            "X-Page-Count": str(prepared["pageCount"]),
            "X-Signed-By": CHAIN[0].subject.rfc4514_string(),
            "X-Signature-Field": completed["field"],
            "X-Timestamped": "true" if completed["timestamped"] else "false",
        },
    )


# A signed PDF back for a verdict: which signatures it carries, whether each still matches the
# bytes, whether the value checks out under the signer's key, and whether the signer is this server.
@app.post("/api/submissions/verify")
async def verify(request: Request):
    pdf = base64.b64encode(await request.body()).decode("ascii")
    report = render({"abi": "1.0.0", "op": "verify", "pdf": {"data": pdf}})
    if not report["ok"]:
        return JSONResponse(status_code=400, content={"error": report["error"]})
    verdicts = []
    for sig in report["signatures"]:
        signer = sig["signer"]
        valid = bool(signer) and verify_bytes(base64.b64decode(signer["publicKey"]), base64.b64decode(sig["toBeVerified"]), base64.b64decode(sig["signature"]))
        verdicts.append({
            "field": sig["field"],
            "signer": signer["subject"] if signer else None,
            "signingTime": sig["signingTime"],
            "digestMatches": sig["digestMatches"],  # the file still hashes to what was signed
            "certificateMatches": sig["certificateMatches"],  # the signed attributes name this certificate
            "signatureValid": valid,  # the value checks out under the signer's public key
            "coversDocument": sig["coversDocument"],  # nothing was appended after this signature
            "trusted": bool(signer) and signer["certificate"] == CERTIFICATES[0],  # the signer is this server
            "certification": sig["certification"],
            "timestamp": sig.get("timestamp"),
        })
    # The files the signature sealed, by digest: what a record's JSON must hash to.
    return {"signatures": verdicts, "attachments": report["attachments"]}


def timestamp(value: bytes) -> str:
    tsq = render({"abi": "1.0.0", "op": "timestampRequest", "signature": base64.b64encode(value).decode("ascii")})["request"]
    request = urllib.request.Request(TSA_URL, data=base64.b64decode(tsq), headers={"Content-Type": "application/timestamp-query"})
    with urllib.request.urlopen(request, timeout=10) as response:
        return base64.b64encode(response.read()).decode("ascii")


def render(request: dict) -> dict:
    return json.loads(qjs(RENDER, json.dumps(request), 15, 256 * 1024 * 1024))
