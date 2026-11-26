import { hostCase, type CapabilityModule, type CaseContext } from "../case.js";
import { check, expectContains, expectEqual, expectHeader, expectStatus, textAt } from "../expect.js";
import { has, path } from "../json.js";
import { ASSETS_ROUTE, REACHABLE } from "../preflight.js";

/**
 * AST: story two's browser half (the Java kit's AssetsContract): host.json names the versioned
 * assets base and the API base, the form's bundles are served immutable under the build id, the
 * page glue is served, and the builder's files stay away unless the builder is on (--builder-enabled),
 * by no other spelling either. Over the wire a server may refuse a dot segment itself (400) before
 * Datum sees it; either way nothing is served. The dot-segment spellings go out as written (the
 * client never normalises a path).
 */
async function host(context: CaseContext): Promise<unknown> {
  const reply = await context.http.get(`${context.target.assetsPath}/host.json`);
  expectStatus(reply, 200, "host.json");
  check(reply.mediaType().endsWith("json"), () => `host.json: the media type ${JSON.stringify(reply.mediaType())} does not end with json`);
  return reply.json();
}

async function assetsBase(context: CaseContext): Promise<string> {
  return textAt(await host(context), "assetsBase");
}

export const ASSETS: CapabilityModule = {
  capability: "assets",
  probes: [REACHABLE, ASSETS_ROUTE],
  cases: [
    hostCase({
      id: "AST-01",
      capability: "assets",
      order: 1301,
      oracle: "AssetsContract#hostJsonNamesTheBuildTheAssetsAndTheApi",
      expects: "GET <assets>/host.json -> 200 JSON: a buildId, an assetsBase ending in /<buildId>, an apiBase member, csrf.headerName",
      async run(context) {
        const json = await host(context);
        const buildId = textAt(json, "buildId");
        check(buildId.trim() !== "", "host.json: the buildId is blank");
        check(textAt(json, "assetsBase").endsWith(`/${buildId}`), () => `host.json: assetsBase ${JSON.stringify(textAt(json, "assetsBase"))} does not end with /${buildId}`);
        check(has(json, "apiBase"), () => `host.json has no apiBase: ${JSON.stringify(json)}`);
        check(has(path(json, "csrf"), "headerName"), () => `host.json has no csrf.headerName: ${JSON.stringify(json)}`);
      }
    }),
    hostCase({
      id: "AST-02",
      capability: "assets",
      order: 1302,
      oracle: "AssetsContract#theFormsBundlesAreServedImmutableUnderTheBuildId",
      expects: "GET <assetsBase>/datum-form.js -> 200 text/javascript, Cache-Control immutable, a body; <assetsBase>/datum-wasm.js -> 200",
      async run(context) {
        const base = await assetsBase(context);
        const form = await context.http.get(`${base}/datum-form.js`);
        expectStatus(form, 200, "datum-form.js");
        expectEqual(form.mediaType(), "text/javascript", "datum-form.js media type");
        expectHeader(form, "Cache-Control", (value) => value.includes("immutable"), "datum-form.js");
        check(form.body.length > 0, "datum-form.js: the body is empty");
        expectStatus(await context.http.get(`${base}/datum-wasm.js`), 200, "datum-wasm.js");
      }
    }),
    hostCase({
      id: "AST-03",
      capability: "assets",
      order: 1303,
      oracle: "AssetsContract#theGlueIsServed",
      expects: "GET <assets>/datum-host.js -> 200 text/javascript holding DatumHost and If-Match",
      async run(context) {
        const glue = await context.http.get(`${context.target.assetsPath}/datum-host.js`);
        expectStatus(glue, 200, "datum-host.js");
        expectEqual(glue.mediaType(), "text/javascript", "datum-host.js media type");
        expectContains(glue.text(), "DatumHost", "datum-host.js");
        expectContains(glue.text(), "If-Match", "datum-host.js");
      }
    }),
    hostCase({
      id: "AST-04",
      capability: "assets",
      order: 1304,
      oracle: "AssetsContract#theBuildersFilesFollowTheSwitch",
      expects: "GET <assetsBase>/datum-builder.js -> 200 with --builder-enabled, else 404; with the builder off, DATUM-BUILDER.JS, datum-builder-not-in-the-list.js and builder-fonts/geist-variable.woff2 -> 404, sub/../datum-builder.js and datum-builder.js%2e -> 400 or 404",
      async run(context) {
        const base = await assetsBase(context);
        const builderOn = context.target.builderEnabled;
        expectStatus(await context.http.get(`${base}/datum-builder.js`), builderOn ? 200 : 404, `datum-builder.js with the builder ${builderOn ? "on" : "off"}`);
        if (!builderOn) {
          for (const spelling of ["DATUM-BUILDER.JS", "datum-builder-not-in-the-list.js", "builder-fonts/geist-variable.woff2"]) {
            expectStatus(await context.http.get(`${base}/${spelling}`), 404, spelling);
          }
          for (const spelling of ["sub/../datum-builder.js", "datum-builder.js%2e"]) {
            expectStatus(await context.http.get(`${base}/${spelling}`), [400, 404], spelling);
          }
        }
      }
    }),
    hostCase({
      id: "AST-05",
      capability: "assets",
      order: 1305,
      oracle: "AssetsContract#aWrongBuildIdAndAPathOutOfTheAssetsAreNotFound",
      expects: "GET <assets>/nope/datum-form.js -> 404; <assetsBase>/../manifest.json, /%2e%2e/manifest.json, /sub/../../manifest.json -> 400 or 404",
      async run(context) {
        expectStatus(await context.http.get(`${context.target.assetsPath}/nope/datum-form.js`), 404, "a wrong build id");
        const base = await assetsBase(context);
        // Over the wire a server may refuse a dot segment itself (400) before Datum sees it; either way nothing is served.
        for (const segment of ["/../manifest.json", "/%2e%2e/manifest.json", "/sub/../../manifest.json"]) {
          expectStatus(await context.http.get(`${base}${segment}`), [400, 404], segment);
        }
      }
    })
  ]
};
