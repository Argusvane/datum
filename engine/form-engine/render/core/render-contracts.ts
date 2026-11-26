export type RenderMode = "interactive" | "readonly" | "pdf";

export interface ErrorPresentationConfiguration {
  showComponentErrors: boolean;
  showErrorSummary: boolean;
  errorSummaryPosition?: "top" | "bottom" | "custom";
  focusFirstError?: boolean;
}
