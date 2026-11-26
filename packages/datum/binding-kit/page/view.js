// The viewer's pane page (serve.mjs): /binding-check/run/kit/view.html?case=<id>&pane=plain|shadow|binding.
// It draws one pane of one case the way equality.mjs does (the same kit page functions), so what an
// author sees while writing a binding is what the check measures. The binding pane does what a
// keyboard-less viewer can: validate, set, type (as a written value), focus, blur and settle; a
// click or a key press step shows only in the check.
const params = new URLSearchParams(location.search);
const config = await (await fetch("/binding-check/run/kit/config.json")).json();
const entry = await (await fetch(`/binding-check/run/kit/cases/${encodeURIComponent(params.get("case"))}.json`)).json();
const pane = params.get("pane");
const meta = entry.meta;
const info = await kit.init(config.urls);
const common = { assets: config.assets, bodyClass: meta.bodyClass ?? config.bodyClass, lang: meta.lang ?? config.lang, width: meta.width ?? 560, root: meta.root, focus: meta.focus };
if (pane === "plain") await kit.plain({ ...common, html: entry.html, init: meta.init });
else if (pane === "shadow") await kit.shadow({ ...common, html: entry.html, init: meta.initShadow, bindingId: `${config.id}-reference`, rootFontSize: info.rootFontSize });
else {
  if (config.bodyClass || meta.bodyClass) document.body.className = meta.bodyClass ?? config.bodyClass;
  await bc.load(config.urls.hostUrl, config.urls.bindingUrl, config.assets);
  await bc.mount({ definition: entry.definition, preset: meta.preset, mode: meta.mode, locale: meta.locale, assets: config.assets });
  document.querySelector("[data-bc-host]").style.width = `${meta.width ?? 560}px`;
  for (const step of meta.steps ?? []) {
    if (step.op === "validate") await bc.validate();
    else if (step.op === "set") { bc.setValue(step.path, step.value); await bc.settle(150); }
    else if (step.op === "type") { bc.setValue(step.id, step.text); await bc.settle(150); }
    else if (step.op === "focus") bc.focusControl(step.id, step.index ?? 0, step.which ?? 0);
    else if (step.op === "blur") bc.blur();
    else if (step.op === "settle") await bc.settle(step.ms ?? 150);
  }
}
document.title = `${pane}: ${params.get("case")}`;
