import { DraftError, type DraftStore, type FormDraft, type FormDraftSummary } from "../core/draft-store.js";

export interface DraftServerApi {
  saveDraft(draft: FormDraft): Promise<void>;
  loadDraft(id: string): Promise<FormDraft | undefined>;
  listDrafts(): Promise<FormDraftSummary[]>;
  deleteDraft(id: string): Promise<void>;
}

export class ServerDraftStore implements DraftStore {
  constructor(private readonly api: DraftServerApi) {}

  public async save(draft: FormDraft): Promise<void> {
    await this.api.saveDraft(structuredClone(draft));
  }

  public async load(id: string): Promise<FormDraft> {
    const draft = await this.api.loadDraft(id);
    if (!draft) {
      throw new DraftError("draft.notFound", `Draft not found: ${id}`);
    }

    return structuredClone(draft);
  }

  public async list(): Promise<FormDraftSummary[]> {
    const summaries = await this.api.listDrafts();
    return [...summaries].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public async delete(id: string): Promise<void> {
    await this.api.deleteDraft(id);
  }
}
