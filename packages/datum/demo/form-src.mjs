// The ?src= parameter of demo/form.html: which definition the page loads. Only a relative
// path or an http(s) address is accepted (a javascript:, data: or file: address is ignored),
// and the browser's same-origin / CORS rules still decide whether the fetch succeeds; a
// failure shows the element's own error card. Absent or refused, the page keeps its default.
export const DEFAULT_FORM_SRC = "/demo/intake-form.json";

export function formSrcFromSearch(search, base = "http://localhost/") {
  const raw = new URLSearchParams(search).get("src");
  if (raw === null || raw.trim() === "") {
    return undefined;
  }
  const value = raw.trim();
  // A scheme-less value is a relative path; resolve it only to read its protocol.
  let url;
  try {
    url = new URL(value, base);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return undefined;
  }
  return value;
}
