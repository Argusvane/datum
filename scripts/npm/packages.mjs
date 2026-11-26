// The packages a release publishes to npm, in the order they are published: the three scoped packages
// first, then the four forwarding packages that depend on them (a forwarder's install resolves its scoped package from
// the registry, so that package must be there already). The engine, the PDF kernel, the QuickJS host and the
// submissions server are not here: they stay private, and the published bundles carry their code.
//
// scripts/npm/release.mjs, the release workflow and the packages' pack tests read this one list.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The `repository.url` every published package carries. Publishing with provenance compares it with the repository the
 * workflow ran in, case-sensitively, and GitHub names this one `Argusvane/datum`: a package with `argusvane/datum`
 * is refused by the registry.
 */
export const REPOSITORY_URL = "git+https://github.com/Argusvane/datum.git";

/** `{ folder (relative to the repository), scoped: true for @argusvane/..., forwards: the scoped package a forwarder runs }`. */
export const PUBLISHED = [
  { folder: "packages/datum", name: "@argusvane/datum" },
  { folder: "packages/conformance-suite", name: "@argusvane/datum-conformance-suite" },
  { folder: "packages/form-test", name: "@argusvane/datum-form-test" },
  { folder: "packages/cli-forwarders/datum-form-test", name: "datum-form-test", forwards: "@argusvane/datum-form-test" },
  { folder: "packages/cli-forwarders/datum-host-check", name: "datum-host-check", forwards: "@argusvane/datum-conformance-suite" },
  { folder: "packages/cli-forwarders/datum-security-check", name: "datum-security-check", forwards: "@argusvane/datum-conformance-suite" },
  { folder: "packages/cli-forwarders/datum-binding-check", name: "datum-binding-check", forwards: "@argusvane/datum-conformance-suite" }
];
