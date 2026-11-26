# Architecture decision records

One file per decision. Each explains how the thing works and, where there was a real choice, the reasoning. Numbers are never reused; gaps are decisions that were merged into another record or removed.

| ADR | Title | Status |
|---|---|---|
| 0001 | [Foundations](0001-architecture-constraints.md) | Accepted |
| 0028 | [Builder Preview Through the Shared Form Renderer](0028-builder-preview-through-the-shared-form-renderer.md) | Accepted |
| 0029 | [QuickJS/WASM Sandbox — real engine, portable kernel, plugin modules](0029-quickjs-wasm-sandbox.md) | Accepted |
| 0033 | [Grid Columns Are One Property](0033-grid-columns-one-property.md) | Accepted |
| 0034 | [File Upload Stores Through a Named Storage Kind](0034-file-upload-storage-kinds.md) | Accepted |
| 0035 | [Print: the read-only rendition, a live form, and print drawn apart from the live binding](0035-print-through-the-readonly-rendition.md) | Accepted |
| 0037 | [Inline Options and Wiring-Time Data Sources](0037-inline-options-and-wiring-time-data-sources.md) | Accepted |
| 0038 | [Embeddable Web Components and the Contained Builder Layout](0038-embeddable-web-components-and-contained-builder-layout.md) | Accepted |
| 0043 | [PDF Rendering — Portable Kernel, Renditions, Layouts, Templates](0043-pdf-rendering-portable-kernel.md) | Accepted |
| 0044 | [PDF layouts: several per form, chosen by the answers, and where a template's PDF comes from](0044-several-pdf-layouts-per-form.md) | Accepted |
| 0045 | [One builder for HTML and PDF; a slim renderer with optional PDF](0045-one-builder-for-html-and-pdf-slim-renderer.md) | Accepted |
| 0046 | [Sandboxed validation in the embeddable form](0046-sandboxed-validation-in-the-embeddable-form.md) | Accepted |
| 0048 | [Pluggable icon sets; Font Awesome as a package](0048-pluggable-icon-sets.md) | Accepted |
| 0049 | [Authored validation messages on the component tree](0049-authored-validation-messages.md) | Accepted |
| 0050 | [The sandbox run log](0050-sandbox-run-log.md) | Accepted |
| 0052 | [Submission: in flight, the receipt, host-supplied errors and the download action](0052-submission-in-flight-and-receipt.md) | Accepted |
| 0055 | [Settled change events and answer writes](0055-settled-change-notification.md) | Accepted |
| 0057 | [Template layouts: areas, page imagery, encrypted templates and export values](0057-template-areas-and-page-imagery.md) | Accepted |
| 0059 | [PDF/A Conformance — Archival Documents From the Same Kernel](0059-pdf-a-conformance.md) | Accepted |
| 0060 | [Uploaded Files as Embedded Files in the Rendered PDF](0060-uploaded-files-as-pdf-attachments.md) | Accepted |
| 0061 | [PDF Digital Signatures — The Server's Seal on Its Own Record](0061-pdf-digital-signatures.md) | Accepted |
| 0062 | [The local signing agent: hardware tokens and certificate files](0062-pdf-signing-with-a-hardware-token-from-the-browser.md) | Accepted |
| 0063 | [WebAuthn-Signed Submissions: Passkeys and Security Keys as Signers, and What a Signer Says](0063-webauthn-signed-submissions.md) | Accepted |
| 0064 | [A Submissions Service: `@argusvane/datum-submissions`](0064-submissions-service.md) | Accepted |
| 0066 | [Form Chrome Parts and Form-Authored Header and Footer](0066-form-chrome-parts-and-form-authored-regions.md) | Accepted |
| 0067 | [The Marketing Site in site/](0067-static-marketing-site.md) | Accepted |
| 0068 | [Form Frames — `chrome.frame` with Binding-Defined Presets](0068-form-frames-and-binding-defined-presets.md) | Accepted |
| 0079 | [Character count, prefix and suffix](0079-character-count-prefix-and-suffix.md) | Accepted |
| 0081 | [Steps Container](0081-steps-container.md) | Accepted |
| 0095 | [Host-wired components and plugins](0095-host-wired-components-and-plugins.md) | Accepted |
| 0098 | [PDF theme geometry, hints, fonts and the form look](0098-pdf-theme-geometry-and-theme-fonts.md) | Accepted |
| 0099 | [The Studio builder shell: one bar, the strip, drawers over the canvas, remembered panels](0099-studio-builder-shell.md) | Accepted |
| 0100 | [A command palette for the builder](0100-command-palette.md) | Accepted |
| 0103 | [Panels on the activity strip: form settings, header and footer, variables, view and settings](0103-panels-on-the-activity-strip.md) | Accepted |
| 0109 | [Data keys — where an answer is stored, apart from the component's id](0109-data-keys.md) | Accepted |
| 0110 | [The data model: reading a form's data, and building a form from a sample or a schema](0110-the-data-model.md) | Accepted |
| 0111 | [The inspector: its subject, its drafts and its problems](0111-the-inspector-its-subject-drafts-and-problems.md) | Accepted |
| 0112 | [Journeys — multi-page flows over one form](0112-journeys-multi-page-flows-over-one-form.md) | Accepted |
| 0115 | [Journeys in the builder](0115-journeys-in-the-builder.md) | Accepted |
| 0117 | [Form fields from a fillable PDF](0117-form-fields-from-a-fillable-pdf.md) | Accepted |
| 0118 | [File actions on the builder's bar, and the builder's look for host controls](0118-file-actions-on-the-builders-bar-and-its-look-for-host-controls.md) | Accepted |
| 0119 | [The journey map: a flow map that edits the journey, and Try it draws the same map](0119-a-flow-map-of-the-journey-in-the-builder.md) | Accepted |
| 0120 | [Rules that add checks: Required when and Validate](0120-rules-that-add-checks.md) | Accepted |
| 0121 | [Journey-only fields](0121-journey-only-fields.md) | Accepted |
| 0122 | [Number and date answers are checked](0122-number-and-date-answers-are-checked.md) | Accepted |
| 0123 | [Button groups](0123-button-groups.md) | Accepted |
| 0124 | [The studio look and its tokens](0124-the-studio-look.md) | Accepted |
| 0125 | [Builder workspaces](0125-builder-workspaces.md) | Accepted |
| 0126 | [The Form workspace](0126-the-form-workspace.md) | Accepted |
| 0127 | [The Logic and Data workspaces](0127-the-logic-and-data-workspaces.md) | Accepted |
| 0137 | [The builder's phone tier](0137-the-builder-phone-tier.md) | Accepted |
| 0139 | [Formulas: rules as FEEL text, if/then/else, emptiness, dates and a clock](0139-formulas-rules-as-feel-text.md) | Accepted |
| 0140 | [The formula builder](0140-the-formula-builder.md) | Accepted |
| 0141 | [Try it on the builder's canvas](0141-try-it-on-the-builders-canvas.md) | Accepted |
| 0142 | [The validation gate fails closed](0142-the-validation-gate-fails-closed.md) | Accepted |
| 0143 | [The `features` model and the lazy splits](0143-the-features-model-and-lazy-splits.md) | Accepted |
| 0144 | [A journey engine seam, with the journeys runtime loaded on demand](0144-a-journey-engine-seam-with-the-journeys-runtime-loaded-on-demand.md) | Accepted |
| 0151 | [A security suite for the validation gate](0151-a-security-suite-for-the-validation-gate.md) | Accepted |
| 0152 | [A Spring Boot host as capability modules on shared JVM libraries](0152-a-spring-boot-host-as-capability-modules-on-shared-jvm-libraries.md) | Accepted |
| 0153 | [A data grid container](0153-a-data-grid-container.md) | Accepted |
| 0154 | [Form tests: scenarios over rules, journeys and verdicts](0154-form-tests-scenarios-over-rules-journeys-and-verdicts.md) | Accepted |
| 0155 | [Agent tools over the form and the builder](0155-agent-tools-over-the-form-and-the-builder.md) | Accepted |
| 0157 | [A dark mode for the builder](0157-a-dark-mode-for-the-builder.md) | Accepted |
| 0158 | [Translations as a Section of the Definition, and the Languages Workspace](0158-translations-as-a-section-of-the-definition.md) | Accepted |
| 0162 | [The renderer is a lit-html update step, and the binding contract](0162-the-binding-contract-and-the-ownership-rule.md) | Accepted |
| 0163 | [The Datum binding: its look, its surface and its customization seams](0163-the-datum-binding-and-its-customization-seams.md) | Accepted |
| 0164 | [Design-system files in the form's shadow root, and the reference bindings](0164-design-system-files-in-the-forms-shadow-root.md) | Accepted |
| 0167 | [Air-Gapped Deployments Are Checked, Packed and Bundled](0167-air-gapped-deployments.md) | Accepted |
| 0169 | [The Engine Entry](0169-the-engine-entry.md) | Accepted |
| 0171 | [The Step view draws one step on the form's own canvas](0171-the-step-view-on-the-form-canvas.md) | Accepted |
| 0172 | [The Check answers step](0172-the-check-answers-step.md) | Accepted |
| 0174 | [Print configuration and the Print workspace](0174-print-configuration-and-the-print-workspace.md) | Accepted |
| 0175 | [The MIT licence and package names under Argusvane](0175-the-mit-licence-and-package-names.md) | Accepted |
| 0176 | [One sandbox library per server language for the WebAssembly programs](0176-one-sandbox-library-per-server-language.md) | Accepted |
| 0178 | [The fold and server parity](0178-the-fold-and-server-parity.md) | Accepted |
| 0179 | [Builder interaction patterns: toolbars, confirmations, dialogs and leaving](0179-builder-interaction-patterns.md) | Accepted |
| 0180 | [Undo of catalog actions](0180-undo-of-catalog-actions.md) | Accepted |
| 0181 | [A fresh sandbox for every server call](0181-a-fresh-sandbox-for-every-server-call.md) | Accepted |
