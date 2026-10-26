"""Executable vendor coverage inventory and pytest outcome gate.

The inventory names behavior tests, not files. Full-suite collection catches
renamed/deleted cases; focused selections audit only the cases they select.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "tests" / "fixtures" / "cli-regression"
RUNNER_CAPABILITIES = ({"posix_pty", "darwin_helper"}, {"posix_pty"}, {"windows_conpty"})
PLATFORM_REQUIREMENTS = {
    ("claude", "shutdown"): {"posix_pty"},
}


def load_catalog() -> dict:
    return json.loads((FIXTURES / "catalog.json").read_text(encoding="utf-8"))


def required_capabilities(spec) -> set[str]:
    capabilities = {"launch"}
    if spec.make_log_reader:
        capabilities.add("reader")
    capabilities.add("resume" if spec.supports_session_resume else "unsupported_session")
    for capability, declared in (("push", spec.push_channel),
                                 ("interrupt", spec.interrupt_key),
                                 ("hooks", spec.install_hooks),
                                 ("login", spec.login_command_args),
                                 ("shutdown", spec.shutdown)):
        if declared is not None:
            capabilities.add(capability)
    return capabilities


def validate_catalog(data: dict, vendors: dict) -> list[str]:
    errors = []
    if data.get("schemaVersion") != 1:
        errors.append("unsupported catalog schemaVersion")
    declared = data.get("vendors", {})
    if set(declared) != set(vendors):
        errors.append(f"vendor coverage differs: missing={sorted(set(vendors) - set(declared))}, "
                      f"unexpected={sorted(set(declared) - set(vendors))}")
    for key, entry in declared.items():
        if key not in vendors:
            continue
        expected = required_capabilities(vendors[key])
        if set(entry.get("capabilities", [])) != expected:
            errors.append(f"{key}: capabilities must be {sorted(expected)}")
        if set(entry.get("cases", {})) != expected:
            errors.append(f"{key}: every declared capability needs an executable case")
        for capability, case in entry.get("cases", {}).items():
            if not case.get("nodeid", "").startswith("tests/") or "::test_" not in case["nodeid"]:
                errors.append(f"{key}/{capability}: missing behavioral test nodeid")
            if set(case.get("requires", [])) - {"posix_pty", "windows_conpty", "darwin_helper"}:
                errors.append(f"{key}/{capability}: unknown platform requirement")
            if not any(set(case.get("requires", [])) <= runner for runner in RUNNER_CAPABILITIES):
                errors.append(f"{key}/{capability}: no CI runner can execute this requirement")
            allowed = PLATFORM_REQUIREMENTS.get((key, capability), set())
            if set(case.get("requires", [])) != allowed:
                errors.append(f"{key}/{capability}: platform exemptions must match {sorted(allowed)}")
        path = FIXTURES / entry.get("fixture", "")
        if path.parent != FIXTURES or not path.is_file():
            errors.append(f"{key}: missing fixture {path.name}")
            continue
        fixture = json.loads(path.read_text(encoding="utf-8"))
        provenance = fixture.get("provenance", {})
        if provenance.get("kind") not in {"synthetic", "recorded"} or not all(
            provenance.get(field) for field in ("source", "revision", "notes")
        ):
            errors.append(f"{key}: fixture provenance is incomplete")
        elif not re.fullmatch(r"[0-9a-f]{7,40}", provenance["revision"]) or not (ROOT / provenance["source"]).is_file():
            errors.append(f"{key}: fixture source/revision is invalid")
        if fixture.get("vendor") != key:
            errors.append(f"{key}: fixture belongs to another vendor")
    return errors


def matches(nodeid: str, declared: str) -> bool:
    return nodeid == declared or nodeid.startswith(declared + "[")


def applicable(case: dict) -> bool:
    available = {"windows_conpty"} if sys.platform == "win32" else {"posix_pty"}
    if sys.platform == "darwin":
        available.add("darwin_helper")
    return set(case.get("requires", [])) <= available


def validate_collection(required: set[str], collected: set[str]) -> list[str]:
    return [f"required case was not collected: {case}" for case in sorted(required)
            if not any(matches(node, case) for node in collected)]


def validate_outcomes(required: set[str], outcomes: dict[str, str]) -> list[str]:
    return [f"required case {node}: {outcomes.get(node, 'not-run')}"
            for node in sorted(required) if outcomes.get(node) != "passed"]


def _required_cases() -> set[str]:
    return {case["nodeid"] for entry in load_catalog()["vendors"].values()
            for case in entry["cases"].values() if applicable(case)}


def _historical_case_owners() -> dict[str, str]:
    # The historical inventory shares this gate but owns its own schema.
    from .historical_catalog import load_catalog as load, required_cases, validate_catalog as validate
    data = load()
    errors = validate(data)
    if errors:
        raise pytest.UsageError("Historical regression inventory:\n" + "\n".join(errors))
    owners = {entry["id"]: entry["owner"] for entry in data["regressions"]}
    return {node: owners[identity] for node, identity in required_cases(data).items()}


def _historical_cases() -> set[str]:
    return set(_historical_case_owners())


@pytest.hookimpl(tryfirst=True)
def pytest_collection_modifyitems(config, items):
    from agent_team_backend.cli_vendors.registry import VENDORS

    errors = validate_catalog(load_catalog(), VENDORS)
    required = _required_cases()
    historical_owners = _historical_case_owners()
    historical = set(historical_owners)
    collected = {item.nodeid for item in items}
    # Full collection is the CI gate. A developer selecting one regression
    # keeps that quick loop without being forced to run unrelated tests.
    full = any(Path(arg.split("::")[0]).resolve() == ROOT / "backend" / "tests"
               for arg in config.args)
    if full:
        errors.extend(validate_collection(required | historical, collected))
    if errors:
        raise pytest.UsageError("CLI regression inventory:\n" + "\n".join(errors))
    for item in items:
        vendor_case = any(matches(item.nodeid, node) for node in required)
        history_owners = {owner for node, owner in historical_owners.items() if matches(item.nodeid, node)}
        history_case = bool(history_owners)
        if vendor_case or history_case:
            item.add_marker(pytest.mark.cli_regression)
            if vendor_case or history_owners - {"shared"}:
                item.add_marker(pytest.mark.cli_vendor)
            if "shared" in history_owners:
                item.add_marker(pytest.mark.cli_shared)
            item.user_properties.append(("cli_contract", "vendor" if vendor_case else "historical"))
    config._cli_contract_required = required | historical
    config._cli_contract_outcomes = {}


def pytest_collection_finish(session):
    required = getattr(session.config, "_cli_contract_required", set())
    session.config._cli_contract_selected = {
        item.nodeid for item in session.items
        if any(matches(item.nodeid, node) for node in required)
    }


def _record_outcome(outcomes, nodeid, report):
    if report.skipped or getattr(report, "wasxfail", False):
        outcomes[nodeid] = "xfailed" if getattr(report, "wasxfail", False) else "skipped"
    elif report.failed:
        outcomes[nodeid] = "failed"
    elif report.when == "call" and nodeid not in outcomes:
        outcomes[nodeid] = "passed"


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    result = yield
    report = result.get_result()
    _record_outcome(getattr(item.config, "_cli_contract_outcomes", {}), item.nodeid, report)


def _is_xdist_worker(config) -> bool:
    return hasattr(config, "workerinput")


def _is_xdist_controller(config) -> bool:
    # The condition pytest-xdist itself uses to start a distributed session.
    return (not _is_xdist_worker(config) and config.getoption("dist", "no") != "no"
            and bool(config.getoption("tx", None)))


class _XdistControllerCoverage:
    """Under pytest-xdist the controller collects and runs nothing, and each
    worker runs only part of the suite, so the coverage check moves here and
    is rebuilt from what the workers report."""

    def __init__(self, config):
        self.config = config
        config._cli_contract_outcomes = {}

    @pytest.hookimpl(optionalhook=True)
    def pytest_xdist_node_collection_finished(self, node, ids):
        # Every worker collects the same selection.
        required = _required_cases() | _historical_cases()
        self.config._cli_contract_selected = {
            nodeid for nodeid in ids if any(matches(nodeid, node_id) for node_id in required)
        }

    def pytest_runtest_logreport(self, report):
        _record_outcome(self.config._cli_contract_outcomes, report.nodeid, report)


def pytest_configure(config):
    if _is_xdist_controller(config) and not config.option.collectonly:
        config.pluginmanager.register(_XdistControllerCoverage(config), "cli-contract-xdist-coverage")


def pytest_sessionfinish(session, exitstatus):
    if session.config.option.collectonly or _is_xdist_worker(session.config):
        return
    errors = validate_outcomes(getattr(session.config, "_cli_contract_selected", set()),
                               getattr(session.config, "_cli_contract_outcomes", {}))
    if errors:
        session.exitstatus = pytest.ExitCode.TESTS_FAILED
        reporter = session.config.pluginmanager.get_plugin("terminalreporter")
        if reporter:
            reporter.write_sep("=", "CLI regression coverage incomplete", red=True)
            for error in errors:
                reporter.write_line(error, red=True)
