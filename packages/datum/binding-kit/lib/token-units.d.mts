export const UNITS: readonly string[];
export class TokenUnitError extends Error {}
export function unitOf(value: string): string;
export function lengthToPt(value: string, options?: { remPt?: number; token?: string }): number;
export function missingTokens(contract: { tokens: ReadonlyArray<{ name: string }> }, read: (name: string) => string | undefined): string[];
