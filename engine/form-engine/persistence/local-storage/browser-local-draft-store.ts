import { DraftError, type DraftStore, type FormDraft, type FormDraftSummary } from "../core/draft-store.js";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The error a draft key the store keeps for itself is refused with. */
export class ReservedDraftKeyError extends Error {
  public readonly code = "draft.reservedKey";
  constructor(public readonly draftId: string) {
    super(`The draft key ${JSON.stringify(draftId)} is reserved: keys starting with "__" belong to the store (its index).`);
    this.name = "ReservedDraftKeyError";
  }
}

/** Keys starting `__` are the store's own (`__index__`); a draft cannot be saved, read or removed under one. */
function assertDraftKey(id: string): void {
  if (typeof id === "string" && id.startsWith("__")) {
    throw new ReservedDraftKeyError(id);
  }
}

function summaryOf(draft: FormDraft): FormDraftSummary {
  return {
    id: draft.id,
    formId: draft.formId,
    formVersion: draft.formVersion,
    locale: draft.locale,
    updatedAt: draft.updatedAt
  };
}

export class BrowserLocalDraftStore implements DraftStore {
  constructor(
    private readonly storage: StorageLike,
    private readonly prefix = "draft:"
  ) {}

  public async save(draft: FormDraft): Promise<void> {
    assertDraftKey(draft.id);
    this.storage.setItem(`${this.prefix}${draft.id}`, JSON.stringify(draft));
  }

  public async load(id: string): Promise<FormDraft> {
    assertDraftKey(id);
    const payload = this.storage.getItem(`${this.prefix}${id}`);
    if (!payload) {
      throw new DraftError("draft.notFound", `Draft not found: ${id}`);
    }

    return JSON.parse(payload) as FormDraft;
  }

  public async list(): Promise<FormDraftSummary[]> {
    const indexPayload = this.storage.getItem(`${this.prefix}__index__`);
    if (!indexPayload) {
      return [];
    }

    const ids = JSON.parse(indexPayload) as string[];
    const drafts = await Promise.all(ids.map(async (id) => this.load(id)));

    return drafts
      .map(summaryOf)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public async delete(id: string): Promise<void> {
    assertDraftKey(id);
    this.storage.removeItem(`${this.prefix}${id}`);

    const indexPayload = this.storage.getItem(`${this.prefix}__index__`);
    if (!indexPayload) {
      return;
    }

    const ids = JSON.parse(indexPayload) as string[];
    const next = ids.filter((entry) => entry !== id);
    this.storage.setItem(`${this.prefix}__index__`, JSON.stringify(next));
  }

  public async rebuildIndex(ids: string[]): Promise<void> {
    // Explicit index rebuild keeps list() deterministic across browser engines.
    this.storage.setItem(`${this.prefix}__index__`, JSON.stringify([...new Set(ids)]));
  }
}
