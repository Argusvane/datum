/**
 * The live examples the docs pages place, by the name a page gives `<LiveExample name="…">`.
 * Adding one is adding a spec file beside the others and a line here.
 */
import { bootstrapExample } from "./bootstrap";
import { builderExample } from "./builder";
import { builderSaveExample } from "./builder-save";
import { iconsFontawesomeExample } from "./icons-fontawesome";
import { iconsLibraryExample } from "./icons-library";
import { pluginExample } from "./plugin";
import { togetherExample } from "./together";
import { chromeExample } from "./chrome";
import { slowSubmitExample } from "./slow-submit";
import { featuresExample } from "./features";
import { formExample } from "./form";
import { iframeExample } from "./iframe";
import { journeyExample } from "./journey";
import { journeyServerCheckExample } from "./journey-server-check";
import { wasmExample } from "./wasm";
import { languagesBuilderWordsExample } from "./languages-builder-words";
import { languagesCatalogExample } from "./languages-catalog";
import { languagesDataSourcesExample } from "./languages-data-sources";
import { languagesFormExample } from "./languages-form";
import { languagesSaveExample } from "./languages-save";
import { testsExample } from "./tests";
import { serverValidateExample } from "./server-validate";
import { serverPdfExample } from "./server-pdf";
import { serverFillExample } from "./server-fill";
import { serverSignExample } from "./server-sign";
import type { ExampleSpec } from "./types";
import { yubikeySignExample } from "./yubikey-sign";

export const EXAMPLES: Record<string, ExampleSpec> = {
  tests: testsExample,
  "server-validate": serverValidateExample,
  "server-pdf": serverPdfExample,
  "server-fill": serverFillExample,
  "server-sign": serverSignExample,
  "yubikey-sign": yubikeySignExample,
  form: formExample,
  builder: builderExample,
  together: togetherExample,
  "builder-save": builderSaveExample,
  plugin: pluginExample,
  "icons-fontawesome": iconsFontawesomeExample,
  "icons-library": iconsLibraryExample,
  features: featuresExample,
  bootstrap: bootstrapExample,
  iframe: iframeExample,
  wasm: wasmExample,
  journey: journeyExample,
  "journey-server-check": journeyServerCheckExample,
  chrome: chromeExample,
  "slow-submit": slowSubmitExample,
  "languages-form": languagesFormExample,
  "languages-catalog": languagesCatalogExample,
  "languages-data-sources": languagesDataSourcesExample,
  "languages-save": languagesSaveExample,
  "languages-builder-words": languagesBuilderWordsExample
};
