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
stack (`JSON.parse` of nested input, about 2,000 levels at 512 KiB, under 1,000 at 128 KiB). So the runtime watches
the shadow stack itself. Before `_start` it writes a canary over the lowest `CANARY` bytes of the stack region, which
nothing touches until the stack is that deep. After the guest ends, however it ends, the run is a stack overrun when
the canary changed or when a `.rodata` segment (constant data the guest never writes) no longer matches the module;
the second check sees a frame larger than the canary that stepped over it. The harness reads an overrun as a trap,
whatever the guest did after it: the release build's sandbox program, for one, throws `invalid opcode` and then loops
until the epoch ends it.

The layout comes from the module itself: the `__stack_pointer` global's initial value is the stack's top, the data
segments and their names (the name section) are the statics, and the floor is the top less `STACK_SIZE`. A module
without those names, or whose floor would sit inside its data segments, runs without the guard (a stack placed first
overruns below address 0, which wasmtime traps by itself). A module built with a larger stack is guarded at 64 KiB
all the same; one built with a smaller stack would have live `.bss` under the canary, which the module's bytes do
not show, so the guard is for the pinned release build, which the runtime verifies by its digest.
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    import wasmtime

STACK_SIZE: Final = 64 * 1024
"""wasm-ld's default `-z stack-size`, which the QuickJS-ng release builds of `qjs-wasi.wasm` keep."""
CANARY: Final = 4096
"""How many of the stack's lowest bytes the canary covers: more than an ordinary QuickJS frame."""
_CANARY_BYTE: Final = 0xA5
_STACK_POINTER: Final = "__stack_pointer"
_RODATA: Final = ".rodata"

_MAGIC: Final = b"\0asm\1\0\0\0"
_CUSTOM, _IMPORT, _GLOBAL, _DATA = 0, 2, 6, 11
"""Section ids."""
_IMPORT_FUNC, _IMPORT_TABLE, _IMPORT_MEMORY, _IMPORT_GLOBAL, _IMPORT_TAG = 0, 1, 2, 3, 4
_DATA_ACTIVE, _DATA_PASSIVE, _DATA_ACTIVE_INDEXED = 0, 1, 2
_NAMES_GLOBAL, _NAMES_DATA = 7, 9
"""Name-section subsections: global names, data segment names."""
_I32_CONST, _GLOBAL_GET, _END = 0x41, 0x23, 0x0B
_LIMITS_HAS_MAX: Final = 0x01


class StackOverrunError(Exception):
    """The guest's shadow stack reached its floor: its statics may be overwritten, so the run is a trap."""


@dataclass(frozen=True, slots=True)
class StackGuard:
    """Where the canary goes and which constant segments must still match after a run."""

    floor: int
    top: int
    rodata: tuple[tuple[int, bytes], ...]

    def arm(self, store: "wasmtime.Store", memory: "wasmtime.Memory") -> None:
        """Write the canary over the stack's lowest bytes, after instantiation and before `_start`."""
        memory.write(store, bytes([_CANARY_BYTE]) * CANARY, self.floor)

    def overran(self, store: "wasmtime.Store", memory: "wasmtime.Memory") -> bool:
        """Say whether the canary changed or a `.rodata` segment no longer matches the module."""
        if memory.read(store, self.floor, self.floor + CANARY).count(_CANARY_BYTE) != CANARY:
            return True
        return any(memory.read(store, offset, offset + len(data)) != data for offset, data in self.rodata)

    def describe(self) -> str:
        """Return the engine-info note: the stack region and how much constant data is compared."""
        constant = sum(len(data) for _, data in self.rodata)
        return (
            f"shadow stack guard: {self.floor}..{self.top}, canary {CANARY} bytes, {constant} bytes of .rodata "
            "compared after each run"
        )


def stack_guard(module: bytes) -> StackGuard | None:
    """Read the guard's layout from the module's bytes; `None` when the module does not have the layout it needs."""
    try:
        layout = _Layout.read(module)
    except (IndexError, ValueError):
        return None
    top = layout.stack_top()
    segments = layout.active_segments
    if top is None or not segments:
        return None
    floor = top - STACK_SIZE
    if floor < max(offset + len(data) for offset, data, _ in segments):
        return None
    rodata = tuple((offset, data) for offset, data, name in segments if name == _RODATA)
    return StackGuard(floor=floor, top=top, rodata=rodata)


def describe_unguarded() -> str:
    """Return the engine-info note for a module that runs without the guard."""
    return "shadow stack guard: off (the module does not name a stack above its data)"


class _Layout:
    """The few parts of a wasm module the guard reads: imported globals, globals, data segments and their names."""

    def __init__(self, module: bytes) -> None:
        self._bytes = module
        self.imported_globals = 0
        self.global_inits: list[int | None] = []
        self.global_names: dict[int, str] = {}
        self.segment_names: dict[int, str] = {}
        self._segments: list[tuple[int, bytes] | None] = []

    @classmethod
    def read(cls, module: bytes) -> "_Layout":
        layout = cls(module)
        if module[: len(_MAGIC)] != _MAGIC:
            raise ValueError("not a wasm module")
        at = len(_MAGIC)
        while at < len(module):
            section = module[at]
            size, at = layout._uleb(at + 1)
            end = at + size
            if section == _IMPORT:
                layout._imports(at)
            elif section == _GLOBAL:
                layout._globals(at)
            elif section == _DATA:
                layout._data(at)
            elif section == _CUSTOM:
                layout._custom(at, end)
            at = end
        return layout

    @property
    def active_segments(self) -> list[tuple[int, bytes, str | None]]:
        return [
            (segment[0], segment[1], self.segment_names.get(index))
            for index, segment in enumerate(self._segments)
            if segment is not None
        ]

    def stack_top(self) -> int | None:
        for index, name in self.global_names.items():
            if name == _STACK_POINTER and index >= self.imported_globals:
                defined = index - self.imported_globals
                return self.global_inits[defined] if defined < len(self.global_inits) else None
        return None

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
            at += 2  # value type, mutability
            value, at = self._const_expr(at)
            self.global_inits.append(value)

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
            value, at = self._sleb(at + 1)
        elif opcode == _GLOBAL_GET:
            _, at = self._uleb(at + 1)
        else:
            raise ValueError(f"unsupported constant expression opcode {opcode:#x}")
        if self._bytes[at] != _END:
            raise ValueError("a constant expression of more than one instruction")
        return value, at + 1

    def _uleb(self, at: int) -> tuple[int, int]:
        result = shift = 0
        while True:
            byte = self._bytes[at]
            at += 1
            result |= (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                return result, at

    def _sleb(self, at: int) -> tuple[int, int]:
        result = shift = 0
        while True:
            byte = self._bytes[at]
            at += 1
            result |= (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                if byte & 0x40:
                    result -= 1 << shift
                return result, at
