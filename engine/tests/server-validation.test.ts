import { describe, expect, it } from "vitest";

import { ServerValidationRunner } from "../form-engine/validation/server/server-validation.js";

describe("server validation runner", () => {
  it("merges errors from multiple hooks in order", async () => {
    const trace: string[] = [];

    const runner = new ServerValidationRunner([
      {
        id: "eligibility",
        version: "1.0.0",
        validate: async () => {
          trace.push("eligibility");
          return {
            errors: [
              {
                code: "eligibility.inactive",
                stage: "server",
                source: "server"
              }
            ]
          };
        }
      },
      {
        id: "kyc",
        version: "1.0.0",
        validate: async () => {
          trace.push("kyc");
          return {
            errors: [
              {
                code: "kyc.required",
                stage: "server",
                source: "server"
              }
            ]
          };
        }
      }
    ]);

    const result = await runner.run({
      values: {},
      formId: "f1",
      validationContext: { formId: "f1", values: {} },
      services: {}
    });

    expect(trace).toEqual(["eligibility", "kyc"]);
    expect(result.errors).toHaveLength(2);
  });

  it("blocks access to services not on the policy allow-list", async () => {
    const runner = new ServerValidationRunner(
      [
        {
          id: "reads-forbidden-service",
          version: "1.0.0",
          validate: async (ctx) => {
            // Allowed.
            void (ctx.services as Record<string, unknown>).ledger;
            // Not allowed -> throws.
            void (ctx.services as Record<string, unknown>).secrets;
            return { errors: [] };
          }
        }
      ],
      { allow: ["ledger"] }
    );

    await expect(
      runner.run({
        values: {},
        formId: "f1",
        validationContext: { formId: "f1", values: {} },
        services: { ledger: {}, secrets: {} },
        environment: "server"
      })
    ).rejects.toThrow(/service "secrets" is not permitted/i);
  });

  it("refuses to run outside a server environment", async () => {
    const runner = new ServerValidationRunner([]);
    await expect(
      runner.run({
        values: {},
        formId: "f1",
        validationContext: { formId: "f1", values: {} },
        services: {},
        environment: "browser"
      })
    ).rejects.toThrow(/cannot run in environment "browser"/i);
  });
});
