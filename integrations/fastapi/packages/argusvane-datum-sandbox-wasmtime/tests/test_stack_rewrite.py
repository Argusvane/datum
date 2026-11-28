"""The guard's code rewrite: every `global.set` of `__stack_pointer` is held to the stack, and nothing else changes.

Driven on small modules written for the purpose and on the pinned guest, whose every function body the rewrite must
decode to its own end.
"""

import pytest
import wasmtime

from datum_sandbox_wasmtime._qjs import load_qjs
from datum_sandbox_wasmtime._stack import LEAF_ROOM, STACK_SIZE, StackGuard, _Layout, stack_guard

TOP = 70656
FLOOR = TOP - STACK_SIZE
"""A stack of `STACK_SIZE` bytes from 70656 down, above one small `.rodata` segment at 1024."""

SMALL = f"""(module
  (memory (export "memory") 2)
  (global $__stack_pointer (mut i32) (i32.const {TOP}))
  (data $.rodata (i32.const 1024) "constant")
  (func (export "push") (param $size i32) (result i32)
    (global.set $__stack_pointer (i32.sub (global.get $__stack_pointer) (local.get $size)))
    (global.get $__stack_pointer))
  (func (export "set") (param $to i32)
    (global.set $__stack_pointer (local.get $to)))
  (func (export "framed") (param $a i32) (result i64)
    (local $wide i64) (local $narrow f32)
    (local.set $wide (i64.const 7))
    (local.set $narrow (f32.const 1.5))
    (global.set $__stack_pointer (i32.sub (global.get $__stack_pointer) (i32.const 64)))
    (global.set $__stack_pointer (i32.add (global.get $__stack_pointer) (i32.const 64)))
    (i64.add (local.get $wide) (i64.extend_i32_u (i32.add (local.get $a) (i32.trunc_f32_u (local.get $narrow))))))
  (func (export "_start")))
"""


class Small:
    """The small module, guarded, instantiated in a store of its own."""

    def __init__(self, guard: StackGuard) -> None:
        engine = wasmtime.Engine()
        self.store = wasmtime.Store(engine)
        self.instance = wasmtime.Instance(self.store, wasmtime.Module(engine, guard.module), [])
        memory = self.instance.exports(self.store)["memory"]
        assert isinstance(memory, wasmtime.Memory)
        self.memory = memory
        guard.arm(self.store, memory)

    def call(self, name: str, *args: int) -> object:
        func = self.instance.exports(self.store)[name]
        assert isinstance(func, wasmtime.Func)
        return func(self.store, *args)


@pytest.fixture
def guard() -> StackGuard:
    found = stack_guard(wasmtime.wat2wasm(SMALL))
    assert found is not None
    return found


def test_the_layout_and_the_checked_writes_are_read_from_the_module(guard: StackGuard) -> None:
    assert (guard.floor, guard.top, guard.checks) == (FLOOR, TOP, 4)
    assert guard.rodata == ((1024, b"constant"),)


def test_a_move_inside_the_stack_is_kept(guard: StackGuard) -> None:
    small = Small(guard)
    assert small.call("push", 1000) == TOP - 1000
    assert small.call("push", TOP - 1000 - FLOOR - LEAF_ROOM) == FLOOR + LEAF_ROOM, "down to the leaf room exactly"
    small.call("set", TOP)
    assert not guard.overran(small.store, small.memory)


@pytest.mark.parametrize(
    ("name", "argument"),
    [
        ("push", TOP - FLOOR - LEAF_ROOM + 1),  # one byte into the leaf room
        ("push", TOP - FLOOR + 4096),  # past the floor into the statics
        ("push", TOP + 16),  # wrapped below address 0, where the frame's offsets reach the statics again
        ("set", TOP + 16),  # above the top
        ("set", 0),
    ],
    ids=["leaf-room", "statics", "wrapped", "above-the-top", "zero"],
)
def test_a_move_out_of_the_stack_traps_and_marks_the_canary(guard: StackGuard, name: str, argument: int) -> None:
    small = Small(guard)
    with pytest.raises(wasmtime.Trap) as caught:
        small.call(name, argument)
    assert caught.value.trap_code is wasmtime.TrapCode.UNREACHABLE
    assert guard.overran(small.store, small.memory), "the check marks the canary before it traps"
    assert small.call("push", 0) == TOP, "the pointer was never moved"


def test_the_functions_own_locals_are_untouched_by_the_scratch_local(guard: StackGuard) -> None:
    assert Small(guard).call("framed", 3) == 7 + 3 + 1


def test_a_module_without_a_stack_pointer_write_has_no_guard() -> None:
    module = wasmtime.wat2wasm(
        f'(module (memory 2) (global $__stack_pointer (mut i32) (i32.const {TOP})) (data $.rodata (i32.const 1024) "x")'
        ' (func (export "_start")))'
    )
    assert stack_guard(module) is None


@pytest.mark.parametrize(
    "body",
    [
        "(drop (v128.const i64x2 0 0))",  # SIMD: an instruction the rewrite does not decode
        "(drop (i32.atomic.load (i32.const 0)))",  # threads
    ],
    ids=["simd", "atomics"],
)
def test_code_the_rewrite_cannot_decode_has_no_guard(body: str) -> None:
    shared = " shared" if "atomic" in body else ""
    module = wasmtime.wat2wasm(
        f"(module (memory 2 2{shared}) (global $__stack_pointer (mut i32) (i32.const {TOP})) "
        f'(data $.rodata (i32.const 1024) "x") (func $f (param i32) '
        f"(global.set $__stack_pointer (local.get 0)) {body}) "
        '(func (export "_start")))'
    )
    assert stack_guard(module) is None


def test_an_immutable_or_unnamed_stack_pointer_has_no_guard() -> None:
    immutable = SMALL.replace("(mut i32)", "i32").replace(
        "(global.set $__stack_pointer (local.get $to))", "(drop (local.get $to))"
    )
    assert stack_guard(wasmtime.wat2wasm(immutable)) is None
    unnamed = SMALL.replace("$__stack_pointer", "$sp")
    assert stack_guard(wasmtime.wat2wasm(unnamed)) is None


@pytest.fixture(scope="module")
def pinned() -> tuple[bytes, StackGuard]:
    data = load_qjs().data
    found = stack_guard(data)
    assert found is not None, "the rewrite reads every function body of the pinned guest"
    return data, found


def test_the_pinned_guest_is_rewritten_into_a_valid_module(pinned: tuple[bytes, StackGuard]) -> None:
    _, guard = pinned
    wasmtime.Module.validate(wasmtime.Engine(), guard.module)
    assert guard.checks > 1000, "every function with a frame moves the stack pointer"


def test_only_the_code_changes_and_the_dwarf_is_dropped(pinned: tuple[bytes, StackGuard]) -> None:
    data, guard = pinned
    before, after = _Layout.read(data), _Layout.read(guard.module)

    def sections(layout: _Layout, module: bytes) -> list[bytes]:
        return [module[header:end] for section, header, _, end in layout.sections if section != 10]

    kept = [part for part in sections(before, data) if b".debug_" not in part[:16]]
    assert sections(after, guard.module) == kept
    assert len(kept) < len(before.sections) - 1, "the .debug_ sections are gone"
    assert any(b"\x04name" in part[:12] for part in kept), "the name section stays, for the traps' backtraces"
