import type { ComponentPath } from "../schema/types.js";

export type ErrorSeverity = "error" | "warning" | "info";
export type ErrorSource = "client" | "wasm" | "server" | "custom";

export interface FormError {
  id: string;
  code: string;
  message?: string;
  componentId?: string;
  path?: ComponentPath;
  stage: string;
  severity?: ErrorSeverity;
  source: ErrorSource;
  parameters?: Record<string, unknown>;
}

/**
 * An error the host reports into a form from outside validation — a server's verdict on a
 * delivered submission, typically, which arrives after the runtime has accepted it.
 * `FormRuntime.setErrors` turns these into {@link FormError}s under `stage: "host"`, with
 * `source` defaulting to `"server"`. Without a `componentId` the error is the form's as a
 * whole: listed in the summary, attached to no field.
 */
export interface HostError {
  code: string;
  /** Shown when the host's message catalog has no entry for `code`. */
  message?: string;
  componentId?: string;
  /** A value path (`"applicants[1].email"`), when the error is on a row or nested field. */
  path?: string;
  severity?: ErrorSeverity;
  source?: ErrorSource;
  parameters?: Record<string, unknown>;
}
