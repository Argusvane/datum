# Security policy

## Supported versions

Security fixes go to two places: the latest 0.x release and the `main` branch. A fix lands on `main` first and ships
in a new 0.x release; an older release does not get a patch, so the fix is to move to the latest one. Datum is
pre-release, and [Release status](https://datum.argusvane.com/docs/introduction#release-status) says what is
published today. Advisories are public, for everyone, once a fix is out.

What the sandbox protects, who is trusted with what, and what a deployment must do itself are on the
[threat model](https://datum.argusvane.com/docs/threat-model) page (`site/docs/threat-model.md`).

## Reporting a vulnerability

Report privately. Use GitHub private vulnerability reporting when the repository offers it:
https://github.com/argusvane/datum/security/advisories/new

If that page is not available, or you prefer email, write to security@argusvane.com. Either route reaches the maintainers
and stays private.

Do not open a public issue or pull request for a vulnerability.

Please include:

- the affected component and version or commit;
- what you can do that you should not be able to, and the impact;
- steps to reproduce, ideally a minimal form definition, request or program;
- the host (Spring Boot, FastAPI, browser only) and the runtime versions involved;
- any fix or mitigation you have in mind.

## What to expect

We acknowledge a report within 7 days. After that we confirm or dispute the finding, agree a disclosure date with you,
and credit you in the advisory if you want that. Fix times vary with severity.

## Scope

These areas are the most sensitive, and reports about them are especially welcome:

- the sandboxed validation runtime (QuickJS compiled to WASM): escapes, limit bypasses, nondeterminism that changes a
  verdict, and the program and ABI gates that guard it;
- PDF generation, signing and timestamping (PAdES, DocMDP, RFC 3161 tokens, the PIV agent);
- WebAuthn-signed submissions (challenge handling, signature verification, replay);
- the three hosts: the Spring Boot host, the FastAPI host and the browser-only form, including the request-body caps,
  the validating endpoints and the stores.

## Not a finding

Throwaway private keys are committed on purpose in two test fixture folders. They are documented test material and protect nothing:

- `packages/pdf-kernel/tests/fixtures/signing/`
- `integrations/jvm/libs/datum-timestamp-test-support/src/main/resources/fixtures/`

Reports that these keys are public will be closed.
