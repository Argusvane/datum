import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startReferenceServer, type ReferenceServer } from "./helpers/reference-submissions-server.js";

/**
 * The reference server reads a body with `parseStrictJson`, as a Node host does: a body whose
 * object names a key twice is answered as malformed JSON is, before the service sees it.
 */

let server: ReferenceServer;
beforeAll(async () => {
  server = await startReferenceServer();
});
afterAll(async () => {
  await server.close();
});

async function post(path: string, body: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${server.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
  return { status: response.status, body: (await response.json()) as unknown };
}

describe("a body with a repeated key", () => {
  it.each(["/api/submissions", "/api/submissions/validate"])("is refused on %s with the answer malformed JSON gets", async (path) => {
    const malformed = await post(path, "{");
    expect(malformed).toEqual({ status: 400, body: { errors: [{ code: "bad_document" }] } });
    expect(await post(path, '{"document":{"submission":{"locale":"en","values":{}}},"scope":"journey","scope":"page"}')).toEqual(malformed);
    expect(await post(path, '{"submissionKey":"k-1","submissionKey":"k-2","document":{}}')).toEqual(malformed);
  });
});
