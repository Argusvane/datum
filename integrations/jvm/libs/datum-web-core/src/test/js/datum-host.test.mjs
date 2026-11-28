// A regression test for the page glue (datum-host.js) with no browser: a fake fetch answers the host's endpoints,
// a small EventTarget stands in for <datum-form> and <datum-form-builder>, and the two bundles it imports are
// written as stub modules in a temporary directory. It proves the wire the Java side promises:
// what submit(), builder() and passkeys() send, and what they do with each answer.
//
// Run with `node --test src/test/js/datum-host.test.mjs` from libs/datum-web-core (it reads the glue from integrations/shared/glue/); GlueHarnessTest runs it from Maven when node 20+ is
// on the PATH. No dependencies: node:test, node:assert, and the platform's Response and CustomEvent.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GLUE = fileURLToPath(new URL('../../../../../../shared/glue/datum-host.js', import.meta.url));

// The page lives in a temporary directory so the glue's dynamic import of the bundles resolves to files.
const PAGE = mkdtempSync(join(tmpdir(), 'datum-glue-'));
mkdirSync(join(PAGE, 'assets', 'b1'), { recursive: true });
const BUNDLE = `
export const calls = [];
export function createWebAuthnSigningProvider(options) {
  return { sign: async (request) => { calls.push({ options, request }); return [{ webauthn: { credentialId: 'cred-1' } }]; } };
}
export async function registerCredential() { throw new Error('not used here'); }
export function toFormDefinition(json) { return json; }
export function formDefinitionProblem() { return ''; }
`;
writeFileSync(join(PAGE, 'assets', 'b1', 'datum-form.js'), BUNDLE);
writeFileSync(join(PAGE, 'assets', 'b1', 'datum-builder.js'), BUNDLE);

let imports = 0;

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** A page with a fake server: `routes` maps "METHOD /path?query" (relative to the page) to a handler. */
async function boot({ host = {}, routes = {}, cookie = 'XSRF-TOKEN=tok1' } = {}) {
  const seen = [];
  const hostJson = {
    buildId: 'b1',
    assetsBase: 'assets/b1',
    apiBase: 'api',
    csrf: { headerName: 'X-XSRF-TOKEN', cookieName: 'XSRF-TOKEN', metaName: '_csrf' },
    paths: { webauthn: 'api/webauthn' },
    ...host,
  };
  globalThis.window = Object.assign(new EventTarget(), {
    location: { href: pathToFileURL(join(PAGE, 'page.html')).href },
    isSecureContext: true,
    PublicKeyCredential: function PublicKeyCredential() {},
    navigator: { credentials: {} },
  });
  globalThis.document = {
    cookie,
    querySelector: () => null,
    createElement: () => {
      throw new Error('this test does not draw notices');
    },
  };
  globalThis.customElements = { whenDefined: async () => {} };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.href || input.url);
    const method = init.method || 'GET';
    const relative = url.href.slice(pathToFileURL(PAGE).href.length + 1);
    seen.push({ method, path: relative, headers: init.headers || {}, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    if (relative === 'assets/host.json' || url.pathname.endsWith('/host.json')) {
      return json(200, hostJson);
    }
    const handler = routes[`${method} ${relative}`];
    if (!handler) {
      return json(404, { errors: [{ code: 'not.found', message: `${method} ${relative}` }] });
    }
    return typeof handler === 'function' ? handler(seen[seen.length - 1]) : handler;
  };
  imports += 1;
  const { DatumHost } = await import(`${pathToFileURL(GLUE).href}?n=${imports}`);
  return { DatumHost, seen };
}

/** A stand-in for <datum-form> / <datum-form-builder>. */
function fakeElement(extra = {}) {
  const element = Object.assign(new EventTarget(), {
    isConnected: true,
    errors: [],
    notice: '',
    events: [],
    builder: {},
    setErrors(errors) {
      this.errors = errors;
    },
    setNotice(text) {
      this.notice = text;
    },
    hasUnsavedChanges: () => false,
    localeChangesSinceSave: () => ({ removed: [], renamed: [] }),
    markLocalesSaved() {},
    async submit() {
      return {};
    },
    previousElementSibling: null,
    nextElementSibling: null,
    values: {},
    ...extra,
  });
  for (const name of ['datum-host-accepted', 'datum-host-outdated', 'datum-host-saved']) {
    element.addEventListener(name, (event) => element.events.push({ name, detail: event.detail }));
  }
  return element;
}

/** Fires the engine's datum-submit and waits for the delivery the glue hangs on waitUntil. */
async function accept(element, submission, submissionKey = 'attempt-1') {
  const waits = [];
  const event = new CustomEvent('datum-submit', {
    detail: { accepted: true, submission, submissionKey, waitUntil: (promise) => waits.push(promise) },
  });
  Object.defineProperty(event, 'target', { value: element });
  element.dispatchEvent(event);
  await Promise.all(waits);
}

// ------------------------------------------------------------------------------------------------- submit()

test('submit() posts the accepted document with the CSRF header, and shows the receipt', async () => {
  const { DatumHost, seen } = await boot({
    routes: { 'POST api/submissions': json(200, { receipt: 'SUB-0001', handled: false }) },
  });
  const element = fakeElement();
  DatumHost.submit(element);
  await accept(element, { form: { id: 'intake' }, values: { a: 1 } });

  const post = seen.find((call) => call.method === 'POST');
  assert.equal(post.path, 'api/submissions');
  assert.equal(post.headers['X-XSRF-TOKEN'], 'tok1');
  assert.equal(post.headers['X-Datum-Form'], undefined);
  assert.deepEqual(post.body, { document: { form: { id: 'intake' }, values: { a: 1 } }, submissionKey: 'attempt-1' });
  assert.equal(element.notice, 'SUB-0001');
  assert.equal(element.events.at(-1).name, 'datum-host-accepted');
  assert.deepEqual(element.errors, []);
});

test('submit() maps the refusals onto the form and tells the page when the form is outdated', async () => {
  const { DatumHost } = await boot({
    routes: {
      'POST api/submissions': json(409, { errors: [{ code: 'form.outdated', message: 'Reload.' }] }),
    },
  });
  const element = fakeElement();
  DatumHost.submit(element, {});
  await accept(element, { values: {} });
  assert.deepEqual(element.errors, [{ code: 'form.outdated', message: 'Reload.' }]);
  assert.equal(element.events.at(-1).name, 'datum-host-outdated');

  const field = await boot({
    routes: { 'POST api/submissions': json(422, { errors: [{ code: 'required', field: 'name', message: 'Name is needed.' }] }) },
  });
  const other = fakeElement();
  field.DatumHost.submit(other, {});
  await accept(other, { values: {} });
  assert.deepEqual(other.errors, [{ code: 'required', componentId: 'name', message: 'Name is needed.' }]);
});

test('submit() asks once more when a 403 is the session token, not the form', async () => {
  let attempts = 0;
  const { DatumHost, seen } = await boot({
    routes: {
      'POST api/submissions': () => {
        attempts += 1;
        return attempts === 1 ? json(403, {}) : json(200, { receipt: 'SUB-0002' });
      },
    },
  });
  const element = fakeElement();
  DatumHost.submit(element, {});
  await accept(element, { values: {} });
  assert.equal(attempts, 2);
  assert.equal(seen.filter((call) => call.method === 'POST').length, 2);
  assert.equal(element.notice, 'SUB-0002');
});

test('submit() says the form could not be sent when the network fails', async () => {
  const { DatumHost } = await boot({
    routes: {
      'POST api/submissions': () => {
        throw new TypeError('offline');
      },
    },
  });
  const element = fakeElement();
  DatumHost.submit(element, {});
  await accept(element, { values: {} });
  assert.equal(element.errors[0].code, 'delivery.failed');
});

// ------------------------------------------------------------------------------------------------ builder()

const DEFINITION = { id: 'intake', version: '1', schemaVersion: '1', root: { id: 'root', type: 'form', children: { content: [] } } };

test('builder() loads the author copy and the catalog, and saves with If-Match', async () => {
  const { DatumHost, seen } = await boot({
    routes: {
      'GET api/forms/intake/definition?public=false': json(200, DEFINITION, { ETag: '"h1"' }),
      'GET api/forms/intake/translations': json(200, { catalog: { fr: { components: { a: { label: 'A' } } } } }, { ETag: '"c1"' }),
      'PUT api/forms/intake': json(200, { sha256: 'h2' }, { ETag: '"h2"' }),
    },
  });
  const element = fakeElement();
  const status = { textContent: '', dataset: {} };
  const handle = await DatumHost.builder(element, { formKey: 'intake', status });

  assert.deepEqual(element.definition, DEFINITION);
  assert.deepEqual(element.translations, { fr: { components: { a: { label: 'A' } } } });
  assert.equal(handle.sha256(), 'h1');
  assert.equal(status.textContent, 'Ready.');

  assert.equal(await handle.save(), true);
  const put = seen.find((call) => call.method === 'PUT');
  assert.equal(put.headers['If-Match'], '"h1"');
  assert.equal(put.headers['X-XSRF-TOKEN'], 'tok1');
  assert.equal(put.headers['X-Datum-Locale-Changes'], undefined);
  assert.deepEqual(put.body, DEFINITION);
  assert.equal(handle.sha256(), 'h2');
  assert.equal(element.events.at(-1).name, 'datum-host-saved');
  assert.equal(element.events.at(-1).detail.sha256, 'h2');
});

test('builder() sends locale changes, and reloads the catalog the server moved', async () => {
  let catalogReads = 0;
  const { DatumHost, seen } = await boot({
    routes: {
      'GET api/forms/intake/definition?public=false': json(200, DEFINITION, { ETag: '"h1"' }),
      'GET api/forms/intake/translations': () => {
        catalogReads += 1;
        return json(200, { catalog: catalogReads === 1 ? { fr: { form: { title: 'x' } }, de: { form: { title: 'y' } } } : { fr: { form: { title: 'x' } } } }, { ETag: `"c${catalogReads}"` });
      },
      'PUT api/forms/intake': json(200, {}, { ETag: '"h2"', 'X-Datum-Removed-Locales': 'de' }),
    },
  });
  const element = fakeElement({ localeChangesSinceSave: () => ({ removed: ['de'], renamed: [] }) });
  const handle = await DatumHost.builder(element, { formKey: 'intake' });
  assert.equal(await handle.save(), true);
  const put = seen.find((call) => call.method === 'PUT');
  assert.deepEqual(JSON.parse(put.headers['X-Datum-Locale-Changes']), { removed: ['de'], renamed: [] });
  assert.equal(catalogReads, 2);
  assert.deepEqual(element.translations, { fr: { form: { title: 'x' } } });
});

test('builder() refuses by status: 409 tells the page, 422 lists the errors, nothing is marked saved', async () => {
  const stale = await boot({
    routes: {
      'GET api/forms/intake/definition?public=false': json(200, DEFINITION, { ETag: '"h1"' }),
      'GET api/forms/intake/translations': json(404, {}),
      'PUT api/forms/intake': json(409, { errors: [{ code: 'form.outdated', message: 'Changed elsewhere.' }] }),
    },
  });
  const element = fakeElement();
  const status = { textContent: '', dataset: {} };
  const handle = await stale.DatumHost.builder(element, { formKey: 'intake', status });
  await assert.rejects(() => handle.save(), /Changed elsewhere/);
  assert.equal(element.events.at(-1).name, 'datum-host-outdated');
  assert.equal(status.dataset.kind, 'error');
  assert.equal(handle.sha256(), 'h1');

  const refused = await boot({
    routes: {
      'GET api/forms/intake/definition?public=false': json(200, DEFINITION, { ETag: '"h1"' }),
      'GET api/forms/intake/translations': json(404, {}),
      'PUT api/forms/intake': json(422, { errors: [{ code: 'pattern.risky', message: 'Risky.', where: 'rules:fx' }] }),
    },
  });
  const second = fakeElement();
  const again = await refused.DatumHost.builder(second, { formKey: 'intake' });
  await assert.rejects(() => again.save(), /Risky\. \(rules:fx\)/);
});

test('builder() creates a form that does not exist yet from the seed with POST', async () => {
  const { DatumHost, seen } = await boot({
    routes: {
      'GET api/forms/new-one/definition?public=false': json(404, { errors: [{ code: 'form.notFound' }] }),
      'GET api/forms/new-one/translations': json(404, {}),
      'POST api/forms': json(201, {}, { ETag: '"n1"' }),
    },
  });
  const element = fakeElement();
  const handle = await DatumHost.builder(element, { formKey: 'new-one', seed: { ...DEFINITION, id: 'seed' } });
  assert.equal(element.definition.id, 'new-one');
  assert.equal(await handle.save(), true);
  const post = seen.find((call) => call.method === 'POST');
  assert.equal(post.path, 'api/forms');
  assert.equal(post.headers['If-Match'], undefined);
  assert.equal(post.body.id, 'new-one');
  assert.equal(handle.sha256(), 'n1');
});

test('builder() says why it cannot start', async () => {
  const { DatumHost } = await boot({
    routes: { 'GET api/forms/secret/definition?public=false': json(403, { errors: [{ code: 'access.denied' }] }) },
  });
  const element = fakeElement();
  const status = { textContent: '', dataset: {} };
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(() => DatumHost.builder(element, { formKey: 'secret', status }), /you may not edit this form/);
  } finally {
    console.error = originalError;
  }
  assert.match(status.textContent, /^The builder could not start/);
  await assert.rejects(() => DatumHost.builder(fakeElement(), {}), /needs \{formKey\}/);
});

// ----------------------------------------------------------------------------------------------- passkeys()

const SIGNING = { mode: 'required', scope: 'envelope', placement: 'embedded', ready: true, rpId: 'example.test', register: true };

test('passkeys() reads the path host.json names, wires the provider, and signs with the passkeys it was told of', async () => {
  const { DatumHost, seen } = await boot({
    host: { paths: { webauthn: 'api/custom-passkeys' } },
    routes: {
      'GET api/custom-passkeys/passkeys?form=petition': json(200, { passkeys: [{ id: 'cred-1' }], signing: SIGNING }),
    },
  });
  const element = fakeElement();
  const handle = await DatumHost.passkeys(element, { formKey: 'petition' });
  assert.equal(seen.find((call) => call.path.includes('passkeys')).path, 'api/custom-passkeys/passkeys?form=petition');
  assert.equal(handle.signing.rpId, 'example.test');
  assert.equal(element.signWith, 'webauthn');
  assert.deepEqual(element.signing, { scope: 'envelope', placement: 'embedded' });
  assert.equal(element.signingProviders.length, 1);

  const results = await element.signingProviders[0].sign({ digest: 'd' });
  assert.equal(results[0].webauthn.credentialId, 'cred-1');
  assert.deepEqual(handle.headers(), {});
});

test('passkeys() is refused without paths.webauthn unless {endpoint} is given, and {endpoint} overrides paths', async () => {
  const none = await boot({ host: { paths: undefined } });
  await assert.rejects(() => none.DatumHost.passkeys(fakeElement(), { formKey: 'petition' }), /names no paths\.webauthn/);
  assert.equal(none.seen.some((call) => call.path.includes('passkeys')), false);

  const given = await boot({
    host: { paths: undefined },
    routes: { 'GET elsewhere/passkeys?form=petition': json(200, { passkeys: [], signing: SIGNING }) },
  });
  await given.DatumHost.passkeys(fakeElement(), { formKey: 'petition', endpoint: 'elsewhere' });
  assert.equal(given.seen.at(-1).path, 'elsewhere/passkeys?form=petition');

  const moved = await boot({
    host: { paths: { webauthn: 'api/custom' } },
    routes: { 'GET elsewhere/passkeys?form=petition': json(200, { passkeys: [], signing: SIGNING }) },
  });
  await moved.DatumHost.passkeys(fakeElement(), { formKey: 'petition', endpoint: 'elsewhere/' });
  assert.equal(moved.seen.at(-1).path, 'elsewhere/passkeys?form=petition');
});

test('passkeys() returns no signing for a form that does not sign and throws for a broken answer', async () => {
  const off = await boot({
    routes: { 'GET api/webauthn/passkeys?form=plain': json(404, { errors: [{ code: 'signing.off', message: 'Off.' }] }) },
  });
  const handle = await off.DatumHost.passkeys(fakeElement(), { formKey: 'plain' });
  assert.equal(handle.signing, null);
  assert.deepEqual(handle.headers(), {});

  const broken = await boot({
    routes: { 'GET api/webauthn/passkeys?form=bad': json(500, { errors: [{ message: 'Boom.' }] }) },
  });
  await assert.rejects(() => broken.DatumHost.passkeys(fakeElement(), { formKey: 'bad' }), /Boom\./);
  await assert.rejects(() => off.DatumHost.passkeys(fakeElement(), {}), /needs \{formKey\}/);
});

test('config() is read once and a failed read is asked for again', async () => {
  let reads = 0;
  const { DatumHost } = await boot({});
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('host.json')) {
      reads += 1;
      return reads === 1 ? json(500, {}) : original(input, init);
    }
    return original(input, init);
  };
  await assert.rejects(() => DatumHost.config(), /host\.json answered 500/);
  const config = await DatumHost.config();
  assert.equal(config.buildId, 'b1');
  await DatumHost.config();
  assert.equal(reads, 2);
});

test('binding() draws a form route with the host\'s binding: the route\'s override, else the default', async () => {
  const { DatumHost } = await boot({
    host: { bindings: { default: 'datum', routes: { benefits: 'gcds' }, catalog: [{ id: 'datum', label: 'Datum', pdfTheme: 'datum-pdf' }] } },
  });
  const benefits = fakeElement();
  const contact = fakeElement();
  assert.equal(await DatumHost.binding(benefits, { formKey: 'benefits' }), 'gcds');
  assert.equal(benefits.binding, 'gcds');
  assert.equal(await DatumHost.binding(contact, { formKey: 'contact' }), 'datum');
  assert.equal(contact.binding, 'datum');
  const toString = fakeElement();
  assert.equal(await DatumHost.binding(toString, { formKey: 'toString' }), 'datum', 'a key of Object.prototype is not a route');
});

test('binding() leaves the element alone when the host names no bindings', async () => {
  const { DatumHost } = await boot();
  const element = fakeElement();
  assert.equal(await DatumHost.binding(element, { formKey: 'contact' }), undefined);
  assert.equal('binding' in element, false);
});
