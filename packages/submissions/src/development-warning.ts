/**
 * One console warning per process for each thing meant for development and tests: the kernel and the PDF kernel run in this
 * process, with no sandbox between the form author's rules and the server. A production host binds the QuickJS program
 * hosts instead (`createQuickJsValidator` from `@argusvane/datum-submissions/node`, the PDF program).
 */
const warned = new Set<string>();

export function warnDevelopmentOnly(what: string, instead: string): void {
  if (warned.has(what)) {
    return;
  }
  warned.add(what);
  console.warn(`datum submissions: ${what} runs in this process, with no sandbox between a form's rules and the server. It is for development and tests. ${instead}`);
}
