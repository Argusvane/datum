import { describe, expect, it } from "vitest";

import { DuplicateJsonKeyError, InMemorySubmissionStore, createKernelValidator, createSubmissionService, errorResponse, parseStrictJson, parseSubmissionDocument } from "../src/index.js";

/**
 * A body whose object names a key twice is malformed JSON: refused as any other malformed JSON
 * is, before anything reads it, rather than keeping the last value.
 */

const ENVELOPE = {
  versionContext: { form: { id: "intake", version: "1.0.0" }, client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1.0.0" } },
  submission: { locale: "en", values: { name: "Ada" } }
};

describe("parseStrictJson", () => {
  it("refuses an object with a repeated key, at any depth and however the key is escaped", () => {
    for (const text of [
      '{"a":1,"a":2}',
      '{"a":1,"\\u0061":2}',
      '{"outer":{"x":[{"k":1},{"k":2,"k":3}]}}',
      '[{"values":{"name":"Ada","name":"Grace"}}]',
      '{"__proto__":1,"__proto__":2}',
      '{ "a" : 1 , "b" : 2 , "a" : 3 }'
    ]) {
      expect(() => parseStrictJson(text), text).toThrow(DuplicateJsonKeyError);
      expect(() => parseStrictJson(text), text).toThrow(SyntaxError);
    }
  });

  it("reads what JSON.parse reads when no object repeats a key", () => {
    for (const text of [
      '{"a":1,"b":{"a":2},"c":[{"a":3},{"a":4}]}',
      '{"a":"\\"a\\":1,","b":"{\\"a\\":2}","c":"}]{["}',
      '{"a":"x\\\\","a\\\\":1}',
      '["a","a",{"a":"a"}]',
      '"plain"',
      "42"
    ]) {
      expect(parseStrictJson(text), text).toEqual(JSON.parse(text));
    }
    // The scan keeps its own stack, so nesting costs it no recursion.
    expect(() => parseStrictJson(`${'[{"a":'.repeat(3000)}1${"}]".repeat(3000)}`)).not.toThrow();
  });

  it("throws what JSON.parse throws for text that is not JSON", () => {
    expect(() => parseStrictJson("{")).toThrow(SyntaxError);
    expect(() => parseStrictJson("{")).not.toThrow(DuplicateJsonKeyError);
  });
});

describe("the service's own JSON reads", () => {
  it("refuses a submission document with a repeated key as not valid JSON", () => {
    const text = JSON.stringify(ENVELOPE).replace('"name":"Ada"', '"name":"Ada","name":"Grace"');
    expect(() => parseSubmissionDocument(text)).toThrow(/not valid JSON/);
  });

  it("answers an inspected document with a repeated key as it answers malformed JSON: 400 bad_document", async () => {
    const service = createSubmissionService({ store: new InMemorySubmissionStore(), validator: createKernelValidator() });
    const refusal = async (text: string) => {
      try {
        await service.inspectDocument({ kind: "json", text });
        return undefined;
      } catch (error) {
        return errorResponse(error);
      }
    };
    const malformed = await refusal("{");
    expect(malformed).toEqual({ status: 400, body: { errors: [{ code: "bad_document" }] } });
    expect(await refusal(JSON.stringify(ENVELOPE).replace('"locale":"en"', '"locale":"en","locale":"fr"'))).toEqual(malformed);
  });
});
