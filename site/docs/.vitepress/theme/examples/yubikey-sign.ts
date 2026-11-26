/** A form whose PDF the person signs with the certificate on their own token, through a local agent. */
import { SAMPLE_DATA_SOURCES, bundleTags, htmlDocument, jsLiteral, moduleScript, openTag } from "./page";
import type { ExampleSpec } from "./types";

const AGENT_URL = "http://127.0.0.1:7391";
const DEFINITION_URL = "/forms/signed-intake.json";

export const yubikeySignExample: ExampleSpec = {
  title: "A page that signs the PDF with a hardware token",
  options: [
    {
      key: "slot",
      label: "Certificate",
      default: "9c",
      choices: [
        { value: "9c", label: "YubiKey, slot 9c" },
        { value: "file", label: "A certificate file (--p12)" }
      ]
    }
  ],
  page(options) {
    const element = openTag("datum-form", [`id="intake"`, `src="${DEFINITION_URL}"`, `pdf="auto"`]) + "</datum-form>";
    return htmlDocument("Customer intake, signed", bundleTags("form"), [
      element,
      `    <p>`,
      `      <button id="plain" type="button">Draw the PDF</button>`,
      `      <button id="sign" type="button">Sign with my certificate</button>`,
      `      <span id="status" role="status"></span>`,
      `    </p>`,
      ``,
      moduleScript([
        `// The bundle exports the client for the local signing agent: no key and no`,
        `// cryptography in the page.`,
        `import { createAgentPdfSigner } from "/datum/datum-form.js";`,
        ``,
        `const form = document.getElementById("intake");`,
        `form.dataSources = ${jsLiteral(SAMPLE_DATA_SOURCES)};`,
        `const status = document.getElementById("status");`,
        ``,
        `// The unsigned PDF, drawn in the browser.`,
        `document.getElementById("plain").addEventListener("click", async () => {`,
        `  const { bytes, pageCount } = await form.renderPdf();`,
        `  status.textContent = \`Drew \${pageCount} page(s), \${bytes.length} bytes, unsigned.\`;`,
        `});`,
        ``,
        `// The agent runs on the person's own computer and listens on the loopback address for`,
        `// the origins it was started with. It asks for the PIN or passphrase in the system's`,
        `// own dialog, so the page never sees it, and it never sees the PDF.`,
        `document.getElementById("sign").addEventListener("click", async () => {`,
        `  status.textContent = "Waiting for the prompt on your computer…";`,
        `  try {`,
        `    // Lists what the agent holds and takes ${options.slot === "file" ? `its certificate file` : `slot 9c, the Digital Signature slot`}.`,
        `    form.pdfSigner = await createAgentPdfSigner({ url: "${AGENT_URL}", slot: "${options.slot}" });`,
        `    // The layout ends in a signature field. The kernel prepares the bytes, the agent`,
        `    // signs them, the kernel embeds the signature and the file downloads.`,
        `    const { signature } = await form.downloadPdf();`,
        `    status.textContent = \`Signed in \${signature.field}.\`;`,
        `  } catch (error) {`,
        `    // error.code: unreachable, origin_denied, no_device, pin_cancelled, pin_invalid,`,
        `    // pin_blocked, touch_timeout, busy`,
        `    status.textContent = \`Not signed (\${error.code ?? "error"}): \${error.message}\`;`,
        `    console.log("not signed:", error.code ?? error.message);`,
        `  } finally {`,
        `    form.pdfSigner = undefined; // one signed download; the plain PDF stays plain`,
        `  }`,
        `});`
      ])
    ]);
  }
};
