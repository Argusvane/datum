export const packageRoot: string;
export function chromeFromEnvironment(who?: string, env?: Record<string, string | undefined>): string | undefined;
export function freePort(): Promise<number>;
export function waitFor<T>(check: () => T | Promise<T>, options?: { timeoutMs?: number; every?: number; what?: string; who?: string }): Promise<T>;
export class Page {
  console: string[];
  pw: import("playwright").Page;
  evaluate(expression: string): Promise<any>;
  cdp(): Promise<import("playwright").CDPSession>;
  close(): Promise<void>;
}
export function launch(options: {
  serverPort: number;
  who?: string;
  readyPath?: string;
  viewport?: { width: number; height: number };
  serve?: boolean;
  pointer?: "platform" | "mouse";
  chromeArgs?: string[];
  headless?: boolean;
  browserType?: { launch(options: object): Promise<any> };
}): Promise<{ origin: string; version: string; browser: import("playwright").Browser; open(path: string, contextOptions?: import("playwright").BrowserContextOptions): Promise<Page>; close(): Promise<void> }>;
export function sortKeys<T>(value: T): T;
export function diff(before: unknown, after: unknown, path?: string): string[];
