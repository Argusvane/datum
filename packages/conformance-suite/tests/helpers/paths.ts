import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The checkout root (packages/conformance-suite/tests/helpers -> four levels up). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const PACKAGE_ROOT = resolve(REPO_ROOT, "packages", "conformance-suite");
