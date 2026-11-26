package com.argusvane.datum.sandbox.protocol;

import java.util.List;
import java.util.Objects;

/**
 * Wraps the {@link Sandbox} a host's runtime makes for the programs it has just loaded (a decorator wraps it, none
 * replaces it): the runtime builds
 * {@link SandboxService} itself, at every start and recheck, over its own guarded engine, the slots, the ABI gate and the
 * run log, and hands it to each decorator in order, so whatever they answer is what the ABI proof, the warm-up runs and
 * every request run go through. A decorator is handed only the sandbox the runtime built (or what the decorator before it
 * answered), never the runtime's parts. That it wraps what it is handed, rather than answering a sandbox of its own (one
 * {@link SandboxService#create} built over another runtime, say), is a contract the code does not enforce: the runtime
 * cannot tell a wrapper from a stand-in.
 *
 * <p>Several coexist, as Spring Boot composes its {@code TaskDecorator}s: {@link #compose} applies them in the order
 * given, the first wrapping the runtime's sandbox and each next one wrapping the one before, so the last sees each call
 * first. A Spring binding collects every decorator bean in the framework's order ({@code @Order}, {@code Ordered},
 * {@code @Priority}). A decorator delegates every call to the sandbox it was given and never answers in its place
 * (see {@link Sandbox}: delegate, observe, rethrow).
 */
@FunctionalInterface
public interface SandboxDecorator {

    /**
     * @param sandbox the sandbox to wrap: the runtime's, or what the decorator before this one answered
     * @return the sandbox the callers use; never null
     */
    Sandbox decorate(Sandbox sandbox);

    /**
     * The decorators as one, applied in the order given; an empty list answers the sandbox it is given.
     *
     * @throws NullPointerException at decoration when a decorator answers null
     */
    static SandboxDecorator compose(List<? extends SandboxDecorator> decorators) {
        List<SandboxDecorator> ordered = List.copyOf(Objects.requireNonNull(decorators, "decorators"));
        return sandbox -> {
            Sandbox current = Objects.requireNonNull(sandbox, "sandbox");
            for (SandboxDecorator decorator : ordered) {
                current = Objects.requireNonNull(decorator.decorate(current), "The sandbox decorator " + decorator + " answered null.");
            }
            return current;
        };
    }
}
