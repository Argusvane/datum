import type { ValidationContext, ValidationResult } from "../../core/schema/contracts.js";

export interface ServerServices {
  [serviceName: string]: unknown;
}

export type ServerEnvironment = "server";

/** Allow-list of service names a server validation hook may read. */
export interface ServerServicePolicy {
  allow: string[];
}

/**
 * What a run is asked to judge, so a hook can skip work outside it:
 * - `"submission"`: a delivery being received, or checked as one;
 * - `"journey"`: a journey's answers before its final Submit;
 * - `"page"`: one page of a journey on Continue — `componentIds` are the page's components
 *   and their subtrees, and only errors on those (or on the form as a whole) are shown.
 * The values are every submittable answer whatever the scope, so a hook can compare a page's
 * answers with earlier ones.
 */
export interface ServerValidationScope {
  kind: "submission" | "journey" | "page";
  /** The journey the answers were given through, when there was one. */
  journeyId?: string;
  /** The page being checked, for `kind: "page"`. */
  pageId?: string;
  componentIds?: string[];
}

export interface ServerValidationContext {
  values: Record<string, unknown>;
  formId: string;
  validationContext: ValidationContext;
  services: ServerServices;
  /** Defaults to `"server"`. A non-server value is rejected before hooks run. */
  environment?: string;
  /** Absent: the whole submission. */
  scope?: ServerValidationScope;
}

export interface ServerValidationHook {
  id: string;
  version: string;
  validate(context: ServerValidationContext): Promise<ValidationResult>;
}

/** Throws unless the runner is executing in a server environment. */
export function assertServerEnvironment(environment: string | undefined): void {
  const resolved = environment ?? "server";
  if (resolved !== "server") {
    throw new Error(
      `Server-only validation cannot run in environment "${resolved}"; non-deterministic I/O is server-privileged.`
    );
  }
}

function enforceServicePolicy(
  services: ServerServices,
  policy: ServerServicePolicy | undefined
): ServerServices {
  if (!policy) {
    return services;
  }
  const allow = new Set(policy.allow);
  return new Proxy(services, {
    get(target, property, receiver) {
      if (typeof property === "string" && !allow.has(property)) {
        throw new Error(`Server service "${property}" is not permitted by policy`);
      }
      return Reflect.get(target, property, receiver);
    }
  });
}

export class ServerValidationRunner {
  constructor(
    private readonly hooks: ServerValidationHook[],
    private readonly policy?: ServerServicePolicy
  ) {}

  public async run(context: ServerValidationContext): Promise<ValidationResult> {
    assertServerEnvironment(context.environment);

    const guardedContext: ServerValidationContext = {
      ...context,
      services: enforceServicePolicy(context.services, this.policy)
    };

    const merged: ValidationResult = { errors: [] };
    for (const hook of this.hooks) {
      const result = await hook.validate(guardedContext);
      merged.errors.push(...result.errors);
    }
    return merged;
  }
}
