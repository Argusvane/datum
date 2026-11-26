---
layout: home
title: Datum docs
titleTemplate: false

hero:
  name: Datum
  text: Sovereign forms, documented.
  tagline: One form definition. A page, a PDF, a printed sheet, a validated record, a signature. All of it on hardware you run.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: What Datum is
      link: /introduction
    - theme: alt
      text: Back to the site
      link: ../
      target: _self

features:
  - title: A form on a page
    details: Load one module, place one element, point it at the definition the builder saved. The binding, the locale, the draft key and the PDF layer are attributes or properties.
    link: /getting-started
    linkText: Getting started
  - title: Build without a server
    details: The builder, the renderer, the validation sandbox and PDF generation run in the browser. Design, test and publish a complete form before any server exists.
    link: /building-a-form
    linkText: Building a form
  - title: One verdict on both sides
    details: The same kernel program checks the answers in the page while you develop and inside a WASM sandbox on your server. Same definition, same answers, same bytes.
    link: /validation
    linkText: Validation and the sandbox
  - title: PDFs from the answers
    details: Draw a layout, or keep the fillable PDF you already have and fill its fields. PDF/A levels, embedded attachments and PAdES signatures are settings, not projects.
    link: /pdf
    linkText: PDFs
  - title: Your look
    details: Datum draws forms in its own light and dark look. A binding draws a form in a design system's own markup and components.
    link: /look
    linkText: Look and chrome
  - title: Your server, your framework
    details: Spring Boot and FastAPI hosts are built, with the same endpoints, codes and sandbox. A conformance suite holds every host to the same wire.
    link: /server-hosts
    linkText: Server hosts
---
