package com.argusvane.datum.sandbox.protocol;

import java.util.List;
import java.util.Objects;

/**
 * Wraps the {@link PdfKernel} a host's runtime makes for the PDF program it has just loaded (the PDF side
 * of {@link SandboxDecorator}): the runtime builds {@link PdfProgram}
 * itself over its guarded engine, the limits and the ABI gate, at every start and recheck, and hands it to each decorator
 * in order, so the program's ABI proof, the warm-up and every render, fill, sign and verify go through what they answer.
 * Composed as {@link SandboxDecorator#compose}: the first wraps the program, the last sees each call first. As there, a
 * decorator is handed only the runtime's kernel, and that it wraps it and delegates every call is a contract the code does
 * not enforce.
 */
@FunctionalInterface
public interface PdfKernelDecorator {

    /**
     * @param kernel the kernel to wrap: the runtime's, or what the decorator before this one answered
     * @return the kernel the callers use; never null
     */
    PdfKernel decorate(PdfKernel kernel);

    /**
     * The decorators as one, applied in the order given; an empty list answers the kernel it is given.
     *
     * @throws NullPointerException at decoration when a decorator answers null
     */
    static PdfKernelDecorator compose(List<? extends PdfKernelDecorator> decorators) {
        List<PdfKernelDecorator> ordered = List.copyOf(Objects.requireNonNull(decorators, "decorators"));
        return kernel -> {
            PdfKernel current = Objects.requireNonNull(kernel, "kernel");
            for (PdfKernelDecorator decorator : ordered) {
                current = Objects.requireNonNull(decorator.decorate(current), "The PDF kernel decorator " + decorator + " answered null.");
            }
            return current;
        };
    }
}
