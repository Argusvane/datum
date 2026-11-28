"""The guest's shadow stack guard: a run whose C stack ran out is a trap, never an answer.

QuickJS-ng compiles its native stack check out under WASI, so the only check on JavaScript recursion inside
`qjs-wasi.wasm` is wasmtime's own: `Config.max_wasm_stack` (512 KiB by default) bounds the wasm call stack. The C
compiler's shadow stack, which holds every QuickJS frame's arguments, locals and operand stack, is a separate region
of linear memory that wasm-ld places between the static data and the heap (64 KiB, its default `-z stack-size`,
growing down). A JavaScript frame costs about 350 bytes of it against about 770 bytes of wasm stack, more with locals,
so plain recursion of about 190 frames runs the shadow stack into the module's `.bss`, `.data` and `.rodata` well
before wasmtime's stack check fires. Nothing traps at that point: the guest goes on over its own overwritten statics
and ends however that goes (a null indirect call, a bad signature, QuickJS's `invalid opcode`, a loop, a plain exit).

Lowering `max_wasm_stack` until it fires first cannot close that: a frame's shadow cost grows with its locals while
its wasm cost does not, and the lower limit takes depth from native-only recursion that never touches the shadow
stack (`JSON.parse` of nested input, about 2,000 levels at 512 KiB, under 1,000 at 128 KiB). Watching the memory
alone cannot close it either: a frame need not write all the room it reserves, so a canary of any size can be left
untouched by a frame that reaches below it.

So the runtime holds the stack pointer itself. The C stack moves only through the module's `__stack_pointer` global:
every frame, `alloca` and restore is a `global.set` of it (the global is not exported, so nothing outside the module
moves it). Before compiling, after the digest check on the original bytes, the runtime rewrites the module's code so
that every `global.set` of that global first checks the new value: one below `floor + LEAF_ROOM` or above the top
writes a byte into the canary and traps (`unreachable`). LLVM's wasm32 functions that make no call may use up to 128
bytes below the pointer without moving it (the red zone), which `LEAF_ROOM` covers, so no frame ever reaches below the
floor. The rewrite touches only those `global.set` instructions and the locals declaration of each function holding
one (a scratch `i32` for the checked value); the DWARF sections, which would no longer match the code, are dropped.

Two checks after the run stay as a second line: the canary over the lowest `CANARY` bytes of the stack region, written
before `_start` (the check's own trap marks it too), and the module's `.rodata` segments (constant data the guest never
writes) compared with the module. After the guest ends, however it ends, either one changed is a stack overrun; the
harness reads an overrun as a trap, whatever the guest did after it.

The layout comes from the module itself: the `__stack_pointer` global's initial value is the stack's top, the data
segments and their names (the name section) are the statics, and the floor is the top less `STACK_SIZE`. A module
without those names, whose floor would sit inside its data segments, or whose code the rewrite cannot read (an
instruction outside the core, bulk-memory, reference-type and sign-extension sets, such as SIMD or exceptions) gets
no guard, and the runtime refuses to start on it unless `datum.runtime.allow_unguarded_stack` says otherwise. A module
built with a larger stack is guarded at 64 KiB all the same; one built with a smaller stack would have live `.bss`
under the floor, which the module's bytes do not show, so the guard is for the pinned release build, which the runtime
verifies by its digest.
"""

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from collections.abc import Callable

    import wasmtime

STACK_SIZE: Final = 64 * 1024
"""wasm-ld's default `-z stack-size`, which the QuickJS-ng release builds of `qjs-wasi.wasm` keep."""
CANARY: Final = 4096
"""How many of the stack's lowest bytes the canary covers: more than an ordinary QuickJS frame."""
LEAF_ROOM: Final = 512
"""How far above the floor the stack pointer must stay: four times LLVM's 128-byte wasm32 red zone."""
_CANARY_BYTE: Final = 0xA5
_STACK_POINTER: Final = "__stack_pointer"
_RODATA: Final = ".rodata"
_DEBUG: Final = b".debug_"

_MAGIC: Final = b"\0asm\1\0\0\0"
_CUSTOM, _TYPE, _IMPORT, _FUNCTION, _MEMORY, _GLOBAL, _CODE, _DATA = 0, 1, 2, 3, 5, 6, 10, 11
"""Section ids."""
_IMPORT_FUNC, _IMPORT_TABLE, _IMPORT_MEMORY, _IMPORT_GLOBAL, _IMPORT_TAG = 0, 1, 2, 3, 4
_DATA_ACTIVE, _DATA_PASSIVE, _DATA_ACTIVE_INDEXED = 0, 1, 2
_NAMES_GLOBAL, _NAMES_DATA = 7, 9
"""Name-section subsections: global names, data segment names."""
_FUNC_TYPE: Final = 0x60
_I32: Final = 0x7F
_MUTABLE: Final = 0x01
_VALUE_TYPES: Final = frozenset({0x7F, 0x7E, 0x7D, 0x7C, 0x7B, 0x70, 0x6F})
"""The one-byte value types: i32, i64, f32, f64, v128, funcref, externref."""
_LIMITS_HAS_MAX: Final = 0x01

_UNREACHABLE, _IF, _END, _GLOBAL_SET = 0x00, 0x04, 0x0B, 0x24
_LOCAL_GET, _LOCAL_TEE, _I32_CONST, _GLOBAL_GET = 0x20, 0x22, 0x41, 0x23
_I32_STORE8, _I32_GT_U, _I32_SUB, _EMPTY_BLOCK = 0x3A, 0x4B, 0x6B, 0x40


class StackOverrunError(Exception):
    """The guest's shadow stack reached its floor: its statics may be overwritten, so the run is a trap."""


@dataclass(frozen=True, slots=True)
class StackGuard:
    """The guarded module, where the canary goes and which constant segments must still match after a run."""

    floor: int
    top: int
    rodata: tuple[tuple[int, bytes], ...]
    module: bytes = field(repr=False, compare=False)
    """The module rewritten so that every `__stack_pointer` write is held to `floor + LEAF_ROOM` .. `top`."""
    checks: int = 0
    """How many `global.set` instructions of the stack pointer the rewrite checks."""

    def arm(self, store: "wasmtime.Store", memory: "wasmtime.Memory") -> None:
        """Write the canary over the stack's lowest bytes, after instantiation and before `_start`."""
        memory.write(store, bytes([_CANARY_BYTE]) * CANARY, self.floor)

    def overran(self, store: "wasmtime.Store", memory: "wasmtime.Memory") -> bool:
        """Say whether the canary changed or a `.rodata` segment no longer matches the module."""
        if memory.read(store, self.floor, self.floor + CANARY).count(_CANARY_BYTE) != CANARY:
            return True
        return any(memory.read(store, offset, offset + len(data)) != data for offset, data in self.rodata)

    def describe(self) -> str:
        """Return the engine-info note: the stack region, the checked writes and how much constant data is compared."""
        constant = sum(len(data) for _, data in self.rodata)
        return (
            f"shadow stack guard: {self.floor}..{self.top}, {self.checks} stack pointer writes held to "
            f"{self.floor + LEAF_ROOM}..{self.top}, canary {CANARY} bytes, {constant} bytes of .rodata compared after "
            "each run"
        )


def stack_guard(module: bytes) -> StackGuard | None:
    """Read the guard's layout from the module's bytes and rewrite its code; `None` when either cannot be done."""
    try:
        layout = _Layout.read(module)
        found = layout.stack_pointer()
        segments = layout.active_segments
        if found is None or not segments or layout.memories == 0:
            return None
        pointer, top = found
        floor = top - STACK_SIZE
        if floor < max(offset + len(data) for offset, data, _ in segments):
            return None
        checks = _Checks(pointer=pointer, floor=floor, top=top)
        guarded, count = layout.rewrite(checks)
    except (IndexError, ValueError):
        return None
    rodata = tuple((offset, data) for offset, data, name in segments if name == _RODATA)
    return StackGuard(floor=floor, top=top, rodata=rodata, module=guarded, checks=count)


def describe_unguarded() -> str:
    """Return the engine-info note for a module that runs without the guard."""
    return "shadow stack guard: off (the module does not name a stack above its data, or its code cannot be read)"


@dataclass(frozen=True, slots=True)
class _Checks:
    """What each checked `global.set` holds the stack pointer to."""

    pointer: int
    floor: int
    top: int

    def instead_of_set(self, scratch: int) -> bytes:
        """Return the instructions that replace one `global.set` of the pointer; `scratch` is the function's new local.

        `(local.tee s) (i32.sub (i32.const low)) (i32.gt_u (i32.const top - low)) (if (then <mark the canary>
        unreachable)) (local.get s) (global.set sp)`: one unsigned compare holds the value to `low..top`, so a value
        that wrapped below 0 is caught too.
        """
        low = self.floor + LEAF_ROOM
        return b"".join(
            (
                bytes([_LOCAL_TEE]),
                _uleb(scratch),
                bytes([_I32_CONST]),
                _sleb(low),
                bytes([_I32_SUB, _I32_CONST]),
                _sleb(self.top - low),
                bytes([_I32_GT_U, _IF, _EMPTY_BLOCK, _I32_CONST]),
                _sleb(self.floor),
                bytes([_I32_CONST, 0, _I32_STORE8, 0, 0, _UNREACHABLE, _END, _LOCAL_GET]),
                _uleb(scratch),
                bytes([_GLOBAL_SET]),
                _uleb(self.pointer),
            )
        )


class _Layout:
    """The parts of a wasm module the guard reads: types, imports, functions, globals, data, names, code."""

    def __init__(self, module: bytes) -> None:
        self._bytes = module
        self.imported_globals = 0
        self.memories = 0
        self.type_params: list[int] = []
        self.function_types: list[int] = []
        self.global_inits: list[int | None] = []
        self.global_mutable_i32: list[bool] = []
        self.global_names: dict[int, str] = {}
        self.segment_names: dict[int, str] = {}
        self._segments: list[tuple[int, bytes] | None] = []
        self.sections: list[tuple[int, int, int, int]] = []
        """Each section as (id, start of its header, start of its contents, end)."""

    @classmethod
    def read(cls, module: bytes) -> "_Layout":
        layout = cls(module)
        if module[: len(_MAGIC)] != _MAGIC:
            raise ValueError("not a wasm module")
        at = len(_MAGIC)
        readers: dict[int, Callable[[int], None]] = {
            _TYPE: layout._types,
            _IMPORT: layout._imports,
            _FUNCTION: layout._functions,
            _MEMORY: layout._memories,
            _GLOBAL: layout._globals,
            _DATA: layout._data,
        }
        while at < len(module):
            section = module[at]
            size, start = layout._uleb(at + 1)
            end = start + size
            if end > len(module):
                raise ValueError("a section runs past the end of the module")
            layout.sections.append((section, at, start, end))
            if section == _CUSTOM:
                layout._custom(start, end)
            elif section in readers:
                readers[section](start)
            at = end
        return layout

    @property
    def active_segments(self) -> list[tuple[int, bytes, str | None]]:
        return [
            (segment[0], segment[1], self.segment_names.get(index))
            for index, segment in enumerate(self._segments)
            if segment is not None
        ]

    def stack_pointer(self) -> tuple[int, int] | None:
        """Return the stack pointer's global index and initial value, when it is a defined mutable i32 constant."""
        for index, name in self.global_names.items():
            if name == _STACK_POINTER and index >= self.imported_globals:
                defined = index - self.imported_globals
                if defined >= len(self.global_inits) or not self.global_mutable_i32[defined]:
                    return None
                top = self.global_inits[defined]
                return None if top is None else (index, top)
        return None

    def rewrite(self, checks: _Checks) -> tuple[bytes, int]:
        """Return the module with every `global.set` of the pointer checked, and how many were; DWARF is dropped."""
        parts = [self._bytes[: len(_MAGIC)]]
        count = 0
        for section, header, start, end in self.sections:
            if section == _CUSTOM and self._custom_name(start).startswith(_DEBUG):
                continue
            if section == _CODE:
                contents, count = self._code(start, checks)
                parts.extend((bytes([_CODE]), _uleb(len(contents)), contents))
            else:
                parts.append(self._bytes[header:end])
        if count == 0:
            raise ValueError("the module's code never sets the stack pointer")
        return b"".join(parts), count

    def _code(self, at: int, checks: _Checks) -> tuple[bytes, int]:
        bodies, at = self._uleb(at)
        if bodies != len(self.function_types):
            raise ValueError("the code and function sections differ in length")
        parts = [_uleb(bodies)]
        count = 0
        for index in range(bodies):
            size, at = self._uleb(at)
            body = self._bytes[at : at + size]
            at += size
            params = self.type_params[self.function_types[index]]
            rewritten, sites = _checked_body(body, params, checks)
            count += sites
            parts.extend((_uleb(len(rewritten)), rewritten))
        return b"".join(parts), count

    def _custom_name(self, at: int) -> bytes:
        length, at = self._uleb(at)
        return self._bytes[at : at + length]

    def _types(self, at: int) -> None:
        count, at = self._uleb(at)
        for _ in range(count):
            if self._bytes[at] != _FUNC_TYPE:
                raise ValueError("a type that is not a plain function type")
            params, at = self._value_types(at + 1)
            _, at = self._value_types(at)
            self.type_params.append(params)

    def _value_types(self, at: int) -> tuple[int, int]:
        count, at = self._uleb(at)
        if any(kind not in _VALUE_TYPES for kind in self._bytes[at : at + count]):
            raise ValueError("a value type outside the one-byte types")
        return count, at + count

    def _functions(self, at: int) -> None:
        count, at = self._uleb(at)
        for _ in range(count):
            kind, at = self._uleb(at)
            if kind >= len(self.type_params):
                raise ValueError("a function names a type the module does not have")
            self.function_types.append(kind)

    def _memories(self, at: int) -> None:
        count, _ = self._uleb(at)
        self.memories += count

    def _imports(self, at: int) -> None:
        count, at = self._uleb(at)
        for _ in range(count):
            for _name in range(2):  # module, field
                length, at = self._uleb(at)
                at += length
            kind = self._bytes[at]
            at += 1
            if kind == _IMPORT_FUNC:
                _, at = self._uleb(at)
            elif kind == _IMPORT_TAG:
                _, at = self._uleb(at + 1)
            elif kind == _IMPORT_TABLE:
                at = self._limits(at + 1)
            elif kind == _IMPORT_MEMORY:
                at = self._limits(at)
                self.memories += 1
            elif kind == _IMPORT_GLOBAL:
                self.imported_globals += 1
                at += 2
            else:
                raise ValueError(f"unknown import kind {kind}")

    def _limits(self, at: int) -> int:
        flags = self._bytes[at]
        _, at = self._uleb(at + 1)
        if flags & _LIMITS_HAS_MAX:
            _, at = self._uleb(at)
        return at

    def _globals(self, at: int) -> None:
        count, at = self._uleb(at)
        for _ in range(count):
            kind, mutable = self._bytes[at], self._bytes[at + 1]
            value, at = self._const_expr(at + 2)
            self.global_inits.append(value)
            self.global_mutable_i32.append(kind == _I32 and mutable == _MUTABLE)

    def _data(self, at: int) -> None:
        count, at = self._uleb(at)
        for _ in range(count):
            flags, at = self._uleb(at)
            offset: int | None = None
            if flags in {_DATA_ACTIVE, _DATA_ACTIVE_INDEXED}:
                if flags == _DATA_ACTIVE_INDEXED:
                    _, at = self._uleb(at)
                offset, at = self._const_expr(at)
            elif flags != _DATA_PASSIVE:
                raise ValueError(f"unknown data segment flags {flags}")
            size, at = self._uleb(at)
            self._segments.append(None if offset is None else (offset, self._bytes[at : at + size]))
            at += size

    def _custom(self, at: int, end: int) -> None:
        length, at = self._uleb(at)
        if self._bytes[at : at + length] != b"name":
            return
        at += length
        while at < end:
            kind = self._bytes[at]
            size, at = self._uleb(at + 1)
            if kind in {_NAMES_GLOBAL, _NAMES_DATA}:
                names = self.global_names if kind == _NAMES_GLOBAL else self.segment_names
                count, cursor = self._uleb(at)
                for _ in range(count):
                    index, cursor = self._uleb(cursor)
                    length, cursor = self._uleb(cursor)
                    names[index] = self._bytes[cursor : cursor + length].decode("utf-8", "replace")
                    cursor += length
            at += size

    def _const_expr(self, at: int) -> tuple[int | None, int]:
        """Read an `i32.const` expression's value, or `None` for a `global.get`; refuse any other expression."""
        opcode = self._bytes[at]
        value: int | None = None
        if opcode == _I32_CONST:
            value, at = _read_sleb(self._bytes, at + 1)
        elif opcode == _GLOBAL_GET:
            _, at = self._uleb(at + 1)
        else:
            raise ValueError(f"unsupported constant expression opcode {opcode:#x}")
        if self._bytes[at] != _END:
            raise ValueError("a constant expression of more than one instruction")
        return value, at + 1

    def _uleb(self, at: int) -> tuple[int, int]:
        return _read_uleb(self._bytes, at)


# -- the code rewrite ------------------------------------------------------------------------------------------------
_NONE, _INDEX, _TWO, _BLOCK, _MEMARG, _LEB, _F32, _F64, _BR_TABLE, _SELECT, _PREFIX = range(11)
"""How an opcode's immediates are laid out (`_INDEX`: one LEB, `_TWO`: two, `_LEB`: a signed constant)."""
_UNKNOWN: Final = -1
_PREFIX_TWO: Final = frozenset({8, 10, 12, 14})
"""0xFC sub-opcodes with two indices: memory.init, memory.copy, table.init, table.copy."""
_PREFIX_ONE: Final = frozenset({9, 11, 13, 15, 16, 17})
"""0xFC sub-opcodes with one index: data.drop, memory.fill, elem.drop, table.grow, table.size, table.fill."""
_PREFIX_NONE: Final = 7
"""0xFC sub-opcodes 0..7 (the saturating truncations) have no immediates."""


def _kinds() -> tuple[int, ...]:
    kinds = [_UNKNOWN] * 256
    for opcode in (0x00, 0x01, 0x05, 0x0B, 0x0F, 0x1A, 0x1B, 0xD1, *range(0x45, 0xC5)):
        kinds[opcode] = _NONE
    for opcode in (0x02, 0x03, 0x04):
        kinds[opcode] = _BLOCK
    for opcode in (0x0C, 0x0D, 0x10, 0x12, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x3F, 0x40, 0xD2):
        kinds[opcode] = _INDEX
    for opcode in (0x11, 0x13):
        kinds[opcode] = _TWO
    for opcode in range(0x28, 0x3F):
        kinds[opcode] = _MEMARG
    kinds[0x41] = kinds[0x42] = kinds[0xD0] = _LEB  # i32.const, i64.const, ref.null's heap type
    kinds[0x43], kinds[0x44] = _F32, _F64
    kinds[0x0E], kinds[0x1C], kinds[0xFC] = _BR_TABLE, _SELECT, _PREFIX
    return tuple(kinds)


_KINDS: Final = _kinds()
_BLOCKS: Final = frozenset({0x02, 0x03, 0x04})
_NOT_ONE_BYTE: Final = frozenset({0x63, 0x64})
"""The reference-type prefixes of the GC proposal: a block or select type of more than one byte."""


def _checked_body(body: bytes, params: int, checks: _Checks) -> tuple[bytes, int]:
    """Return a function body with every `global.set` of the pointer checked, and how many were; refuse what is odd."""
    groups, first = _read_uleb(body, 0)
    at = first
    declared = 0
    for _ in range(groups):
        count, at = _read_uleb(body, at)
        if body[at] not in _VALUE_TYPES:
            raise ValueError("a local of a type outside the one-byte types")
        declared += count
        at += 1
    sites = _pointer_sets(body, at, checks.pointer)
    if not sites:
        return body, 0
    scratch = params + declared
    replacement = checks.instead_of_set(scratch)
    parts = [_uleb(groups + 1), body[first:at], _uleb(1), bytes([_I32])]
    cursor = at
    for begin, finish in sites:
        parts.extend((body[cursor:begin], replacement))
        cursor = finish
    parts.append(body[cursor:])
    return b"".join(parts), len(sites)


def _pointer_sets(body: bytes, at: int, pointer: int) -> list[tuple[int, int]]:
    """Decode the body's instructions from `at`; return where each `global.set pointer` begins and ends.

    The decode must end on the function's own `end` exactly at the end of the body, or the body is refused.
    """
    sites: list[tuple[int, int]] = []
    depth = 1
    end = len(body)
    while at < end:
        opcode = body[at]
        at += 1
        kind = _KINDS[opcode]
        if kind == _NONE:
            if opcode == _END:
                depth -= 1
                if depth == 0:
                    break
        elif kind == _INDEX:
            index, after = _read_uleb(body, at)
            if opcode == _GLOBAL_SET and index == pointer:
                sites.append((at - 1, after))
            at = after
        elif kind == _MEMARG:
            at = _skip_memarg(body, at)
        elif kind == _LEB:
            at = _skip_leb(body, at)
        elif kind == _BLOCK:
            depth += 1
            at = _skip_block_type(body, at)
        else:
            skip = _SKIP.get(kind)
            if skip is None:
                raise ValueError(f"an instruction the rewrite does not know: {opcode:#x}")
            at = skip(body, at)
    if depth != 0 or at != end:
        raise ValueError("a function body does not end where its size says")
    return sites


def _skip_two(body: bytes, at: int) -> int:
    return _skip_leb(body, _skip_leb(body, at))


def _skip_f32(_body: bytes, at: int) -> int:
    return at + 4


def _skip_f64(_body: bytes, at: int) -> int:
    return at + 8


def _skip_br_table(body: bytes, at: int) -> int:
    count, at = _read_uleb(body, at)
    for _ in range(count + 1):
        at = _skip_leb(body, at)
    return at


def _skip_select(body: bytes, at: int) -> int:
    count, at = _read_uleb(body, at)
    if any(kind not in _VALUE_TYPES for kind in body[at : at + count]):
        raise ValueError("a select type outside the one-byte types")
    return at + count


def _skip_prefix(body: bytes, at: int) -> int:
    sub, at = _read_uleb(body, at)
    if sub <= _PREFIX_NONE:
        return at
    if sub in _PREFIX_ONE:
        return _skip_leb(body, at)
    if sub in _PREFIX_TWO:
        return _skip_two(body, at)
    raise ValueError(f"an unknown 0xfc instruction {sub}")


_SKIP: Final[dict[int, "Callable[[bytes, int], int]"]] = {
    _TWO: _skip_two,
    _F32: _skip_f32,
    _F64: _skip_f64,
    _BR_TABLE: _skip_br_table,
    _SELECT: _skip_select,
    _PREFIX: _skip_prefix,
}
"""How to skip the immediates of the rarer layouts."""


def _skip_block_type(body: bytes, at: int) -> int:
    if body[at] in _NOT_ONE_BYTE:
        raise ValueError("a block type outside the one-byte types")
    return _skip_leb(body, at)  # 0x40, a one-byte value type, or a type index (s33)


def _skip_memarg(body: bytes, at: int) -> int:
    align, at = _read_uleb(body, at)
    if align & 0x40:  # multi-memory: a memory index follows
        at = _skip_leb(body, at)
    return _skip_leb(body, at)


def _skip_leb(data: bytes, at: int) -> int:
    while data[at] & 0x80:
        at += 1
    return at + 1


def _read_uleb(data: bytes, at: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        byte = data[at]
        at += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return result, at


def _read_sleb(data: bytes, at: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        byte = data[at]
        at += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            if byte & 0x40:
                result -= 1 << shift
            return result, at


def _uleb(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def _sleb(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if (value == 0 and not byte & 0x40) or (value == -1 and byte & 0x40):
            out.append(byte)
            return bytes(out)
        out.append(byte | 0x80)
