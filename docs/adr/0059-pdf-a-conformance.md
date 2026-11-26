# ADR 0059: PDF/A Conformance — Archival Documents From the Same Kernel

## Status
Accepted.

## Context
A form platform's PDFs are records. Records management asks for ISO 19005 — PDF/A — which is what
the `tagged` switch explicitly is not (ADR 0043 §7, [`docs/pdf-tagging.md`](../pdf-tagging.md)):
no XMP packet declaring a level, no output intent with an ICC profile, and a fallback to the
unembedded standard 14 fonts whenever a family has no resource.

Almost everything PDF/A needs is there already: every font a resource covers is embedded as a
subset, bytes are deterministic, the trailer `/ID`, `/Lang`, the title and both dates come from
the request, the structure tree is optional. What remains is a short list of things `pdf-lib`
leaves out of a conforming file, a font policy, and a way to say which level a document declares —
on the layout, where `accessibility` already lives, with the theme as a fallback and a per-render
override, so the browser, Node and the Java / .NET hosts (ADR 0043) all get the same file from the
same layout.

Two constraints shape the kernel side. `@cantoo/pdf-lib` ships a `convertToPDFA()`, but its
metadata sync runs on every save and goes through `new Date()`, which the sandbox forbids (ADR
0043 §3, ADR 0029); and the same request must yield the same bytes in-process and in QuickJS.
Everything below is strings and bytes from `env`. The configuration and the pass, as an author or
host meets them, are in [`docs/pdf-rendering.md`](../pdf-rendering.md#conformance-pdfa).

## Decision
1. **A `conformance` block on the layout, the theme as fallback, the render options as
   override.** `PdfGeneratedLayout.conformance` and `PdfTemplateLayout.conformance` carry
   `{ pdfa?, outputIntent?, attachData?, attachment? }`; `pdfa` is one of `2b`, `2u`, `2a`, `3b`,
   `3u`, `3a` (ISO 19005-2 and -3; part 1 is only ever *kept* from a template).
   `PdfThemeSettings.pdfa` and `.outputIntent` default the level and the output condition for every
   layout under the theme, each tier on its own — a layout may set the level and inherit the
   theme's profile — resolved exactly as `tagged` is. `PdfRenderOptions.pdfa` overrides the level
   for one render, or `false` turns it off. `resolvePdfConformance` reads the block tolerantly;
   `validatePdfLayout` names what is wrong with one.

2. **The model and the fill plan carry the claim; the kernel keeps it.** `PdfDocument.conformance`
   and `PdfFillPlan.conformance` cross the ABI; the program's `document` op builds them itself.
   `kernel/pdfa.ts` runs after the last drawing and appearance operation and before `save`,
   because that is when fonts are frozen; what it writes is listed in the guide.

3. **The output condition is configurable and derived where it can be.** Absent an
   `outputIntent`, the document declares sRGB IEC61966-2.1 with the profile pdf-lib bundles
   (already in the program: no bundle growth). A configured one names its ICC profile as the same
   attachment envelope a template travels in (`PdfAssetSource`), and the number of colour
   components is read from the profile's header, never authored. Under a Gray or CMYK intent —
   a configured one, or a template's own — every page and appearance stream the kernel drew gets
   `/ColorSpace /DefaultRGB [/ICCBased sRGB]`, since everything the kernel draws is DeviceRGB. A
   profile that cannot be resolved or is not an ICC profile falls back to sRGB with a warning
   (`pdfa.outputIntent`): a conformant file under a different condition, never a false claim.

4. **Three output conditions come with the kernel; a host may list more.** An organisation asked
   for PDF/A rarely has an ICC profile to hand, so the kernel carries sRGB IEC61966-2.1 (the HP
   profile pdf-lib bundles), pdf.js's compact CGATS TR 001 (SWOP) compatible CMYK profile (CC0,
   vendored as a base64 module with its device class set to `prtr`, since the file calls itself a
   scanner profile and an output intent must be an output or monitor one) and a grey one it builds
   itself (`grayGamma22Profile`). veraPDF accepts all three. They are named as an envelope with
   `storage: "builtin"` and `ref` (`srgb` / `gray` / `cmyk`), the same shape every other asset
   has, and the kernel resolves them itself (`kernel/profiles.ts`), so the same bytes come out on
   every host and the engine's resolver skips them. Press-grade profiles (1–2 MB each) stay out of
   the program: a host lists its own through the template resolver's `listProfiles()`.

5. **The designer authors the profile.** The property editor has a `file` field type: a pick is
   read into the attachment envelope embedded files already use, and one that is not an ICC
   profile — by `accept`, then by the bytes — is refused in place. `readIccColorSpace`
   (`core/schema/pdf-layout.ts`) is the one reader the designer, `validatePdfLayout` and the
   kernel share.

6. **Fonts are strict under a claim.** A `FontSet` in strict mode throws `font` for a family with
   no resource instead of falling back to the standard 14, and replaces a character no supplied
   font covers with `?` (warning `font.unencodable`) instead of letting pdf-lib draw `.notdef` — a
   glyph with no Unicode mapping, which the "u" levels forbid. The fill path's appearance fonts
   follow the same rule. CFF/OpenType faces embed too. A CFF subset is a bare
   `CIDFontType0C` whose CIDs are its glyph ids, so its descriptor gets a `CIDSet` from the CFF's
   `CharStrings` count (an OpenType-wrapped program: from `maxp`) and no `Length1`, and the
   `CIDToGIDMap` pdf-lib writes beside it, which means nothing there, is deleted.

7. **A template keeps its own claim; the kernel never invents one.** `fill` reads the level the
   template declares in its XMP. With none, the template is filled as any PDF and the reply
   carries no `pdfa`, with `pdfa.template` saying why. A declared level is the claim, raised from
   part 2 to 3 when the layout asks for 3 (part 3 differs from 2 only in allowing attachments)
   and keeping the template's level letter (a layout asking "u" on a "b" template gets
   `pdfa.level` and "b": "u" is a promise about text the template already has). A part-1
   template stays part 1, and the template's output intent stays. An appearance the kernel cannot
   regenerate, or an encrypted template, is a `conformance` error rather than a warning, since
   either would break the claim. Everything a template already contained is trusted as the
   template declares it; the kernel vouches for what it adds.

8. **The submission as an associated file (part 3).** `attachData: true` under `3b` / `3u` / `3a`
   embeds the answers as `application/json` — `{ form, layout, locale, values }` through
   `kernelStableStringify`, so both hosts embed the same bytes — as `/AFRelationship /Data`. Under
   part 2 nothing is attached and `pdfa.attachments` says so. The kernel writes the file
   specification itself: pdf-lib's `attach()` takes `Date` objects.

9. **Level "a" is what ISO 19005 asks, not PDF/UA.** veraPDF's PDF/A-2A profile adds seven rules
   over 2U (`MarkInfo/Marked`, a `StructTreeRoot`, three role-map sanity rules, a `/Lang` that is
   a language tag, and `ActualText` for Private Use Area glyphs) plus the letter itself, and the
   kernel's tagged output already met all but the letter. So the claim is made honest rather than
   validated: under "a" a generated document is tagged whatever `accessibility.tagged` or
   `options.tagged` says (`pdfa.tagged` when that overrode an explicit off), a PUA character is
   replaced with `?` like an uncovered one (`font.privateUse`), and `applyPdfA` checks the catalog
   for the tree, the mark and a `/Lang` matching veraPDF's own test (empty, or
   `^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$`) — failing which the letter
   drops to "u" with `pdfa.level`, since a level-"a" file is level-"u" by construction. The tree
   stays what ADR 0043 §7 made it: best-effort structure; `docs/pdf-tagging.md` lists what PDF/UA
   would ask beyond it.

10. **A fill under "a" tags what it adds into the template's own tree** (`ExistingTagging`,
    `kernel/tagging.ts`), rather than demoting every "a" fill. Two shapes are declined rather than
    mishandled, both dropping the letter to "u" with `pdfa.level`: a `ParentTree` with `Kids` (a
    number tree this kernel does not rebalance) and `flatten: true` (flattened appearances become
    page content no element owns, and their `OBJR`s would dangle). A fill that adds nothing
    untagged keeps the template's level.

11. **veraPDF is the test.** The structural assertions (`tests/kernel-pdfa.test.ts`) say what the
    file contains; `tests/verapdf.test.ts` runs the reference validator at the level each fixture
    declares, and is skipped when `verapdf` is not installed, so the suite needs no Java. The parity suite holds a PDF/A render and fill byte-identical in
    QuickJS, and the bundle test makes one where `Date` throws.

## Consequences
- A layout that declares a level produces a file veraPDF accepts at that level, in the browser,
  in Node and on every host running the program; a template that is PDF/A stays PDF/A through a
  fill, and the designer says which templates are.
- Bytes for a document that declares nothing are unchanged.
- Strictness is the price of the claim: a host that ships no font resources gets a `font` error
  instead of Helvetica. The browser path always carries the DejaVu pack and the server samples
  list their fonts, so it fires only when fonts were really left out.
