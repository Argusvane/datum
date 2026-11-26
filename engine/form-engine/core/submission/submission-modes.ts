export interface SubmissionMode {
  id: string;
  validate: boolean;
  sign: boolean;
  serverValidation: boolean;
}

export class SubmissionModeRegistry {
  private readonly modes = new Map<string, SubmissionMode>();

  public register(mode: SubmissionMode): void {
    if (this.modes.has(mode.id)) {
      throw new Error(`Submission mode already exists: ${mode.id}`);
    }
    this.modes.set(mode.id, mode);
  }

  public resolve(modeId: string): SubmissionMode {
    const mode = this.modes.get(modeId);
    if (!mode) {
      throw new Error(`Unknown submission mode: ${modeId}`);
    }
    return mode;
  }
}
