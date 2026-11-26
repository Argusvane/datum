#!/usr/bin/env node
/**
 * Mints the demo keys and certificates the signature tests use. They are
 * committed under `tests/fixtures/signing/`; CI never runs this. openssl does the work
 * because Node's `crypto` can generate keys but cannot issue a certificate.
 *
 *   node scripts/make-signing-fixtures.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "tests", "fixtures", "signing");
mkdirSync(out, { recursive: true });

// A fixed validity window keeps the tests' clock (`ENV.createdAt`) inside it whenever the fixtures are minted.
const VALIDITY = ["-not_before", "20260101000000Z", "-not_after", "21260101000000Z"];

const SIGNER = ["basicConstraints=CA:FALSE", "keyUsage=critical,digitalSignature,nonRepudiation", "subjectKeyIdentifier=hash"];
const CA = ["basicConstraints=critical,CA:TRUE", "keyUsage=critical,keyCertSign,cRLSign", "subjectKeyIdentifier=hash"];
const TSA = ["basicConstraints=CA:FALSE", "keyUsage=critical,digitalSignature", "extendedKeyUsage=critical,timeStamping", "subjectKeyIdentifier=hash"];

function openssl(args) {
  execFileSync("openssl", args, { cwd: out, stdio: ["ignore", "inherit", "inherit"] });
}

/** A `req` config whose `[v3]` section carries the extensions. */
function config(extensions) {
  const file = join(out, "req.cnf");
  writeFileSync(file, ["[req]", "distinguished_name=dn", "x509_extensions=v3", "[dn]", "[v3]", ...extensions, ""].join("\n"));
  return file;
}

function extfile(extensions) {
  const file = join(out, "cert.ext");
  writeFileSync(file, extensions.join("\n") + "\n");
  return file;
}

function key(name, algorithm, option) {
  openssl(["genpkey", "-algorithm", algorithm, "-pkeyopt", option, "-out", `${name}.key.pem`]);
}

function selfSigned(name, subject, extensions, extra = []) {
  openssl(["req", "-x509", "-new", "-key", `${name}.key.pem`, "-sha256", "-subj", subject, ...VALIDITY, "-config", config(extensions), "-extensions", "v3", "-out", `${name}.cert.pem`, ...extra]);
}

// RSA 2048, the samples' shape.
key("rsa2048", "RSA", "rsa_keygen_bits:2048");
selfSigned("rsa2048", "/CN=Datum demo signer/O=Datum/C=CA", SIGNER);
// EC P-256 and P-384.
key("p256", "EC", "ec_paramgen_curve:P-256");
selfSigned("p256", "/CN=Datum demo signer P-256/O=Datum/C=CA", SIGNER);
key("p384", "EC", "ec_paramgen_curve:P-384");
selfSigned("p384", "/CN=Datum demo signer P-384/O=Datum/C=CA", SIGNER);
// A two-level chain: a demo CA and a leaf it issued.
key("demo-ca", "RSA", "rsa_keygen_bits:2048");
selfSigned("demo-ca", "/CN=Datum demo CA/O=Datum/C=CA", CA);
key("chain-leaf", "RSA", "rsa_keygen_bits:2048");
openssl(["req", "-new", "-key", "chain-leaf.key.pem", "-sha256", "-subj", "/CN=Datum forms office/O=Datum/C=CA", "-config", config(SIGNER), "-out", "chain-leaf.csr.pem"]);
openssl(["x509", "-req", "-in", "chain-leaf.csr.pem", "-CA", "demo-ca.cert.pem", "-CAkey", "demo-ca.key.pem", "-CAcreateserial", "-sha256", ...VALIDITY, "-extfile", extfile(SIGNER), "-out", "chain-leaf.cert.pem"]);
// An expired certificate on the RSA key, for the hygiene warning.
openssl(["req", "-x509", "-new", "-key", "rsa2048.key.pem", "-sha256", "-subj", "/CN=Datum expired signer/O=Datum/C=CA", "-not_before", "20200101000000Z", "-not_after", "20210101000000Z", "-config", config(SIGNER), "-extensions", "v3", "-out", "expired.cert.pem"]);
// A timestamp authority, so the tests can mint RFC 3161 tokens with `openssl ts -reply`.
key("tsa", "RSA", "rsa_keygen_bits:2048");
selfSigned("tsa", "/CN=Datum demo TSA/O=Datum/C=CA", TSA);
writeFileSync(
  join(out, "tsa.cnf"),
  [
    "[ tsa ]",
    "default_tsa = tsa_config",
    "[ tsa_config ]",
    "dir = .",
    "serial = $dir/tsa.serial",
    "signer_cert = $dir/tsa.cert.pem",
    "signer_key = $dir/tsa.key.pem",
    "signer_digest = sha256",
    "default_policy = 1.3.6.1.4.1.99999.1",
    "digests = sha256, sha384, sha512",
    "accuracy = secs:1",
    "ordering = no",
    "tsa_name = yes",
    "ess_cert_id_chain = no",
    "ess_cert_id_alg = sha256",
    ""
  ].join("\n")
);
writeFileSync(
  join(out, "README.md"),
  [
    "# Signing fixtures",
    "",
    "Demo keys and certificates for the signature tests: throwaway material with",
    "no trust anywhere, minted by `scripts/make-signing-fixtures.mjs` with openssl. Never use",
    "them outside the tests.",
    "",
    "| file | what |",
    "|---|---|",
    "| `rsa2048.*` | RSA-2048 self-signed signer (the samples' shape) |",
    "| `p256.*`, `p384.*` | EC signers on P-256 and P-384 |",
    "| `demo-ca.*`, `chain-leaf.*` | a two-level chain: the leaf's issuer is the CA |",
    "| `expired.cert.pem` | the RSA key under a certificate that expired in 2021 |",
    "| `tsa.*`, `tsa.cnf` | a timestamp authority for `openssl ts -reply` (the tests copy these to a scratch directory) |",
    ""
  ].join("\n")
);
for (const scratch of ["req.cnf", "cert.ext", "chain-leaf.csr.pem", "demo-ca.cert.srl"]) {
  rmSync(join(out, scratch), { force: true });
}
console.log(`signing fixtures written to ${out}`);
