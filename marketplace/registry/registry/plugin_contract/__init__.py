"""Byte-identical copies of the plan B interface contract modules.

The Registry image ships only this ``registry`` package, so it cannot import
``backend/agent_team_backend/plugins``. ``agent_tools_contract.py`` and
``disclosure_contract.py`` here are exact copies of the backend files;
``tests/test_disclosure.py`` fails when they drift. Change the backend copy
(and the shared fixtures) first, then copy it here.
"""
