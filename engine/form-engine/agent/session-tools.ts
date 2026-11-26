/**
 * The session pair's words and schemas. `begin_session` / `end_session`
 * are registered once per page by the registrar, never by a catalogue: Chrome keeps one title,
 * description and schema per name per document and a page may hold a form, a builder or both,
 * so the wording names neither catalogue's tools and says "the result describes the form or
 * the builder". This module is the single owner of those strings in code: the
 * registrar imports them, the schema-sanity test and the reference docs read them from here.
 *
 * Static English only; nothing here runs at import time.
 */

import type { AgentToolAnnotations } from "./tool-types.js";

export const SESSION_TOOL_NAMES = ["begin_session", "end_session"] as const;

export type SessionToolName = (typeof SESSION_TOOL_NAMES)[number];

/** Titles and descriptions byte for byte as the session pair documents them. */
export const SESSION_TOOL_TEXTS: Readonly<Record<SessionToolName, { title: string; description: string }>> = {
  begin_session: {
    title: "Start a session",
    description:
      "Tell the person you are about to work for several steps: they see a banner with your `purpose` and a Stop button while you work, and everything you change until end_session can be undone in one go (the person is offered Undo all; you can pass undo: true to end_session). Single calls do not need a session. Call end_session when you are done; the session also ends by itself after 45 seconds without a call. The result describes the form or the builder you are working on. On a page with both a form and a builder, pass `target`."
  },
  end_session: {
    title: "End the session",
    description:
      "End the session begun with begin_session: hands the page back to the person and replaces the banner with your `summary` (one or two sentences they read and hear) and an Undo all button. Pass undo: true to undo everything the session changed before ending. Call it as soon as your work is done. The result describes the form or the builder."
  }
};

/** Both session tools carry no hints: UI state, nothing leaves the page, Stop restores. */
export const SESSION_TOOL_ANNOTATIONS: Readonly<AgentToolAnnotations> = {};

/** The idle timeout the description promises: a session ends by itself after this long without a call. */
export const SESSION_IDLE_TIMEOUT_MS = 45_000;

/** The caps the registrar pre-cuts `purpose` and `summary` at; the schemas state the same numbers. */
export const SESSION_PURPOSE_MAX = 200;
export const SESSION_SUMMARY_MAX = 500;

function targetProperties(): Record<string, unknown> {
  return {
    target: {
      type: "string",
      enum: ["form", "builder"],
      description: "Which kind of element, only when the page has both a form and a builder. Leave it out otherwise."
    },
    form: {
      type: "string",
      description:
        "Which form, when the page has more than one: a handle from describe_form. Leave it out when there is one form."
    },
    builder: {
      type: "string",
      description:
        "Which builder, when the page has more than one: a handle from describe_builder. Leave it out when there is one builder."
    }
  };
}

/**
 * The two input schemas, exact to the documented schemas, as fresh objects on every call (Chrome stores a
 * schema verbatim and nothing here should share a mutable reference with what was registered).
 */
export function sessionToolSchemas(): Record<SessionToolName, Record<string, unknown>> {
  return {
    begin_session: {
      type: "object",
      properties: {
        purpose: {
          type: "string",
          maxLength: SESSION_PURPOSE_MAX,
          description:
            "What you are about to do, in one short sentence the person will read, e.g. 'Filling in your trip details from the email you pasted'."
        },
        ...targetProperties()
      },
      required: ["purpose"]
    },
    end_session: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          maxLength: SESSION_SUMMARY_MAX,
          description:
            "What you did and what the person should do next, one or two sentences, e.g. 'Filled your trip details and two expenses; please add the hotel receipt and press Submit'."
        },
        undo: {
          type: "boolean",
          description: "Undo every change made during the session before ending (default false)."
        },
        ...targetProperties()
      },
      required: ["summary"]
    }
  };
}
