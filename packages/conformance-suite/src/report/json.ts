import type { Report } from "./model.js";

/** The report as JSON text, two-space indented, newline-terminated. Stable key order is the model's. */
export function renderJson(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * Blanks the value of any flag that carries a secret before argv goes into a report
 * (`--auth-header "Authorization: Bearer x"` keeps the header name only; `--cookie`, too).
 */
export function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] as string;
    const equals = /^(--(?:auth-header|cookie|header))=(.*)$/.exec(arg);
    if (equals !== null) {
      out.push(`${equals[1]}=${headerName(equals[1] as string, equals[2] as string)}`);
      continue;
    }
    if (arg === "--auth-header" || arg === "--cookie" || arg === "--header") {
      out.push(arg);
      const value = argv[at + 1];
      if (value !== undefined) {
        out.push(headerName(arg, value));
        at += 1;
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}

function headerName(flag: string, value: string): string {
  if (flag === "--cookie") {
    return "<redacted>";
  }
  const colon = value.indexOf(":");
  return colon > 0 ? `${value.slice(0, colon)}: <redacted>` : "<redacted>";
}
