/**
 * What a host under test serves and how it was configured (the Java kit's Capability enum). Each
 * capability runs as its own group in this fixed order (HostTck's RUNS map): the flood capability
 * spends the address's request budget, so it is last whatever order `--capabilities` names them in.
 */
export const CAPABILITY_ORDER = [
  "submissions",
  "submissions-test",
  "forms",
  "assets",
  "builder",
  "pdf",
  "tsa",
  "passkeys",
  "hardening",
  "runtime-down",
  "host-context",
  "flood"
] as const;

export type Capability = (typeof CAPABILITY_ORDER)[number];

/** One line per capability: what it holds the host to and the switches the host needs for it. */
export const CAPABILITY_NOTES: Readonly<Record<Capability, { holds: string; needs: string }>> = {
  submissions: {
    holds: "story one over the fixture form: the golden control documents, the journey check, the refusals before the kernel (409, 415, 413, 400, 404), the submission key (a retry answered with the first receipt, another attempt another record, a known key with another document 409)",
    needs: "the fixture form installed (datum-host-check fixtures); at least 20 submissions a minute from one address. It writes records: run it against a test deployment"
  },
  "submissions-test": {
    holds: "POST /submissions/test reports the golden values",
    needs: "the dry-run route switched on (Spring Boot: datum.web.api.endpoints.test=true)"
  },
  forms: {
    holds: "the public copy of the fixture form under its key and the catalog key id@version, its ETag and the 304, 404 form.notFound",
    needs: "the fixture form installed"
  },
  assets: {
    holds: "host.json, the immutable bundles under the build id, the glue, the builder's files following the builder switch, no path out of the assets",
    needs: "--builder-enabled when the host serves the builder"
  },
  builder: {
    holds: "only someone who may build saves, If-Match and 409, the kernel's 422s, id rules, 409 form.exists",
    needs: "--build-form <key> and --person-header / --other-person-header for an author and a viewer (--csrf when the host checks a cookie token)"
  },
  pdf: {
    holds: "posted answers print, refused answers do not, sign, the server's chain, verify, 404 layout.notFound, 415, 400 pdf.notAPdf; two routes on one host get each route's catalog PDF theme (X-Datum-Pdf-Theme, and drawn into the PDF)",
    needs: "the fixture form installed; --pdf-signing when the host holds a signing key (else the seal cases are skipped); --pdf-bindings when the host routes the fixture form's copy (datum-security-suite-b) to a binding whose PDF theme is the kit's datum-host-check-pdf (fixture-pdf-theme.json) and the fixture form to another (else PDF-06 is skipped)"
  },
  tsa: {
    holds: "a granted RFC 3161 token over the digest and nonce, a rejection for unreadable bytes, 403 for a session cookie then 415, the certificates in PEM and DER",
    needs: "the timestamp server switched on (--tsa-path when it is not /tsa)"
  },
  passkeys: {
    holds: "the signing block, who may ask for a challenge, the challenge's shape, the register refusals in order, a person's list, 404 for another person's passkey",
    needs: "--signing-form <key> and --person-header / --other-person-header for two signed-in people (--csrf when the host checks a cookie token)"
  },
  hardening: {
    holds: "with the kit's hostile rule module registered for the fixture form: a looping validator is cut, memory without bound and a 40 MiB answer are refused, stray bytes after the answer frame refuse the run; a run that gave no verdict is a 503 with its code (wasm.execution_error, outcome_too_large) and no Retry-After, on a delivery and on a journey check, never a 422 or a 200; only validator.failed is a 422",
    needs: "a TEST deployment that registers hardening-rules.js (datum-host-check fixtures) for the fixture form"
  },
  "runtime-down": {
    holds: "a runtime that could not prove its program answers 503 to every submission and to a journey check (no accepted member)",
    needs: "a TEST deployment started with the stale program (stale-program.js) as its sandbox program and fail-fast off"
  },
  "host-context": {
    holds: "the host judges host. rules with a context it works out itself, never one the client writes: with X-Datum-Test-Role: admin the check (journey and page scope) and the delivery refuse a missing admin_note; user accepts; no header (no context) accepts and the dry run lists admin_note in visibilitySkipped; a document that forges the context is read as the user's and stores no forged answer",
    needs: "a TEST deployment that serves fixture-host-context-form.json (datum-host-check fixtures; form datum-host-context), has the dry-run route on, and wires a TEST-ONLY host context provider answering {role: <X-Datum-Test-Role>} for that form only. Never wire it where real submissions are taken"
  },
  flood: {
    holds: "429 flood with Retry-After, from the per-form limit and from the address limit (which counts a body that does not parse); always last because it spends the request budget",
    needs: "a low per-form limit (the kit posts at most 120 times) and an address limit above a whole kit run's other traffic and below 400 (Spring Boot: datum.web.throttle.limit=30, datum.web.throttle.address-limit=200; FastAPI: DATUM_WEB__THROTTLE__LIMIT=30, DATUM_WEB__THROTTLE__ADDRESS_LIMIT=200)"
  }
};

export class UnknownCapability extends Error {
  constructor(public readonly key: string) {
    super(`"${key}" is not a capability (${CAPABILITY_ORDER.join(", ")})`);
    this.name = "UnknownCapability";
  }
}

/** The capability named `key`, in either spelling (`submissions-test` or `SUBMISSIONS_TEST`), as Capability.of reads it. */
export function capabilityOf(key: string): Capability {
  const normalized = key.trim().toLowerCase().replace(/_/g, "-");
  const found = CAPABILITY_ORDER.find((capability) => capability === normalized);
  if (found === undefined) throw new UnknownCapability(key.trim());
  return found;
}

/** A comma-separated list as a set in the fixed order (blank entries ignored, as HostTck does). */
export function capabilitiesOf(list: string): Capability[] {
  const named = new Set<Capability>();
  for (const key of list.split(",")) {
    if (key.trim() !== "") named.add(capabilityOf(key));
  }
  return CAPABILITY_ORDER.filter((capability) => named.has(capability));
}
