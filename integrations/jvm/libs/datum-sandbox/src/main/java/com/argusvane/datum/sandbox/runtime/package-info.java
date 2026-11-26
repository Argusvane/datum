/**
 * The sandbox as an application runs it: {@link com.argusvane.datum.sandbox.runtime.DatumSandbox},
 * the framework-free lifecycle over an engine and the two Datum programs (start, ABI proof, warm-up, run pool and slots, recheck,
 * stop), and {@link com.argusvane.datum.sandbox.runtime.SandboxSettings}, the one immutable tree of settings with every default and
 * every clamp, whose {@code explain()} says where each value came from.
 *
 * <p>A host with no framework writes {@code try (DatumSandbox sandbox = DatumSandbox.builder().build()) { sandbox.start();
 * sandbox.sandbox().validate(...); }}: the engine is selected by {@code settings.engine().id()} and the programs are the packaged
 * ones. A framework binding maps its configuration onto {@link com.argusvane.datum.sandbox.runtime.SandboxSettings#builder()} and
 * hands over the beans it has (the engine, the event publisher, the decorators); {@link com.argusvane.datum.sandbox.runtime.SandboxStatus}
 * is what health and an actuator endpoint show.
 */
package com.argusvane.datum.sandbox.runtime;
