// What the binding pages publish of each design system's own files, and what they leave out. One entry per
// reference binding (bindings/<id>); scripts/copy-binding-assets.mjs reads it. The files are the pinned
// release the binding's tests run against (bindings/<id>/node_modules, or bindings/<id>/vendor for a
// stylesheet pinned from the design system's own site), served as the design system ships them except
// for the redactions below: a typeface a licence keeps for the authority's own services, a government's
// signature or logo. A binding with no entry is not shown live.
//
//   url      the host files the binding's own binding-check.json names, as it lists them: a root-absolute
//            path ("/node_modules/<package>/…" or "/vendor/…"). The copy publishes each at
//            bindings/<id>/files/<path without node_modules/> and the manifest points the page at it.
//   vendor   what is copied: { from, only?, skip? }. `from` is a path inside bindings/<id> (a file or a
//            folder), `only` a filter on a file's name, `skip` a filter on its path below `from` (a mark,
//            a source map). Every vendored package gets a NOTICE.txt beside its files.
//   redact   [file pattern, text pattern, replacement, expected matches] over the copied files. Each
//            expectation must hold or the copy fails: the library changed, so read what it draws before
//            publishing it again.
//   notices  { <package folder>: lines } the licence statement written beside a package's files.
//
// GDS Transport is never served. The GOV.UK entry drops the stylesheet's @font-face rules for it
// and the crest it names; the page says the form falls back to Arial.

const NOT_MAP = (name) => !name.endsWith(".map");
const WOFF2 = (name) => name.endsWith(".woff2");

const MIT_TEXT = [
  "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:",
  "",
  "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.",
  "",
  "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE."
];

/** A notice for a package whose own folder ships no licence file: what its package.json states, and the licence text where it is a standard one. */
function notice(lines, { mit } = {}) {
  return [...lines, ...(mit ? ["", `The MIT License (MIT)`, "", `Copyright: ${mit}`, "", ...MIT_TEXT] : [])].join("\n");
}

/** The binding ids the pages show, in the order the index lists them (Datum's own is built in and needs nothing here). */
export const REFERENCE_BINDINGS = ["gcds", "govuk", "uswds", "bootstrap", "nova-scotia", "alberta", "quebec", "ontario", "fluent"];

/** Per binding: what is copied, redacted and noticed. */
export const BINDING_ASSETS = {
  gcds: {
    vendor: [{ from: "node_modules/gcds-components-1.7.0/dist/gcds", only: NOT_MAP }],
    // The component bundle draws the Government of Canada signature and wordmark as inline svg: the title stays, the artwork goes.
    redact: [
      [
        /^gcds-components-1\.7\.0\/dist\/gcds\/.*\.js$/,
        /(<svg[^>]*aria-labelledby="(?:wordmark|signature)-(?:en|fr)-title">(?:\\n|\\t)*<title[\s\S]*?<\/title>)[\s\S]*?(<\/svg>)/g,
        "$1$2",
        4
      ]
    ],
    notices: {
      "gcds-components-1.7.0": notice(
        [
          "@gcds-core/components 1.7.0, the GC Design System components: https://github.com/cds-snc/gcds-components",
          "",
          "Licence: MIT, as the package's package.json declares; the package ships no licence file.",
          "Not published: the Government of Canada signature and wordmark, which the component bundle draws as inline svg (the titles stay, the artwork is removed)."
        ],
        { mit: "Government of Canada / Gouvernement du Canada (the package's author field)" }
      )
    }
  },
  govuk: {
    vendor: [
      { from: "node_modules/govuk-frontend-6.6.0/dist/govuk/govuk-frontend.min.css" },
      { from: "node_modules/govuk-frontend-6.6.0/dist/govuk/all.bundle.js" }
    ],
    // The stylesheet names GDS Transport (two @font-face rules) and the crest (three uses) by root-absolute address.
    // Neither is published, so the references go and the browser asks this site for nothing.
    redact: [
      [/govuk-frontend\.min\.css$/, /@font-face\{font-family:GDS Transport;[^}]*\}/g, "", 2],
      [/govuk-frontend\.min\.css$/, /url\(\/assets\/images\/govuk-crest\.svg\)/g, "none", 3]
    ],
    notices: {
      "govuk-frontend-6.6.0": notice(
        [
          "govuk-frontend 6.6.0, https://github.com/alphagov/govuk-frontend/tree/v6.6.0/packages/govuk-frontend",
          "",
          "Licence: MIT, as the repository's LICENSE.txt gives it (https://github.com/alphagov/govuk-frontend/blob/v6.6.0/LICENSE.txt); the package ships no licence file. The documentation is Crown copyright, under the Open Government Licence v3.0.",
          "The GDS Transport typeface and the crown and logotype are for GOV.UK services only: none is served here, and the stylesheet's references to them are removed. A form drawn with it falls back to Arial."
        ],
        { mit: "2017 Crown Copyright (Government Digital Service)" }
      )
    }
  },
  uswds: {
    vendor: [
      { from: "node_modules/uswds-3.14.0/dist/css/uswds.min.css" },
      { from: "node_modules/uswds-3.14.0/dist/fonts", only: WOFF2 },
      { from: "node_modules/uswds-3.14.0/dist/img", skip: (path) => /^(material-icons|favicons)|hero\./.test(path) },
      { from: "node_modules/uswds-3.14.0/LICENSE.md" },
      // LICENSE.md links the Apache License 2.0 of the Material Icons in img/ by address only: the text is kept in the binding.
      { from: "vendor/LICENSE-Apache-2.0.txt" }
    ],
    notices: { "uswds-3.14.0": "@uswds/uswds 3.14.0, the U.S. Web Design System: https://github.com/uswds/uswds\n\nLicence: the package's LICENSE.md, beside this notice (a public-domain dedication for the project's own work, with the licences of the fonts and icons it includes). The Apache License 2.0 that covers the Material Icons in img/ (sprite.svg, usa-icons, usa-icons-bg) is published as vendor/LICENSE-Apache-2.0.txt." }
  },
  bootstrap: {
    vendor: [{ from: "node_modules/bootstrap-5.3.8/dist/css/bootstrap.min.css" }, { from: "node_modules/bootstrap-5.3.8/LICENSE" }],
    notices: { "bootstrap-5.3.8": "Bootstrap 5.3.8, https://github.com/twbs/bootstrap\n\nLicence: MIT, the package's LICENSE, beside this notice." }
  },
  "nova-scotia": {
    // saltire.css is css/saltire.css of https://github.com/nsgov/patternlibrary at commit 663c256, with the url() of the
    // Open Sans faces pointing at the copies beside it. The library's logos are not copied.
    vendor: [
      { from: "vendor/saltire/saltire.css" },
      { from: "vendor/saltire/LICENSE" },
      { from: "vendor/saltire/fonts", only: (name) => name.endsWith(".woff") },
      // The Apache text of the Open Sans faces, in the folder of the faces it covers.
      { from: "vendor/saltire/fonts/LICENSE-open-sans-apache.txt" },
      { from: "node_modules/font-awesome-4.7.0/css/font-awesome.min.css" },
      { from: "node_modules/font-awesome-4.7.0/fonts", only: (name) => /\.woff2?$/.test(name) },
      // The package ships no licence file; the SIL OFL 1.1 text the font declares is kept in the binding and published with the files.
      { from: "vendor/font-awesome/OFL-font-awesome-4.7.txt" }
    ],
    notices: {
      vendor: [
        "Files of the Nova Scotia Pattern Library, pinned in Datum's Nova Scotia binding.",
        "",
        "saltire/saltire.css: css/saltire.css of https://github.com/nsgov/patternlibrary at commit 663c256 (2021-09-15), under the repository's MIT licence, except that the url() of the Open Sans faces points at the copies beside it. Its logos are not copied.",
        "saltire/fonts: the Open Sans .woff faces the library serves, under the Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0)."
      ].join("\n"),
      "font-awesome-4.7.0": [
        "Font Awesome 4.7.0 by Dave Gandy, https://fontawesome.io, source https://github.com/FortAwesome/Font-Awesome",
        "",
        "The Font Awesome font is licensed under the SIL Open Font License 1.1 (https://scripts.sil.org/OFL).",
        "Font Awesome CSS, LESS and Sass files are licensed under the MIT License (https://opensource.org/licenses/mit-license.html).",
        "The package ships no licence file; this notice repeats what its README and its stylesheet header state. The OFL text is published as vendor/font-awesome/OFL-font-awesome-4.7.txt."
      ].join("\n")
    }
  },
  alberta: {
    vendor: [
      { from: "node_modules/abgov-web-components-3.2.0/index.js" },
      { from: "node_modules/abgov-web-components-3.2.0/index.css" },
      // The package ships no licence file: the Apache License 2.0 its package.json declares and the repository's own LICENSE text are kept in the binding.
      { from: "reference/LICENSE-abgov-web-components.txt" }
    ],
    // The header's two logo images (118 x 32 and 32 x 32), each inline twice, are inline in the component bundle: replaced by an empty svg.
    redact: [
      [
        /index\.js$/,
        /data:image\/svg\+xml;base64,PHN2ZyB3aWR0aD0i(?:MTE4IiBoZWlnaHQ9IjMyIiB2aWV3|MzIiIGhlaWdodD0iMzIiIHZpZXdC)[A-Za-z0-9+/=]*/g,
        "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
        4
      ]
    ],
    notices: {
      "abgov-web-components-3.2.0": notice(
        [
          "@abgov/web-components 3.2.0, the Alberta Design System components: https://github.com/GovAlta/ui-components",
          "",
          "Licence: Apache License 2.0, as the package's package.json declares; the package ships no licence file. The upstream repository's own LICENSE file reads as the MIT text (Copyright (c) 2020-2026 Government of Alberta). Both texts are published as reference/LICENSE-abgov-web-components.txt.",
          "Not published: the Government of Alberta header logos, which the component bundle carries inline (replaced by an empty svg)."
        ]
      )
    }
  },
  ontario: {
    vendor: [
      {
        from: "node_modules/ontario-design-system-component-library-9.2.2/dist/ontario-design-system-components",
        only: (name) => /\.(js|css|svg)$/.test(name),
        // The Ontario logo, the trillium favicon and the footer supergraphic are the province's identity, not the design system's code.
        skip: (path) => /logo|supergraphic|favicon/i.test(path) || path.endsWith(".map") || path.startsWith("fonts/")
      },
      { from: "node_modules/ontario-design-system-component-library-9.2.2/LICENSE" },
      { from: "node_modules/ontario-design-system-global-styles-9.2.2/dist/styles/css/compiled/ontario-theme.min.css" },
      { from: "node_modules/ontario-design-system-global-styles-9.2.2/dist/fonts", only: WOFF2 },
      // The package's OFL 1.1 text for those fonts, in the license/ folder it keeps beside them.
      { from: "node_modules/ontario-design-system-global-styles-9.2.2/dist/fonts/license/OFL.txt" },
      { from: "node_modules/ontario-design-system-global-styles-9.2.2/LICENSE" }
    ],
    notices: {
      "ontario-design-system-component-library-9.2.2": "@ongov/ontario-design-system-component-library 9.2.2: https://github.com/ongov/ontario-design-system\n\nLicence: Apache License 2.0, the package's LICENSE, beside this notice.\nNot published: the Ontario logo, the trillium favicon and the footer supergraphic.",
      "ontario-design-system-global-styles-9.2.2": "@ongov/ontario-design-system-global-styles 9.2.2: https://github.com/ongov/ontario-design-system\n\nLicence: Apache License 2.0, the package's LICENSE, beside this notice."
    }
  },
  fluent: {
    // Fluent ships no stylesheet. theme/*.css are bindings/fluent/theme: custom-property sheets Datum generates from the
    // pinned @fluentui/tokens (bindings/fluent/scripts/generate-theme.mjs). The component script is one self-contained
    // module that defines every fluent- element on import. No font is named by either: Fluent's type is a system stack.
    vendor: [
      { from: "theme", only: (name) => name.endsWith(".css") },
      { from: "node_modules/fluentui-web-components-3.2.1/dist/web-components.min.js" },
      { from: "node_modules/fluentui-tokens-1.0.0-alpha.24/LICENSE" }
    ],
    notices: {
      "fluentui-web-components-3.2.1": notice(
        [
          "@fluentui/web-components 3.2.1, the Fluent UI web components (Fluent 2): https://github.com/microsoft/fluentui/tree/master/packages/web-components",
          "",
          "Licence: MIT, as the package's package.json declares; the package ships no licence file.",
          "Published: dist/web-components.min.js only. The package names no font and ships no icon file."
        ],
        { mit: "Microsoft Corporation (the package's author field)" }
      ),
      "fluentui-tokens-1.0.0-alpha.24": [
        "@fluentui/tokens 1.0.0-alpha.24, the Fluent 2 design tokens: https://github.com/microsoft/fluentui/tree/master/packages/tokens",
        "",
        "Licence: MIT, the package's LICENSE, beside this notice.",
        "The theme/*.css files published with the binding are generated by Datum from this release (the Teams light, dark and high contrast themes and the web light and dark themes, as custom properties); they are not Microsoft's files.",
        "The package's own note applies: usage of the fonts and icons referenced in Fluent UI React is subject to the terms at https://aka.ms/fluentui-assets-license. None is published here."
      ].join("\n")
    }
  },
  quebec: {
    vendor: [
      { from: "node_modules/qc-trousse-sdg-1.6.1/dist/css/qc-sdg-rfz100.min.css" },
      { from: "node_modules/qc-trousse-sdg-1.6.1/dist/js/qc-sdg.min.js" },
      { from: "node_modules/qc-trousse-sdg-1.6.1/dist/fonts", only: WOFF2 },
      // The package ships no font licence text: the standard OFL 1.1 (Open Sans, Roboto, Roboto Mono) and Apache 2.0 (Material Symbols) texts are kept in the binding.
      { from: "vendor/fonts/LICENSE-OFL-1.1.txt" },
      { from: "vendor/fonts/LICENSE-Apache-2.0.txt" },
      // Only the search icon of dist/img: QUEBEC_blanc.svg and QUEBEC_couleur.svg are the government's signature.
      { from: "node_modules/qc-trousse-sdg-1.6.1/dist/img/piv-search.svg" },
      { from: "node_modules/qc-trousse-sdg-1.6.1/copyright.txt" }
    ],
    // The package states ISC in package.json and ships one licence file, copyright.txt, an MIT text naming another company.
    // The notice says both, and the file rides along.
    notices: {
      "qc-trousse-sdg-1.6.1": [
        "qc-trousse-sdg 1.6.1, the toolkit of the Système de design gouvernemental du Québec: https://github.com/Quebecca/qc_trousse_sdg",
        "",
        "What the package declares: its package.json gives the licence as ISC and names MCE as author.",
        "What the package ships: its one licence file, copyright.txt (beside this notice), is an MIT text with the copyright line of another company. The two statements differ. These files are published under the licence the package.json declares, ISC, whose text follows; the MIT text is kept beside them as the package ships it.",
        "",
        "Not published: the Government of Québec signature (dist/img/QUEBEC_blanc.svg, QUEBEC_couleur.svg) and the header images.",
        "",
        "dist/fonts: Open Sans, Roboto and Roboto Mono, under the SIL Open Font License 1.1; Material Symbols Rounded, copyright Google LLC, under the Apache License 2.0. The two standard texts are published as vendor/fonts/LICENSE-OFL-1.1.txt and vendor/fonts/LICENSE-Apache-2.0.txt.",
        "",
        "ISC License",
        "",
        "Copyright (c) MCE (the author named by the package's package.json)",
        "",
        "Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.",
        "",
        "THE SOFTWARE IS PROVIDED \"AS IS\" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE."
      ].join("\n")
    }
  }
};

/** The typefaces a form may not be served in, by design system: the pages say what the form falls back to. */
export const NOT_SERVED_FONTS = { govuk: "GDS Transport" };

/**
 * Every package's notice, by its folder name (`vendor` for the Nova Scotia files pinned in the binding): the
 * NOTICE.txt a host that publishes the package's files writes beside them. The binding pages write it here.
 */
export const PACKAGE_NOTICES = Object.fromEntries(Object.values(BINDING_ASSETS).flatMap((spec) => Object.entries(spec.notices)));
