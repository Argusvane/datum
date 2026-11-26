import { InMemorySubmissionStore, createSubmissionService, parseValidateRequest, receiveResponse, validateResponse, errorResponse } from "@argusvane/datum-submissions";
import { createQuickJsValidator } from "@argusvane/datum-submissions/node";

const definition = {
  id: "visit-request", version: "1.0.0", schemaVersion: "1",
  root: { id: "root", type: "form", configuration: {}, children: { content: [
    { id: "fullName", type: "text", configuration: { label: "Full name", required: true } }
  ] } }
};

const validator = await createQuickJsValidator();   // the sandbox, on a worker thread
const service = createSubmissionService({ store: new InMemorySubmissionStore(), validator });
await service.register(definition);

// The two routes, as functions of a parsed JSON body.
async function deliver(body) {
  try { return receiveResponse(await service.receive(body, { source: "api" })); }
  catch (error) { return errorResponse(error) ?? { status: 500, body: {} }; }
}
async function check(body) {
  try { return validateResponse(await service.validate(parseValidateRequest(body))); }
  catch (error) { return errorResponse(error) ?? { status: 500, body: {} }; }
}

const envelope = (values) => ({
  versionContext: { form: { id: "visit-request", version: "1.0.0" }, client: { runtimeVersion: "1.0.0", rendererVersion: "1.0.0", schemaVersion: "1" } },
  submission: { locale: "en", values }
});

console.log(JSON.stringify(await check({ document: envelope({}), scope: "journey" })));
console.log(JSON.stringify(await deliver({ document: envelope({}), submissionKey: crypto.randomUUID() })));
const ok = await deliver({ document: envelope({ fullName: "Ada" }), submissionKey: crypto.randomUUID() });
console.log(ok.status, Object.keys(ok.body));
await validator.dispose();
