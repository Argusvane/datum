import { createHash } from "node:crypto";

import { validValues } from "../../../fixtures/base-form.js";
import type { Json } from "../../../observation.js";
import { canonicalText } from "../../../reference/canonical.js";
import { catalogKey } from "../http.js";
import { observe } from "../wire.js";
import { observeBuilder } from "./builder-observe.js";
import { submissionsProfile } from "./submissions.js";
import { BuilderSetupError, type BuilderCtx, type BuilderHost, type HostResult, type StoredForm } from "./builder-types.js";

/**
 * `@argusvane/datum-submissions` as a builder host (`SUBMISSION_ROUTES`):
 *
 * - save   `POST /api/forms` (the definition; 201 `{ key, formulaProblems? }`, 422 `invalid_definition`)
 * - read   `GET /api/forms/:key/inspect?op=public` (the service routes no author copy; the public copy is what can be read back)
 * - public `GET /api/forms/:key/definition`
 * - check  `GET /api/forms/:key/inspect?op=check`; chained `POST /api/submissions/validate`; deliver `POST /api/submissions`
 * - delete `DELETE /api/forms/:key?cascade=true` (204), for the suite form's key and every key a hostile version registered
 *
 * The service has no `PUT /api/forms/:id` (`SUBMISSION_ROUTES` has none): a new save of
 * the same id and version replaces the entry, a new version supersedes the older ones.
 */
const keyOf = (formId: string, version: string): string => catalogKey(formId, version);

export const submissionsBuilderHost: BuilderHost = {
  name: "submissions",

  allow(ctx) {
    const base = new URL(ctx.config.baseUrl);
    const prefix = base.pathname.replace(/\/+$/, "");
    return (method, url) => {
      if (url.origin !== base.origin) {
        return false;
      }
      const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
      if (method === "POST" && url.search === "" && (path === "/api/forms" || path === "/api/submissions" || path === "/api/submissions/validate")) {
        return true;
      }
      const tracked = new Set<string>([keyOf(ctx.formId, ctx.formVersion), ...ctx.keys]);
      const match = /^\/api\/forms\/([^/]+)(\/definition|\/inspect)?$/.exec(path);
      if (match === null) {
        return false;
      }
      let key: string;
      try {
        key = decodeURIComponent(match[1] as string);
      } catch {
        return false;
      }
      if (!tracked.has(key)) {
        return false;
      }
      if (match[2] === "/definition") {
        return method === "GET" && url.search === "";
      }
      if (match[2] === "/inspect") {
        return method === "GET" && /^\?op=(public|check)$/.test(url.search);
      }
      return method === "DELETE" && url.search === "?cascade=true";
    };
  },

  async create() {
    // `register` creates the form on the first save; there is nothing to make first.
  },

  async prepare() {
    // No token: the service has no auth layer of its own (a proxy's header goes in --auth-header).
  },

  async save(ctx, spec, label) {
    if ((spec.method ?? "POST") === "POST") {
      ctx.saves += 1;
    }
    const headers: Record<string, string> = {};
    if (spec.contentType !== null) {
      headers["content-type"] = spec.contentType ?? "application/json";
    }
    Object.assign(headers, spec.headers ?? {});
    const method = spec.method ?? "POST";
    const response = await ctx.client.send({
      method,
      url: `${ctx.config.baseUrl.replace(/\/+$/, "")}/api/forms`,
      headers,
      ...(method === "POST" || method === "PUT" ? { body: spec.body } : {}),
      label
    });
    const observation = observeBuilder(response, spec.htmlOk === true ? { htmlOk: true } : {});
    const key = (response.json as { key?: unknown } | undefined)?.key;
    if ((response.status === 200 || response.status === 201) && typeof key === "string") {
      ctx.keys.add(key);
    }
    return { response, observation };
  },

  async readBack(ctx, label) {
    const response = await ctx.client.send({ method: "GET", url: `${formUrl(ctx)}/inspect?op=public`, label: label.startsWith("page ") ? label : `page ${label}` });
    const definition = (response.json as { definition?: unknown } | undefined)?.definition;
    if (response.status !== 200 || definition === undefined) {
      return undefined;
    }
    return storedOf(definition);
  },

  async readPublic(ctx, label) {
    const response = await ctx.client.send({ method: "GET", url: `${formUrl(ctx)}/definition`, anonymous: true, label: `page public ${label}` });
    if (response.status !== 200 || !response.jsonOk) {
      return { unreadable: `GET /api/forms/<key>/definition answered HTTP ${response.status}` };
    }
    return { definition: response.json };
  },

  async readCheck(ctx, label) {
    const response = await ctx.client.send({ method: "GET", url: `${formUrl(ctx)}/inspect?op=check`, label: `page check ${label}` });
    return response.status === 200 && response.jsonOk ? { answer: response.json } : { unreadable: `GET /api/forms/<key>/inspect?op=check answered HTTP ${response.status}` };
  },

  async validate(ctx, label): Promise<HostResult> {
    const response = await ctx.client.send({
      method: "POST",
      url: `${ctx.config.baseUrl.replace(/\/+$/, "")}/api/submissions/validate`,
      headers: { "content-type": "application/json" },
      body: submissionsProfile.checkBody({ formId: ctx.formId, formVersion: ctx.formVersion } as never, { values: validValues() as Json }),
      label
    });
    return { response, observation: observe(response) };
  },

  async submit(ctx, label): Promise<HostResult> {
    const response = await ctx.client.send({
      method: "POST",
      url: `${ctx.config.baseUrl.replace(/\/+$/, "")}/api/submissions`,
      headers: { "content-type": "application/json" },
      body: submissionsProfile.submitBody({ formId: ctx.formId, formVersion: ctx.formVersion } as never, { values: validValues() as Json }),
      label
    });
    if (response.status === 200) {
      ctx.recordsCreated += 1;
    }
    return { response, observation: observe(response) };
  },

  async remove(ctx) {
    const keys = [...new Set([keyOf(ctx.formId, ctx.formVersion), ...ctx.keys])];
    const failed: string[] = [];
    for (const key of keys) {
      const response = await ctx.client.send({ method: "DELETE", url: `${ctx.config.baseUrl.replace(/\/+$/, "")}/api/forms/${encodeURIComponent(key)}?cascade=true`, label: "delete form" });
      if (response.status !== 204 && response.status !== 404) {
        failed.push(`${key} (HTTP ${response.status})`);
      }
    }
    const remedy = keys.map((key) => `DELETE /api/forms/${encodeURIComponent(key)}?cascade=true`).join("; ");
    return failed.length === 0 ? { complete: true, detail: `deleted ${keys.length} catalogue entr${keys.length === 1 ? "y" : "ies"}`, remedy } : { complete: false, detail: `could not delete ${failed.join(", ")}`, remedy };
  },

  async isGone(ctx) {
    const keys = [keyOf(ctx.formId, ctx.formVersion), ...ctx.keys];
    for (const key of new Set(keys)) {
      const response = await ctx.client.send({ method: "GET", url: `${ctx.config.baseUrl.replace(/\/+$/, "")}/api/forms/${encodeURIComponent(key)}/definition`, label: "page definition after delete" });
      if (response.status !== 404) {
        return false;
      }
    }
    return true;
  },

  hashOf(response) {
    const key = (response.json as { key?: unknown } | undefined)?.key;
    return typeof key === "string" ? key : undefined;
  },

  async describeAdopted(ctx) {
    return this.readBack(ctx, "page definition adopt");
  },

  async restore(ctx, original) {
    const result = await this.save(ctx, { body: original.text }, "restore adopted");
    return result.observation.kind === "answer";
  }
};

function formUrl(ctx: BuilderCtx): string {
  return `${ctx.config.baseUrl.replace(/\/+$/, "")}/api/forms/${encodeURIComponent(keyOf(ctx.formId, ctx.formVersion))}`;
}

function storedOf(definition: unknown): StoredForm {
  const text = canonicalText(definition);
  return { definition, hash: createHash("sha256").update(text).digest("hex"), text };
}

export { BuilderSetupError };
