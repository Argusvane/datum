// A client alone in its process (no test runner keeping the event loop busy): the RES-11 stall needs a
// quiet loop to show. Sends paced checks the way an endpoint run does and prints, per request, the
// wall time of the send (the pacing pause included) and the exchange's own total, as JSON.
// argv: <base url> [count] ["fetch": use the global fetch as the transport, to show the stall by hand]
import { Budget } from "../../src/runners/endpoint/budget.js";
import { HttpClient, routesFor, type EndpointTarget } from "../../src/runners/endpoint/http.js";

const [baseUrl, countText, mode] = process.argv.slice(2);
const target: EndpointTarget = { baseUrl: baseUrl as string, profile: "submissions", formId: "fx", formVersion: "1", allowWrites: false };
const client = new HttpClient({
  target,
  budget: new Budget({ maxRequests: 100, delayMs: 250 }),
  timeoutMs: 30_000,
  headers: {},
  ...(mode === "fetch" ? { fetchImpl: globalThis.fetch.bind(globalThis) } : {})
});
const out: { wallMs: number; totalMs: number; status: number }[] = [];
for (let at = 0; at < Number(countText ?? "5"); at += 1) {
  const started = performance.now();
  const answer = await client.send({ method: "POST", url: routesFor(target).validate, headers: { "content-type": "application/json" }, body: "{}" });
  out.push({ wallMs: Math.round(performance.now() - started), totalMs: Math.round(answer.timing.totalMs), status: answer.status });
}
process.stdout.write(`${JSON.stringify(out)}\n`);
