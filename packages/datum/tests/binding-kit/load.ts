// The kit is plain ESM (.mjs) without declarations; tests load it by URL, untyped on purpose.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const KIT = join(here, "..", "..", "binding-kit");
export const REPO = join(here, "..", "..", "..", "..");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const load = (path: string): Promise<any> => import(/* @vite-ignore */ `file://${path}`);
