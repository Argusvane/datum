package com.argusvane.datum.sandbox.endive;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.sandbox.tck.RuntimeTckAssets;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import run.endive.runtime.Instance;
import run.endive.runtime.Memory;
import run.endive.wasm.Parser;
import run.endive.wasm.WasmEngineException;

/**
 * The build's stack guard rewrite ({@code src/build/java} StackGuardRewrite): every {@code global.set} of
 * {@code __stack_pointer} is held to the stack, nothing else in the code changes, the pinned module is rewritten into the
 * module this jar's class was compiled from, and a module the rewrite cannot read exactly is refused, never left unguarded.
 * Driven on small modules assembled here (run on Endive's interpreter) and on the pinned guest.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class StackGuardRewriteTest {

    /** A stack of {@code STACK_SIZE} bytes from TOP down, above one small {@code .rodata} segment at 1024. */
    private static final int TOP = 70656;
    private static final int FLOOR = TOP - StackGuardRewrite.STACK_SIZE;
    private static final int LOW = FLOOR + StackGuardRewrite.LEAF_ROOM;

    private byte[] pinned;
    private StackGuardRewrite.Guarded guarded;

    @BeforeAll
    void rewriteThePinnedGuest() throws IOException {
        String configured = System.getProperty("qjs.wasm.file");
        pinned = Files.readAllBytes(configured != null && !configured.isBlank() ? Path.of(configured) : Path.of("target/qjs/qjs-wasi.wasm"));
        guarded = StackGuardRewrite.rewrite(pinned);
    }

    // -- the pinned guest ------------------------------------------------------------------------------------------------

    @Test
    void thePinnedGuestIsRewrittenIntoTheModuleTheBuildCompiled() throws IOException {
        String configured = System.getProperty("qjs.guarded.file");
        Path compiled = configured != null && !configured.isBlank() ? Path.of(configured) : Path.of("target/qjs/qjs-wasi-guarded.wasm");
        assertThat(Files.readAllBytes(compiled)).as("the build compiles exactly the rewrite of the pinned bytes").isEqualTo(guarded.module());
        assertThat(StackGuardRewrite.rewrite(pinned).module()).as("the rewrite depends on its input alone").isEqualTo(guarded.module());
        Parser.parse(guarded.module());
    }

    @Test
    void thePinnedGuestsStackIsAWhole64KiBAboveItsStatics() {
        assertThat(guarded.top() - guarded.floor()).isEqualTo(64 * 1024);
        assertThat(guarded.checks()).as("every function with a frame moves the stack pointer").isGreaterThan(1000);
        assertThat(guarded.rodata()).isNotEmpty();
        assertThat(guarded.rodata()).allSatisfy(segment -> assertThat(segment[0] + segment[1]).isLessThanOrEqualTo(guarded.floor()));
    }

    @Test
    void theJarCarriesTheLayoutOfThisRewrite() throws IOException {
        Properties facts = new Properties();
        try (var in = StackGuard.class.getClassLoader().getResourceAsStream(StackGuard.RESOURCE)) {
            assertThat(in).as(StackGuard.RESOURCE).isNotNull();
            facts.load(in);
        }
        assertThat(facts.getProperty("source.sha256")).isEqualTo(RuntimeTckAssets.sha256(pinned));
        assertThat(facts.getProperty("guarded.sha256")).isEqualTo(RuntimeTckAssets.sha256(guarded.module()));
        assertThat(Integer.parseInt(facts.getProperty("floor"))).isEqualTo(guarded.floor());
        assertThat(Integer.parseInt(facts.getProperty("top"))).isEqualTo(guarded.top());
        assertThat(Integer.parseInt(facts.getProperty("checks"))).isEqualTo(guarded.checks());
    }

    @Test
    void onlyTheCodeChangesAndTheDwarfIsDropped() {
        List<byte[]> before = sections(pinned);
        List<byte[]> after = sections(guarded.module());
        List<byte[]> kept = new ArrayList<>();
        for (byte[] section : before) {
            if (!(section[0] == 0 && customName(section).startsWith(".debug_"))) {
                kept.add(section);
            }
        }
        assertThat(kept.size()).as("the .debug_ sections are gone").isLessThan(before.size());
        assertThat(after).hasSameSizeAs(kept);
        for (int i = 0; i < kept.size(); i++) {
            if (kept.get(i)[0] == 10) {
                assertThat(after.get(i)[0]).isEqualTo((byte) 10);
                assertThat(after.get(i)).isNotEqualTo(kept.get(i));
            } else {
                assertThat(after.get(i)).as("section %d is kept byte for byte", kept.get(i)[0]).isEqualTo(kept.get(i));
            }
        }
        assertThat(kept).anySatisfy(section -> assertThat(customName(section)).isEqualTo("name"));
    }

    @Test
    void theBuildStepHoldsItsInputToThePin(@org.junit.jupiter.api.io.TempDir Path dir) throws IOException {
        Path in = dir.resolve("in.wasm");
        byte[] other = pinned.clone();
        other[other.length - 1] ^= 1;
        Files.write(in, other);
        String sha256 = RuntimeTckAssets.sha256(pinned);
        assertThatThrownBy(() -> StackGuardRewrite.main(new String[] {in.toString(), sha256, Integer.toString(pinned.length),
            dir.resolve("out.wasm").toString(), dir.resolve("facts.properties").toString()}))
            .isInstanceOf(IllegalStateException.class).hasMessageContaining("is not the pinned qjs-wasi.wasm");
        assertThat(dir.resolve("out.wasm")).doesNotExist();

        Files.write(in, pinned);
        StackGuardRewrite.main(new String[] {in.toString(), sha256, Integer.toString(pinned.length), dir.resolve("out.wasm").toString(),
            dir.resolve("facts.properties").toString()});
        assertThat(Files.readAllBytes(dir.resolve("out.wasm"))).isEqualTo(guarded.module());
    }

    // -- small modules ---------------------------------------------------------------------------------------------------

    @Test
    void theLayoutAndTheCheckedWritesAreReadFromTheModule() {
        StackGuardRewrite.Guarded small = StackGuardRewrite.rewrite(new Small().build());
        assertThat(small.floor()).isEqualTo(FLOOR);
        assertThat(small.top()).isEqualTo(TOP);
        assertThat(small.checks()).isEqualTo(4);
        assertThat(small.rodata()).singleElement().satisfies(segment -> assertThat(segment).containsExactly(1024, 8));
    }

    @Test
    void aMoveInsideTheStackIsKept() {
        Instance instance = instantiate(new Small().build());
        assertThat(call(instance, "push", 1000)).isEqualTo(TOP - 1000);
        assertThat(call(instance, "push", TOP - 1000 - LOW)).as("down to the leaf room exactly").isEqualTo(LOW);
        call(instance, "set", TOP);
        assertThat(call(instance, "push", 0)).isEqualTo(TOP);
        assertThat(instance.memory().read(FLOOR)).as("the canary is untouched").isEqualTo((byte) 0xA5);
    }

    @ParameterizedTest(name = "{0}")
    @CsvSource({
        "one byte into the leaf room, push, " + (TOP - LOW + 1),
        "past the floor into the statics, push, " + (TOP - FLOOR + 4096),
        "wrapped below address 0, push, " + (TOP + 16),
        "above the top, set, " + (TOP + 16),
        "zero, set, 0",
    })
    void aMoveOutOfTheStackTrapsAndMarksTheCanary(String name, String function, int argument) {
        Instance instance = instantiate(new Small().build());
        assertThatThrownBy(() -> call(instance, function, argument)).isInstanceOf(WasmEngineException.class)
            .hasMessageContaining("unreachable");
        assertThat(instance.memory().read(FLOOR)).as("the check marks the canary before it traps").isZero();
        assertThat(call(instance, "push", 0)).as("the pointer was never moved").isEqualTo(TOP);
    }

    @Test
    void theFunctionsOwnLocalsAreUntouchedByTheScratchLocal() {
        Instance instance = instantiate(new Small().build());
        assertThat(instance.export("framed").apply(3)[0]).isEqualTo(7 + 3 + 1);
    }

    @Test
    void aModuleTheRewriteCannotReadExactlyIsRefused() {
        assertThatThrownBy(() -> StackGuardRewrite.rewrite("not wasm".getBytes(StandardCharsets.UTF_8)))
            .isInstanceOf(StackGuardRewrite.UnguardableException.class).hasMessageContaining("not a wasm module");
        Small unnamed = new Small();
        unnamed.names = false;
        assertRefused(unnamed, "no global is named __stack_pointer");
        Small immutable = new Small();
        immutable.mutable = false;
        assertRefused(immutable, "not a mutable i32 global");
        Small exported = new Small();
        exported.exportPointer = true;
        assertRefused(exported, "is exported");
        Small crowded = new Small();
        crowded.dataAt = FLOOR - 4;
        assertRefused(crowded, "below the end of the static data");
        Small simd = new Small();
        simd.extra = new byte[] {(byte) 0xFD, 0x0C, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x1A}; // v128.const 0, drop
        assertRefused(simd, "an instruction the rewrite does not know: 0xfd");
        Small trailing = new Small();
        trailing.trailing = true;
        assertRefused(trailing, "ends before its size says");
        Small still = new Small();
        still.setsPointer = false;
        assertRefused(still, "never sets the stack pointer");
    }

    private static void assertRefused(Small module, String why) {
        assertThatThrownBy(() -> StackGuardRewrite.rewrite(module.build())).isInstanceOf(StackGuardRewrite.UnguardableException.class)
            .hasMessageContaining(why);
    }

    private static Instance instantiate(byte[] module) {
        Instance instance = Instance.builder(Parser.parse(StackGuardRewrite.rewrite(module).module())).build();
        Memory memory = instance.memory();
        for (int at = FLOOR; at < FLOOR + 4096; at++) {
            memory.writeByte(at, (byte) 0xA5);
        }
        return instance;
    }

    private static long call(Instance instance, String name, int argument) {
        long[] results = instance.export(name).apply(argument);
        return results == null || results.length == 0 ? -1 : results[0];
    }

    /**
     * A small module laid out as wasm-ld lays out the guest: {@code push} moves the pointer down by its argument and
     * returns it, {@code set} sets it, {@code framed} moves it down and back with locals of its own.
     */
    private static final class Small {

        boolean names = true;
        boolean mutable = true;
        boolean exportPointer;
        boolean setsPointer = true;
        boolean trailing;
        int dataAt = 1024;
        byte[] extra = new byte[0];

        byte[] build() {
            Out module = new Out();
            module.raw(0, 'a', 's', 'm', 1, 0, 0, 0);
            // types: (i32)->(i32), (i32)->(), ()->(), (i32)->(i64)
            module.section(1, new Out().u(4).raw(0x60, 1, 0x7F, 1, 0x7F).raw(0x60, 1, 0x7F, 0).raw(0x60, 0, 0).raw(0x60, 1, 0x7F, 1, 0x7E));
            module.section(3, new Out().u(4).u(0).u(1).u(2).u(3));
            module.section(5, new Out().u(1).raw(0).u(2));
            module.section(6, new Out().u(1).raw(0x7F, mutable ? 1 : 0, 0x41).s(TOP).raw(0x0B));
            Out exports = new Out().u(exportPointer ? 6 : 5).name("push").raw(0).u(0).name("set").raw(0).u(1).name("_start").raw(0).u(2)
                .name("framed").raw(0).u(3).name("memory").raw(2).u(0);
            if (exportPointer) {
                exports.name("sp").raw(3).u(0);
            }
            module.section(7, exports);
            int set = setsPointer ? 0x24 : 0x1A; // global.set 0, or drop
            Out push = new Out().u(0).raw(0x23, 0, 0x20, 0, 0x6B, set).raw(setsPointer ? new int[] {0} : new int[0]).raw(0x23, 0);
            push.raw(extra).raw(0x0B);
            if (trailing) {
                push.raw(0x01);
            }
            Out setter = new Out().u(0).raw(0x20, 0).raw(setsPointer ? new int[] {0x24, 0} : new int[] {0x1A}).raw(0x0B);
            Out start = new Out().u(0).raw(0x0B);
            Out framed = new Out().u(2).u(1).raw(0x7E).u(1).raw(0x7D)
                .raw(0x42, 7, 0x21, 1) // local.set 1 (i64.const 7)
                .raw(0x43, 0, 0, 0xC0, 0x3F, 0x21, 2) // local.set 2 (f32.const 1.5)
                .raw(0x23, 0, 0x41).s(64).raw(0x6B).raw(setsPointer ? new int[] {0x24, 0} : new int[] {0x1A})
                .raw(0x23, 0, 0x41).s(64).raw(0x6A).raw(setsPointer ? new int[] {0x24, 0} : new int[] {0x1A})
                .raw(0x20, 1, 0x20, 0, 0x20, 2, 0xA9, 0x6A, 0xAD, 0x7C, 0x0B);
            Out code = new Out().u(4);
            for (Out body : List.of(push, setter, start, framed)) {
                code.u(body.size()).raw(body.bytes());
            }
            module.section(10, code);
            byte[] constant = "constant".getBytes(StandardCharsets.UTF_8);
            module.section(11, new Out().u(1).u(0).raw(0x41).s(dataAt).raw(0x0B).u(constant.length).raw(constant));
            if (names) {
                Out globals = new Out().u(1).u(0).name("__stack_pointer");
                Out data = new Out().u(1).u(0).name(".rodata");
                module.section(0, new Out().name("name").raw(7).u(globals.size()).raw(globals.bytes()).raw(9).u(data.size()).raw(data.bytes()));
            }
            module.section(0, new Out().name(".debug_info").raw(1, 2, 3));
            return module.bytes();
        }
    }

    /** The bytes of a module under assembly, with the LEB128 writers. */
    private static final class Out {

        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();

        Out raw(int... values) {
            for (int value : values) {
                bytes.write(value);
            }
            return this;
        }

        Out raw(byte[] values) {
            bytes.write(values, 0, values.length);
            return this;
        }

        Out u(long value) {
            do {
                int b = (int) (value & 0x7F);
                value >>>= 7;
                bytes.write(value != 0 ? b | 0x80 : b);
            } while (value != 0);
            return this;
        }

        Out s(long value) {
            while (true) {
                int b = (int) (value & 0x7F);
                value >>= 7;
                if (value == 0 && (b & 0x40) == 0 || value == -1 && (b & 0x40) != 0) {
                    bytes.write(b);
                    return this;
                }
                bytes.write(b | 0x80);
            }
        }

        Out name(String text) {
            byte[] utf8 = text.getBytes(StandardCharsets.UTF_8);
            return u(utf8.length).raw(utf8);
        }

        Out section(int id, Out contents) {
            return raw(id).u(contents.size()).raw(contents.bytes());
        }

        int size() {
            return bytes.size();
        }

        byte[] bytes() {
            return bytes.toByteArray();
        }
    }

    /** Each section of a module, header included, in order. */
    private static List<byte[]> sections(byte[] module) {
        List<byte[]> sections = new ArrayList<>();
        int[] at = {8};
        while (at[0] < module.length) {
            int header = at[0]++;
            int size = StackGuardRewrite.uleb(module, at);
            int end = at[0] + size;
            sections.add(java.util.Arrays.copyOfRange(module, header, end));
            at[0] = end;
        }
        return sections;
    }

    private static String customName(byte[] section) {
        int[] at = {1};
        StackGuardRewrite.uleb(section, at);
        int length = StackGuardRewrite.uleb(section, at);
        return new String(section, at[0], length, StandardCharsets.UTF_8);
    }
}
