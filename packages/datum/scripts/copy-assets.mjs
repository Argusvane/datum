// Copies the stylesheets a page may <link> beside the bundles into dist/: the two small
// companion sheets for the elements (a plugin package's own assets are copied beside its
// bundle by its own build). Also the PDF
// program for a server's own QuickJS, the fonts both the PDF module and that server embed,
// and what pdf.js reads beside the page imagery module: its worker, the standard
// fonts, the CMaps, the wasm decoders and the ICC profiles — served locally, never from a CDN.
// Each copied font and data folder carries the licence of its package beside it (fonts/LICENSE,
// pdfjs/LICENSE), and the program its licence file (scripts/bundle-notices.mjs writes the other bundles').
import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

const assets = [
  [join(root, "src", "datum-form.css"), "datum-form.css"],
  [join(root, "src", "datum-builder.css"), "datum-builder.css"],
  // The PDF program as @argusvane/datum-pdf-kernel bundles it, beside the bundles under the
  // name the sandbox program's sets (datum-sandbox-program.js): what a server evaluates in a
  // QuickJS of its own to render the very PDF the browser's PDF button renders.
  // Built by `npm run build:program` in packages/pdf-kernel, which the package's own tests run.
  [join(root, "node_modules", "@argusvane", "datum-pdf-kernel", "dist", "datum-pdf.program.js"), "datum-pdf-program.js"],
  // The licence text of the packages the program carries (pdf-lib, fontkit and the rest), written by the same build.
  [join(root, "node_modules", "@argusvane", "datum-pdf-kernel", "dist", "datum-pdf.program.LICENSE.txt"), "datum-pdf-program.LICENSE.txt"]
];

// The fonts the PDF module (`dist/datum-pdf.js`) fetches from `fonts/` beside itself: the
// DejaVu Sans pair it loads by default, plus the rest of the pack for a page that asks for more.
const fontsDir = join(root, "node_modules", "dejavu-fonts-ttf", "ttf");
for (const file of ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSans-Oblique.ttf", "DejaVuSerif.ttf", "DejaVuSerif-Bold.ttf", "DejaVuSansMono.ttf", "DejaVuSansMono-Bold.ttf"]) {
  assets.push([join(fontsDir, file), join("fonts", file)]);
}
// The DejaVu licence asks that its notice travel with every copy of the fonts: it sits beside them.
assets.push([join(root, "node_modules", "dejavu-fonts-ttf", "LICENSE"), join("fonts", "LICENSE")]);
mkdirSync(join(dist, "fonts"), { recursive: true });

// The builder's own faces (the studio look): Geist and Geist Mono with their licence and
// @font-face sheet, copied whole to `builder-fonts/` beside the bundles, where
// <datum-form-builder load-fonts> links them from (src/builder-fonts.ts).
cpSync(join(root, "fonts", "builder-fonts"), join(dist, "builder-fonts"), { recursive: true });
console.log("copy-assets: dist/builder-fonts/");

for (const [from, name] of assets) {
  if (!existsSync(from)) {
    const hint = name.startsWith("datum-pdf-program") ? "run npm run build:program in packages/pdf-kernel" : "run npm install?";
    console.error(`copy-assets: missing ${from} (${hint})`);
    process.exit(1);
  }
  copyFileSync(from, join(dist, name));
  console.log(`copy-assets: dist/${name}`);
}

// What `dist/datum-pdf-pages.js` fetches from `pdfjs/` beside itself. The worker is the
// legacy build, the one the module itself is bundled from; the rest are pdf.js's own data
// directories, copied whole (about 4 MB on disk, fetched only as a page needs them).
const pdfjs = join(root, "node_modules", "pdfjs-dist");
const pdfjsOut = join(dist, "pdfjs");
mkdirSync(pdfjsOut, { recursive: true });
copyFileSync(join(pdfjs, "legacy", "build", "pdf.worker.min.mjs"), join(pdfjsOut, "pdf.worker.min.mjs"));
console.log("copy-assets: dist/pdfjs/pdf.worker.min.mjs");
// pdf.js's own licence (Apache-2.0), beside its worker; the data folders below carry the licences of what they hold.
copyFileSync(join(pdfjs, "LICENSE"), join(pdfjsOut, "LICENSE"));
console.log("copy-assets: dist/pdfjs/LICENSE");
for (const dir of ["standard_fonts", "cmaps", "wasm", "iccs"]) {
  cpSync(join(pdfjs, dir), join(pdfjsOut, dir), { recursive: true });
  console.log(`copy-assets: dist/pdfjs/${dir}/`);
}
