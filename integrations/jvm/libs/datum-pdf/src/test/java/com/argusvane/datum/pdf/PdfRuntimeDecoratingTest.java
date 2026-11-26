package com.argusvane.datum.pdf;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatNullPointerException;

import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.PdfKernel;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.RunSlots;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

/** A replacement {@code PdfRuntime} still goes through the host's kernel decorators. */
class PdfRuntimeDecoratingTest {

    private static final class Kernel implements PdfKernel {

        final Program program = Program.of(Program.Kind.PDF, "/* pdf */".getBytes(StandardCharsets.UTF_8));
        final AtomicInteger calls = new AtomicInteger();

        @Override
        public Program program() {
            return program;
        }

        @Override
        public List<String> capabilities() {
            return List.of("fill");
        }

        @Override
        public ObjectNode call(ObjectNode request) {
            calls.incrementAndGet();
            return request;
        }
    }

    private static PdfRuntime over(AtomicReference<PdfKernel> current) {
        return new PdfRuntime() {
            @Override
            public PdfKernel program() {
                return current.get();
            }

            @Override
            public RunSlots slots() {
                return new RunSlots(1, Duration.ZERO, "PDF render");
            }

            @Override
            public EngineInfo engine() {
                return new EngineInfo("test", "1", "panama", "");
            }

            @Override
            public java.util.Map<String, String> contextKeys() {
                return HostOptions.defaults().contextKeys();
            }

            @Override
            public int pdfSeconds() {
                return ProgramLimits.defaults().pdfSeconds();
            }
        };
    }

    @Test
    void theProgramIsWrappedOncePerKernelAndTheRestIsTheDelegates() {
        Kernel first = new Kernel();
        AtomicReference<PdfKernel> current = new AtomicReference<>(first);
        AtomicInteger decorations = new AtomicInteger();
        AtomicInteger seen = new AtomicInteger();
        PdfRuntime decorated = PdfRuntime.decorating(over(current), kernel -> {
            decorations.incrementAndGet();
            return new PdfKernel() {
                @Override
                public Program program() {
                    return kernel.program();
                }

                @Override
                public List<String> capabilities() {
                    return kernel.capabilities();
                }

                @Override
                public ObjectNode call(ObjectNode request) {
                    seen.incrementAndGet();
                    return kernel.call(request);
                }
            };
        });

        decorated.program().call(tools.jackson.databind.json.JsonMapper.builder().build().createObjectNode());
        decorated.program().call(tools.jackson.databind.json.JsonMapper.builder().build().createObjectNode());
        assertThat(seen).as("the decorator saw both runs").hasValue(2);
        assertThat(first.calls).hasValue(2);
        assertThat(decorations).as("applied once for the same kernel").hasValue(1);
        assertThat(decorated.program()).isSameAs(decorated.program());

        current.set(new Kernel());
        decorated.program();
        assertThat(decorations).as("a new kernel (a recheck) is decorated afresh").hasValue(2);

        assertThat(decorated.engine().mode()).isEqualTo("panama");
        assertThat(decorated.pdfSeconds()).isEqualTo(ProgramLimits.defaults().pdfSeconds());
        assertThat(decorated.permanentlyUnavailable()).isNull();
    }

    @Test
    void aDecoratorThatAnswersNullIsRefused() {
        PdfRuntime decorated = PdfRuntime.decorating(over(new AtomicReference<>(new Kernel())), kernel -> null);
        assertThatNullPointerException().isThrownBy(decorated::program);
    }
}
