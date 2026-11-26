package com.argusvane.datum.sandbox.endive;

import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;

/**
 * What health and info report about the runtime: the runner in use and the pinned QuickJS module the jar was
 * compiled from.
 *
 * @param runner "panama", "jffi" or "bytecode"
 * @param providerClass the native provider's class, or {@code null} on bytecode
 * @param selection why this runner, and what was passed over
 * @param qjsVersion the quickjs-ng release ({@code qjs.version} of the pom's pin)
 * @param qjsSha256 the sha256 of {@code qjs-wasi.wasm} the build checked
 * @param qjsSize its size in bytes
 * @param endiveVersion the Endive release that compiled it
 * @param initialMemoryBytes the module's own initial memory: the least memory budget a run can take
 */
public record RuntimeInfo(String runner, String providerClass, String selection, String qjsVersion, String qjsSha256,
                          long qjsSize, String endiveVersion, long initialMemoryBytes) {

    /** Where the build writes the pin ({@code src/main/resources}, filtered). */
    public static final String RESOURCE = "META-INF/datum/runtime.properties";

    /** Whether QuickJS runs as native code. */
    public boolean isNative() {
        return !Runner.BYTECODE.id().equals(runner);
    }

    /** The pin as the jar carries it; "unknown" for any value it lacks (a jar not built by Maven). */
    static Properties pin() {
        Properties properties = new Properties();
        try (InputStream in = RuntimeInfo.class.getClassLoader().getResourceAsStream(RESOURCE)) {
            if (in != null) {
                properties.load(in);
            }
        } catch (IOException e) {
            // Health shows "unknown"; nothing about a run depends on it.
        }
        return properties;
    }

    static RuntimeInfo of(ProviderSelector.Selection selection, long initialMemoryBytes) {
        Properties pin = pin();
        long size;
        try {
            size = Long.parseLong(pin.getProperty("qjs.size", "-1"));
        } catch (NumberFormatException e) {
            size = -1;
        }
        return new RuntimeInfo(selection.runner().id(), selection.provider() == null ? null : selection.provider().getClass().getName(),
            selection.reason(), pin.getProperty("qjs.version", "unknown"), pin.getProperty("qjs.sha256", "unknown"), size,
            pin.getProperty("endive.version", "unknown"), initialMemoryBytes);
    }
}
