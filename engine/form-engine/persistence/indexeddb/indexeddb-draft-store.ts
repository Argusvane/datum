import { DraftError, type DraftStore, type FormDraft, type FormDraftSummary } from "../core/draft-store.js";

export interface IndexedDraftRepository {
  put(draft: FormDraft): Promise<void>;
  get(id: string): Promise<FormDraft | undefined>;
  list(): Promise<FormDraft[]>;
  delete(id: string): Promise<void>;
}

export class IndexedDbDraftStore implements DraftStore {
  constructor(private readonly repository: IndexedDraftRepository) {}

  public async save(draft: FormDraft): Promise<void> {
    await this.repository.put(structuredClone(draft));
  }

  public async load(id: string): Promise<FormDraft> {
    const draft = await this.repository.get(id);
    if (!draft) {
      throw new DraftError("draft.notFound", `Draft not found: ${id}`);
    }

    return structuredClone(draft);
  }

  public async list(): Promise<FormDraftSummary[]> {
    const drafts = await this.repository.list();

    return drafts
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
    await this.repository.delete(id);
  }
}
