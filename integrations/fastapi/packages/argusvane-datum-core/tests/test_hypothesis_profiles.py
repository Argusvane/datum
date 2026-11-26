from typing import Any

from hypothesis import settings

from datum_core.testing import hypothesis_profiles as profiles


def test_dev_is_the_default_and_ci_is_larger() -> None:
    dev: Any = settings.get_profile(profiles.DEV)
    ci: Any = settings.get_profile(profiles.CI)
    assert dev.max_examples == 50
    assert ci.max_examples == 500
    assert ci.deadline is None
    profiles.register_profiles()  # idempotent


def test_load_default_activates_dev() -> None:
    before = settings.get_current_profile_name()
    try:
        settings.load_profile(profiles.CI)
        assert settings().max_examples == 500
        profiles.load_default()
        assert settings.get_current_profile_name() == profiles.DEV
        assert settings().max_examples == 50
    finally:
        settings.load_profile(before)
