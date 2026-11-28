package com.argusvane.datum.sandbox.endive;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Properties;
import run.endive.runtime.Memory;
import run.endive.wasm.WasmModule;
import run.endive.wasm.types.ActiveDataSegment;
import run.endive.wasm.types.DataSegment;
import run.endive.wasm.types.FunctionBody;
import run.endive.wasm.types.Instruction;
import run.endive.wasm.types.OpCode;

/**
 * The guest's C stack guard, the run-time half: a run whose C stack reached its floor is a trap, never an answer.
 *
 * <p>QuickJS-ng compiles its native stack check out under WASI, and the C stack its frames use is wasm-ld's fixed 64 KiB
 * directly above the module's static data. Endive's call-stack limit and the JVM's stack bound the depth of wasm calls, not
 * that region, so before this guard a frame that ran past the floor wrote into {@code .bss}, {@code .data} and
 * {@code .rodata} unnoticed. The build (the {@code StackGuardRewrite} step in this module's pom, before the Endive
 * compile) rewrites the pinned {@code qjs-wasi.wasm} so that every write of its {@code __stack_pointer} global traps when the
 * new value is below the floor plus {@link #LEAF_ROOM} or above the top, after storing a byte at the floor; the pin is
 * checked on the downloaded bytes first, and a module the rewrite cannot read exactly fails the build. It writes the layout
 * it found to {@link #RESOURCE}.
 *
 * <p>Here, for each run: {@link #arm} writes a canary over the stack's lowest {@link #CANARY} bytes after instantiation and
 * before {@code _start}, and {@link #overran} reads it, and the module's {@code .rodata} (constant data the guest never
 * writes, compared with the module's own segments), after {@code _start} however it ended. The check's own store marks the
 * canary, so its trap reads as an overrun; a frame that wrote the canary without moving the pointer past the check, or
 * anything that wrote {@code .rodata}, does too. {@link #verify} refuses a compiled class that does not carry the rewrite
 * (a stale prebuilt compile): every retained function body's writes of the pointer must be checked ones.
 */
final class StackGuard {

    /** The layout the build's rewrite found, in this jar. */
    static final String RESOURCE = "META-INF/datum/stack-guard.properties";
    /** How many of the stack's lowest bytes the canary covers: more than an ordinary QuickJS frame. */
    static final int CANARY = 4096;
    /** How far above the floor the pointer must stay (the build's {@code StackGuardRewrite.LEAF_ROOM}). */
    static final int LEAF_ROOM = 512;
    /** The trap's words: the start of an overrun's trap message. */
    static final String OVERRUN = "the guest's C stack reached its floor";

    private static final byte CANARY_BYTE = (byte) 0xA5;

    private final int pointer;
    private final int definedPointer;
    private final int floor;
    private final int top;
    private final int checks;
    private final byte[] canary;
    private final List<Rodata> rodata;

    private record Rodata(int offset, byte[] bytes) {
    }

    private StackGuard(int pointer, int definedPointer, int floor, int top, int checks, List<Rodata> rodata) {
        this.pointer = pointer;
        this.definedPointer = definedPointer;
        this.floor = floor;
        this.top = top;
        this.checks = checks;
        this.rodata = List.copyOf(rodata);
        this.canary = new byte[CANARY];
        Arrays.fill(canary, CANARY_BYTE);
    }

    /** The guard of the compiled class: its layout from {@link #RESOURCE}, held to the module the class carries. */
    static StackGuard load(WasmModule module, String qjsSha256) {
        Properties facts = new Properties();
        try (InputStream in = StackGuard.class.getClassLoader().getResourceAsStream(RESOURCE)) {
            if (in == null) {
                throw new IllegalStateException("datum-sandbox-endive carries no " + RESOURCE + ": the jar was not built by its pom, "
                    + "which guards the C stack of the module it compiles.");
            }
            facts.load(in);
        } catch (IOException e) {
            throw new IllegalStateException("datum-sandbox-endive could not read " + RESOURCE + ".", e);
        }
        if (!qjsSha256.equals(facts.getProperty("source.sha256"))) {
            throw new IllegalStateException(RESOURCE + " was made from qjs-wasi.wasm sha256 " + facts.getProperty("source.sha256")
                + ", not the pinned " + qjsSha256 + ": rebuild datum-sandbox-endive.");
        }
        List<Rodata> rodata = new ArrayList<>();
        for (String segment : facts.getProperty("rodata", "").split(",")) {
            String[] parts = segment.split(":");
            int offset = Integer.parseInt(parts[0]);
            int length = Integer.parseInt(parts[1]);
            rodata.add(new Rodata(offset, segmentAt(module, offset, length)));
        }
        StackGuard guard = new StackGuard(Integer.parseInt(facts.getProperty("pointer")),
            Integer.parseInt(facts.getProperty("pointer.defined")), Integer.parseInt(facts.getProperty("floor")),
            Integer.parseInt(facts.getProperty("top")), Integer.parseInt(facts.getProperty("checks")), rodata);
        guard.verify(module);
        return guard;
    }

    /** The bytes of the active data segment the module places at {@code offset}, of {@code length} bytes. */
    private static byte[] segmentAt(WasmModule module, int offset, int length) {
        for (DataSegment segment : module.dataSection().dataSegments()) {
            if (segment instanceof ActiveDataSegment active && active.offsetInstructions().size() == 1
                && active.offsetInstructions().get(0).opcode() == OpCode.I32_CONST
                && active.offsetInstructions().get(0).operand(0) == offset && active.data().length == length) {
                return active.data();
            }
        }
        throw new IllegalStateException("The compiled module has no .rodata segment of " + length + " bytes at " + offset + ", which "
            + RESOURCE + " names: rebuild datum-sandbox-endive.");
    }

    /**
     * Refuses a compiled class that does not carry the rewrite: the pointer's initial value must be the top the build
     * found, and every write of the pointer in the function bodies the class keeps must be a checked one (the rewrite's
     * {@code if ... unreachable end local.get} right before it).
     */
    void verify(WasmModule module) {
        var global = module.globalSection().getGlobal(definedPointer);
        var init = global.initInstructions();
        if (init.size() != 1 || init.get(0).opcode() != OpCode.I32_CONST || init.get(0).operand(0) != top) {
            throw new IllegalStateException("The compiled module's stack pointer does not start at " + top + ", where " + RESOURCE
                + " puts the stack's top: rebuild datum-sandbox-endive.");
        }
        int checked = 0;
        for (FunctionBody body : module.codeSection().functionBodies()) {
            List<? extends Instruction> code = body.instructions();
            for (int at = 0; at < code.size(); at++) {
                Instruction instruction = code.get(at);
                if (instruction.opcode() != OpCode.GLOBAL_SET || instruction.operand(0) != pointer) {
                    continue;
                }
                if (at < 3 || code.get(at - 1).opcode() != OpCode.LOCAL_GET || code.get(at - 2).opcode() != OpCode.END
                    || code.get(at - 3).opcode() != OpCode.UNREACHABLE) {
                    throw new IllegalStateException("The compiled module writes its stack pointer without the stack guard's check: "
                        + "the Qjs class was compiled from the unrewritten qjs-wasi.wasm (a stale -Pendive-prebuilt compile?); "
                        + "rebuild datum-sandbox-endive without -Pendive-prebuilt.");
                }
                checked++;
            }
        }
        if (checked == 0) {
            throw new IllegalStateException("The compiled module keeps no function body that writes its stack pointer, so the stack "
                + "guard cannot be confirmed: rebuild datum-sandbox-endive.");
        }
    }

    /** Writes the canary over the stack's lowest bytes, after instantiation and before {@code _start}. */
    void arm(Memory memory) {
        memory.write(floor, canary);
    }

    /** Whether the canary changed or a {@code .rodata} segment no longer matches the module. */
    boolean overran(Memory memory) {
        if (!Arrays.equals(memory.readBytes(floor, CANARY), canary)) {
            return true;
        }
        for (Rodata segment : rodata) {
            if (!Arrays.equals(memory.readBytes(segment.offset(), segment.bytes().length), segment.bytes())) {
                return true;
            }
        }
        return false;
    }

    /** The engine-info note: the stack, the checked writes and how much constant data is compared. */
    String describe() {
        long constant = rodata.stream().mapToLong(segment -> segment.bytes().length).sum();
        return "C stack guard: " + floor + ".." + top + ", " + checks + " stack pointer writes held to " + (floor + LEAF_ROOM) + ".." + top
            + ", canary " + CANARY + " bytes, " + constant + " bytes of .rodata compared after each run";
    }

    int floor() {
        return floor;
    }

    int top() {
        return top;
    }

    int checks() {
        return checks;
    }

    /** A run whose C stack reached its floor: a trap, whatever the guest did after it. */
    static final class OverrunException extends RuntimeException {

        private static final long serialVersionUID = 1L;

        OverrunException(String message) {
            super(message);
        }
    }
}
