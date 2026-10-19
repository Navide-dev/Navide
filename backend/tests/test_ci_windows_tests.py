"""The detached Windows runner must fail closed when job setup is unavailable."""
import importlib.util
import types
from pathlib import Path

import pytest

_MODULE_SPEC = importlib.util.spec_from_file_location(
    "ci_windows_tests", Path(__file__).resolve().parents[1] / "ci_windows_tests.py"
)
assert _MODULE_SPEC is not None and _MODULE_SPEC.loader is not None
ci_windows_tests = importlib.util.module_from_spec(_MODULE_SPEC)
_MODULE_SPEC.loader.exec_module(ci_windows_tests)


class _Kernel32:
    def __init__(self, failure: str):
        self.failure = failure
        self.closed: list[int] = []

    def CreateJobObjectW(self, *_args):
        return 0 if self.failure == "create" else 123

    def SetInformationJobObject(self, *_args):
        return self.failure != "configure"

    def AssignProcessToJobObject(self, *_args):
        return self.failure != "assign"

    def GetCurrentProcess(self):
        return 456

    def CloseHandle(self, handle):
        self.closed.append(handle)
        return True


@pytest.mark.parametrize("failure", ["create", "configure", "assign"])
def test_join_job_reports_setup_failure_and_closes_partial_job(monkeypatch, failure):
    kernel32 = _Kernel32(failure)
    monkeypatch.setattr(ci_windows_tests, "_kernel32", lambda: kernel32)
    monkeypatch.setattr(ci_windows_tests.ctypes, "get_last_error", lambda: 5, raising=False)

    assert ci_windows_tests._join_job() is None
    assert kernel32.closed == ([] if failure == "create" else [123])


def test_join_job_sets_limits_and_assigns_current_process(monkeypatch):
    class _SuccessfulKernel32(_Kernel32):
        def __init__(self):
            super().__init__("")
            self.calls = []
            self.limits = None

        def CreateJobObjectW(self, *_args):
            self.calls.append("create")
            return 123

        def SetInformationJobObject(self, handle, kind, info_ptr, size):
            self.calls.append("configure")
            assert handle == 123
            assert kind == ci_windows_tests.JobObjectExtendedLimitInformation
            assert size == ci_windows_tests.ctypes.sizeof(
                ci_windows_tests._JOBOBJECT_EXTENDED_LIMIT_INFORMATION
            )
            info = ci_windows_tests.ctypes.cast(
                info_ptr,
                ci_windows_tests.ctypes.POINTER(
                    ci_windows_tests._JOBOBJECT_EXTENDED_LIMIT_INFORMATION
                ),
            ).contents
            self.limits = (
                info.BasicLimitInformation.LimitFlags,
                info.BasicLimitInformation.ActiveProcessLimit,
                info.JobMemoryLimit,
            )
            return True

        def AssignProcessToJobObject(self, handle, process):
            self.calls.append("assign")
            assert (handle, process) == (123, 456)
            return True

    kernel32 = _SuccessfulKernel32()
    monkeypatch.setattr(ci_windows_tests, "_kernel32", lambda: kernel32)

    assert ci_windows_tests._join_job() == (kernel32, 123)
    assert kernel32.calls == ["create", "configure", "assign"]
    assert kernel32.limits == (
        ci_windows_tests.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | ci_windows_tests.JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | ci_windows_tests.JOB_OBJECT_LIMIT_JOB_MEMORY,
        ci_windows_tests.MAX_PROCESSES,
        ci_windows_tests.MAX_JOB_MEMORY,
    )
    assert kernel32.closed == []


def test_main_writes_failure_verdict_without_starting_pytest(tmp_path, monkeypatch):
    class _Output:
        value = ""

        def reconfigure(self, **_kwargs):
            pass

        def write(self, text):
            self.value += text
            return len(text)

        def flush(self):
            pass

    output = _Output()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(ci_windows_tests.sys, "argv", ["ci_windows_tests.py"])
    monkeypatch.setattr(ci_windows_tests.sys, "stdout", output)
    monkeypatch.setattr(ci_windows_tests, "_join_job", lambda: None)

    def unexpected_pytest_spawn(*_args, **_kwargs):
        raise AssertionError("pytest must not start without the Job Object")

    monkeypatch.setattr(ci_windows_tests.subprocess, "Popen", unexpected_pytest_spawn)

    assert ci_windows_tests.main() == 1
    assert Path(ci_windows_tests.DONE).read_text(encoding="ascii") == "1"
    assert "pytest not started" in output.value


def test_main_takes_the_verdict_of_a_pytest_that_ended_at_the_cap(tmp_path, monkeypatch):
    """pytest ends during the last report interval: the loop leaves at the cap
    without polling again, so the verdict has to come from one more poll."""
    class _Output:
        value = ""

        def reconfigure(self, **_kwargs):
            pass

        def write(self, text):
            self.value += text
            return len(text)

        def flush(self):
            pass

    clock = [0.0]

    class _Child:
        pid = 789

        def poll(self):
            # Still running until the clock reaches the cap, done from then on.
            return 0 if clock[0] >= ci_windows_tests.CAP_SECONDS else None

    def sleep(seconds):
        clock[0] += seconds

    output = _Output()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(ci_windows_tests.sys, "argv", ["ci_windows_tests.py"])
    monkeypatch.setattr(ci_windows_tests.sys, "stdout", output)
    monkeypatch.setattr(ci_windows_tests, "_join_job", lambda: object())
    monkeypatch.setattr(ci_windows_tests, "_job_pids", lambda _job: [])
    monkeypatch.setattr(ci_windows_tests, "_runner_procs", lambda: "(none)")
    monkeypatch.setattr(ci_windows_tests.subprocess, "Popen", lambda *_args, **_kwargs: _Child())
    monkeypatch.setattr(ci_windows_tests.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(ci_windows_tests.time, "sleep", sleep)
    monkeypatch.setattr(ci_windows_tests.psutil, "virtual_memory", lambda: types.SimpleNamespace(percent=1, total=1 << 30))
    monkeypatch.setattr(ci_windows_tests.psutil, "cpu_percent", lambda: 1)
    monkeypatch.setattr(ci_windows_tests.psutil, "pids", lambda: [])

    assert ci_windows_tests.main() == 0
    assert Path(ci_windows_tests.DONE).read_text() == "0"
    assert "pytest exit: 0" in output.value
    assert "still running at cap" not in output.value
