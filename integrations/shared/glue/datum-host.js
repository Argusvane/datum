/**
 * Datum page glue for a server-rendered host (thin, optional).
 *
 * The application writes its own pages and sets every element attribute itself; this script only saves the
 * plumbing a page would otherwise copy: loading the bundle from the versioned assets path, the CSRF token,
 * and wiring a <datum-form> to the submissions endpoint. Load it as a module from the assets path:
 *
 *   <script type="module" src="/datum/assets/datum-host.js"></script>
 *   <script type="module">
 *     await DatumHost.load({ bundle: 'form' });
 *     DatumHost.submit(document.querySelector('#f'));
 *   </script>
 *
 * It sits beside host.json (no-store: buildId, assetsBase, apiBase, the CSRF names and the bindings table), which it reads once.
 * Nothing here depends on a CMS or a framework's page model. Also exported as a module (`import { DatumHost } from '.../datum-host.js'`).
 */

const HOST_JSON = new URL('host.json', import.meta.url);
const SUBMIT_TIMEOUT_MS = 30000;
const DATA_SOURCE_TIMEOUT_MS = 8000;
const DATA_SOURCE_RETRY_MS = 30000;

let configPromise;
const bundles = new Map();

/**
 * host.json, fetched once (a failed fetch is forgotten, so the next call asks again).
 * @returns {Promise<{buildId: string, assetsBase: string, apiBase: string, csrf: {headerName: string, cookieName: string, metaName: string}, bindings?: {default: string, routes: Object<string, string>, catalog: Array<{id: string, label: string, pdfTheme?: string}>}}>}
 */
function config() {
  if (!configPromise) {
    configPromise = (async () => {
      const response = await fetch(HOST_JSON, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`Datum: host.json answered ${response.status}.`);
      }
      return response.json();
    })().catch((error) => {
      configPromise = undefined;
      throw error;
    });
  }
  return configPromise;
}

function absolute(path) {
  return new URL(path, window.location.href);
}

/**
 * Imports a bundle from the versioned assets path and resolves to its module.
 * 'form' is datum-form.js; 'builder' is datum-builder.js, which defines <datum-form> too.
 *
 * @param {{bundle?: 'form'|'builder'}} [options]
 */
async function load({ bundle = 'form' } = {}) {
  if (bundle !== 'form' && bundle !== 'builder') {
    throw new Error(`Datum: unknown bundle "${bundle}" (use "form" or "builder").`);
  }
  if (!bundles.has(bundle)) {
    const loading = config()
      .then((host) => import(absolute(`${host.assetsBase}/datum-${bundle}.js`).href))
      .catch((error) => {
        bundles.delete(bundle);
        throw error;
      });
    bundles.set(bundle, loading);
  }
  return bundles.get(bundle);
}

function cookie(name) {
  const prefix = `${encodeURIComponent(name)}=`;
  for (const part of document.cookie ? document.cookie.split('; ') : []) {
    if (part.startsWith(prefix)) {
      return decodeURIComponent(part.slice(prefix.length));
    }
  }
  return '';
}

/**
 * The CSRF token for state-changing requests: the framework's readable XSRF-TOKEN cookie, else a <meta name="_csrf"> the page renders. '' when the page has neither (CSRF off).
 * Read on every call: the cookie rotates with the session.
 *
 * @returns {Promise<{headerName: string, token: string}>}
 */
async function csrf() {
  const host = await config();
  const names = host.csrf || {};
  let token = names.cookieName ? cookie(names.cookieName) : '';
  if (!token && names.metaName) {
    const meta = document.querySelector(`meta[name="${names.metaName}"]`);
    token = (meta && meta.getAttribute('content')) || '';
  }
  return { headerName: names.headerName || 'X-XSRF-TOKEN', token };
}

async function csrfToken() {
  return (await csrf()).token;
}

async function post(url, body, token, headerName, extra) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
  if (token) {
    headers[headerName] = token;
  }
  return fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });
}

function toElementErrors(errors) {
  return errors.map((error) => ({
    code: error.code,
    ...(error.field ? { componentId: error.field } : {}),
    ...(error.message ? { message: error.message } : {}),
  }));
}

async function deliver(element, delivery, { headers }) {
  element.setErrors([]);
  let response;
  let body = {};
  try {
    const host = await config();
    const extra = {
      ...(typeof headers === 'function' ? await headers(element) : headers || {}),
    };
    const url = `${absolute(host.apiBase).href}/submissions`;
    let { headerName, token } = await csrf();
    response = await post(url, delivery, token, headerName, extra);
    body = await response.json().catch(() => ({}));
    if (response.status === 403 && !Array.isArray(body.errors)) {
      // Not the form's own refusal (that comes with errors): the token no longer matches the session. Once
      // more with whatever the cookie holds now.
      ({ headerName, token } = await csrf());
      response = await post(url, delivery, token, headerName, extra);
      body = await response.json().catch(() => ({}));
    }
  } catch {
    element.setErrors([
      {
        code: 'delivery.failed',
        message: 'The form could not be sent. Check your connection and try again.',
      },
    ]);
    return;
  }
  if (response.ok) {
    if (body.receipt) {
      element.setNotice(body.receipt);
    }
    element.dispatchEvent(
      new CustomEvent('datum-host-accepted', { bubbles: true, detail: body }),
    );
    return;
  }
  const errors =
    Array.isArray(body.errors) && body.errors.length > 0
      ? body.errors
      : [
          {
            field: null,
            code: response.status === 403 ? 'session.ended' : 'delivery.failed',
            message: `The form could not be sent (${response.status}).`,
          },
        ];
  element.setErrors(toElementErrors(errors));
  if (
    response.status === 409 &&
    errors.some((error) => error.code === 'form.outdated')
  ) {
    // The form changed while the page was open: the page decides what to offer (a reload that keeps the answers).
    element.dispatchEvent(
      new CustomEvent('datum-host-outdated', { bubbles: true, detail: body }),
    );
  }
}

/**
 * Posts the element's accepted submissions to POST {apiBase}/submissions as {document, submissionKey} (the key of
 * the submit attempt the form gives in datum-submit's detail) with the CSRF header, shows the receipt
 * with setNotice and the refusals with setErrors. Fires datum-host-accepted (detail: the receipt body) and
 * datum-host-outdated (409 form.outdated) on the element.
 *
 * @param {HTMLElement} element    the <datum-form>.
 * @param {{headers?: object|Function}} [options]
 *   headers (an object, or a function of the element returning one) are sent as given (anti-spam tokens,
 *   a source reference).
 * @returns {Function} undoes the wiring.
 */
function submit(element, options = {}) {
  const listener = (event) => {
    if (event.target !== element || !event.detail.accepted) {
      return;
    }
    // Under the wrapper placement the signed document is what is delivered; the envelope is inside it. The
    // submission key is the submit attempt's: the same on a retry, so the host answers a retry with the first receipt.
    event.detail.waitUntil(
      deliver(
        element,
        {
          document: event.detail.signed || event.detail.submission,
          submissionKey: event.detail.submissionKey,
        },
        options,
      ),
    );
  };
  element.addEventListener('datum-submit', listener);
  return () => element.removeEventListener('datum-submit', listener);
}

/**
 * The design-system binding the host draws a form route with (the host's configuration says it, never
 * the form's definition). host.json's `bindings` is `{default, routes: {formKey: bindingId}, catalog}`: the route's
 * override, else the default. Sets it as the element's `binding`; an id the page has not registered on its
 * `bindings` (the host's catalog lists what its deployment knows, the page registers what it loads) is reported
 * by the element as `datum-binding-error` and the form is drawn by Datum's own binding. A host.json with no
 * `bindings` (a host that configures none) leaves the element alone.
 *
 * @param {HTMLElement} element  the <datum-form>.
 * @param {{formKey: string}} options  the route: the form's key.
 * @returns {Promise<string|undefined>} the binding id set, or undefined when the host names none.
 */
async function binding(element, { formKey } = {}) {
  const host = await config();
  const table = host.bindings;
  if (!table || typeof table !== 'object') {
    return undefined;
  }
  const routes = table.routes && typeof table.routes === 'object' ? table.routes : {};
  const id = (formKey && Object.hasOwn(routes, formKey) ? routes[formKey] : table.default) || undefined;
  if (id !== undefined) {
    element.binding = id;
  }
  return id;
}

/**
 * Loaders for server data sources, for <datum-form>.dataSources: sourceId => (request, context) => items.
 * Each id is read from {apiBase}/data-sources/{id}?locale=. The engine asks again on every repaint and waits for
 * every source, so each (id, locale) is fetched once and kept; a source that fails or takes too long gives no
 * options for half a minute rather than holding the form up.
 *
 * @param {string[]|Object<string, string|Array>} sources
 *   ids served by this host, or an object of id => endpoint URL | the items themselves.
 * @param {{formKey?: string}} [options]
 *   formKey is sent as ?form=, so the host's access policy can decide whether this form may read the source.
 * @returns {Object<string, Function|Array>}
 */
function dataSources(sources, { formKey } = {}) {
  const entries = Array.isArray(sources)
    ? sources.map((id) => [id, undefined])
    : Object.entries(sources || {});
  const cache = new Map();
  const fetchItems = async (id, url, locale) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DATA_SOURCE_TIMEOUT_MS);
    try {
      const host = await config();
      const target = absolute(url || `${host.apiBase}/data-sources/${encodeURIComponent(id)}`);
      if (locale) {
        target.searchParams.set('locale', locale);
      }
      if (formKey) {
        target.searchParams.set('form', formKey);
      }
      const response = await fetch(target, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`The data source answered ${response.status}.`);
      }
      const body = await response.json();
      return Array.isArray(body.items) ? body.items : [];
    } finally {
      clearTimeout(timer);
    }
  };
  return Object.fromEntries(
    entries.map(([id, source]) => {
      if (Array.isArray(source)) {
        return [id, source];
      }
      return [
        id,
        (request, context) => {
          const locale = (context && context.locale) || '';
          const key = `${id}|${locale}`;
          if (!cache.has(key)) {
            cache.set(
              key,
              fetchItems(id, source, locale).catch((error) => {
                console.warn(`Datum: the options of ${id} could not be loaded.`, error);
                setTimeout(() => cache.delete(key), DATA_SOURCE_RETRY_MS);
                return [];
              }),
            );
          }
          return cache.get(key);
        },
      ];
    }),
  );
}

/** How long a save of the definition or the catalog may take before the page gives up on it. */
const SAVE_TIMEOUT_MS = 30000;
/** How many refusal lines a status text lists before it says "and N more". */
const MAX_LISTED_ERRORS = 5;

function say(status, text, kind = 'status') {
  if (status) {
    status.textContent = text;
    status.dataset.kind = kind;
  }
}

/** The hash an ETag carries: weak marker and quotes off ('' when there is none). */
function hashOf(response) {
  const tag = response.headers.get('ETag') || '';
  return tag.replace(/^W\//, '').replace(/^"|"$/g, '');
}

/** What a refusal body says, as one line: its messages (or codes), where they point, the first few. */
function describe(body, fallback) {
  const errors = Array.isArray(body && body.errors) ? body.errors : [];
  if (errors.length === 0) {
    return (body && body.message) || fallback;
  }
  const lines = errors.slice(0, MAX_LISTED_ERRORS).map((error) => {
    const text = error.message || error.code || '';
    return error.where ? `${text} (${error.where})` : text;
  });
  const more = errors.length - lines.length;
  return `${lines.join(' ')}${more > 0 ? ` and ${more} more.` : ''}`.trim() || fallback;
}

/**
 * Wires a <datum-form-builder> to the host's form endpoints (the endpoint catalog): loads
 * {apiBase}/forms/{formKey}/definition?public=false into it, loads the host's translations catalog and hands it to the
 * builder (the Languages workspace reads it, read-only), and saves with PUT {apiBase}/forms/{formKey} and If-Match.
 *
 * Needs datum.builder.enabled on the server and a policy that lets the user build this form. The page owns the
 * element's attributes (theme, features, pdf, ...); this only does the plumbing. Refusals show on the builder's
 * bar (its Save rejects with the text) and on `status` when given:
 *   409 form.outdated  somebody else saved first: nothing is overwritten, the page offers a reload
 *                      (datum-host-outdated fires on the element);
 *   422                the server's check refused the definition: its errors are listed;
 *   413, 503, other    worded by status.
 * The element fires datum-host-saved (detail: {sha256}) after a successful save.
 *
 * @param {HTMLElement} element  the <datum-form-builder>.
 * @param {{formKey: string, status?: HTMLElement, seed?: object, dataSources?: string[]|object}} options
 *   seed: the definition to start from when the form does not exist yet (the first save then POSTs it to
 *   {apiBase}/forms); also what the builder's New puts in place. dataSources: ids (or id => URL) the inspector
 *   offers, see dataSources().
 * @returns {Promise<{save: Function, sha256: Function, dispose: Function}>} resolves once the form is loaded.
 */
async function builder(element, options = {}) {
  const { formKey, status } = options;
  if (!formKey || typeof formKey !== 'string') {
    throw new Error('Datum: DatumHost.builder() needs {formKey}.');
  }
  try {
    return await wireBuilder(element, options);
  } catch (error) {
    say(status, `The builder could not start: ${error.message}`, 'error');
    // eslint-disable-next-line no-console
    console.error('Datum: the builder could not start.', error);
    throw error;
  }
}

async function wireBuilder(element, { formKey, status, seed, dataSources: sources }) {
  const datum = await load({ bundle: 'builder' });
  await customElements.whenDefined('datum-form-builder');
  const host = await config();
  const api = absolute(host.apiBase).href;
  const key = encodeURIComponent(formKey);
  const formUrl = `${api}/forms/${key}`;
  const readJson = async (url) => {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
    });
    return { response, body: await response.json().catch(() => ({})) };
  };

  // The full definition: public=false names the author's copy (server-secret rules included), whose hash is the
  // version a save builds on (If-Match).
  let creating = false;
  let definition;
  let loadedHash = '';
  {
    const { response, body } = await readJson(`${formUrl}/definition?public=false`);
    if (response.ok) {
      definition = body;
      loadedHash = hashOf(response);
    } else if (response.status === 404 && seed) {
      creating = true;
      definition = { ...JSON.parse(JSON.stringify(seed)), id: formKey };
    } else if (response.status === 401 || response.status === 403) {
      throw new Error('you may not edit this form.');
    } else if (response.status === 404) {
      throw new Error(`the form "${formKey}" does not exist.`);
    } else {
      throw new Error(describe(body, `the form could not be loaded (${response.status}).`));
    }
  }

  // The host's catalog: {catalog} with an ETag, in the nested shape (locale, then kind, then id, then
  // property path, string leaves). The builder only reads it: the Languages workspace shows a cell the catalog
  // words as overridden, and the host edits the catalog elsewhere. Not offered (404 from a switched-off endpoint,
  // or a form not created yet) simply means no overrides; any other failure is said, but does not stop the builder.
  let catalog = {};
  async function loadCatalog() {
    const { response, body } = await readJson(`${formUrl}/translations`);
    if (!response.ok) {
      return response.status;
    }
    catalog = body.catalog || {};
    return 200;
  }
  if (!creating) {
    const code = await loadCatalog();
    if (code !== 200 && code !== 404) {
      say(status, `The translations could not be loaded (${code}).`, 'warning');
    }
  }
  element.translations = catalog;
  if (sources) {
    element.dataSources = dataSources(sources, { formKey });
  }

  // The builder refuses a definition it cannot take (a datum-error; the form as it stands stays: the blank
  // default). Save must not post that blank form over the stored one, so a refusal is kept here and stops saves
  // until a definition is taken.
  let refused = '';
  function assign(next) {
    let problem = '';
    const onError = (event) => {
      problem = (event.detail && event.detail.message) || 'The form was not loaded.';
    };
    element.addEventListener('datum-error', onError);
    try {
      element.definition = next;
    } finally {
      element.removeEventListener('datum-error', onError);
    }
    refused = problem;
    return problem;
  }
  if (assign(definition)) {
    say(status, `${refused} Saving is off on this page so the stored form is not overwritten.`, 'error');
  } else {
    say(status, creating ? 'A new form. Save to create it.' : 'Ready.');
  }

  let dirty = false;
  let saving = false;
  const onChange = (event) => {
    if (!['init', 'select', 'preview'].includes(event.detail && event.detail.reason)) {
      dirty = true;
      say(status, 'Unsaved changes.', 'warning');
    }
  };
  element.addEventListener('datum-builder-change', onChange);
  const onUnload = (event) => {
    if (dirty || element.hasUnsavedChanges()) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', onUnload);

  // One request at a time: the definition and the catalog are saved on the same record, and two saves in
  // flight could each undo the other's.
  let queue = Promise.resolve();
  function send(method, url, payload, extra = {}) {
    const request = queue.then(async () => {
      const attempt = async () => {
        const { headerName, token } = await csrf();
        const response = await fetch(url, {
          method,
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(token ? { [headerName]: token } : {}),
            ...extra,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
        });
        return { response, body: await response.json().catch(() => ({})) };
      };
      let result = await attempt();
      if (result.response.status === 403 && !Array.isArray(result.body.errors) && !result.body.code) {
        // Not the endpoint's own refusal (that comes with errors or a code): the token no longer matches the session.
        // Once more with whatever the cookie holds now.
        result = await attempt();
      }
      return result;
    });
    queue = request.catch(() => {});
    return request;
  }

  // Rejects with what went wrong, which the builder shows beside its File menu; the status line says it too.
  function failed(text, event) {
    say(status, text, 'error');
    if (event) {
      element.dispatchEvent(new CustomEvent(event.name, { bubbles: true, detail: event.detail }));
    }
    const error = new Error(text);
    error.said = true;
    throw error;
  }

  function refusal(response, body, what) {
    switch (response.status) {
      case 409:
        return failed(
          describe(
            body,
            `The ${what} was changed elsewhere since this page loaded. Download this copy if you want to keep it, then reload the page to get the current one.`,
          ),
          { name: 'datum-host-outdated', detail: body },
        );
      case 413:
        return failed(`The ${what} is larger than the server accepts.`);
      case 401:
      case 403:
        return failed(describe(body, `You may not save this ${what}.`));
      case 422:
        return failed(describe(body, `The server did not accept the ${what}.`));
      case 503:
        return failed(
          `The ${what} could not be checked right now. Try again in a moment.`,
        );
      default:
        return failed(describe(body, `The ${what} could not be saved (${response.status}).`));
    }
  }

  // The language changes since the baseline (the builder's LocaleChanges) ride with the definition, and the
  // server moves the catalog in the same save. A save that fails keeps the builder's count, so a retry sends
  // them again.
  async function persist(changes) {
    if (saving) {
      return false;
    }
    if (refused) {
      failed(`${refused} Saving is off on this page so the stored form is not overwritten.`);
    }
    const current = element.definition;
    if (current && current.id !== formKey) {
      failed(`This page edits the form "${formKey}"; the form's id cannot be changed to "${current.id}" here.`);
    }
    saving = true;
    say(status, 'Saving…');
    try {
      const moved = changes && ((changes.removed || []).length > 0 || (changes.renamed || []).length > 0);
      const { response, body } = await send(
        creating ? 'POST' : 'PUT',
        creating ? `${api}/forms` : formUrl,
        current,
        {
          ...(!creating && loadedHash ? { 'If-Match': `"${loadedHash}"` } : {}),
          ...(moved ? { 'X-Datum-Locale-Changes': JSON.stringify(changes) } : {}),
        },
      );
      if (!response.ok) {
        refusal(response, body, 'form');
      }
      dirty = false;
      loadedHash = hashOf(response) || body.sha256 || loadedHash;
      const removed = response.headers.get('X-Datum-Removed-Locales');
      const created = creating;
      creating = false;
      if (removed || moved || created) {
        // The server dropped (or moved) catalog columns with this save: show the catalog as it stands now.
        await loadCatalog().catch(() => {});
        element.translations = catalog;
      }
      say(status, 'Saved.');
      element.dispatchEvent(new CustomEvent('datum-host-saved', { bubbles: true, detail: { sha256: loadedHash } }));
      return true;
    } catch (error) {
      if (error && error.said) {
        throw error;
      }
      failed(
        error && error.name === 'TimeoutError'
          ? 'The form could not be saved: the server did not answer in time. Check your connection and try again.'
          : 'The form could not be saved. Check your connection and try again.',
      );
    } finally {
      saving = false;
    }
    return false;
  }

  const replaceWith = (next, message) => {
    if (assign(next)) {
      say(status, refused, 'error');
      return;
    }
    dirty = true;
    say(status, message, 'warning');
  };
  // The builder's New, Open, Download and Save, for this form's id: the id keys every stored copy, so a form taken
  // from a file or from the seed gets this form's. The builder does the asking (unsaved edits, the picker, a
  // refused file on its bar).
  const actions = {
    save: (context) => persist(context && context.localeChanges),
    saveLabel: 'Save',
    download: () => ({
      name: `${formKey}.json`,
      text: `${JSON.stringify(element.definition, null, 2)}\n`,
      type: 'application/json',
    }),
  };
  if (seed) {
    actions.new = () =>
      replaceWith(
        { ...JSON.parse(JSON.stringify(seed)), id: formKey },
        'An empty form. Save to keep it, or leave the page to discard it.',
      );
  }
  if (datum && typeof datum.toFormDefinition === 'function' && typeof datum.formDefinitionProblem === 'function') {
    actions.open = (file) => {
      let json;
      try {
        json = JSON.parse(file.text);
      } catch (error) {
        throw new Error(`it is not JSON: ${error.message}`);
      }
      // Throws, with its reason, for what is not a form definition (the builder's own Open checks).
      const opened = datum.toFormDefinition(json);
      const problem = datum.formDefinitionProblem(opened);
      if (problem) {
        throw new Error(problem);
      }
      return () =>
        replaceWith(
          { ...opened, id: formKey },
          opened.id === formKey
            ? `Imported ${file.name}. Save to keep it.`
            : `Imported ${file.name}, with its id changed to ${formKey}. Save to keep it.`,
        );
    };
  }
  element.fileActions = actions;

  return {
    /** Saves as the File menu's Save does (the builder's own asking about unapplied edits is not repeated). */
    save: () =>
      persist(
        typeof element.localeChangesSinceSave === 'function' ? element.localeChangesSinceSave() : undefined,
      ).then((saved) => {
        if (saved && typeof element.markLocalesSaved === 'function') {
          element.markLocalesSaved();
        }
        return saved;
      }),
    /** The hash of the definition this page builds on ('' while the form is not created yet). */
    sha256: () => loadedHash,
    /** Undoes the wiring (listeners; the element keeps what it shows). */
    dispose() {
      element.removeEventListener('datum-builder-change', onChange);
      window.removeEventListener('beforeunload', onUnload);
    },
  };
}

/** The engine's id for the passkey signing provider (signWith names it). */
const PASSKEY_PROVIDER_ID = 'webauthn';
/** How long a call to the passkey endpoints may take. */
const PASSKEY_REQUEST_TIMEOUT_MS = 15000;
/** How long the browser's create() may take: well inside the challenge's life (300 s), which is fetched when the person chooses. */
const PASSKEY_CREATE_TIMEOUT_MS = 120000;

function passkeyFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function passkeyCodeOf(error) {
  return error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
}

/** A WebAuthn failure, worded for the person filling the form in (the words a person filling the form in reads). */
function passkeyWorded(error) {
  const code = passkeyCodeOf(error);
  switch (code) {
    case 'cancelled':
    case 'aborted':
      return passkeyFailure(code, 'The passkey prompt was closed or timed out. Sign again when you are ready.');
    case 'unsupported':
      return passkeyFailure(code, 'This browser cannot sign with a passkey. Use a browser or device that supports passkeys.');
    case 'security':
      return passkeyFailure(code, 'Passkeys are not set up for this address of the site. Contact us.');
    case 'in_use':
      return passkeyFailure(code, 'This device already has a passkey for this site: sign with that one.');
    case 'no_credentials':
      return passkeyFailure(code, 'No passkey was chosen to sign with.');
    case 'declined':
    case 'registration':
    case 'challenge':
    case 'session':
    case 'insecure':
    case 'not_set_up':
    case 'sign_in':
      return error;
    default:
      return passkeyFailure(code || 'protocol', `The passkey could not sign: ${(error && error.message) || String(error)}`);
  }
}

/** What a page that cannot sign says, by why and by what the form does (unsigned, refused or prompt). */
function passkeyBlockedText(why, kind) {
  const texts = {
    sign_in: {
      unsigned: 'Sign in to sign this form.',
      refused: 'Sign in to send this form: it must be signed with a passkey, and only people who are signed in can sign on this site.',
      prompt: 'Sign in to sign this form: only people who are signed in can sign on this site.',
    },
    not_set_up: {
      unsigned: 'Passkeys are not set up on this site, so the form is sent unsigned and recorded as not signed.',
      refused: 'This form must be signed with a passkey, and passkeys are not set up on this site, so it cannot be sent now. Contact us.',
      prompt: 'Passkeys are not set up on this site, so the form cannot be signed. Contact us.',
    },
    insecure: {
      unsigned: 'This page is not on a secure (https) connection, so it cannot use passkeys: the form is sent unsigned and recorded as not signed.',
      refused: 'This form must be signed with a passkey, and passkeys work only over a secure (https) connection to this site. Contact us.',
      prompt: 'Passkeys work only over a secure (https) connection to this site, so the form cannot be signed here. Contact us.',
    },
    unsupported: {
      unsigned: 'This browser cannot sign with a passkey, so the form is sent unsigned and recorded as not signed.',
      refused: 'This form must be signed with a passkey, and this browser cannot make or use one. Open it in a browser or device that supports passkeys.',
      prompt: 'This browser cannot sign with a passkey. Use a browser or device that supports passkeys.',
    },
  };
  return texts[why][kind];
}

/**
 * Wires a <datum-form> to the passkey endpoints: reads {endpoint}/passkeys?form=<formKey> for what the form signs and which
 * passkeys the signed-in person has, gives the element its signing provider, and offers to make a passkey (a
 * challenge from POST {endpoint}/challenge, the browser's create() through the form bundle's registerCredential(),
 * the server's check at POST {endpoint}/register) when none signs or the server refuses the one that did.
 *
 * Needs datum.webauthn.enabled on the server and a form that signs (datum.webauthn.forms.<key>.mode). The CSRF
 * header goes with every POST. The endpoints live at datum.webauthn.path (default /api/webauthn), which host.json
 * carries in `paths.webauthn`; pass {endpoint} only to override it. A server whose host.json names no
 * `paths.webauthn` serves no passkey endpoints, and the call is refused unless {endpoint} is given.
 *
 * Pass `headers: handle.headers` to DatumHost.submit() so a browser without passkeys says so
 * (X-Datum-Signing: unavailable) to a form that accepts that. A refused delivery (signature.unknown,
 * signature.unusable) is seen through the element's setErrors, and a new passkey is offered at once.
 *
 * @param {HTMLElement} element  the <datum-form>.
 * @param {{formKey: string, endpoint?: string, context?: 'submit'|'amend'|'test', defaultLabel?: string,
 *   labelPath?: string}} options  labelPath: an answer's value path that names a visitor's passkey (the server's
 *   datum.webauthn.label-path is told to the page and used when this is not given).
 * @returns {Promise<{headers: Function, refresh: Function, dispose: Function, signing: object|null}>}
 *   resolves once the form's signing settings are known; `signing` is null for a form that does not sign.
 */
async function passkeys(element, options = {}) {
  const { formKey } = options;
  if (!formKey || typeof formKey !== 'string') {
    throw new Error('Datum: DatumHost.passkeys() needs {formKey}.');
  }
  const datum = await load({ bundle: 'form' });
  const host = await config();
  // host.json names datum.webauthn.path in `paths` (the server knows where it put the endpoints).
  const named = options.endpoint || (host.paths && typeof host.paths.webauthn === 'string' ? host.paths.webauthn : '');
  if (!named) {
    throw new Error('Datum: DatumHost.passkeys() found no passkey endpoints: host.json names no paths.webauthn; pass {endpoint}.');
  }
  const base = absolute(named).href.replace(/\/+$/, '');
  const context = options.context || 'submit';
  const state = { mine: [], made: null, lastCredential: '', refusedAs: '', unavailable: false };
  const cleanups = [];
  let guardText = '';

  const asJson = async (response) => {
    let json = {};
    let readable = true;
    try {
      json = await response.json();
    } catch {
      readable = false;
    }
    if (!json || typeof json !== 'object') {
      json = {};
      readable = false;
    }
    return { ok: response.ok, status: response.status, json, readable };
  };
  const requestJson = async (path, { method = 'GET', body } = {}) => {
    if (method === 'GET') {
      return asJson(
        await fetch(`${base}${path}`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(PASSKEY_REQUEST_TIMEOUT_MS),
        }),
      );
    }
    const { headerName, token } = await csrf();
    return asJson(await post(`${base}${path}`, body === undefined ? {} : body, token, headerName));
  };
  const sessionEnded = (answer) => Boolean(answer) && answer.status === 403 && !Array.isArray(answer.json && answer.json.errors);
  const messageOf = (json, fallback) => {
    const error = json && Array.isArray(json.errors) ? json.errors[0] : null;
    return error && typeof error.message === 'string' && error.message !== '' ? error.message : fallback;
  };
  const sessionText = () =>
    'Your session has ended, so a passkey cannot be made now. Reload the page, and sign in again if asked.';

  // ----- what the server says this form signs
  let answer;
  try {
    answer = await requestJson(`/passkeys?form=${encodeURIComponent(formKey)}`);
  } catch {
    answer = { ok: false, status: 0, json: {}, readable: false };
  }
  const refusalCode = (answer.json.errors && answer.json.errors[0] && answer.json.errors[0].code) || '';
  if (answer.status === 404 && refusalCode === 'signing.off') {
    return { headers: () => ({}), refresh: async () => {}, dispose() {}, signing: null };
  }
  let signing = answer.ok ? answer.json.signing || null : null;
  const serverBlock = answer.status === 503 && refusalCode === 'signing.not_set_up' ? 'not_set_up' : '';
  if (!signing && !serverBlock) {
    throw new Error(messageOf(answer.json, `The passkey settings could not be loaded (${answer.status}).`));
  }
  signing = signing || { mode: 'required', scope: 'envelope', placement: 'embedded', ready: false };
  state.mine = answer.ok && Array.isArray(answer.json.passkeys) ? answer.json.passkeys : [];
  const labelPath = options.labelPath || signing.labelPath || '';

  // ----- small UI: a notice before the form, and questions with buttons
  let asked = 0;
  const notice = (kind) => {
    const existing = element.previousElementSibling;
    if (existing && existing.hasAttribute('data-datum-signing-notice')) {
      existing.remove();
    }
    const note = document.createElement('div');
    note.setAttribute('data-datum-signing-notice', '');
    note.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    note.className = `datum-signing-notice datum-signing-notice--${kind}`;
    element.before(note);
    return note;
  };
  const clearNotice = () => {
    const existing = element.previousElementSibling;
    if (existing && existing.hasAttribute('data-datum-signing-notice')) {
      existing.remove();
    }
  };
  const ask = (paragraphs, choices) => {
    const note = notice('status');
    note.setAttribute('role', 'group');
    note.setAttribute('aria-label', 'Signing');
    asked += 1;
    const ids = [];
    paragraphs.forEach((text, index) => {
      const paragraph = document.createElement('p');
      paragraph.id = `datum-signing-ask-${asked}-${index}`;
      paragraph.textContent = text;
      ids.push(paragraph.id);
      note.append(paragraph);
    });
    if (ids.length > 0) {
      note.setAttribute('aria-describedby', ids.join(' '));
    }
    return new Promise((resolve) => {
      const buttons = choices.map((choice) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = choice.label;
        button.dataset.datumSigningChoice = choice.value;
        button.addEventListener('click', () => {
          note.remove();
          resolve(choice.value);
        });
        note.append(button);
        return button;
      });
      if (buttons[0]) {
        buttons[0].focus();
      }
    });
  };
  const signalUnknown = (credentialId) => {
    const api = window.PublicKeyCredential;
    if (!credentialId || !signing.rpId || !api || typeof api.signalUnknownCredential !== 'function') {
      return;
    }
    try {
      Promise.resolve(api.signalUnknownCredential({ rpId: signing.rpId, credentialId })).catch(() => {});
    } catch {
      // A refusal here changes nothing for the form.
    }
  };
  const supported = () => typeof window.PublicKeyCredential !== 'undefined' && Boolean(window.navigator && window.navigator.credentials);
  const labelFor = () => {
    const values = element.values || {};
    const value = labelPath ? values[labelPath] : '';
    return typeof value === 'string' && value.trim() !== '' && context === 'submit' ? value.trim().slice(0, 128) : options.defaultLabel || '';
  };

  // ----- the passkeys and the ceremony
  const refreshMine = async () => {
    try {
      const reply = await requestJson(`/passkeys?form=${encodeURIComponent(formKey)}`);
      state.mine = reply.ok && Array.isArray(reply.json.passkeys) ? reply.json.passkeys : [];
    } catch {
      // The browser offers the passkeys it has for the site regardless.
      state.mine = [];
    }
  };
  const fetchChallenge = async () => {
    let reply;
    try {
      reply = await requestJson('/challenge', { method: 'POST', body: { form: formKey, context, label: labelFor() } });
    } catch {
      throw passkeyFailure('challenge', 'A passkey cannot be made now: this site could not be reached. Check your connection and try again.');
    }
    if (sessionEnded(reply)) {
      throw passkeyFailure('session', sessionText());
    }
    const challenge = reply.json;
    const usable =
      reply.ok &&
      typeof challenge.challenge === 'string' &&
      typeof challenge.token === 'string' &&
      challenge.rp &&
      typeof challenge.rp.id === 'string' &&
      challenge.user &&
      typeof challenge.user.id === 'string';
    if (!usable) {
      throw passkeyFailure('challenge', reply.ok ? 'A passkey cannot be made now.' : messageOf(reply.json, 'A passkey cannot be made now.'));
    }
    return challenge;
  };
  const register = async () => {
    const challenge = await fetchChallenge();
    const label = labelFor();
    let record;
    try {
      record = await datum.registerCredential({
        rpId: challenge.rp.id,
        rpName: challenge.rp.name,
        user: challenge.user,
        name: label || options.defaultLabel || challenge.user.name,
        challenge: challenge.challenge,
        residentKey: challenge.residentKey || 'required',
        userVerification: challenge.userVerification || 'preferred',
        excludeCredentials: challenge.excludeCredentials || [],
        timeout: PASSKEY_CREATE_TIMEOUT_MS,
      });
    } catch (error) {
      throw passkeyWorded(error);
    }
    // What the server checks and keeps: the ceremony's raw outputs, never the record's own account of itself.
    const credential = {
      id: record.id,
      publicKey: record.publicKey,
      algorithm: record.algorithm,
      transports: record.transports,
      userHandle: record.userHandle,
      response: record.response,
    };
    for (;;) {
      let reply = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        reply = await requestJson('/register', { method: 'POST', body: { token: challenge.token, form: formKey, label, credential, context } });
      } catch {
        reply = null;
      }
      if (reply && reply.ok && typeof reply.json.id === 'string') {
        state.mine = [...state.mine, reply.json];
        // The page signs with it from now on: a visitor's device would otherwise offer every passkey it has.
        state.made = reply.json;
        return reply.json;
      }
      const again = reply === null || reply.status >= 500 || reply.status === 429 || !reply.readable;
      if (!again) {
        // Refused: a passkey this site will never know.
        signalUnknown(record.id);
        if (sessionEnded(reply)) {
          throw passkeyFailure('session', sessionText());
        }
        throw passkeyFailure('registration', messageOf(reply.json, 'The passkey could not be registered.'));
      }
      // eslint-disable-next-line no-await-in-loop
      const choice = await ask(
        [
          reply === null || !reply.readable
            ? 'Your new passkey could not be sent to this site: the connection failed.'
            : messageOf(reply.json, 'This site could not register your new passkey just now.'),
        ],
        [
          { label: 'Try again', value: 'retry' },
          { label: 'Cancel', value: 'cancel' },
        ],
      );
      if (choice !== 'retry') {
        signalUnknown(record.id);
        throw passkeyFailure('declined', 'The form was not signed.');
      }
    }
  };

  const offerText = (why, refusal) => {
    const lead =
      why === 'unknown'
        ? 'The passkey you chose is not registered on this site.'
        : why === 'unusable'
          ? 'The passkey you chose cannot sign this form.'
          : 'No passkey was used. If you have none for this site yet, make one now.';
    const tail = refusal
      ? 'Make a new passkey for this site now: your device keeps it, and asks for your fingerprint, face or PIN. Or send the form again and choose another of yours.'
      : 'Make a new passkey for this site now, or try another of yours: your device keeps it, and asks for your fingerprint, face or PIN.';
    return why === 'none' ? `${lead} Your device keeps it, and asks for your fingerprint, face or PIN.` : `${lead} ${tail}`;
  };
  const offerRegistration = async (why, refusal = false) => {
    const mayRegister = signing.register !== false;
    if (!mayRegister) {
      // The site lets people sign only with passkeys made ahead of time.
      await ask(
        [
          `${why === 'none' ? 'No passkey was used.' : 'The passkey you chose cannot sign this form.'} You need a passkey registered with this site to sign this form: ${
            signing.signedIn ? 'add one on your passkeys page, then sign again.' : "ask the site's administrators for a registration link."
          }`,
        ],
        [{ label: 'OK', value: 'cancel' }],
      );
      throw passkeyFailure('declined', 'The form was not signed.');
    }
    let problem = '';
    let canCreate = true;
    for (;;) {
      const paragraphs = [];
      if (problem) {
        paragraphs.push(problem);
      }
      paragraphs.push(offerText(why, refusal));
      if (signing.statement) {
        paragraphs.push(`By signing you agree: ${signing.statement}`);
      }
      const choices = [
        ...(canCreate ? [{ label: 'Create a passkey for this site', value: 'create' }] : []),
        ...(refusal ? [] : [{ label: 'Try my passkeys again', value: 'retry' }]),
        { label: refusal ? 'Not now' : 'Cancel', value: 'cancel' },
      ];
      // eslint-disable-next-line no-await-in-loop
      const choice = await ask(paragraphs, choices);
      if (choice === 'cancel') {
        throw passkeyFailure('declined', 'The form was not signed.');
      }
      if (choice === 'retry') {
        return false;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await register();
        return true;
      } catch (error) {
        const code = passkeyCodeOf(error);
        if (code === 'declined' || code === 'session') {
          throw error;
        }
        // Said above the offer, which stays: a challenge that could not be had offers no "Create" until the person tries again.
        problem = error.message;
        canCreate = code !== 'challenge';
      }
    }
  };

  // ----- the engine provider
  const engineProvider = () =>
    datum.createWebAuthnSigningProvider({
      id: PASSKEY_PROVIDER_ID,
      rpId: signing.rpId,
      discoverable: true,
      credentials: () => state.mine || [],
      userVerification: signing.userVerification || 'preferred',
    });
  const signOnce = async (request) => {
    const results = await engineProvider().sign(request);
    const first = Array.isArray(results) ? results[0] : null;
    state.lastCredential = first && first.webauthn && typeof first.webauthn.credentialId === 'string' ? first.webauthn.credentialId : '';
    return results;
  };
  const provider = {
    id: PASSKEY_PROVIDER_ID,
    async sign(request) {
      if (!supported()) {
        throw passkeyWorded(passkeyFailure('unsupported', ''));
      }
      if (guardText) {
        throw passkeyFailure('declined', guardText);
      }
      clearNotice();
      await refreshMine();
      if (state.made && !state.mine.some((passkey) => passkey && passkey.id === state.made.id)) {
        state.mine = [...state.mine, state.made];
      }
      // The server refused the passkey that signed last, and the person said "Not now" to a new one: straight to the offer.
      let offer = state.refusedAs;
      state.refusedAs = '';
      for (;;) {
        if (!offer) {
          try {
            // eslint-disable-next-line no-await-in-loop
            return await signOnce(request);
          } catch (error) {
            const code = passkeyCodeOf(error);
            if (code !== 'cancelled' && code !== 'no_credentials') {
              throw passkeyWorded(error);
            }
            // No passkey for this site, or the prompt was closed: WebAuthn does not say which.
            offer = 'none';
          }
        }
        // eslint-disable-next-line no-await-in-loop
        const made = await offerRegistration(offer);
        offer = '';
        if (made) {
          try {
            // eslint-disable-next-line no-await-in-loop
            return await signOnce(request);
          } catch (again) {
            if (passkeyCodeOf(again) !== 'cancelled') {
              throw passkeyWorded(again);
            }
          }
          // Some browsers want a fresh click for each prompt.
          // eslint-disable-next-line no-await-in-loop
          const choice = await ask(
            ['Your passkey is ready. Sign the form with it now.'],
            [
              { label: 'Sign now', value: 'sign' },
              { label: 'Cancel', value: 'cancel' },
            ],
          );
          if (choice !== 'sign') {
            throw passkeyFailure('declined', 'The form was not signed.');
          }
          try {
            // eslint-disable-next-line no-await-in-loop
            return await signOnce(request);
          } catch (last) {
            throw passkeyWorded(last);
          }
        }
        // "Try my passkeys again": the prompt again; closed again, the offer again.
      }
    },
  };
  const blockedProvider = (why, kind = 'prompt') => ({
    id: PASSKEY_PROVIDER_ID,
    async sign() {
      throw passkeyFailure(why, passkeyBlockedText(why, kind));
    },
  });

  // ----- what the page can do at all
  element.signing = {
    scope: signing.scope,
    placement: signing.placement,
    ...(signing.statement ? { statement: signing.statement } : {}),
  };
  if (signing.statement) {
    const paragraph = document.createElement('p');
    paragraph.setAttribute('data-datum-signing-statement', '');
    paragraph.textContent = `By signing you agree: ${signing.statement}`;
    const next = element.nextElementSibling;
    if (next && next.hasAttribute('data-datum-signing-statement')) {
      next.remove();
    }
    element.after(paragraph);
    cleanups.push(() => paragraph.remove());
  }
  const required = signing.mode === 'required';
  let why = '';
  if (serverBlock || signing.ready === false) {
    why = 'not_set_up';
  } else if (signing.signIn) {
    why = 'sign_in';
  } else if (window.isSecureContext === false) {
    why = 'insecure';
  } else if (!supported()) {
    why = 'unsupported';
  } else if (
    !datum ||
    typeof datum.createWebAuthnSigningProvider !== 'function' ||
    typeof datum.registerCredential !== 'function'
  ) {
    why = 'unsupported';
    // eslint-disable-next-line no-console
    console.warn('Datum: this bundle has no passkey signing; the form cannot sign.');
  }
  if (why === 'sign_in' && !required) {
    // An optional form is sent unsigned, as plain Send sends it.
    element.signingProviders = [{ id: PASSKEY_PROVIDER_ID, async sign() { return []; } }];
    notice('status').textContent = passkeyBlockedText('sign_in', 'unsigned');
  } else if (why) {
    if (required && signing.unavailable === 'accept' && why !== 'sign_in') {
      // Sent unsigned, and recorded as "Not signed: passkeys unavailable".
      state.unavailable = true;
      notice('warning').textContent = passkeyBlockedText(why, 'unsigned');
    } else if (required) {
      notice('error').textContent = passkeyBlockedText(why, 'refused');
      // Never delivered unsigned.
      element.signWith = PASSKEY_PROVIDER_ID;
    }
    // A button whose Signature option is Passkey says why it cannot sign.
    element.signingProviders = [blockedProvider(why)];
  } else {
    element.signingProviders = [provider];
    if (required) {
      // Every submit signs; never delivered unsigned.
      element.signWith = PASSKEY_PROVIDER_ID;
    }
  }

  // ----- a refused delivery: a new passkey is offered at once, then the form is sent with it
  const offerAfterRefusal = async (reason) => {
    let made = false;
    try {
      made = await offerRegistration(reason, true);
    } catch (error) {
      // Not now: the next send offers again. A session that ended is said.
      if (passkeyCodeOf(error) === 'session') {
        notice('error').textContent = error.message;
      }
      return;
    }
    if (!made) {
      return;
    }
    state.refusedAs = '';
    const canSend = typeof element.submit === 'function';
    const choice = await ask(
      [canSend ? 'Your passkey is ready. Sign and send the form with it now.' : 'Your passkey is ready. Send the form again to sign with it.'],
      canSend
        ? [
            { label: 'Sign and send', value: 'send' },
            { label: 'Not now', value: 'cancel' },
          ]
        : [{ label: 'OK', value: 'cancel' }],
    );
    if (choice === 'send') {
      try {
        await element.submit({ signWith: PASSKEY_PROVIDER_ID });
      } catch {
        // The form shows its own errors; the passkey stays for the next send.
      }
    }
  };
  const refused = (errors) => {
    if (!Array.isArray(errors) || why) {
      return;
    }
    const codes = errors.map((error) => error && error.code);
    let reason = '';
    if (codes.includes('signature.unknown')) {
      signalUnknown(state.lastCredential);
      reason = 'unknown';
    } else if (codes.includes('signature.unusable')) {
      reason = 'unusable';
    }
    if (!reason) {
      return;
    }
    // The refused passkey is not offered again from this page.
    const refusedId = state.lastCredential;
    if (refusedId) {
      if (state.made && state.made.id === refusedId) {
        state.made = null;
      }
      state.mine = (state.mine || []).filter((passkey) => !passkey || passkey.id !== refusedId);
    }
    state.refusedAs = reason;
    // Not awaited: the delivery's handling ends now, the offer stays.
    offerAfterRefusal(reason).catch(() => {});
  };
  // The page's refusals reach the element through setErrors (DatumHost.submit): watch them there.
  if (typeof element.setErrors === 'function') {
    const original = element.setErrors;
    element.setErrors = function setErrors(errors, ...rest) {
      const result = original.call(this, errors, ...rest);
      refused(errors);
      return result;
    };
    cleanups.push(() => {
      element.setErrors = original;
    });
  }

  return {
    /** Headers for DatumHost.submit(): a browser without passkeys says so to a form that accepts that. */
    headers: () => (state.unavailable ? { 'X-Datum-Signing': 'unavailable' } : {}),
    /** Reads the caller's passkeys again (after signing in, or making one elsewhere). */
    refresh: refreshMine,
    /** Stops a signing until the text is empty again (the Amend tab's reason): the person is told why. */
    guard(text) {
      guardText = text || '';
    },
    /** Undoes the wiring (the setErrors watch, the statement; the element keeps its providers). */
    dispose() {
      cleanups.forEach((cleanup) => cleanup());
    },
    signing,
  };
}

export const DatumHost = Object.freeze({
  config,
  load,
  csrfToken,
  submit,
  binding,
  dataSources,
  builder,
  passkeys,
});

globalThis.DatumHost = DatumHost;
