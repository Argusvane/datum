export interface AuditState {
  id: string;
  mode: "interactive" | "readonly";
  locale: string;
  invalid: boolean;
  label: string;
}

export interface FixturePart {
  id: string;
  label: string;
  components: string[];
}

export interface AuditContrast {
  foreground: string;
  background: string;
  ratio: number | string | undefined;
  expected: string | undefined;
  fontSize: string | undefined;
  fontWeight: string | undefined;
}

export interface AuditEntry {
  ruleId: string;
  impact: string;
  criteria: string[];
  part: string;
  componentId: string | undefined;
  target: string;
  summary: string;
  contrast?: AuditContrast;
}

export interface AuditResult {
  violations: AuditEntry[];
  incomplete: AuditEntry[];
  passes: string[];
}

export const WCAG_TAGS: readonly string[];
export const AUDIT_STATES: readonly AuditState[];
export const FIXTURE_PARTS: readonly FixturePart[];
export function axeRunOptions(options: { colour: boolean }): Record<string, unknown>;
export function criteriaFromTags(tags: readonly string[] | undefined): string[];
export function attributeNode(node: Node | null | undefined): { componentId: string | undefined; part: string };
export function normaliseAxeResults(results: unknown, resolve: (node: unknown) => Element | null | undefined): AuditResult;
