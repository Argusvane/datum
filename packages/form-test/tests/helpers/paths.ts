import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The checkout root (packages/form-test/tests/helpers -> four levels up). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const PACKAGE_ROOT = resolve(REPO_ROOT, "packages", "form-test");
export const FIXTURES = join(PACKAGE_ROOT, "fixtures");

export const fixture = (name: string): string => join(FIXTURES, name);
