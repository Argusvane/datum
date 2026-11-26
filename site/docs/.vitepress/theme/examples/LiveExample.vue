<script setup lang="ts">
/**
 * One live example: the reader's choices, the page those choices make, and that page running in a
 * frame, with a log of what it did. The frame runs the code shown and nothing else, so the code
 * cannot drift from the result. Changing a choice that changes the page reloads the frame.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { withBase } from "vitepress";

import { EXAMPLES } from "./index";
import { STAND_IN_PATHS, frameAddress, frameDocument, type FrameMessage } from "./frame";
import { BUNDLE_BASE } from "./page";
import { highlight } from "./highlight";
import type { ExampleFile, ExampleOptions, ExampleReply } from "./types";

const props = defineProps<{ name: string }>();
const spec = EXAMPLES[props.name];
if (!spec) throw new Error(`No live example is named "${props.name}".`);

const options = reactive<ExampleOptions>(Object.fromEntries(spec.options.map((option) => [option.key, option.default])));
const shownOptions = computed(() => spec.options.filter((option) => option.when?.(options) ?? true));

const files = computed<ExampleFile[]>(() => [{ title: "index.html", lang: "html", code: spec.page(options) }, ...(spec.files?.(options) ?? [])]);
const fileIndex = ref(0);
const file = computed(() => files.value[Math.min(fileIndex.value, files.value.length - 1)]!);
const coloured = ref("");
watch(
  file,
  async (shown) => {
    if (typeof window === "undefined") return;
    const markup = await highlight(shown.code, shown.lang).catch(() => "");
    if (file.value === shown) coloured.value = markup;
  },
  { immediate: true }
);

// The frame: built once the example is on screen, rebuilt when the page's code changes.
const frameId = `example-${props.name}-${Math.random().toString(36).slice(2)}`;
const root = ref<HTMLElement>();
const frame = ref<HTMLIFrameElement>();
const state = ref<"waiting" | "running" | "missing">("waiting");
const visible = ref(false);
const height = ref(240);
const expanded = ref(false);
// A page with the builder on it needs room: under 900px the builder takes its small-screen layout,
// which hides the palette and the panels an example is there to show. Where the window has the
// room, such a result runs past the text column to the right, into the place of the page outline,
// which is hidden while the result is on screen (the stylesheet reads the class set below).
const BUILDER_WIDTH = 920;
const WIDEST = 1120;
const wide = computed(() => files.value[0]!.code.includes("<datum-form-builder"));
const wideWidth = ref(0);
function measure(): void {
  const left = root.value?.getBoundingClientRect().left ?? 0;
  const room = document.documentElement.clientWidth - left - 24;
  wideWidth.value = wide.value && room >= BUILDER_WIDTH ? Math.min(room, WIDEST) : 0;
}
watch(wide, () => measure());
// Whether this example's wide result is on screen now. The page may hold several: the outline
// stays hidden while any of them is, counted on the document.
const onScreen = ref(false);
const coversOutline = computed(() => onScreen.value && wideWidth.value > 0 && !expanded.value);
const OUTLINE_COUNT = "liveExampleWide";
function countOutline(change: 1 | -1): void {
  const html = document.documentElement;
  const count = Math.max(0, Number(html.dataset[OUTLINE_COUNT] ?? 0) + change);
  if (count > 0) html.dataset[OUTLINE_COUNT] = String(count);
  else delete html.dataset[OUTLINE_COUNT];
}
watch(coversOutline, (covers) => countOutline(covers ? 1 : -1));
const run = ref(0);
// The site's root, one level above the docs: where demo/ holds this site's copy of the bundles.
const siteRoot = (): string => new URL("../", new URL(withBase("/"), location.href)).pathname;
const bundles = (): string => `${siteRoot()}demo/`;
/** The example's files that have an address: the docs page serves them to the frame. */
const served = computed(() => files.value.filter((entry) => entry.path !== undefined));

// The frame's address, and those of the pages it frames itself. Blob addresses, revoked on change.
let addresses: string[] = [];
const frameSrc = ref("");
function build(): void {
  for (const address of addresses) URL.revokeObjectURL(address);
  addresses = [];
  if (!visible.value || state.value !== "running") {
    frameSrc.value = "";
    return;
  }
  const rewrites: Record<string, string> = { [`${BUNDLE_BASE}/`]: bundles() };
  for (const [written, real] of Object.entries(spec.rewrites ?? {})) rewrites[written] = `${siteRoot()}${real}`;
  const paths = [...STAND_IN_PATHS, ...(spec.paths ?? []), ...served.value.map((entry) => entry.path!)];
  // A page the example frames is loaded the same way, and the example's page is pointed at it.
  const pageRewrites = { ...rewrites };
  for (const entry of served.value.filter((candidate) => candidate.lang === "html")) {
    const address = frameAddress(frameDocument({ page: entry.code, frameId, rewrites, paths, nested: true }));
    addresses.push(address);
    pageRewrites[entry.path!] = address;
  }
  const address = frameAddress(frameDocument({ page: files.value[0]!.code, frameId, rewrites: pageRewrites, paths }));
  addresses.push(address);
  log.value = [];
  frameSrc.value = address;
}

interface LogLine { at: string; kind: "event" | "console" | "request"; text: string; more?: string }
const log = ref<LogLine[]>([]);
const logBox = ref<HTMLElement>();
const LOG_LIMIT = 60;

function compact(value: unknown): string {
  if (value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 96 ? `${text.slice(0, 96)}…` : text;
}

function note(kind: LogLine["kind"], text: string, detail?: unknown): void {
  const full = detail === undefined || detail === null ? undefined : JSON.stringify(detail, null, 2);
  log.value = [...log.value, { at: new Date().toLocaleTimeString(), kind, text, more: full !== undefined && full.length > 96 ? full : undefined }].slice(-LOG_LIMIT);
  requestAnimationFrame(() => logBox.value?.scrollTo({ top: logBox.value.scrollHeight }));
}

async function answer(request: Extract<FrameMessage, { kind: "request" }>, source: Window): Promise<void> {
  let reply: ExampleReply | undefined;
  let type = "application/json";
  const own = served.value.find((entry) => entry.path === request.path);
  if (request.method === "GET" && own) {
    reply = { status: 200, body: own.code };
    type = own.lang === "css" ? "text/css" : own.lang === "html" ? "text/html" : own.lang === "javascript" ? "text/javascript" : type;
  } else if (request.method === "GET" && request.path.startsWith("/forms/")) {
    // The definitions the examples load are files of this site's.
    const response = await fetch(withBase(request.path)).catch(() => undefined);
    reply = response?.ok ? { status: 200, body: await response.text() } : { status: 404 };
  } else {
    reply = (await Promise.resolve(spec.serve?.(request, options)).catch((error: unknown) => ({ status: 500, body: { error: String(error) } }))) ?? {
      status: 404,
      body: { error: "Nothing answers this address in the example." }
    };
  }
  const delay = reply.delay ?? 0;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  const body = reply.body;
  const bytes = body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof Blob;
  const text = body === undefined ? null : bytes ? (body as ArrayBuffer) : typeof body === "string" ? body : JSON.stringify(body);
  if (reply.type) type = reply.type;
  if (!own && !request.path.startsWith("/forms/")) {
    for (const line of reply.log ?? []) note("console", `server: ${line}`);
    const size = body instanceof Blob ? body.size : bytes ? (body as ArrayBuffer).byteLength : 0;
    const shown = bytes ? `${size} bytes of ${type}` : compact(body);
    note("request", `${request.method} ${request.path}  →  ${reply.fail ? "no answer" : `${reply.status ?? 200} ${shown}`}`, request.bytes ? `${request.bytes.byteLength} bytes sent` : request.body ? safeParse(request.body) : undefined);
  }
  source.postMessage(
    { datumExampleReply: frameId, id: request.id, fail: reply.fail === true, status: reply.status ?? 200, body: text, headers: { ...(text === null ? {} : { "content-type": type }), ...(reply.headers ?? {}) } },
    location.origin
  );
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function onMessage(event: MessageEvent): void {
  const message = event.data as ({ datumExample?: string } & FrameMessage) | null;
  // The frame id is this example's alone; the sender is its frame or a page that frame holds.
  if (!message || message.datumExample !== frameId || event.origin !== location.origin || !event.source) return;
  if (message.kind === "height") {
    // A builder in full window is out of the page's flow, so the page under it measures short.
    if (!expanded.value) height.value = Math.max(120, message.height);
  } else if (message.kind === "fullWindow") expanded.value = message.on;
  else if (message.kind === "event") note("event", `${message.type}  ${compact(message.detail)}`, message.detail);
  else if (message.kind === "console") note("console", `${message.level === "log" ? "" : `${message.level}: `}${message.args.map(compact).join(" ")}`);
  else if (message.kind === "request") void answer(message, event.source as Window);
}

function reload(): void {
  log.value = [];
  run.value += 1;
}

// Rebuilt when the example comes on screen and whenever a choice changes a file the frame loads.
watch([visible, state, () => files.value.map((entry) => entry.code).join("\u0000")], build);

let observer: IntersectionObserver | undefined;
let resultObserver: IntersectionObserver | undefined;
const result = ref<HTMLElement>();
onMounted(async () => {
  window.addEventListener("message", onMessage);
  window.addEventListener("resize", measure);
  measure();
  // The bundles are built apart from the docs. Without them the code still reads; say so.
  const probe = await fetch(`${bundles()}datum-form.js`, { method: "HEAD" }).catch(() => undefined);
  state.value = probe?.ok && (probe.headers.get("content-type") ?? "").includes("javascript") ? "running" : "missing";
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        visible.value = true;
        observer?.disconnect();
      }
    },
    { rootMargin: "200px" }
  );
  if (root.value) observer.observe(root.value);
  resultObserver = new IntersectionObserver((entries) => {
    onScreen.value = entries.some((entry) => entry.isIntersecting);
  });
  if (result.value) resultObserver.observe(result.value);
});
onBeforeUnmount(() => {
  window.removeEventListener("message", onMessage);
  window.removeEventListener("resize", measure);
  observer?.disconnect();
  resultObserver?.disconnect();
  if (coversOutline.value) countOutline(-1);
  for (const address of addresses) URL.revokeObjectURL(address);
});

function onKey(event: KeyboardEvent): void {
  if (event.key !== "Escape" || !expanded.value) return;
  // The builder holds its own full-window state: it is asked to leave, and reports that it has.
  if (wide.value) frame.value?.contentWindow?.postMessage({ datumExampleCommand: frameId, fullWindow: false }, location.origin);
  else expanded.value = false;
}
</script>

<template>
  <section ref="root" class="live-example" :aria-label="spec.title" @keydown="onKey">
    <div v-if="shownOptions.length > 0" class="live-example__options" role="group" aria-label="Example options">
      <label v-for="option in shownOptions" :key="option.key" class="live-example__option" :class="{ 'live-example__option--toggle': !option.choices }">
        <template v-if="option.choices">
          <span>{{ option.label }}</span>
          <select v-model="options[option.key]">
            <option v-for="choice in option.choices" :key="choice.value" :value="choice.value">{{ choice.label }}</option>
          </select>
        </template>
        <template v-else>
          <input v-model="options[option.key]" type="checkbox" />
          <span>{{ option.label }}</span>
        </template>
      </label>
    </div>

    <div v-if="files.length > 1" class="live-example__tabs" role="tablist" aria-label="Files">
      <button v-for="(entry, index) in files" :key="entry.title" type="button" role="tab" :aria-selected="index === fileIndex" @click="fileIndex = index">{{ entry.title }}</button>
    </div>
    <div class="live-example__code" :class="`language-${file.lang}`">
      <button title="Copy Code" class="copy"></button>
      <span class="lang">{{ files.length > 1 ? file.lang : file.title }}</span>
      <div v-if="coloured" v-html="coloured"></div>
      <pre v-else class="vp-code"><code>{{ file.code }}</code></pre>
    </div>

    <div
      ref="result"
      class="live-example__result"
      :class="{ 'live-example__result--expanded': expanded, 'live-example__result--wide': wideWidth > 0 && !expanded }"
      :style="wideWidth > 0 && !expanded ? { width: `${wideWidth}px` } : undefined"
    >
      <div class="live-example__bar">
        <span>Result</span>
        <span class="live-example__note">This page, running. Addresses under <code v-for="path in STAND_IN_PATHS" :key="path">{{ path }}</code> are answered by the example.</span>
        <button type="button" :disabled="state !== 'running'" @click="reload">Reload</button>
        <!-- A builder has a full-window button of its own, which the frame passes on. -->
        <button v-if="!wide" type="button" :aria-pressed="expanded" @click="expanded = !expanded">{{ expanded ? "Close" : "Expand" }}</button>
      </div>
      <p v-if="state === 'missing'" class="live-example__missing">
        The live result needs the built bundles, which this copy of the site does not have. The code above is the whole example.
      </p>
      <iframe v-else-if="frameSrc" :key="`${run}-${frameSrc}`" ref="frame" :title="spec.title" :src="frameSrc" :style="{ height: expanded && wide ? undefined : `${height}px` }"></iframe>
      <div v-else class="live-example__placeholder" :style="{ height: `${height}px` }"></div>
      <div class="live-example__log">
        <div class="live-example__log-head">What the page did</div>
        <div ref="logBox" class="live-example__log-body" role="log" aria-label="What the page did">
          <p v-if="log.length === 0">Nothing yet.</p>
          <template v-for="(line, index) in log" :key="index">
            <details v-if="line.more" :class="`is-${line.kind}`">
              <summary><time>{{ line.at }}</time> {{ line.text }}</summary>
              <pre>{{ line.more }}</pre>
            </details>
            <div v-else :class="`is-${line.kind}`"><time>{{ line.at }}</time> {{ line.text }}</div>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>
