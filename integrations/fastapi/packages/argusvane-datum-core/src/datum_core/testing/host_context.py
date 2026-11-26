"""The host-context contract form and its TEST-ONLY provider (cases HCX-01 to HCX-04 of the host kit)."""

from typing import TYPE_CHECKING, Any, Final

if TYPE_CHECKING:
    from datum_core.submissions import SubmissionContext
    from datum_sandbox.json import JsonValue

HOST_CONTEXT_FORM_ID: Final = "datum-host-context"
"""The contract form for the host context (cases HCX-01 to HCX-04), version 1."""
HOST_CONTEXT_ROLE_HEADER: Final = "X-Datum-Test-Role"
"""The request header the TEST-ONLY provider reads the role from; it is never a header a real application trusts."""


def host_context_form() -> dict[str, Any]:
    """Return the host-context contract form: `name` (required text) and `admin_note` (required, shown to admins only).

    `admin_note` is visible when `host.role = "admin"`: with that context a missing note is refused (`required`), with
    any other role it is hidden and left out of the values, and with no context at all the rule is not judged.
    """
    return {
        "id": HOST_CONTEXT_FORM_ID,
        "version": "1",
        "root": {
            "id": "root",
            "type": "form",
            "configuration": {},
            "children": {
                "content": [
                    {"id": "name", "type": "text", "configuration": {"label": "Name", "required": True}},
                    {
                        "id": "admin_note",
                        "type": "text",
                        "configuration": {"label": "Note for administrators", "required": True},
                        "rules": {"visibleWhen": 'host.role = "admin"'},
                    },
                ]
            },
        },
    }


def role_header_host_context(form_key: str, context: "SubmissionContext") -> dict[str, "JsonValue"] | None:
    """Answer the contract cases' host context from a header: TEST-ONLY, never wire it into a real application.

    For the host-context form only, it answers `{"role": <X-Datum-Test-Role>}` when the request carries the header,
    and no context when it does not; every other form gets none. A real provider reads the signed-in person, never a
    header the caller chooses.
    """
    if form_key != HOST_CONTEXT_FORM_ID or context.headers is None:
        return None
    wanted = HOST_CONTEXT_ROLE_HEADER.lower()
    role = next((value for name, value in context.headers.items() if name.lower() == wanted), None)
    return None if role is None else {"role": role}
