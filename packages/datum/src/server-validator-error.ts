/**
 * A check the server answered with a status that is no verdict: anything but 200 and 422.
 * `status` is what the runtime reads: every such status, a 4xx as much as a 5xx, is
 * the check being unavailable (a lapsed session or a moved route is no verdict on the answers
 * either), so the page is held as in an outage and the page's `onUnavailable` decides.
 *
 * Apart from `server-validator.ts`: that module is a lazy chunk, loaded when
 * `validate-url` is set, while this class is what a host's `instanceof` names, so it stays in
 * the bundle and the chunk imports it from there. One class, never a copy in each.
 */
export class JourneyValidationHttpError extends Error {
  public readonly status: number;

  constructor(status: number, url: string) {
    super(`The journey check at ${url} answered ${status}`);
    this.name = "JourneyValidationHttpError";
    this.status = status;
  }
}
