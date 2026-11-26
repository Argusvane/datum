// What a page asks of the network, split into what stays on the hosts it is served from and what does
// not. The check (../check.mjs) puts this on a browser context: a request to any other host is refused
// before it leaves the machine, and recorded, so a page that would reach out on an open network is found
// on any network, and a page that needs the answer shows what it does without it.

/**
 * Whether `url` leaves the hosts in `local` (host names with their port, as `URL.host` gives them).
 * data:, blob:, about: and the browser's own schemes never do.
 */
export function leaves(url, local) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^(?:https?|wss?):$/.test(parsed.protocol)) return false;
  return !local.some((host) => host === parsed.host || host === parsed.hostname);
}

/**
 * Watches a Playwright browser context. Returns `{ attach(), take() }`: `attach` installs the routing,
 * `take` returns and clears `{ outside, missing, requests }`: the URLs refused because they leave `local`
 * (once each), the local URLs answered with 400 or above, and the number of requests that stayed local.
 */
export function watchContext(context, { local }) {
  let outside = new Set();
  let missing = new Set();
  let requests = 0;
  return {
    async attach() {
      await context.route(/.*/, (route) => {
        const url = route.request().url();
        if (leaves(url, local)) {
          outside.add(url);
          return route.abort("blockedbyclient");
        }
        if (/^https?:/.test(url)) requests += 1;
        return route.continue();
      });
      context.on("response", (response) => {
        if (response.status() >= 400 && !leaves(response.url(), local)) missing.add(`${response.status()} ${response.url()}`);
      });
    },
    take() {
      const taken = { outside: [...outside].sort(), missing: [...missing].sort(), requests };
      outside = new Set();
      missing = new Set();
      requests = 0;
      return taken;
    }
  };
}
