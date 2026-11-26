# Timestamp server example

A FastAPI application that is an RFC 3161 timestamp authority: `POST /tsa` answers a timestamp query with a token, and
`GET /tsa/certificate` serves the certificate a client verifies against. The settings come from the environment, in the
block below: the self-signed certificate is generated at start, and `DATUM_TSA__ALLOW_MEMORY_STORES=true` acknowledges that
serials and the issue log are kept in memory, per process. A restart forgets them, and each
worker of a multi-worker server counts its own serials. The self-signed certificate is for development only: a production
server loads its own PKCS#12 or PEM key, under its own policy OID (`1.2.3.4.5` here is a placeholder). The example
holds no secret. Install the workspace first (see
[the workspace README](../../README.md)): `npm run fastapi:assets` from the repository root, then
`uv sync --all-packages --all-extras --frozen` in `integrations/fastapi`.

```sh
export DATUM_TSA__ENABLED=true
export DATUM_TSA__POLICY=1.2.3.4.5
export DATUM_TSA__ACCESS=open
export DATUM_TSA__SIGNER__SELF_SIGNED=true
export DATUM_TSA__ALLOW_MEMORY_STORES=true
uv run --frozen --package datum-example-tsa-server uvicorn app:app --port 8000
```

Timestamp a file (`f` is any file; `-sha256` hashes it, and the nonce is on by default), send the query, then verify the
reply against the served certificate. `openssl ts -verify` takes one of `-queryfile` or `-data`, so the check runs twice:

```sh
openssl ts -query -data f -sha256 -cert > q.tsq
curl -s -H 'Content-Type: application/timestamp-query' --data-binary @q.tsq http://localhost:8000/tsa -o r.tsr
openssl ts -verify -in r.tsr -queryfile q.tsq -CAfile <(curl -s http://localhost:8000/tsa/certificate)
openssl ts -verify -in r.tsr -data f -CAfile <(curl -s http://localhost:8000/tsa/certificate)
```

Each verify prints `Verification: OK`: the first checks the token against the query (the imprint and the nonce), the second
checks it against the file itself.
