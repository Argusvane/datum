import {
  DraftError,
  type DraftStore,
  type FormDraft,
  type FormDraftSummary
} from "../core/draft-store.js";

export class InMemoryDraftStore implements DraftStore {
  private readonly drafts = new Map<string, FormDraft>();

  public async save(draft: FormDraft): Promise<void> {
    this.drafts.set(draft.id, structuredClone(draft));
  }

  public async load(id: string): Promise<FormDraft> {
    const draft = this.drafts.get(id);
    if (!draft) {
      throw new DraftError("draft.notFound", `Draft not found: ${id}`);
    }
    return structuredClone(draft);
  }

  public async list(): Promise<FormDraftSummary[]> {
    return [...this.drafts.values()]
      .map((draft) => ({
        id: draft.id,
        formId: draft.formId,
        formVersion: draft.formVersion,
        locale: draft.locale,
        updatedAt: draft.updatedAt
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public async delete(id: string): Promise<void> {
    this.drafts.delete(id);
  }
}
