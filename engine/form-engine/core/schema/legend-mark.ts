/**
 * The legend mark a labelled group asks for (`configuration.legendMark`): `"required"` or
 * `"optional"`, drawn after the legend's words (announced, as a group has no required state
 * to carry it) so a design system's "(Required)" / "(Optional)" flag applies, and printed
 * after a PDF group's heading. Absent or anything else: no mark, the legend as it always was.
 * Presentational only: it is not the field `required` flag, so it makes no child required,
 * raises no error and never reaches the validators; it is a distinct key for that reason
 * (`required: true` on a container would be collected as a constraint).
 */
export function readLegendMark(configuration: unknown): "required" | "optional" | undefined {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return undefined;
  }
  const mark = (configuration as Record<string, unknown>)["legendMark"];
  return mark === "required" || mark === "optional" ? mark : undefined;
}
