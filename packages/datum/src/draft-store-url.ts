import { DraftError, type DraftStore, type FormDraft, type FormDraftSummary } from "@argusvane/datum-engine";

/**
 * The `draft-store` attribute: where a draft is kept, spelled as a string a page can
 * write in markup, for the common case of a server that stores them. The grammar:
 *
 * - `server:<url>`: the page's own service, `<url>` absolute or relative to the page
 *   (`server:/api/drafts`). It speaks four requests, with `<id>` the `draft` key, percent-encoded:
 *   `PUT <url>/<id>` with the draft as the JSON body saves it; `GET <url>/<id>` answers the draft
 *   as JSON, or 404 when there is none; `DELETE <url>/<id>` removes it (404 counts as removed);
 *   `GET <url>` answers the list of draft summaries as JSON, newest first or in any order. Any
 *   other status is the request failing, and the draft calls reject with it.
 * - `local`: the browser's own storage, which is what a `draft` key gets without this attribute.
 *
 * Anything else is a mistake the element reports as `datum-error`, and so is a `server:` URL on
 * another origin than the page's unless `allow-origins` lists it (drafts carry the answers). A
 * `draftStore` object assigned from script always wins over the attribute: a page that needs
 * headers, credentials, another origin or another protocol writes its own `DraftStore` (the
 * interface is four methods) and assigns it.
 */
export type DraftStoreSpec = { kind: "local" } | { kind: "server"; url: string };

/** Reads the attribute's value; throws, naming the grammar, for a value it does not recognise. */
export function parseDraftStoreSpec(raw: string): DraftStoreSpec {
  const value = raw.trim();
  if (value === "local") {
    return { kind: "local" };
  }
  if (value.startsWith("server:") && value.length > "server:".length) {
    return { kind: "server", url: new URL(value.slice("server:".length).trim(), document.baseURI).href };
  }
  throw new Error(`draft-store must be "server:<url>" or "local", not "${raw}"`);
}

/** A {@link DraftStore} over the four requests of the `server:<url>` grammar. */
export function createUrlDraftStore(url: string): DraftStore {
  // The id goes on the pathname, so a base with a query (`/api/drafts?form=a`) keeps it:
  // `/api/drafts/<id>?form=a`. The list request is the base itself, query included.
  const parsed = new URL(url, typeof document === "undefined" ? "http://localhost/" : document.baseURI);
  const trimmed = parsed.pathname.replace(/\/+$/, "");
  const listing = new URL(parsed.href);
  listing.pathname = trimmed === "" ? "/" : trimmed;
  const base = listing.href;
  const at = (id: string): string => {
    const target = new URL(parsed.href);
    target.pathname = `${trimmed}/${encodeURIComponent(id)}`;
    // Every request stays at `<base>/<encoded id>`: the URL parser collapses
    // the dot segments `.` and `..` (not percent-encoded by encodeURIComponent) and an empty id
    // names the collection, so a request that did not land one segment under the base is refused.
    const rest = target.pathname.startsWith(`${trimmed}/`) ? target.pathname.slice(trimmed.length + 1) : "";
    if (id === "" || id === "." || id === ".." || rest === "" || rest.includes("/")) {
      throw new Error(`draft-store: the draft key ${JSON.stringify(id)} cannot name a draft under ${base}`);
    }
    return target.href;
  };
  const failed = (what: string, response: Response): Error => new Error(`${what} failed: ${response.status} ${response.statusText}`.trim());
  return {
    async save(draft: FormDraft): Promise<void> {
      const response = await fetch(at(draft.id), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft)
      });
      if (!response.ok) {
        throw failed("Saving the draft", response);
      }
    },
    async load(id: string): Promise<FormDraft> {
      const response = await fetch(at(id), { headers: { accept: "application/json" } });
      if (response.status === 404) {
        throw new DraftError("draft.notFound", `Draft not found: ${id}`);
      }
      if (!response.ok) {
        throw failed("Loading the draft", response);
      }
      return (await response.json()) as FormDraft;
    },
    async list(): Promise<FormDraftSummary[]> {
      const response = await fetch(base, { headers: { accept: "application/json" } });
      if (!response.ok) {
        throw failed("Listing the drafts", response);
      }
      const summaries = (await response.json()) as FormDraftSummary[];
      return [...summaries].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async delete(id: string): Promise<void> {
      const response = await fetch(at(id), { method: "DELETE" });
      if (!response.ok && response.status !== 404) {
        throw failed("Deleting the draft", response);
      }
    }
  };
}
