"""The wrapped `import wasmtime`: an unsupported platform is refused by name, with the musl hint on Alpine."""

import platform
from collections.abc import Callable
from types import ModuleType

import pytest

from datum_sandbox.wasi import Available, EngineConfigurationError, Unavailable
from datum_sandbox_wasmtime import WasmtimeProvider, _platform, _provider

NO_LIBRARY = OSError("dlopen(/site-packages/wasmtime/linux-x86_64/_libwasmtime.so, 0x0006): tried: (no such file)")
NO_LIBGCC = OSError("Error loading shared library libgcc_s.so.1: No such file or directory (needed by _libwasmtime.so)")


def _failing(error: BaseException) -> Callable[[str], ModuleType]:
    def importer(name: str) -> ModuleType:
        raise error

    return importer


def test_a_missing_native_library_names_the_platform_and_the_machine() -> None:
    with pytest.raises(EngineConfigurationError) as caught:
        _platform.load_wasmtime(_failing(NO_LIBRARY))
    text = caught.value.message
    assert repr(platform.machine()) in text
    assert "platform.machine()" in text
    assert "py3-none-any" in text, "the reason the bare wheel installed anyway"
    assert "no such file" in text, "the loader's own words are kept"
    assert "datum.runtime.engine" in caught.value.hint
    assert isinstance(caught.value.__cause__, OSError)


def test_the_musl_refusal_says_apk_add_libgcc() -> None:
    text = _platform.unavailable_reason(NO_LIBGCC, musl=True)
    assert "apk add libgcc" in text
    assert "libgcc_s.so.1" in text
    assert "apk add" not in _platform.unavailable_reason(NO_LIBGCC, musl=False)


def test_a_binding_not_installed_by_the_marker_is_refused_by_platform() -> None:
    with pytest.raises(EngineConfigurationError) as caught:
        _platform.load_wasmtime(_failing(ModuleNotFoundError("No module named 'wasmtime'")))
    assert "not installed" in caught.value.message
    assert repr(platform.machine()) in caught.value.message


def test_the_provider_answers_unavailable_naming_the_platform(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse() -> ModuleType:
        raise EngineConfigurationError(_platform.unavailable_reason(NO_LIBRARY, musl=False))

    monkeypatch.setattr(_provider, "load_wasmtime", refuse)
    availability = WasmtimeProvider().availability()
    assert isinstance(availability, Unavailable)
    assert repr(platform.machine()) in availability.reason


def test_the_provider_is_available_here_with_the_release() -> None:
    availability = WasmtimeProvider().availability()
    assert isinstance(availability, Available)
    assert availability.notes[0].startswith("wasmtime ")


def test_importing_the_package_imports_no_wasmtime_code_of_its_own() -> None:
    import datum_sandbox_wasmtime  # noqa: PLC0415

    assert WasmtimeProvider().id == "wasmtime"
    assert datum_sandbox_wasmtime.ENGINE_ID == "wasmtime"
    with pytest.raises(AttributeError):
        _ = datum_sandbox_wasmtime.not_a_name
