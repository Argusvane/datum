import type {
  PdfRenditionContribution,
  PdfRenditionDeclaration
} from "../../core/schema/contracts.js";

/**
 * Plugin-contributed PDF renditions, keyed by the component type they extend.
 * A plugin reaches here through `FormPlugin.pdfRenditions`; the rendition resolver consults
 * this registry after a type's own definition and before the engine's built-in table, so a
 * plugin can add a rendition to `text` without owning `text`.
 */
export class PdfRenditionRegistry {
  private readonly byType = new Map<string, Map<string, PdfRenditionDeclaration>>();

  public register(contribution: PdfRenditionContribution): void {
    const { componentType, rendition } = contribution;
    if (typeof componentType !== "string" || componentType === "") {
      throw new Error("PDF rendition contribution needs a componentType");
    }
    if (!rendition || typeof rendition.id !== "string" || rendition.id === "") {
      throw new Error(`PDF rendition for ${componentType} needs an id`);
    }
    if (typeof rendition.render !== "function") {
      throw new Error(`PDF rendition ${componentType}:${rendition.id} needs a render function`);
    }
    const renditions = this.byType.get(componentType) ?? new Map<string, PdfRenditionDeclaration>();
    if (renditions.has(rendition.id)) {
      throw new Error(`PDF rendition ${componentType}:${rendition.id} is already registered`);
    }
    renditions.set(rendition.id, rendition);
    this.byType.set(componentType, renditions);
  }

  /** The contributed renditions for a type, in registration order. */
  public list(componentType: string): PdfRenditionDeclaration[] {
    return [...(this.byType.get(componentType)?.values() ?? [])];
  }

  public resolve(componentType: string, renditionId: string): PdfRenditionDeclaration | undefined {
    return this.byType.get(componentType)?.get(renditionId);
  }

  public types(): string[] {
    return [...this.byType.keys()];
  }
}
