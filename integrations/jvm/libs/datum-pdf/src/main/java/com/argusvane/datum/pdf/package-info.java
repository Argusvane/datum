/**
 * Datum PDF: the PDF program's ops for a server host, the seal with the server's key and the
 * host's half of verifying a PDF, framework-free.
 *
 * <p>{@link com.argusvane.datum.pdf.PdfService} assembles, runs and seals the PDF program's requests;
 * {@link com.argusvane.datum.pdf.verify} holds the host's half of verifying;
 * {@link com.argusvane.datum.pdf.api.PdfApi} holds every decision of the HTTP
 * endpoints so the MVC and WebFlux adapters (and a Quarkus binding) only move bytes.
 */
package com.argusvane.datum.pdf;
