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
        root = Path(self._tmp.name)
        self.dir = root / "state"
        self.dir.mkdir(mode=0o700)
        roles_file = root / "roles.json"
        roles_file.write_text(json.dumps({"supervisor": SUP_NATIVE}), encoding="utf-8")
        roles_file.chmod(0o600)
        code, out, err = controller.run([
            "init", "--state-dir", str(self.dir), "--team-id", "t",
            "--workspace-root", ROOT, "--roles-file", str(roles_file),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        self.settings = root / "settings.local.json"
        self.settings.write_text(json.dumps(BASE_SETTINGS, indent=2), encoding="utf-8")
        self.settings.chmod(0o600)
        self.install_root = root / "install"
        self.install_root.mkdir(mode=0o700)
        self.source = Path(controller.__file__).resolve().parent
        # Real one-time probe binding before any install.
        code, out, err = controller.run([
            "prepare-bind", "--state-dir", str(self.dir), "--settings", str(self.settings),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        challenge = json.loads(out)
        payload = {"session_id": SUP_NATIVE, "cwd": ROOT, "hook_event_name": "PostToolUse",
                   "tool_name": "Bash", "tool_input": {"command": challenge["command"]}}
        code, out, err = controller.run([
            "hook", "--event", "PostToolUse", "--probe", "--state-dir", str(self.dir),
        ], stdin_text=json.dumps(payload), now=RUN)
        self.assertEqual((code, out), (0, ""), err)
        code, out, err = controller.run([
            "bind-commit", "--state-dir", str(self.dir),
            "--confirm-session-id", SUP_NATIVE, "--challenge", challenge["nonce"],
            "--settings", str(self.settings), "--supervisor-ccd-session-id", SUP_CCD,
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)

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


class SettingsConcurrencyTests(InstallerHarness):
    def test_foreign_write_between_read_and_save_is_refused_and_preserved(self):
        from unittest import mock
        real_read = controller._read_settings
        calls = {"count": 0}

        def tampering_read(path):
            data, digest, raw = real_read(path)
            calls["count"] += 1
            if calls["count"] == 2:
                # Another writer lands a foreign key after our merge was computed.
                current = json.loads(raw)
                current["foreignKey"] = "kept"
                path.write_text(json.dumps(current), encoding="utf-8")
                path.chmod(0o600)
                return real_read(path)
            return data, digest, raw

        with mock.patch.object(controller, "_read_settings", side_effect=tampering_read):
            code, out, err = self.install()
        self.assertNotEqual(code, 0)
        self.assertIn("SETTINGS_CONFLICT", out + err)
        data = self.load()
        self.assertEqual(data["foreignKey"], "kept")
        owned = [entry for entry in data.get("hooks", {}).get("Stop", [])
                 if any("--state-dir" in hook.get("args", [])
                        for hook in entry.get("hooks", []))]
        self.assertEqual(owned, [])


class CliProcessTests(unittest.TestCase):
    def test_full_cli_chain_runs_through_subprocess_with_revision_protocol(self):
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            state.mkdir(mode=0o700)
            roles = root / "roles.json"
            roles.write_text(json.dumps({
                "supervisor": "sup", "engineering": "eng",
                "technical": "tech", "product": "prod",
            }), encoding="utf-8")
            roles.chmod(0o600)
            script = Path(controller.__file__).resolve()
            base = [sys.executable, "-I", "-B", str(script)]

            def cli(*args, stdin=""):
                return subprocess.run(base + list(args), input=stdin,
                                      capture_output=True, text=True, timeout=120)

            init = cli("init", "--state-dir", str(state), "--team-id", "t",
                       "--workspace-root", ROOT, "--roles-file", str(roles))
            self.assertEqual(init.returncode, 0, init.stderr)
            spec = root / "spec.json"
            spec.write_text(json.dumps({
                "schema_version": "global-team-task/v1", "task_id": "T1",
                "approval_source": "cli test", "scope_digest": "c" * 64,
                "repo": "mlhjyx/global-backend", "branch": "claude/cli",
                "pr": None, "head": "a" * 40, "owner_role": "engineering",
                "writer_role": "engineering", "applicability": {"product": "REQUIRED"},
                "depends_on": [], "required_checks": ["build"],
            }), encoding="utf-8")
            registered = cli("register-task", "--state-dir", str(state), "--input", str(spec),
                             "--expected-revision", "0")
            self.assertEqual(registered.returncode, 0, registered.stderr)
            event_file = root / "event.json"
            event_file.write_text(json.dumps({
                "schema_version": "global-team-event/v1", "event_kind": "ENGINEERING_DELIVERED",
                "task_id": "T1", "task_revision": 1, "head": "a" * 40,
                "issuer_role": "engineering", "issuer_session_id": "eng",
                "receipt_id": "e",
                "payload": {"scope_digest": "c" * 64, "artifact_sha256": "d" * 64,
                            "artifact_relpath": "docs/evidence/x.md", "limitations": []},
            }), encoding="utf-8")
            ingested = cli("ingest", "--state-dir", str(state), "--input", str(event_file),
                           "--expected-revision", "1")
            self.assertEqual(ingested.returncode, 0, ingested.stderr)
            ready = json.loads(ingested.stdout)["ready_action"]
            claimed = cli("claim", "--state-dir", str(state), "--action-id", ready["action_id"],
                          "--actor", "eng", "--expected-revision", "2")
            self.assertEqual(claimed.returncode, 0, claimed.stderr)
            lease = json.loads(claimed.stdout)["lease_id"]
            result = root / "result.json"
            result.write_text(json.dumps({"result": "DONE", "checkpoint": "SENT"}),
                              encoding="utf-8")
            finished = cli("finish", "--state-dir", str(state), "--action-id", ready["action_id"],
                           "--lease-id", lease, "--result-file", str(result),
                           "--expected-revision", "3")
            self.assertEqual(finished.returncode, 0, finished.stderr)
            # The revision protocol is mandatory: parsing succeeds, the process refuses cleanly.
            missing_revision = cli("finish", "--state-dir", str(state),
                                   "--action-id", ready["action_id"], "--lease-id", lease,
                                   "--result-file", str(result))
            self.assertEqual(missing_revision.returncode, 2)
            status = cli("status", "--state-dir", str(state))
            self.assertEqual(status.returncode, 0, status.stderr)
            self.assertEqual(json.loads(status.stdout)["revision"], 4)


def _cli_state(tmp, name="state"):
    directory = Path(tmp) / name
    directory.mkdir(mode=0o700)
    return directory


def _write_roles(root, roles):
    path = root / "roles.json"
    path.write_text(json.dumps(roles), encoding="utf-8")
    path.chmod(0o600)
    return path


def _write_event(root, name, event):
    path = root / name
    path.write_text(json.dumps(event), encoding="utf-8")
    return path


class SupplementCliCycleTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.state = _cli_state(self.root)
        self.roles = {"supervisor": "sup", "engineering": "eng",
                      "technical": "tech", "product": "prod"}
        roles_file = _write_roles(self.root, self.roles)
        code, out, err = controller.run([
            "init", "--state-dir", str(self.state), "--team-id", "t",
            "--workspace-root", ROOT, "--roles-file", str(roles_file),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        spec = self.root / "spec.json"
        spec.write_text(json.dumps({
            "schema_version": "global-team-task/v1", "task_id": "T1",
            "approval_source": "cli cycle", "scope_digest": "c" * 64,
            "repo": "mlhjyx/global-backend", "branch": "claude/cli-cycle",
            "pr": None, "head": "a" * 40, "owner_role": "engineering",
            "writer_role": "engineering", "applicability": {"product": "REQUIRED"},
            "depends_on": [], "required_checks": ["build"],
        }), encoding="utf-8")
        code, out, err = controller.run(["register-task", "--state-dir", str(self.state),
                                         "--input", str(spec), "--expected-revision", "0"],
                                        stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        delivered = _write_event(self.root, "delivered.json", {
            "schema_version": "global-team-event/v1", "event_kind": "ENGINEERING_DELIVERED",
            "task_id": "T1", "task_revision": 1, "head": "a" * 40,
            "issuer_role": "engineering", "issuer_session_id": "eng", "receipt_id": "e1",
            "payload": {"scope_digest": "c" * 64, "artifact_sha256": "d" * 64,
                        "artifact_relpath": "docs/evidence/x.md", "limitations": []},
        })
        code, out, err = controller.run(["ingest", "--state-dir", str(self.state),
                                         "--input", str(delivered), "--expected-revision", "1"],
                                        stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)

    def state_revision(self) -> int:
        return json.loads((self.state / "snapshot.json").read_text(encoding="utf-8"))["revision"]

    def ingest_wait(self, receipt: str, revision: int):
        path = _write_event(self.root, f"{receipt}.json", {
            "schema_version": "global-team-event/v1", "event_kind": "WAIT_OBSERVED",
            "task_id": "T1", "task_revision": 1, "head": "a" * 40,
            "issuer_role": "supervisor", "issuer_session_id": "sup",
            "receipt_id": receipt,
            "payload": {"reason": "WAIT_OWNER", "owner_role": "technical",
                        "evidence": "REVIEW_ACTIVE"},
        })
        return controller.run(["ingest", "--state-dir", str(self.state), "--input", str(path),
                               "--expected-revision", str(revision)], stdin_text="", now=RUN)

    def acknowledge(self):
        code, out, err = controller.run(["next", "--state-dir", str(self.state)],
                                        stdin_text="", now=RUN)
        ready = json.loads(out)
        self.assertEqual(ready["action_kind"], "RECONCILE_STAGE")
        revision = self.state_revision()
        code, out, err = controller.run([
            "claim", "--state-dir", str(self.state), "--action-id", ready["action_id"],
            "--actor", "sup", "--expected-revision", str(revision),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        lease = json.loads(out)["lease_id"]
        result = self.root / "reconciled.json"
        result.write_text(json.dumps({"result": "DONE", "checkpoint": "RECONCILED",
                                      "resolution": "RECONCILED"}), encoding="utf-8")
        code, out, err = controller.run([
            "finish", "--state-dir", str(self.state), "--action-id", ready["action_id"],
            "--lease-id", lease, "--result-file", str(result),
            "--expected-revision", str(self.state_revision()),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        return ready["action_id"]

    def test_wait_cycles_and_duplicate_events_through_cli(self):
        code, out, err = self.ingest_wait("wait_1", self.state_revision())
        self.assertEqual(code, 0, err)
        first_id = self.acknowledge()
        revision_after_first = self.state_revision()
        code, out, err = self.ingest_wait("wait_2", revision_after_first)
        self.assertEqual(code, 0, err)
        code, out, err = controller.run(["next", "--state-dir", str(self.state)],
                                        stdin_text="", now=RUN)
        second = json.loads(out)
        self.assertEqual(second["action_kind"], "RECONCILE_STAGE")
        self.assertNotEqual(second["action_id"], first_id)
        code, out, err = controller.run([
            "claim", "--state-dir", str(self.state), "--action-id", second["action_id"],
            "--actor", "sup", "--expected-revision", str(self.state_revision()),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        generation = json.loads(
            (self.state / "snapshot.json").read_text(encoding="utf-8")
        )["tasks"]["T1"].get("wait_generation")
        self.assertEqual(generation, 2)
        # Replaying WAIT1/WAIT2 with their old revisions stays an idempotent no-op.
        revision_before = self.state_revision()
        code, out, err = self.ingest_wait("wait_1", revision_before - 5)
        self.assertEqual(code, 0, err)
        code, out, err = self.ingest_wait("wait_2", revision_before - 6)
        self.assertEqual(code, 0, err)
        self.assertEqual(self.state_revision(), revision_before)
        # Same event key with a different payload conflicts.
        path = _write_event(self.root, "wait_conflict.json", {
            "schema_version": "global-team-event/v1", "event_kind": "WAIT_OBSERVED",
            "task_id": "T1", "task_revision": 1, "head": "a" * 40,
            "issuer_role": "supervisor", "issuer_session_id": "sup",
            "receipt_id": "wait_2",
            "payload": {"reason": "CI_PENDING", "owner_role": "supervisor",
                        "evidence": "CI_EVENT"},
        })
        code, out, err = controller.run(["ingest", "--state-dir", str(self.state),
                                         "--input", str(path),
                                         "--expected-revision", str(self.state_revision())],
                                        stdin_text="", now=RUN)
        self.assertEqual(code, 3)
        self.assertIn("EVENT_CONFLICT", err)

    def test_expired_claim_cli_persists_and_survives_restart(self):
        import subprocess
        script = Path(controller.__file__).resolve()
        wrapper = ("import json,sys;sys.path.insert(0,sys.argv[1]);import controller;"
                   "code,out,err=controller.run(json.loads(sys.argv[2]),stdin_text=sys.argv[3],"
                   "now=sys.argv[4]);print(json.dumps([code,out,err]))")

        def cli(now, *args, stdin=""):
            proc = subprocess.run(
                [sys.executable, "-I", "-B", "-c", wrapper, str(script.parent),
                 json.dumps(list(args)), stdin, now],
                capture_output=True, text=True, timeout=120,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            code, out, err = json.loads(proc.stdout)
            return code, out, err

        code, out, err = cli(RUN, "next", "--state-dir", str(self.state))
        self.assertEqual(code, 0, err)
        handoff = json.loads(out)
        revision = self.state_revision()
        code, out, err = cli(RUN, "claim", "--state-dir", str(self.state),
                             "--action-id", handoff["action_id"], "--actor", "eng",
                             "--expected-revision", str(revision))
        self.assertEqual(code, 0, err)
        self.assertTrue(json.loads(out)["lease_id"])

        late = "2026-11-17T00:03:00Z"
        current_revision = self.state_revision()
        code, out, err = cli(late, "claim", "--state-dir", str(self.state),
                             "--action-id", handoff["action_id"], "--actor", "eng",
                             "--expected-revision", str(current_revision))
        self.assertEqual(code, 0, err)
        recovered = json.loads(out)
        self.assertEqual(recovered.get("recovery"), "LEASE_EXPIRED")
        self.assertIsNone(recovered.get("lease_id"))
        self.assertEqual(recovered.get("revision"), current_revision + 1)
        self.assertEqual(recovered.get("ready_action", {}).get("action_kind"),
                         "RECONCILE_STAGE")

        # A brand-new process reads the committed normalization (no extra event).
        code, out, err = cli(late, "next", "--state-dir", str(self.state))
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["action_kind"], "RECONCILE_STAGE")
        snapshot = json.loads((self.state / "snapshot.json").read_text(encoding="utf-8"))
        self.assertEqual(snapshot["revision"], current_revision + 1)
        self.assertEqual(snapshot["actions"][handoff["action_id"]]["state"], "UNKNOWN")
        # Repeating the recovery attempt changes nothing further.
        code, out, err = cli(late, "claim", "--state-dir", str(self.state),
                             "--action-id", handoff["action_id"], "--actor", "eng",
                             "--expected-revision", str(current_revision + 1))
        self.assertEqual(code, 3)
        self.assertIn(err.strip(), {"GATE_UNSATISFIED", "ACTION_UNKNOWN"})
        self.assertEqual(self.state_revision(), current_revision + 1)

        # An old snapshot without the new persistent fields fails closed with a stable code.
        snapshot["tasks"]["T1"].pop("wait_generation", None)
        (self.state / "snapshot.json").write_text(json.dumps(snapshot), encoding="utf-8")
        (self.state / "snapshot.json").chmod(0o600)
        code, out, err = cli(late, "status", "--state-dir", str(self.state))
        self.assertEqual(code, 3)
        self.assertIn("STATE_SCHEMA_INCOMPLETE", err)


if __name__ == "__main__":
    unittest.main()
