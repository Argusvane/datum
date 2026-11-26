import { hostCase, type CapabilityModule } from "../case.js";
import { assume, check, expectCode, expectEqual, expectHeader, expectNotContains, expectStatus, textAt } from "../expect.js";
import { FORM, SECRET_MARKER, VERSION } from "../fixtures.js";
import { CSRF_TOKEN, DEFINITION_ROUTE, FIXTURE_FORM, REACHABLE } from "../preflight.js";

/**
 * FRM: the definition reads of the fixture form (the Java kit's FormsContract): the public copy
 * (never the server-secret rule) under the plain key and the catalog key `id@version` (as the
 * security suite's SEC-02 asks), its ETag and the 304 it earns, 404 form.notFound for a version
 * that is not current and for a form that does not exist, and, with the builder off, a 404 for the
 * author's copy (`?public=false`) that carries no ETag and none of the secret rule.
 */
const definition = (api: (path: string) => string, key: string): string => api(`/forms/${key}/definition`);

export const FORMS: CapabilityModule = {
  capability: "forms",
  probes: [REACHABLE, CSRF_TOKEN, DEFINITION_ROUTE, FIXTURE_FORM],
  cases: [
    hostCase({
      id: "FRM-01",
      capability: "forms",
      order: 1201,
      oracle: "FormsContract#thePublicCopyOfTheFormAnswers200WithoutTheServerSecretRule",
      expects: `GET <api>/forms/{${FORM}%40${VERSION} | ${FORM} | ${FORM}@${VERSION}}/definition -> 200 JSON with id ${FORM}, without "server-secret" or the fixture's secret marker; ${FORM}%402 -> 404 form.notFound`,
      async run(context) {
        for (const key of [`${FORM}%40${VERSION}`, FORM, `${FORM}@${VERSION}`]) {
          const reply = await context.http.get(definition(context.api, key));
          expectStatus(reply, 200, key);
          check(reply.mediaType().endsWith("json"), () => `${key}: the media type ${JSON.stringify(reply.mediaType())} does not end with json`);
          expectNotContains(reply.text(), "server-secret", key);
          expectNotContains(reply.text(), SECRET_MARKER, key);
          expectEqual(textAt(reply.json(), "id"), FORM, `${key}: id`);
        }
        const otherVersion = await context.http.get(definition(context.api, `${FORM}%402`));
        expectStatus(otherVersion, 404, "a version that is not current");
        expectCode(otherVersion, "form.notFound", "a version that is not current");
      }
    }),
    hostCase({
      id: "FRM-02",
      capability: "forms",
      order: 1202,
      oracle: "FormsContract#theDefinitionCarriesAnETagThatEarnsA304",
      expects: 'GET the definition -> 200 with ETag "<64 hex>"; again with If-None-Match: <etag> -> 304, the same ETag, an empty body',
      async run(context) {
        const reply = await context.http.get(definition(context.api, FORM));
        expectStatus(reply, 200);
        const etag = expectHeader(reply, "ETag");
        expectHeader(reply, "ETag", /"[0-9a-f]{64}"/);
        const again = await context.http.get(definition(context.api, FORM), "visitor", { "If-None-Match": etag });
        expectStatus(again, 304, "If-None-Match");
        expectHeader(again, "ETag", etag, "the 304");
        expectEqual(again.body.length, 0, "the 304's body length");
      }
    }),
    hostCase({
      id: "FRM-03",
      capability: "forms",
      order: 1203,
      oracle: "FormsContract#aFormThatDoesNotExistIs404",
      expects: "GET <api>/forms/datum-tck-no-such-form/definition -> 404 form.notFound",
      async run(context) {
        const reply = await context.http.get(definition(context.api, "datum-tck-no-such-form"));
        expectStatus(reply, 404);
        expectCode(reply, "form.notFound");
      }
    }),
    hostCase({
      id: "FRM-04",
      capability: "forms",
      order: 1204,
      oracle: "FormsContract#theAuthorsCopyIsNotServedWithTheBuilderOff",
      expects: `with the builder off (no --builder-enabled; skipped when it is on): GET <api>/forms/{${FORM} | ${FORM}@${VERSION} | datum-tck-no-such-form}/definition?public=false -> 404, no ETag header, a body without "server-secret" or the fixture's secret marker`,
      async run(context) {
        assume(!context.target.builderEnabled, "the builder is on: the builder contract reads the author's copy");
        for (const key of [FORM, `${FORM}@${VERSION}`, "datum-tck-no-such-form"]) {
          const reply = await context.http.get(`${definition(context.api, key)}?public=false`);
          expectStatus(reply, 404, key);
          expectNotContains(reply.text(), SECRET_MARKER, key);
          expectNotContains(reply.text(), "server-secret", key);
          check(reply.header("ETag") === undefined, () => `${key}: a 404 carries an ETag header: ${reply.describe()}`);
        }
      }
    })
  ]
};
