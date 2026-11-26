# Signing fixtures

Demo keys and certificates for the signature tests: throwaway material with
no trust anywhere, minted by `scripts/make-signing-fixtures.mjs` with openssl. Never use
them outside the tests.

| file | what |
|---|---|
| `rsa2048.*` | RSA-2048 self-signed signer (the samples' shape) |
| `p256.*`, `p384.*` | EC signers on P-256 and P-384 |
| `demo-ca.*`, `chain-leaf.*` | a two-level chain: the leaf's issuer is the CA |
| `expired.cert.pem` | the RSA key under a certificate that expired in 2021 |
| `tsa.*`, `tsa.cnf` | a timestamp authority for `openssl ts -reply` (the tests copy these to a scratch directory) |
