"""Hypothesis profiles: ``dev`` (the default, 50 examples) and ``ci`` (500 examples, no deadline).

Select one with ``pytest --hypothesis-profile ci``. Importing this module registers both and loads ``dev``; the pytest
plugin loads the named profile afterwards when the option is given.
"""

from typing import Final

from hypothesis import settings

DEV: Final = "dev"
CI: Final = "ci"


def register_profiles() -> None:
    """Register ``dev`` and ``ci``; repeating it is harmless."""
    settings.register_profile(DEV, max_examples=50)
    settings.register_profile(CI, max_examples=500, deadline=None)


def load_default() -> None:
    """Register the profiles and make ``dev`` the active one."""
    register_profiles()
    settings.load_profile(DEV)
