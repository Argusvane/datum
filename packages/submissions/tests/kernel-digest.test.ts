import { describe, expect, it } from "vitest";
import { createInProcessWasmValidationHost, type ComponentNode, type FormDefinition } from "@argusvane/datum-engine";

import {
  InMemorySubmissionStore,
  createKernelValidator,
  createSubmissionService,
  serializeDeliveredDocument,
  submissionDigest
} from "../src/index.js";

/**
 * One digest: the canonical text and SHA-256 the kernel returns for the
 * document a host sends are the ones this package computes for the Data tab, for an envelope
 * with keys where code-unit order and ICU collation part, and for a signed wrapper.
 */

const form: ComponentNode = { id: "form", type: "form", configuration: {}, children: { content: [{ id: "fullName", type: "text", configuration: {} }] } };

const envelope = {
  versionContext: { form: { id: "contact", version: "1.0.0" }, client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" } },
  submission: { locale: "fr", values: { fullName: "Zoë", B: 1, a: 2, a_b: 3, ab: 4, "a-b": 5, "\u{1F600}": 6, "�": 7, "10": 8, "2": 9 } }
};

const wrapper = {
  format: { scope: "envelope", placement: "wrapper", digest: "sha-256", canonicalization: "jcs" },
  payload: envelope,
  signatures: [{ provider: "demo", value: "c2ln", participantId: "p", signedAt: "2026-10-07T00:00:00Z" }]
};

describe("the kernel's digest is the Data tab's", () => {
  it("matches submissionDigest and serializeDeliveredDocument for an envelope and a wrapper", async () => {
    const host = createInProcessWasmValidationHost([]);
    for (const document of [envelope, wrapper]) {
      const outcome = await host.run({
        context: { formId: "contact", locale: "fr", values: { fullName: "Zoë" }, form, document },
        policy: { allowNetwork: false, allowFilesystem: false, allowProcess: false, allowEnvironment: false }
      });
      expect(outcome.canonical).toBe(serializeDeliveredDocument(document as never));
      expect(outcome.digest).toBe(submissionDigest(document as never));
    }
  });
});

describe("inspectDocument finds a stored record by its digest", () => {
  it("names the record holding the same document, and none for another", async () => {
    const INTAKE: FormDefinition = { id: "intake", version: "1.0.0", schemaVersion: "1.0.0", root: form };
    const envelopeOf = (values: Record<string, unknown>) => ({
      versionContext: { form: { id: "intake", version: "1.0.0" }, client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1.0.0" } },
      submission: { locale: "en", values }
    });
    const store = new InMemorySubmissionStore();
    let n = 0;
    const service = createSubmissionService({ store, validator: createKernelValidator(), ids: () => `rec-${++n}` });
    await service.register(INTAKE);
    const document = envelopeOf({ fullName: "Ada", B: 1, a: 2 });
    const { record } = await service.receive({ submissionKey: crypto.randomUUID(), document });
    expect(record.digest).toBe(submissionDigest(document));
    const same = await service.inspectDocument({ kind: "json", text: JSON.stringify(document) });
    expect(same).toMatchObject({ recordId: record.id, digest: submissionDigest(document) });

    const stranger = await service.inspectDocument({ kind: "json", text: JSON.stringify(envelopeOf({ fullName: "Ada", B: 2 })) });
    expect(stranger.recordId).toBeUndefined();
  });
});
