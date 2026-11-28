package com.argusvane.datum.sandbox.endive;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The build's stack guard: rewrites the pinned {@code qjs-wasi.wasm} so that every {@code global.set} of its
 * {@code __stack_pointer} traps when the new value leaves the C stack, before the module is compiled.
 *
 * <p>QuickJS-ng compiles its native stack check out under WASI, and wasm-ld puts the C stack (64 KiB, its default
 * {@code -z stack-size}, growing down) directly above the module's static data. A frame that runs past its floor writes
 * into {@code .bss}, {@code .data} and {@code .rodata} with nothing to stop it: Endive's call-stack limit and the JVM's
 * stack bound the wasm call depth, not that region, and a frame need not write all the room it reserves, so a canary
 * alone can be stepped over. The C stack moves only through the module's own {@code __stack_pointer} global (not
 * imported, not exported), so holding every write of it holds the stack: each one becomes
 * <pre>
 *   local.tee $s  i32.const low  i32.sub  i32.const (top - low)  i32.gt_u
 *   if  i32.const floor  i32.const 0  i32.store8  unreachable  end
 *   local.get $s  global.set $__stack_pointer
 * </pre>
 * with {@code low = floor + LEAF_ROOM}: one unsigned compare holds the value to {@code low..top}, so a value that wrapped
 * below 0 traps too, and the store marks the lowest byte of the stack (the runtime's canary) before the trap, which is how
 * the host tells this trap from any other. {@code LEAF_ROOM} covers LLVM's wasm32 red zone (128 bytes a function that makes
 * no call may use below the pointer without moving it) four times over. The rewrite adds one {@code i32} local to each
 * function that holds such a write and changes nothing else in the code; the DWARF sections, which would no longer match it,
 * are dropped, and every other section is kept byte for byte.
 *
 * <p>The layout comes from the module: the global named {@code __stack_pointer} in the name section, its initial value
 * (the top), the floor {@code STACK_SIZE} below it, and the active data segments, which must all end at or below the floor.
 * The pinned module is known, so nothing is guessed: a module whose layout is not that, or a function body the decoder
 * cannot read to its own end exactly (an instruction outside the core, bulk-memory, reference-type and sign-extension sets,
 * such as SIMD), fails the build instead of compiling unguarded.
 *
 * <p>The build runs this file with the JDK's source launcher before the Endive compile:
 * {@code java StackGuardRewrite.java <in> <sha256> <size> <out> <facts>}. It holds {@code <in>} to the pin first, so the
 * pin is checked on the bytes that were downloaded, writes the rewritten module to {@code <out>} and the layout to
 * {@code <facts>} (a properties file the runtime reads for its canary). The output depends on the input alone.
 */
public final class StackGuardRewrite {

    /** wasm-ld's default {@code -z stack-size}, which the quickjs-ng release builds of {@code qjs-wasi.wasm} keep. */
    public static final int STACK_SIZE = 64 * 1024;
    /** How far above the floor the stack pointer must stay: four times LLVM's 128-byte wasm32 red zone. */
    public static final int LEAF_ROOM = 512;

    static final String STACK_POINTER = "__stack_pointer";
    static final String RODATA = ".rodata";

    private static final byte[] MAGIC = {0, 'a', 's', 'm', 1, 0, 0, 0};
    private static final int CUSTOM = 0;
    private static final int TYPE = 1;
    private static final int IMPORT = 2;
    private static final int FUNCTION = 3;
    private static final int MEMORY = 5;
    private static final int GLOBAL = 6;
    private static final int EXPORT = 7;
    private static final int CODE = 10;
    private static final int DATA = 11;
    private static final int NAMES_GLOBAL = 7;
    private static final int NAMES_DATA = 9;
    private static final int FUNC_TYPE = 0x60;
    private static final int I32 = 0x7F;

    private static final int UNREACHABLE = 0x00;
    private static final int IF = 0x04;
    private static final int END = 0x0B;
    private static final int LOCAL_GET = 0x20;
    private static final int LOCAL_TEE = 0x22;
    private static final int GLOBAL_GET = 0x23;
    private static final int GLOBAL_SET = 0x24;
    private static final int I32_STORE8 = 0x3A;
    private static final int I32_CONST = 0x41;
    private static final int I32_GT_U = 0x4B;
    private static final int I32_SUB = 0x6B;
    private static final int EMPTY_BLOCK = 0x40;

    private StackGuardRewrite() {
    }

    /**
     * The rewritten module and where its stack is.
     *
     * @param module the module with every write of the stack pointer checked
     * @param pointer the stack pointer's global index
     * @param definedPointer its index among the module's own (not imported) globals
     * @param floor the lowest byte of the stack
     * @param top the stack's top, the pointer's initial value
     * @param checks how many writes of the pointer the rewrite checks
     * @param rodata the {@code .rodata} segments, as offset and length
     */
    public record Guarded(byte[] module, int pointer, int definedPointer, int floor, int top, int checks, List<int[]> rodata) {

        /** The lowest value the pointer may take. */
        public int low() {
            return floor + LEAF_ROOM;
        }
    }

    /** A module the build refuses to compile unguarded. */
    public static final class UnguardableException extends RuntimeException {

        private static final long serialVersionUID = 1L;

        UnguardableException(String message) {
            super(message);
        }
    }

    /** The build's entry: {@code <in> <sha256> <size> <out> <facts>}. */
    public static void main(String[] args) throws IOException {
        if (args.length != 5) {
            throw new IllegalArgumentException("usage: StackGuardRewrite <in.wasm> <sha256> <size> <out.wasm> <facts.properties>");
        }
        Path in = Path.of(args[0]);
        byte[] module = Files.readAllBytes(in);
        String sha256 = sha256(module);
        if (module.length != Long.parseLong(args[2]) || !sha256.equalsIgnoreCase(args[1])) {
            throw new IllegalStateException(in + " is not the pinned qjs-wasi.wasm: sha256 " + sha256 + ", " + module.length
                + " bytes; the pin is sha256 " + args[1] + ", " + args[2] + " bytes.");
        }
        Guarded guarded = rewrite(module);
        Path out = Path.of(args[3]);
        Path facts = Path.of(args[4]);
        Files.createDirectories(out.toAbsolutePath().getParent());
        Files.createDirectories(facts.toAbsolutePath().getParent());
        Files.write(out, guarded.module());
        Files.writeString(facts, facts(guarded, sha256), StandardCharsets.ISO_8859_1);
        System.out.println("[datum] stack guard: " + guarded.checks() + " writes of __stack_pointer held to " + guarded.low() + ".."
            + guarded.top() + " (stack " + guarded.floor() + ".." + guarded.top() + "); " + out);
    }

    /** The properties the runtime reads: the layout, and which module it was made from and into. */
    static String facts(Guarded guarded, String sourceSha256) {
        StringBuilder rodata = new StringBuilder();
        for (int[] segment : guarded.rodata()) {
            rodata.append(rodata.length() == 0 ? "" : ",").append(segment[0]).append(':').append(segment[1]);
        }
        Map<String, String> facts = new LinkedHashMap<>();
        facts.put("source.sha256", sourceSha256.toLowerCase(java.util.Locale.ROOT));
        facts.put("guarded.sha256", sha256(guarded.module()));
        facts.put("pointer", Integer.toString(guarded.pointer()));
        facts.put("pointer.defined", Integer.toString(guarded.definedPointer()));
        facts.put("floor", Integer.toString(guarded.floor()));
        facts.put("top", Integer.toString(guarded.top()));
        facts.put("low", Integer.toString(guarded.low()));
        facts.put("checks", Integer.toString(guarded.checks()));
        facts.put("rodata", rodata.toString());
        StringBuilder text = new StringBuilder("# Written by StackGuardRewrite at build time: the C stack of the compiled qjs-wasi.wasm.\n");
        facts.forEach((key, value) -> text.append(key).append('=').append(value).append('\n'));
        return text.toString();
    }

    static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * The module with every {@code global.set} of {@code __stack_pointer} checked.
     *
     * @throws UnguardableException when the module's layout is not the one the guard is for, or its code cannot be read
     */
    public static Guarded rewrite(byte[] module) {
        try {
            Layout layout = Layout.read(module);
            int[] found = layout.stackPointer();
            int pointer = found[0];
            int top = found[1];
            int floor = top - STACK_SIZE;
            if (layout.memories != 1) {
                throw new UnguardableException("the module has " + layout.memories + " memories, not one");
            }
            if (layout.segments.isEmpty()) {
                throw new UnguardableException("the module has no active data segments");
            }
            int dataEnd = 0;
            List<int[]> rodata = new ArrayList<>();
            for (Segment segment : layout.segments) {
                dataEnd = Math.max(dataEnd, segment.offset + segment.length);
                if (RODATA.equals(layout.segmentNames.get(segment.index))) {
                    rodata.add(new int[] {segment.offset, segment.length});
                }
            }
            if (floor < dataEnd) {
                throw new UnguardableException("the stack's floor " + floor + " is below the end of the static data, " + dataEnd);
            }
            if (rodata.isEmpty()) {
                throw new UnguardableException("the module names no .rodata segment");
            }
            byte[] rewritten = layout.rewrite(new Checks(pointer, floor, top));
            return new Guarded(rewritten, pointer, pointer - layout.importedGlobals, floor, top, layout.checkCount, List.copyOf(rodata));
        } catch (IndexOutOfBoundsException e) {
            throw new UnguardableException("the module ends inside a section or an instruction");
        }
    }

    /** What each checked {@code global.set} holds the pointer to. */
    record Checks(int pointer, int floor, int top) {

        /** The instructions that replace one {@code global.set} of the pointer; {@code scratch} is the function's new local. */
        byte[] insteadOfSet(int scratch) {
            int low = floor + LEAF_ROOM;
            Bytes out = new Bytes();
            out.write(LOCAL_TEE);
            out.uleb(scratch);
            out.write(I32_CONST);
            out.sleb(low);
            out.write(I32_SUB);
            out.write(I32_CONST);
            out.sleb(top - low);
            out.write(I32_GT_U);
            out.write(IF);
            out.write(EMPTY_BLOCK);
            out.write(I32_CONST);
            out.sleb(floor);
            out.write(I32_CONST);
            out.write(0);
            out.write(I32_STORE8);
            out.write(0); // align
            out.write(0); // offset
            out.write(UNREACHABLE);
            out.write(END);
            out.write(LOCAL_GET);
            out.uleb(scratch);
            out.write(GLOBAL_SET);
            out.uleb(pointer);
            return out.toByteArray();
        }
    }

    private record Segment(int index, int offset, int length) {
    }

    private record Section(int id, int header, int start, int end) {
    }

    /** The parts of a module the guard reads: types, imports, functions, memories, globals, exports, data, names, code. */
    static final class Layout {

        final byte[] bytes;
        int importedGlobals;
        int importedFunctions;
        int memories;
        final List<Integer> typeParams = new ArrayList<>();
        final List<Integer> functionTypes = new ArrayList<>();
        final List<Integer> globalInits = new ArrayList<>();
        final List<Boolean> globalMutableI32 = new ArrayList<>();
        final List<Integer> exportedGlobals = new ArrayList<>();
        final Map<Integer, String> globalNames = new LinkedHashMap<>();
        final Map<Integer, String> segmentNames = new LinkedHashMap<>();
        final List<Segment> segments = new ArrayList<>();
        final List<Section> sections = new ArrayList<>();
        int checkCount;

        private Layout(byte[] bytes) {
            this.bytes = bytes;
        }

        static Layout read(byte[] module) {
            Layout layout = new Layout(module);
            for (int i = 0; i < MAGIC.length; i++) {
                if (module.length <= i || module[i] != MAGIC[i]) {
                    throw new UnguardableException("not a wasm module (version 1)");
                }
            }
            int[] at = {MAGIC.length};
            while (at[0] < module.length) {
                int header = at[0];
                int id = module[at[0]++] & 0xFF;
                int size = uleb(module, at);
                int start = at[0];
                int end = start + size;
                if (end > module.length) {
                    throw new UnguardableException("a section runs past the end of the module");
                }
                layout.sections.add(new Section(id, header, start, end));
                int[] cursor = {start};
                switch (id) {
                    case CUSTOM -> layout.custom(cursor, end);
                    case TYPE -> layout.types(cursor);
                    case IMPORT -> layout.imports(cursor);
                    case FUNCTION -> layout.functions(cursor);
                    case MEMORY -> layout.memories(cursor);
                    case GLOBAL -> layout.globals(cursor);
                    case EXPORT -> layout.exports(cursor);
                    case DATA -> layout.data(cursor);
                    default -> cursor[0] = end;
                }
                if (cursor[0] != end) {
                    throw new UnguardableException("section " + id + " does not end where its size says");
                }
                at[0] = end;
            }
            return layout;
        }

        /** The stack pointer's index and initial value: a defined, mutable, i32 global with a constant initial value. */
        int[] stackPointer() {
            Integer index = null;
            for (Map.Entry<Integer, String> name : globalNames.entrySet()) {
                if (STACK_POINTER.equals(name.getValue())) {
                    if (index != null) {
                        throw new UnguardableException("two globals are named " + STACK_POINTER);
                    }
                    index = name.getKey();
                }
            }
            if (index == null) {
                throw new UnguardableException("no global is named " + STACK_POINTER + " (the name section is missing or has no global names)");
            }
            if (index < importedGlobals) {
                throw new UnguardableException(STACK_POINTER + " is imported");
            }
            if (exportedGlobals.contains(index)) {
                throw new UnguardableException(STACK_POINTER + " is exported");
            }
            int defined = index - importedGlobals;
            if (defined >= globalInits.size() || !globalMutableI32.get(defined) || globalInits.get(defined) == null) {
                throw new UnguardableException(STACK_POINTER + " is not a mutable i32 global with a constant initial value");
            }
            int top = globalInits.get(defined);
            if (top < STACK_SIZE) {
                throw new UnguardableException(STACK_POINTER + " starts at " + top + ", below a whole stack");
            }
            return new int[] {index, top};
        }

        byte[] rewrite(Checks checks) {
            Bytes out = new Bytes();
            out.write(MAGIC);
            checkCount = 0;
            for (Section section : sections) {
                if (section.id == CUSTOM && customName(section.start).startsWith(".debug_")) {
                    continue;
                }
                if (section.id == CODE) {
                    byte[] contents = code(section.start, section.end, checks);
                    out.write(CODE);
                    out.uleb(contents.length);
                    out.write(contents);
                } else {
                    out.write(bytes, section.header, section.end - section.header);
                }
            }
            if (checkCount == 0) {
                throw new UnguardableException("the module's code never sets the stack pointer");
            }
            return out.toByteArray();
        }

        private byte[] code(int start, int end, Checks checks) {
            int[] at = {start};
            int bodies = uleb(bytes, at);
            if (bodies != functionTypes.size()) {
                throw new UnguardableException("the code and function sections differ in length");
            }
            Bytes out = new Bytes();
            out.uleb(bodies);
            for (int index = 0; index < bodies; index++) {
                int size = uleb(bytes, at);
                int bodyStart = at[0];
                int bodyEnd = bodyStart + size;
                if (bodyEnd > end) {
                    throw new UnguardableException("function " + (importedFunctions + index) + " runs past the code section");
                }
                at[0] = bodyEnd;
                int params = typeParams.get(functionTypes.get(index));
                byte[] rewritten = checkedBody(bodyStart, bodyEnd, params, checks, importedFunctions + index);
                out.uleb(rewritten.length);
                out.write(rewritten);
            }
            if (at[0] != end) {
                throw new UnguardableException("the code section does not end where its size says");
            }
            return out.toByteArray();
        }

        /** A function body with every {@code global.set} of the pointer checked; the body unchanged when it has none. */
        private byte[] checkedBody(int start, int end, int params, Checks checks, int function) {
            int[] at = {start};
            int groups = uleb(bytes, at);
            int first = at[0];
            long declared = 0;
            for (int group = 0; group < groups; group++) {
                declared += uleb(bytes, at);
                int kind = bytes[at[0]++] & 0xFF;
                if (!valueType(kind)) {
                    throw new UnguardableException("function " + function + " has a local of type " + hex(kind));
                }
            }
            int localsEnd = at[0];
            List<int[]> sites = pointerSets(localsEnd, end, checks.pointer(), function);
            if (sites.isEmpty()) {
                return java.util.Arrays.copyOfRange(bytes, start, end);
            }
            long scratch = params + declared;
            if (scratch > Integer.MAX_VALUE) {
                throw new UnguardableException("function " + function + " has too many locals");
            }
            byte[] replacement = checks.insteadOfSet((int) scratch);
            Bytes out = new Bytes();
            out.uleb(groups + 1);
            out.write(bytes, first, localsEnd - first);
            out.uleb(1);
            out.write(I32);
            int cursor = localsEnd;
            for (int[] site : sites) {
                out.write(bytes, cursor, site[0] - cursor);
                out.write(replacement);
                cursor = site[1];
            }
            out.write(bytes, cursor, end - cursor);
            checkCount += sites.size();
            return out.toByteArray();
        }

        /**
         * Decodes the body's instructions; returns where each {@code global.set pointer} begins and ends. The decode must
         * end on the function's own {@code end} exactly at the end of the body.
         */
        private List<int[]> pointerSets(int from, int end, int pointer, int function) {
            List<int[]> sites = new ArrayList<>();
            int[] at = {from};
            int depth = 1;
            while (at[0] < end) {
                int begin = at[0];
                int opcode = bytes[at[0]++] & 0xFF;
                switch (KINDS[opcode]) {
                    case NONE -> {
                        if (opcode == END && --depth == 0) {
                            if (at[0] != end) {
                                throw new UnguardableException("function " + function + " ends before its size says");
                            }
                            return sites;
                        }
                    }
                    case INDEX -> {
                        int index = uleb(bytes, at);
                        if (opcode == GLOBAL_SET && index == pointer) {
                            sites.add(new int[] {begin, at[0]});
                        }
                    }
                    case TWO -> {
                        uleb(bytes, at);
                        uleb(bytes, at);
                    }
                    case MEMARG -> memarg(at);
                    case LEB -> skipLeb(at);
                    case F32 -> at[0] += 4;
                    case F64 -> at[0] += 8;
                    case BLOCK -> {
                        depth++;
                        int type = bytes[at[0]] & 0xFF;
                        if (type == 0x63 || type == 0x64) {
                            throw new UnguardableException("function " + function + " has a block type outside the one-byte types");
                        }
                        skipLeb(at); // 0x40, a one-byte value type, or a type index (s33)
                    }
                    case BR_TABLE -> {
                        int count = uleb(bytes, at);
                        for (int i = 0; i <= count; i++) {
                            uleb(bytes, at);
                        }
                    }
                    case SELECT -> {
                        int count = uleb(bytes, at);
                        for (int i = 0; i < count; i++) {
                            int kind = bytes[at[0]++] & 0xFF;
                            if (!valueType(kind)) {
                                throw new UnguardableException("function " + function + " has a select type " + hex(kind));
                            }
                        }
                    }
                    case PREFIX -> {
                        int sub = uleb(bytes, at);
                        if (sub <= 7) {
                            // The saturating truncations: no immediates.
                        } else if (sub == 9 || sub == 11 || sub == 13 || sub == 15 || sub == 16 || sub == 17) {
                            uleb(bytes, at); // data.drop, memory.fill, elem.drop, table.grow, table.size, table.fill
                        } else if (sub == 8 || sub == 10 || sub == 12 || sub == 14) {
                            uleb(bytes, at); // memory.init, memory.copy, table.init, table.copy
                            uleb(bytes, at);
                        } else {
                            throw new UnguardableException("function " + function + " has an unknown 0xfc instruction " + sub);
                        }
                    }
                    default -> throw new UnguardableException("function " + function + " has an instruction the rewrite does not know: "
                        + hex(opcode) + " at byte " + begin);
                }
            }
            throw new UnguardableException("function " + function + " does not end where its size says");
        }

        private void memarg(int[] at) {
            int align = uleb(bytes, at);
            if ((align & 0x40) != 0) {
                throw new UnguardableException("a memory access names a memory index (multi-memory)");
            }
            uleb(bytes, at);
        }

        private void skipLeb(int[] at) {
            int limit = at[0] + 10;
            while ((bytes[at[0]] & 0x80) != 0) {
                at[0]++;
                if (at[0] >= limit) {
                    throw new UnguardableException("a LEB128 longer than ten bytes");
                }
            }
            at[0]++;
        }

        private String customName(int start) {
            int[] at = {start};
            int length = uleb(bytes, at);
            return new String(bytes, at[0], length, StandardCharsets.UTF_8);
        }

        private void types(int[] at) {
            int count = uleb(bytes, at);
            for (int i = 0; i < count; i++) {
                if ((bytes[at[0]++] & 0xFF) != FUNC_TYPE) {
                    throw new UnguardableException("a type that is not a plain function type");
                }
                typeParams.add(valueTypes(at));
                valueTypes(at);
            }
        }

        private int valueTypes(int[] at) {
            int count = uleb(bytes, at);
            for (int i = 0; i < count; i++) {
                int kind = bytes[at[0]++] & 0xFF;
                if (!valueType(kind)) {
                    throw new UnguardableException("a value type outside the one-byte types: " + hex(kind));
                }
            }
            return count;
        }

        private void memories(int[] at) {
            int count = uleb(bytes, at);
            for (int i = 0; i < count; i++) {
                limits(at);
            }
            memories += count;
        }

        private void functions(int[] at) {
            int count = uleb(bytes, at);
            for (int i = 0; i < count; i++) {
                int type = uleb(bytes, at);
                if (type >= typeParams.size()) {
                    throw new UnguardableException("a function names a type the module does not have");
                }
                functionTypes.add(type);
            }
        }

        private void imports(int[] at) {
            int count = uleb(bytes, at);
            for (int i = 0; i < count; i++) {
                for (int name = 0; name < 2; name++) {
                    int length = uleb(bytes, at);
                    at[0] += length;
                }
                int kind = bytes[at[0]++] & 0xFF;
                switch (kind) {
                    case 0 -> {
                        uleb(bytes, at);
                        importedFunctions++;
                    }
                    case 1 -> {
                        at[0]++;
                        limits(at);
                    }
                    case 2 -> {
                        limits(at);
                        memories++;
                    }
                    case 3 -> {
                        importedGlobals++;
                        at[0] += 2;
                    }
                    default -> throw new UnguardableException("an import of kind " + kind);
                }
            }
        }

        private void limits(int[] at) {
            int flags = bytes[at[0]++] & 0xFF;
            if (flags > 1) {
                throw new UnguardableException("shared or 64-bit limits");
            }
            uleb(bytes, at);
            if ((flags & 1) != 0) {
                uleb(bytes, at);
            }
        }

        private void globals(int[] at) {
            int count = uleb(bytes, at);
            for (int i = 0; i < count; i++) {
                int kind = bytes[at[0]++] & 0xFF;
                int mutable = bytes[at[0]++] & 0xFF;
                globalInits.add(constExpr(at));
                globalMutableI32.add(kind == I32 && mutable == 1);
            }
        }

        private void exports(int[] at) {
            int count = uleb(bytes, at);
            for (int i = 0; i < count; i++) {
                int length = uleb(bytes, at);
                at[0] += length;
                int kind = bytes[at[0]++] & 0xFF;
                int index = uleb(bytes, at);
                if (kind == 3) {
                    exportedGlobals.add(index);
                }
            }
        }

        private void data(int[] at) {
            int count = uleb(bytes, at);
            for (int i = 0; i < count; i++) {
                int flags = uleb(bytes, at);
                Integer offset = null;
                if (flags == 0 || flags == 2) {
                    if (flags == 2 && uleb(bytes, at) != 0) {
                        throw new UnguardableException("a data segment for a second memory");
                    }
                    offset = constExpr(at);
                    if (offset == null) {
                        throw new UnguardableException("a data segment placed by a global");
                    }
                } else if (flags != 1) {
                    throw new UnguardableException("data segment flags " + flags);
                }
                int size = uleb(bytes, at);
                if (offset != null) {
                    segments.add(new Segment(i, offset, size));
                }
                at[0] += size;
            }
        }

        private void custom(int[] at, int end) {
            int length = uleb(bytes, at);
            if (!"name".equals(new String(bytes, at[0], length, StandardCharsets.UTF_8))) {
                at[0] = end;
                return;
            }
            at[0] += length;
            while (at[0] < end) {
                int kind = bytes[at[0]++] & 0xFF;
                int size = uleb(bytes, at);
                int next = at[0] + size;
                if (kind == NAMES_GLOBAL || kind == NAMES_DATA) {
                    Map<Integer, String> names = kind == NAMES_GLOBAL ? globalNames : segmentNames;
                    int count = uleb(bytes, at);
                    for (int i = 0; i < count; i++) {
                        int index = uleb(bytes, at);
                        int nameLength = uleb(bytes, at);
                        names.put(index, new String(bytes, at[0], nameLength, StandardCharsets.UTF_8));
                        at[0] += nameLength;
                    }
                }
                at[0] = next;
            }
        }

        /** An {@code i32.const} expression's value, or null for a {@code global.get}; any other expression is refused. */
        private Integer constExpr(int[] at) {
            int opcode = bytes[at[0]++] & 0xFF;
            Integer value;
            if (opcode == I32_CONST) {
                value = sleb32(bytes, at);
            } else if (opcode == GLOBAL_GET) {
                uleb(bytes, at);
                value = null;
            } else if (opcode == 0x42) {
                skipLeb(at); // i64.const: a value the guard does not use
                value = null;
            } else {
                throw new UnguardableException("a constant expression with opcode " + hex(opcode));
            }
            if ((bytes[at[0]++] & 0xFF) != END) {
                throw new UnguardableException("a constant expression of more than one instruction");
            }
            return value;
        }
    }

    // -- the instruction table -------------------------------------------------------------------------------------------
    private static final int UNKNOWN = 0;
    private static final int NONE = 1;
    private static final int INDEX = 2;
    private static final int TWO = 3;
    private static final int BLOCK = 4;
    private static final int MEMARG = 5;
    private static final int LEB = 6;
    private static final int F32 = 7;
    private static final int F64 = 8;
    private static final int BR_TABLE = 9;
    private static final int SELECT = 10;
    private static final int PREFIX = 11;

    /** How each opcode's immediates are laid out: the core, bulk-memory, reference-type and sign-extension sets. */
    private static final int[] KINDS = kinds();

    private static int[] kinds() {
        int[] kinds = new int[256];
        for (int opcode : new int[] {0x00, 0x01, 0x05, 0x0B, 0x0F, 0x1A, 0x1B, 0xD1}) {
            kinds[opcode] = NONE;
        }
        for (int opcode = 0x45; opcode <= 0xC4; opcode++) {
            kinds[opcode] = NONE;
        }
        for (int opcode : new int[] {0x02, 0x03, 0x04}) {
            kinds[opcode] = BLOCK;
        }
        for (int opcode : new int[] {0x0C, 0x0D, 0x10, 0x12, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x3F, 0x40, 0xD2}) {
            kinds[opcode] = INDEX;
        }
        kinds[0x11] = TWO;
        kinds[0x13] = TWO;
        for (int opcode = 0x28; opcode <= 0x3E; opcode++) {
            kinds[opcode] = MEMARG;
        }
        kinds[0x41] = LEB;
        kinds[0x42] = LEB;
        kinds[0xD0] = LEB; // ref.null's heap type
        kinds[0x43] = F32;
        kinds[0x44] = F64;
        kinds[0x0E] = BR_TABLE;
        kinds[0x1C] = SELECT;
        kinds[0xFC] = PREFIX;
        return kinds;
    }

    private static boolean valueType(int kind) {
        return kind == 0x7F || kind == 0x7E || kind == 0x7D || kind == 0x7C || kind == 0x7B || kind == 0x70 || kind == 0x6F;
    }

    private static String hex(int value) {
        return "0x" + Integer.toHexString(value);
    }

    static int uleb(byte[] data, int[] at) {
        long result = 0;
        int shift = 0;
        while (true) {
            int b = data[at[0]++] & 0xFF;
            result |= (long) (b & 0x7F) << shift;
            shift += 7;
            if ((b & 0x80) == 0) {
                break;
            }
            if (shift > 35) {
                throw new UnguardableException("a LEB128 u32 longer than five bytes");
            }
        }
        if (result > Integer.MAX_VALUE) {
            throw new UnguardableException("a LEB128 u32 past 2^31");
        }
        return (int) result;
    }

    static int sleb32(byte[] data, int[] at) {
        long result = 0;
        int shift = 0;
        int b;
        do {
            if (shift > 35) {
                throw new UnguardableException("a LEB128 s32 longer than five bytes");
            }
            b = data[at[0]++] & 0xFF;
            result |= (long) (b & 0x7F) << shift;
            shift += 7;
        } while ((b & 0x80) != 0);
        if ((b & 0x40) != 0) {
            result |= -1L << shift;
        }
        return (int) result;
    }

    /** A growing byte buffer with the LEB128 writers. */
    static final class Bytes {

        private final ByteArrayOutputStream out = new ByteArrayOutputStream();

        void write(int b) {
            out.write(b);
        }

        void write(byte[] data) {
            out.write(data, 0, data.length);
        }

        void write(byte[] data, int from, int length) {
            out.write(data, from, length);
        }

        void uleb(long value) {
            do {
                int b = (int) (value & 0x7F);
                value >>>= 7;
                out.write(value != 0 ? b | 0x80 : b);
            } while (value != 0);
        }

        void sleb(long value) {
            while (true) {
                int b = (int) (value & 0x7F);
                value >>= 7;
                if (value == 0 && (b & 0x40) == 0 || value == -1 && (b & 0x40) != 0) {
                    out.write(b);
                    return;
                }
                out.write(b | 0x80);
            }
        }

        byte[] toByteArray() {
            return out.toByteArray();
        }
    }
}
