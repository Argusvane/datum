/**
 * How the Logic workspace edits a journey's Go to rules: the seam
 * between the Logic surface (a lazy chunk) and the Journeys mode (in the builder's bundle).
 *
 * A Go to rule is a route node of its step, on the journey's own controller; the form's
 * controller is never written for it. The mode registers an object of this shape under the
 * form's controller when it is made, and the Logic surface looks it up by the controller it was
 * given, so neither knows the other and the shell wires nothing: a page with two builders keeps
 * two registries, and a builder with no Journeys mode has no entry, so the surface lists its
 * journey rules read-only as it always did.
 *
 * Every write is one undo step on the journey's controller. Rules are named by what the Logic
 * model names them by (the journey, the step's page id and the route's written position), never
 * by node ids, which stay the mode's business. Types only, plus one WeakMap: this file is in the
 * builder's own bundle.
 */
import type { Journey } from "../../core/schema/journey.js";

/** A written route: the journey it is in, the page it leaves and its position among that page's written routes. */
export interface LogicRouteRef {
  journeyId: string;
  pageId: string;
  routeIndex: number;
}

/** What opens in the Logic editor when the map asks for it: a rule, or a new rule with its From and Go to set. */
export type LogicOpenRequest =
  | { kind: "rule"; ref: LogicRouteRef }
  | { kind: "new"; journeyId: string; pageId: string; to: string };

export interface LogicJourneyHost {
  /** Bumped on every change of the journeys or of what the writes below can do: the model's memo key. */
  version(): number;
  /** The journeys as committed, drafts left out: what the rule list is built from. */
  journeys(): readonly Journey[];
  /** Whether the writes can run now (the designer is loaded). Until then the rules are listed read-only. */
  ready(): boolean;
  /** Loads what the writes need; resolves with whether they can run. */
  prepare(): Promise<boolean>;
  /** Told whenever `version` moves. */
  subscribe(listener: () => void): () => void;
  /** Puts the journey's selection on the rule's route, so the map marks the rule being edited. A route no node stands for selects the step. */
  select(ref: LogicRouteRef): void;
  /**
   * Changes the rule: `to` (a page id of the journey, or `$end`) and/or `when` (formula text; `""`
   * for always). One undo step. `false` when it could not be written.
   */
  update(ref: LogicRouteRef, change: { to?: string | undefined; when?: string | undefined }): boolean;
  /**
   * Adds a rule to the step. It goes before the step's first rule that has no condition, so the
   * step can still try it, else last; selected on the journey. One undo step. The reference to
   * the rule as written, or `undefined` when it could not be added.
   */
  create(spec: { journeyId: string; pageId: string; to: string; when?: string | undefined }): LogicRouteRef | undefined;
  /** The rule one place earlier (-1) or later (1) among the step's written rules. One undo step. The rule's reference after the move, `undefined` at either end. */
  move(ref: LogicRouteRef, delta: -1 | 1): LogicRouteRef | undefined;
  /** Removes the rule. One undo step. */
  remove(ref: LogicRouteRef): boolean;
  /**
   * The ids of the form components whose answers the path has when it tries the rules of the page
   * (its own step's answers and every earlier step's), a layout standing for everything inside it:
   * what a route's condition can read. `undefined` when that is not known (the journey's designer
   * is not built), so the caller assumes every field.
   */
  askedThrough(journeyId: string, pageId: string): readonly string[] | undefined;
  /** A request from the map to edit a rule, made while no Logic surface may be listening: held until one takes it or it grows stale. */
  takePending(): LogicOpenRequest | undefined;
  /** Told of a request made while the surface is on the page (it is then not held). */
  onOpen(listener: (request: LogicOpenRequest) => void): () => void;
}

const hosts = new WeakMap<object, LogicJourneyHost>();
/** Who wants to know that the host for a form came or went: a Logic surface that looked before the Journeys mode was made. */
const watchers = new WeakMap<object, Set<() => void>>();

function tellWatchers(form: object): void {
  for (const listener of [...(watchers.get(form) ?? [])]) {
    listener();
  }
}

/**
 * Registers the host for the builder whose form controller is `form`; the returned function takes
 * it away again (if it is still the registered one). Watchers are told of both: the Journeys mode
 * arrives after the Logic surface when its chunk is slow, or when the `features` list turns it
 * back on, and the surface must then take up its rules.
 */
export function registerLogicJourneyHost(form: object, host: LogicJourneyHost): () => void {
  hosts.set(form, host);
  tellWatchers(form);
  return () => {
    if (hosts.get(form) === host) {
      hosts.delete(form);
      tellWatchers(form);
    }
  };
}

/** Calls `listener` whenever a host is registered for `form` or taken away; the returned function stops it. */
export function watchLogicJourneyHost(form: object, listener: () => void): () => void {
  const held = watchers.get(form) ?? new Set<() => void>();
  held.add(listener);
  watchers.set(form, held);
  return () => {
    held.delete(listener);
  };
}

/** The host registered for `form`, when the builder has a Journeys mode. */
export function logicJourneyHostOf(form: object | undefined): LogicJourneyHost | undefined {
  return form === undefined ? undefined : hosts.get(form);
}
