/**
 * The agent tools of `<datum-form-builder>` (WebMCP) as the builder bundle's own lazy
 * chunk (`datum-builder-agent-*.js`), reached by dynamic import alone through
 * `loadBuilderAgent()` (`agent-loader.ts`). Each bundle's agent chunk carries the registrar, the
 * binding and its own catalogue only: this one carries the builder
 * catalogue (`createBuilderTools`, twenty-four tools) and its element host (`agent-host.ts` here),
 * never the renderer catalogue (`createFormAgentTools`) or the form's element host, so the name
 * of the renderer's answer-writing tool appears in no `datum-builder-*` file (guard 15), and the form bundle's chunk
 * (`../agent.ts`) never imports this one. The basename is `agent` so vite names the chunk after
 * the feature in its bundle, as it names the form's.
 *
 * Only `<datum-form-builder>` attaches here: the engine shell `<datum-builder>` used on
 * its own loads no agent chunk.
 */

import { agentRegistrarFor, createBuilderTools } from "@argusvane/datum-engine/agent";

import { attach, type BuilderAgentAttachment } from "../agent-attach.js";
import type { DatumFormBuilderElement } from "../builder-element.js";
import { elementBuilderHost } from "./agent-host.js";

/**
 * Registers a `<datum-form-builder>` with the page's registrar under its per-connection `signal`:
 * the element host, the builder catalogue, then the browser binding, whose outcome the
 * element reports as `datum-agent-tools`. The handle is the element's `id` when free, else
 * `builder-<n>`.
 *
 * A reseed is a rebuild: a `datum-builder-change { reason: "init" }` after the
 * registration has seen the builder ready (a `definition` or `src` assignment, a new seed) calls
 * `runtimeReplaced()`, so the revision moves, an open session ends as `rebuilt` and the
 * catalogue's per-target state goes. The builder counts as ready at attach when its
 * `agentBuildState` already says so (the chunk usually lands after the shell seeded, so that
 * first `init` was before this listener); otherwise the first `init` makes it ready and does
 * nothing else. Only an `init` after that point is a reseed.
 */
export function attachBuilderAgent(wrapper: DatumFormBuilderElement, signal: AbortSignal): BuilderAgentAttachment {
  const registrar = agentRegistrarFor(wrapper.ownerDocument);
  const host = elementBuilderHost(wrapper);
  const registration = registrar.registerBuilder({ host, catalogue: createBuilderTools, signal, id: wrapper.id });
  let seenReady = wrapper.agentBuildState === "ready";
  const onChange = (event: Event): void => {
    // The form side's seed only: a designer's own document reports under its mode (pdf, journeys).
    const detail = (event as CustomEvent<{ reason?: string; mode?: string }>).detail;
    if (detail?.reason !== "init" || (detail.mode !== undefined && detail.mode !== "form")) {
      return;
    }
    if (!seenReady) {
      seenReady = true;
      return;
    }
    registration.runtimeReplaced();
  };
  if (!signal.aborted) {
    wrapper.addEventListener("datum-builder-change", onChange);
    signal.addEventListener("abort", () => wrapper.removeEventListener("datum-builder-change", onChange), { once: true });
  }
  return attach(wrapper, "builder", registrar, registration, () => host.resetUi());
}
