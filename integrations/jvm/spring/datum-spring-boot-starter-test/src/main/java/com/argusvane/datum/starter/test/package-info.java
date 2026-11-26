/**
 * Test support for applications that use Datum for Spring Boot: {@link
 * com.argusvane.datum.starter.test.AutoConfigureDatum} swaps the WebAssembly engine for a
 * {@link com.argusvane.datum.starter.test.FakeGuestRuntime}, {@link
 * com.argusvane.datum.starter.test.DatumTestForms} holds fixture definitions, and the {@code Datum*}
 * helper classes drive the endpoints through MockMvc or WebTestClient. {@link
 * com.argusvane.datum.starter.test.DatumTck} points the host test kit's contracts (datum-host-tck) at the
 * application on its test port.
 */
package com.argusvane.datum.starter.test;
