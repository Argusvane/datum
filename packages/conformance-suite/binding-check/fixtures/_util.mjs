// Fixture helpers: a minimal form definition around a list of components, and the translation
// record the engine expects (the source hash ties a translation to the English text it renders).
export const form = (content, extra = {}) => ({
  id: "bc-" + Math.random().toString(36).slice(2, 7),
  version: "1.0.0",
  schemaVersion: "1",
  localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr-CA", label: "Français" }] },
  root: { id: "root", type: "form", configuration: {}, children: { content } },
  ...extra
});
export const hash = (text) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};
export const tr = (text, french) => ({ text: french, source: hash(text) });
