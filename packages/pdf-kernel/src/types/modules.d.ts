// Minimal declarations for the byte libraries that ship no types. Only what the kernel uses.

declare module "linebreak" {
  export interface Break {
    position: number;
    required: boolean;
  }
  export class LineBreaker {
    constructor(text: string);
    nextBreak(): Break | null;
  }
}

declare module "bidi-js" {
  export interface EmbeddingLevels {
    levels: Uint8Array;
    paragraphs: Array<{ start: number; end: number; level: number }>;
  }
  export interface Bidi {
    getEmbeddingLevels(text: string, baseDirection?: "ltr" | "rtl" | "auto"): EmbeddingLevels;
    getReorderSegments(text: string, embeddingLevels: EmbeddingLevels, start?: number, end?: number): Array<[number, number]>;
    getReorderedIndices(text: string, embeddingLevels: EmbeddingLevels, start?: number, end?: number): number[];
    getReorderedString(text: string, embeddingLevels: EmbeddingLevels, start?: number, end?: number): string;
    getMirroredCharactersMap(text: string, embeddingLevels: EmbeddingLevels, start?: number, end?: number): Map<number, string>;
    getMirroredCharacter(char: string): string | null;
    getBidiCharType(char: string): number;
    getBidiCharTypeName(char: string): string;
  }
  export default function bidiFactory(): Bidi;
}

declare module "fontkit" {
  export function create(buffer: Uint8Array, postscriptName?: string): unknown;
  export const defaultLanguage: string;
  export function setDefaultLanguage(lang?: string): void;
  export function registerFormat(format: unknown): void;
  export function logErrors(): void;
}
