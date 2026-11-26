// The kit's ports: 5200-5219 (the range this repository gives the binding kit). Picks the first
// one nothing listens on; a fixed `--port` is taken as given, inside the range (the first free one
// from it) or outside it (that port or a failure: a person who names a port outside the range, an
// agent given another one, means it).
import { createServer } from "node:net";

// `BINDING_KIT_PORTS=5300-5319` moves the range (a second checkout or agent running beside the first).
const fromEnv = /^(\d+)-(\d+)$/.exec(process.env.BINDING_KIT_PORTS ?? "");
export const FIRST_PORT = fromEnv ? Number(fromEnv[1]) : 5200;
export const LAST_PORT = fromEnv ? Number(fromEnv[2]) : 5219;

function free(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** The first free port of 5200-5219, starting at `from`; throws when the range is used up. A `from` outside the range is that port, or a throw when it is in use. */
export async function pickPort(from = FIRST_PORT) {
  if (from < FIRST_PORT || from > LAST_PORT) {
    if (await free(from)) return from;
    throw new Error(`port ${from} is in use`);
  }
  for (let port = from; port <= LAST_PORT; port += 1) {
    if (await free(port)) return port;
  }
  throw new Error(`no free port in ${FIRST_PORT}-${LAST_PORT}: the binding kit uses that range only`);
}
