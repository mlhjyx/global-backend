"""Settings merge / installer tests with synthetic settings files."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import controller  # noqa: E402
import state_machine as sm  # noqa: E402

ROOT = "/global"
SUP_NATIVE = "native-supervisor-1"
SUP_CCD = "local_sup_test"
RUN = "2026-11-17T00:00:00Z"
TOOL_COMMIT = "f" * 40
SECRET_SENTINEL = "SECRET-SENTINEL-DO-NOT-COPY"

BASE_SETTINGS = {
    "permissions": {"allow": ["Bash(ls:*)"]},
    "model": "claude-sonnet-5",
    "env": {"SOME_TOKEN": SECRET_SENTINEL},
    "hooks": {
        "SessionStart": [{"hooks": [{"type": "command", "command": "/bin/true"}]}],
        "Stop": [{"hooks": [{"type": "command", "command": "/bin/echo", "args": ["existing"]}]}],
    },
}


class InstallerHarness(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name) / "state"
        self.dir.mkdir(mode=0o700)
        state = sm.init_state(self.dir, team_id="t", workspace_root=ROOT,
                              roles={"supervisor": SUP_NATIVE}, now=RUN)
        state["binding"]["supervisor_hook_session_id"] = SUP_NATIVE
        state["binding"]["supervisor_ccd_session_id"] = SUP_CCD
        sm._write_atomic(self.dir, state)
        self.settings = Path(self._tmp.name) / "settings.local.json"
        self.settings.write_text(json.dumps(BASE_SETTINGS, indent=2), encoding="utf-8")
        self.settings.chmod(0o600)
        self.install_root = Path(self._tmp.name) / "install"
        self.install_root.mkdir(mode=0o700)
        self.source = Path(controller.__file__).resolve().parent

    def install(self, extra=()):
        return controller.run([
            "install-hooks", "--state-dir", str(self.dir), "--settings", str(self.settings),
            "--tool-commit", TOOL_COMMIT, "--source-dir", str(self.source),
            "--install-root", str(self.install_root), *extra,
        ], stdin_text="", now=RUN)

    def load(self) -> dict:
        return json.loads(self.settings.read_text(encoding="utf-8"))


class InstallTests(InstallerHarness):
    def test_install_preserves_every_other_field_and_adds_one_owned_stop_entry(self):
        code, out, err = self.install()
        self.assertEqual(code, 0)
        data = self.load()
        self.assertEqual(data["permissions"], BASE_SETTINGS["permissions"])
        self.assertEqual(data["model"], BASE_SETTINGS["model"])
        self.assertEqual(data["env"], BASE_SETTINGS["env"])
        self.assertEqual(data["hooks"]["SessionStart"], BASE_SETTINGS["hooks"]["SessionStart"])
        stop = data["hooks"]["Stop"]
        self.assertEqual(stop[0], BASE_SETTINGS["hooks"]["Stop"][0])
        self.assertEqual(len(stop), 2)
        entry = stop[1]["hooks"][0]
        self.assertEqual(entry["command"], "/usr/bin/python3")
        self.assertIn("hook", entry["args"])
        self.assertIn("--supervisor-hook-session-id", entry["args"])
        self.assertIn(SUP_NATIVE, entry["args"])
        self.assertNotIn("disableAllHooks", data)
        self.assertEqual(self.settings.stat().st_mode & 0o777, 0o600)
        installed = self.install_root / TOOL_COMMIT
        for name in ("controller.py", "state_machine.py", "schema-v1.json"):
            self.assertTrue((installed / name).is_file())

    def test_reinstall_is_idempotent(self):
        self.install()
        first = self.load()
        code, out, err = self.install()
        self.assertEqual(code, 0)
        self.assertEqual(self.load(), first)

    def test_concurrent_settings_change_is_refused(self):
        self.install()
        data = self.load()
        data["model"] = "changed-by-someone-else"
        self.settings.write_text(json.dumps(data), encoding="utf-8")
        code, out, err = self.install()
        self.assertNotEqual(code, 0)
        self.assertIn("SETTINGS_CONFLICT", err + out)

    def test_uninstall_removes_only_owned_entries(self):
        self.install()
        code, out, err = controller.run([
            "uninstall-hooks", "--state-dir", str(self.dir), "--settings", str(self.settings),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0)
        data = self.load()
        self.assertEqual(data["hooks"]["Stop"], BASE_SETTINGS["hooks"]["Stop"])
        self.assertEqual(data["hooks"]["SessionStart"], BASE_SETTINGS["hooks"]["SessionStart"])
        self.assertEqual(data["env"], BASE_SETTINGS["env"])
        self.assertFalse((self.dir / "install-receipt.json").exists())

    def test_unknown_tool_commit_is_refused(self):
        code, out, err = controller.run([
            "install-hooks", "--state-dir", str(self.dir), "--settings", str(self.settings),
            "--tool-commit", "short", "--source-dir", str(self.source),
            "--install-root", str(self.install_root),
        ], stdin_text="", now=RUN)
        self.assertNotEqual(code, 0)

    def test_settings_secrets_are_never_copied_into_the_state_dir(self):
        self.install()
        for path in self.dir.iterdir():
            self.assertNotIn(SECRET_SENTINEL,
                             path.read_text(encoding="utf-8", errors="replace")
                             if path.is_file() else "")


if __name__ == "__main__":
    unittest.main()
