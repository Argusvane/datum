export const REPORT_PATH: string;
export interface Baselines {
  markup?: unknown;
  browser?: unknown;
}
export function readBaselines(dir?: string): Baselines;
export function renderReport(baselines?: Baselines): string;
export function packageReport(): { path: string; document: string };
