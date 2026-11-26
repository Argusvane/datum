"""`DatumSettings`: `DatumConfig` plus sources.

The fields are `DatumConfig`'s (the class inherits them, so a test comparing the two has nothing to find); what it adds
is where the values come from, in this order: init arguments, the environment (`DATUM_*`, `__` nesting, empty means
unset), the TOML file named by `DATUM_CONFIG_FILE`, then the trailing unknown-key scan. There is no `env_file` (it
refuses unrelated variables) and no copy method; `to_config()` hands the validated tree to `Datum` as a plain
`DatumConfig`.

Libraries: `pydantic_settings.PydanticBaseSettingsSource` is the extension point and
`TomlConfigSettingsSource` reads the file, so the scan is one source class; the scan itself and its did-you-mean are
`datum_core.config.unknown_env_checks` (difflib). A `model_validator(mode="before")` is not used: it wraps the text in a
pydantic `ValidationError` and runs on every `model_validate`, where a source runs
once, before validation, and can raise `DatumConfigurationError`.

A `ValidationError` is logged, if at all, with `errors(include_input=False)`; `hide_input_in_errors` keeps a secret out
of its text too.
"""

import os
from pathlib import Path
from typing import Any, ClassVar, Final

from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    TomlConfigSettingsSource,
)

from datum_core.checks import log_checks, silence
from datum_core.config import DatumConfig, unknown_env_checks
from datum_sandbox.checks import DatumConfigurationError

__all__ = ["CONFIG_FILE_VARIABLE", "DatumSettings"]

CONFIG_FILE_VARIABLE: Final = "DATUM_CONFIG_FILE"
"""The one `DATUM_*` variable the host reads outside the settings tree: the TOML file to load."""


class _EnvScan(PydanticBaseSettingsSource):
    """The trailing source: warns `datum.W007` for each unknown `DATUM_*` variable, refuses under `strict_env`.

    It contributes no value. `strict_env` and `silenced_checks` are read from what the sources before it resolved.
    """

    def get_field_value(self, field: Any, field_name: str) -> tuple[Any, str, bool]:  # noqa: ARG002, ANN401 - the base signature
        """Provide no field: the scan contributes no value."""
        return None, field_name, False

    def __call__(self) -> dict[str, Any]:
        """Scan the process environment once."""
        state = self.current_state
        found = silence(unknown_env_checks(os.environ), _silenced(state.get("silenced_checks")))
        if not found:
            return {}
        if _strict(state.get("strict_env")):
            raise DatumConfigurationError.from_checks(found)
        log_checks(found)
        return {}


def _strict(value: object) -> bool:
    if value is None:
        return False
    try:
        return DatumConfig.model_validate({"strict_env": value}).strict_env
    except ValueError:  # pydantic's ValidationError: the field's own validation reports it, with its name
        return False


def _silenced(value: object) -> tuple[str, ...]:
    if isinstance(value, list | tuple):
        return tuple(str(item) for item in value)
    return ()


class DatumSettings(DatumConfig, BaseSettings):
    """Datum's configuration read from the environment and a TOML file; `to_config()` gives the plain `DatumConfig`."""

    model_config: ClassVar[SettingsConfigDict] = SettingsConfigDict(
        env_prefix="DATUM_",
        env_nested_delimiter="__",
        extra="forbid",
        env_ignore_empty=True,
        validate_default=True,
        frozen=True,
        hide_input_in_errors=True,
    )

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,  # noqa: ARG003 - no env_file
        file_secret_settings: PydanticBaseSettingsSource,  # noqa: ARG003 - no secrets directory
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        """Init, environment, the TOML file, then the scan."""
        sources: list[PydanticBaseSettingsSource] = [init_settings, env_settings]
        named = os.environ.get(CONFIG_FILE_VARIABLE)
        if named:
            if not Path(named).is_file():
                raise DatumConfigurationError(
                    f"{CONFIG_FILE_VARIABLE} names {named!r}, which is not a file.",
                    hint=f"Point {CONFIG_FILE_VARIABLE} at a TOML file, or unset it.",
                )
            sources.append(TomlConfigSettingsSource(settings_cls, toml_file=named))
        sources.append(_EnvScan(settings_cls))
        return tuple(sources)

    def to_config(self) -> DatumConfig:
        """Return the same values as a plain, validation-only `DatumConfig`."""
        return DatumConfig(**{name: getattr(self, name) for name in DatumConfig.model_fields})
