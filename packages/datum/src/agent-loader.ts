import { ChunkLoadError } from "./chunk-load-error.js";

/**
 * The agent tools (WebMCP) as lazy chunks, one per bundle: the
 * form's `agent.ts` carries the engine's agent layer with the renderer catalogue and the form's
 * element host (`datum-form-agent-*.js`); the builder's `builder/agent.ts` carries the registrar,
 * the binding and the builder's own catalogue (`datum-builder-agent-*.js`). Each is reached by
 * dynamic import alone, so a page whose `features` list leaves `agent` out (every page that does
 * not write `features="all agent"`) never downloads either. This module is what the two entries
 * carry instead, in the shape of `journey-engine-loader.ts`: `<datum-form>` calls `loadAgent()`,
 * `<datum-form-builder>` calls `loadBuilderAgent()`.
 */
type AgentModule = typeof import("./agent.js");
type BuilderAgentModule = typeof import("./builder/agent.js");

/**
 * The bundle being built: vite replaces `import.meta.env.MODE` with the `--mode` of the build
 * (`"form"`, `"builder"`, vite.config.ts), `"test"` under vitest and a host's own mode when a host
 * bundles the sources. The optional chain keeps a bundler without `import.meta.env` working.
 */
const BUNDLE_MODE = (import.meta as unknown as { env?: { MODE?: string } }).env?.MODE;

/**
 * Why `<datum-form>` has no agent tools in the builder bundle. The builder bundle defines
 * `<datum-form>` too (it is a superset of the renderer bundle), but its agent chunk must not carry
 * the renderer catalogue (`describe_form` in no `datum-builder-*` file), so
 * in that build the form's import below is a constant branch vite drops, chunk and all. A page
 * that wants both loads `datum-form.js` before `datum-builder.js`: the first definition of
 * `<datum-form>` wins and it is the renderer bundle's. Not a ChunkLoadError: nothing failed to
 * load, and asking again answers the same.
 */
export const BUILDER_BUNDLE_FORM_AGENT_MESSAGE =
  "The agent tools for <datum-form> are in datum-form.js; datum-builder.js carries the builder's only. Load datum-form.js before datum-builder.js to give a <datum-form> on this page its agent tools.";

/** One load of each chunk per page, shared by every element of its kind. */
let agentLoad: Promise<AgentModule> | undefined;
let builderAgentLoad: Promise<BuilderAgentModule> | undefined;

/** What each chunk answered, once it has. */
let agentLoaded: AgentModule | undefined;
let builderAgentLoaded: BuilderAgentModule | undefined;

/** The ChunkLoadError's subject, the same for both chunks (a host deletes them together). */
const SUBJECT = "The agent tools (datum-form-agent-*.js / datum-builder-agent-*.js)";

/**
 * Loads `<datum-form>`'s chunk, once, and answers its module. A failed load is forgotten so the
 * next call asks again (a chunk that 404ed for a moment); in the module build the import goes
 * through the retrying loader (vite.config.ts). A missing or blocked chunk rejects as a
 * ChunkLoadError naming the agent tools, with the browser's error as `cause` (absent-code
 * resilience). In the builder bundle it rejects with
 * {@link BUILDER_BUNDLE_FORM_AGENT_MESSAGE} and loads nothing.
 */
export function loadAgent(): Promise<AgentModule> {
  if (!agentLoad) {
    if (BUNDLE_MODE === "builder") {
      return Promise.reject(new Error(BUILDER_BUNDLE_FORM_AGENT_MESSAGE));
    }
    const load = import("./agent.js").then(
      (module: AgentModule): AgentModule => {
        agentLoaded = module;
        return module;
      },
      (error: unknown): never => {
        throw new ChunkLoadError(SUBJECT, error);
      }
    );
    load.catch(() => {
      if (agentLoad === load) {
        agentLoad = undefined;
      }
    });
    agentLoad = load;
  }
  return agentLoad;
}

/** `<datum-form>`'s chunk module when it has already arrived on this page, else `undefined` (never loading, never failing). */
export function loadedAgent(): AgentModule | undefined {
  return agentLoaded;
}

/** Loads `<datum-form-builder>`'s chunk, once, with the same memo, forget-on-reject and ChunkLoadError as {@link loadAgent}. */
export function loadBuilderAgent(): Promise<BuilderAgentModule> {
  if (!builderAgentLoad) {
    const load = import("./builder/agent.js").then(
      (module: BuilderAgentModule): BuilderAgentModule => {
        builderAgentLoaded = module;
        return module;
      },
      (error: unknown): never => {
        throw new ChunkLoadError(SUBJECT, error);
      }
    );
    load.catch(() => {
      if (builderAgentLoad === load) {
        builderAgentLoad = undefined;
      }
    });
    builderAgentLoad = load;
  }
  return builderAgentLoad;
}

/** `<datum-form-builder>`'s chunk module when it has already arrived on this page, else `undefined`. */
export function loadedBuilderAgent(): BuilderAgentModule | undefined {
  return builderAgentLoaded;
}
