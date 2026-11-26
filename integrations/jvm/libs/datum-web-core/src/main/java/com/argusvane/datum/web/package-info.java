/**
 * Datum shared web plumbing for Spring MVC and WebFlux.
 *
 * <p>Every capability module (forms, submissions, ui, pdf, timestamp, webauthn) builds its endpoints on this
 * package: the {@code datum.*} properties, one error mapping for both stacks ({@code error}), the body cap and
 * the Datum JSON mapper ({@code json}), the versioned asset handler and the page glue ({@code assets}), the
 * stack adapters ({@code mvc}, {@code webflux}), the shared OpenAPI pieces ({@code openapi}) and the actuator
 * scaffolding ({@code actuator}). Both web stacks are optional dependencies: nothing here loads a class of a
 * stack the application does not run.
 */
package com.argusvane.datum.web;
