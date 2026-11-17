"""Hook adapter tests: real bootstrap (init -> probe -> bind -> install), Stop guard
protocol and the one-time probe binding.

All inputs are synthetic stdin payloads against TemporaryDirectory state. No real
settings, sessions, repositories or services are touched.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import controller  # noqa: E402
import state_machine as sm  # noqa: E402

TEAM = "team-test"
ROOT = "/global"
SUP_NATIVE = "native-supervisor-1"
SUP_CCD = "local_sup_test"
WRITER = "local_writer_test"
TECH = "local_tech_test"
PROD = "local_prod_test"
HEAD = "a" * 40
HEAD2 = "b" * 40
SCOPE = "c" * 64
RUN = "2026-11-17T00:00:00Z"
TOOL_COMMIT = "f" * 40

ROLES = {"supervisor": SUP_NATIVE, "engineering": WRITER, "technical": TECH, "product": PROD}


def stop_input(session=SUP_NATIVE, cwd=ROOT, agent_id=None, active=False) -> dict:
    payload = {
        "session_id": session,
        "cwd": cwd,
        "hook_event_name": "Stop",
        "stop_hook_active": active,
        "last_assistant_message": "SHOULD-BE-DROPPED",
    }
    if agent_id is not None:
        payload["agent_id"] = agent_id
        payload["agent_type"] = "subagent"
    return payload


def probe_input(command: str, session=SUP_NATIVE, cwd=ROOT, agent_id=None) -> dict:
    payload = {
        "session_id": session,
        "cwd": cwd,
        "hook_event_name": "PostToolUse",
        "tool_name": "Bash",
        "tool_input": {"command": command},
        "tool_response": {"stdout": "SHOULD-BE-DROPPED"},
    }
    if agent_id:
        payload["agent_id"] = agent_id
        payload["agent_type"] = "subagent"
    return payload


class Harness(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        self.dir = root / "state"
        self.dir.mkdir(mode=0o700)
        roles_file = root / "roles.json"
        roles_file.write_text(json.dumps(ROLES), encoding="utf-8")
        roles_file.chmod(0o600)
        code, out, err = controller.run([
            "init", "--state-dir", str(self.dir), "--team-id", TEAM,
            "--workspace-root", ROOT, "--roles-file", str(roles_file),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        self.settings = root / "settings.local.json"
        self.settings.write_text("{}", encoding="utf-8")
        self.settings.chmod(0o600)
        self.install_root = root / "install"
        self.install_root.mkdir(mode=0o700)
        self.bootstrap()

    def bootstrap(self) -> None:
        code, out, err = controller.run([
            "prepare-bind", "--state-dir", str(self.dir), "--settings", str(self.settings),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        self.challenge = json.loads(out)
        code, out, err = controller.run([
            "hook", "--event", "PostToolUse", "--probe", "--state-dir", str(self.dir),
        ], stdin_text=json.dumps(probe_input(self.challenge["command"])), now=RUN)
        self.assertEqual((code, out), (0, ""), err)
        code, out, err = controller.run([
            "bind-commit", "--state-dir", str(self.dir),
            "--confirm-session-id", SUP_NATIVE, "--challenge", self.challenge["nonce"],
            "--settings", str(self.settings), "--supervisor-ccd-session-id", SUP_CCD,
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        code, out, err = controller.run([
            "install-hooks", "--state-dir", str(self.dir), "--settings", str(self.settings),
            "--tool-commit", TOOL_COMMIT,
            "--source-dir", str(Path(controller.__file__).resolve().parent),
            "--install-root", str(self.install_root),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)

    def spec(self, **overrides) -> dict:
        spec = {
            "schema_version": "global-team-task/v1",
            "task_id": "T1",
            "approval_source": "synthetic approval",
            "scope_digest": SCOPE,
            "repo": "mlhjyx/global-backend",
            "branch": "claude/t1",
            "pr": None,
            "head": HEAD,
            "owner_role": "engineering",
            "writer_role": "engineering",
            "applicability": {"product": "REQUIRED"},
            "depends_on": [],
            "required_checks": ["build"],
        }
        spec.update(overrides)
        return spec

    def persist(self):
        current = sm.load_state(self.dir)
        return sm.locked_update(
            self.dir, expected_revision=current["revision"],
            operation=lambda state: sm.register_task(state, self.spec(), now=RUN), now=RUN,
        )

    def deliver(self, state):
        ev = {
            "schema_version": "global-team-event/v1",
            "event_kind": "ENGINEERING_DELIVERED",
            "task_id": "T1",
            "task_revision": 1,
            "head": HEAD,
            "issuer_role": "engineering",
            "issuer_session_id": WRITER,
            "receipt_id": "e",
            "payload": {
                "scope_digest": SCOPE,
                "artifact_sha256": "d" * 64,
                "artifact_relpath": "docs/evidence/x.md",
                "limitations": [],
            },
        }
        return sm.locked_update(
            self.dir, expected_revision=state["revision"],
            operation=lambda s: sm.reduce_event(s, ev, now=RUN), now=RUN,
        )

    def hook(self, payload: dict, now: str = RUN, extra_args=()):
        return controller.run(
            ["hook", "--event", payload["hook_event_name"], "--state-dir", str(self.dir),
             *extra_args],
            stdin_text=json.dumps(payload), now=now,
        )

    def snapshot_bytes(self) -> bytes:
        return (self.dir / "snapshot.json").read_bytes()


class BootstrapTests(Harness):
    def test_bootstrap_binds_probe_and_enables_the_guard_through_real_paths(self):
        state = sm.load_state(self.dir)
        self.assertEqual(state["binding"]["supervisor_hook_session_id"], SUP_NATIVE)
        self.assertEqual(state["binding"]["supervisor_ccd_session_id"], SUP_CCD)
        self.assertTrue(state["binding"]["capability"]["probe_verified"])
        self.assertTrue(state["binding"]["enabled"])
        settings = json.loads(self.settings.read_text(encoding="utf-8"))
        stop_entries = settings["hooks"]["Stop"]
        self.assertEqual(len(stop_entries), 1)


class FreshInitTests(unittest.TestCase):
    def test_unbound_state_never_blocks_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "state"
            state_dir.mkdir(mode=0o700)
            roles_file = Path(tmp) / "roles.json"
            roles_file.write_text(json.dumps(ROLES), encoding="utf-8")
            roles_file.chmod(0o600)
            code, _, err = controller.run([
                "init", "--state-dir", str(state_dir), "--team-id", TEAM,
                "--workspace-root", ROOT, "--roles-file", str(roles_file),
            ], stdin_text="", now=RUN)
            self.assertEqual(code, 0, err)
            state = sm.load_state(state_dir)
            self.assertFalse(state["binding"]["enabled"])
            code, out, err = controller.run(
                ["hook", "--event", "Stop", "--state-dir", str(state_dir)],
                stdin_text=json.dumps(stop_input()), now=RUN,
            )
            self.assertEqual((code, out), (0, ""))


class IdentityTests(Harness):
    def test_non_supervisor_sessions_are_untouched_noops(self):
        state = self.persist()
        self.deliver(state)
        before = self.snapshot_bytes()
        for payload in (
            stop_input(session="some-other-session"),
            stop_input(agent_id="agent-1"),
            stop_input(cwd="/somewhere/else"),
        ):
            code, out, err = self.hook(payload)
            self.assertEqual((code, out), (0, ""))
        self.assertEqual(self.snapshot_bytes(), before)

    def test_non_supervisor_is_noop_even_with_corrupt_state(self):
        (self.dir / "snapshot.json").write_text("{broken", encoding="utf-8")
        code, out, err = self.hook(stop_input(session="other"))
        self.assertEqual((code, out), (0, ""))


class StopGuardTests(Harness):
    def test_ready_action_blocks_stop_with_a_fixed_reason(self):
        state = self.persist()
        state = self.deliver(state)
        action_id = state["ready_action"]["action_id"]
        code, out, err = self.hook(stop_input())
        self.assertEqual(code, 0)
        response = json.loads(out)
        self.assertEqual(response["decision"], "block")
        self.assertIn("GLOBAL_TEAM_ACTION_REQUIRED", response["reason"])
        self.assertIn(action_id, response["reason"])
        self.assertIn("T1", response["reason"])

    def test_paused_state_allows_stop(self):
        state = self.persist()
        state = self.deliver(state)
        code, out, err = controller.run([
            "pause", "--state-dir", str(self.dir), "--reason", "owner_pause",
            "--by", "supervisor", "--expected-revision", str(state["revision"]),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        code, out, err = self.hook(stop_input())
        self.assertEqual((code, out), (0, ""))

    def test_no_ready_action_and_no_active_task_allows_stop(self):
        self.persist()
        code, out, err = self.hook(stop_input())
        self.assertEqual((code, out), (0, ""))

    def test_repeated_blocks_are_bounded_then_marked_blocked(self):
        state = self.persist()
        state = self.deliver(state)
        for _ in range(3):
            code, out, err = self.hook(stop_input())
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out)["decision"], "block")
        code, out, err = self.hook(stop_input())
        self.assertEqual(code, 0)
        self.assertIn("GLOBAL_TEAM_ACTION_BLOCKED", json.loads(out)["reason"])
        final = sm.load_state(self.dir)
        self.assertTrue(final["guard"].get("blocked"))
        before = self.snapshot_bytes()
        code, out, err = self.hook(stop_input())
        self.assertEqual((code, out), (0, ""))
        self.assertEqual(self.snapshot_bytes(), before)

    def test_missing_state_gives_one_visible_diagnostic_then_stops_blocking(self):
        target = Path(self._tmp.name) / "absent"
        target.mkdir(mode=0o700)
        argv = ["hook", "--event", "Stop", "--state-dir", str(target),
                "--supervisor-hook-session-id", SUP_NATIVE]
        code, out, err = controller.run(argv, stdin_text=json.dumps(stop_input()), now=RUN)
        self.assertEqual(code, 0)
        self.assertIn("GLOBAL_TEAM_STATE_ERROR", json.loads(out)["reason"])
        code, out, err = controller.run(
            ["hook", "--event", "Stop", "--state-dir", str(target),
             "--supervisor-hook-session-id", SUP_NATIVE],
            stdin_text=json.dumps(stop_input(active=True)), now=RUN,
        )
        self.assertEqual((code, out), (0, ""))

    def test_wait_state_blocks_on_a_persisted_reconcile_action_until_acknowledged(self):
        state = self.persist()
        state = self.deliver(state)
        queue_file = Path(self._tmp.name) / "wait.json"
        queue_file.write_text(json.dumps({
            "schema_version": "global-team-event/v1",
            "event_kind": "WAIT_OBSERVED",
            "task_id": "T1",
            "task_revision": 1,
            "head": HEAD,
            "issuer_role": "supervisor",
            "issuer_session_id": SUP_NATIVE,
            "receipt_id": "w1",
            "payload": {"reason": "CI_PENDING", "owner_role": "supervisor",
                        "evidence": "CI_EVENT"},
        }), encoding="utf-8")
        code, out, err = controller.run([
            "ingest", "--state-dir", str(self.dir), "--input", str(queue_file),
            "--expected-revision", str(state["revision"]),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        state = sm.load_state(self.dir)
        self.assertEqual(state["ready_action"]["action_kind"], "RECONCILE_STAGE")

        code, out, _ = self.hook(stop_input())
        self.assertEqual(code, 0)
        self.assertIn("GLOBAL_TEAM_ACTION_REQUIRED", json.loads(out)["reason"])
        code, out, _ = self.hook(stop_input())
        self.assertIn("GLOBAL_TEAM_ACTION_REQUIRED", json.loads(out)["reason"])

        code, out, err = controller.run([
            "next", "--state-dir", str(self.dir),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        ready = json.loads(out)
        self.assertEqual(ready["action_kind"], "RECONCILE_STAGE")

        state = sm.load_state(self.dir)
        code, out, err = controller.run([
            "claim", "--state-dir", str(self.dir), "--action-id", ready["action_id"],
            "--actor", SUP_NATIVE, "--expected-revision", str(state["revision"]),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        lease = json.loads(out)["lease_id"]
        state = sm.load_state(self.dir)
        result_file = Path(self._tmp.name) / "result.json"
        result_file.write_text(json.dumps({
            "result": "DONE", "checkpoint": "RECONCILED", "resolution": "RECONCILED",
        }), encoding="utf-8")
        code, out, err = controller.run([
            "finish", "--state-dir", str(self.dir), "--action-id", ready["action_id"],
            "--lease-id", lease, "--result-file", str(result_file),
            "--expected-revision", str(state["revision"]),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        # Reconciling the wait surfaces the next genuine action: the technical handoff.
        code, out, err = controller.run(["next", "--state-dir", str(self.dir)],
                                        stdin_text="", now=RUN)
        handoff = json.loads(out)
        self.assertEqual(handoff["action_kind"], "HANDOFF")
        self.assertEqual(handoff["target_stage"], "technical")
        state = sm.load_state(self.dir)
        code, out, err = controller.run([
            "claim", "--state-dir", str(self.dir), "--action-id", handoff["action_id"],
            "--actor", WRITER, "--expected-revision", str(state["revision"]),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        lease = json.loads(out)["lease_id"]
        state = sm.load_state(self.dir)
        sent = Path(self._tmp.name) / "sent.json"
        sent.write_text(json.dumps({"result": "DONE", "checkpoint": "SENT"}), encoding="utf-8")
        code, out, err = controller.run([
            "finish", "--state-dir", str(self.dir), "--action-id", handoff["action_id"],
            "--lease-id", lease, "--result-file", str(sent),
            "--expected-revision", str(state["revision"]),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        code, out, err = controller.run(["next", "--state-dir", str(self.dir)],
                                        stdin_text="", now=RUN)
        self.assertEqual(json.loads(out), {"stop": True})
        # A continued (reentry) Stop after the recorded progress may end; a fresh Stop
        # deliberately opens the next bounded re-check cycle instead.
        code, out, _ = self.hook(stop_input(active=True))
        self.assertEqual((code, out), (0, ""))


class ProbeTests(Harness):
    def prepare(self):
        code, out, err = controller.run([
            "prepare-bind", "--state-dir", str(self.dir), "--settings", str(self.settings),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def run_probe_hook(self, payload: dict, now: str = RUN):
        return controller.run(
            ["hook", "--event", "PostToolUse", "--probe", "--state-dir", str(self.dir)],
            stdin_text=json.dumps(payload), now=now,
        )

    def test_prepare_bind_emits_a_harmless_command_and_no_plaintext_nonce(self):
        challenge = self.prepare()
        self.assertIn("GLOBAL-TEAM-BIND-", challenge["command"])
        pending = json.loads((self.dir / "binding-probe-pending.json").read_text(encoding="utf-8"))
        self.assertNotIn(challenge["nonce"], json.dumps(pending))
        self.assertEqual(pending["consumed"], False)
        settings_data = json.loads(self.settings.read_text(encoding="utf-8"))
        self.assertIn("PostToolUse", settings_data["hooks"])

    def test_probe_accepts_only_the_exact_command_once(self):
        challenge = self.prepare()
        (self.dir / "binding-probe.json").unlink(missing_ok=True)
        self.run_probe_hook(probe_input("ls /tmp"))
        self.assertFalse((self.dir / "binding-probe.json").exists())
        self.run_probe_hook(probe_input("printf 'GLOBAL-TEAM-BIND-deadbeef'"))
        self.assertFalse((self.dir / "binding-probe.json").exists())
        self.run_probe_hook(probe_input(challenge["command"], agent_id="sub"))
        self.assertFalse((self.dir / "binding-probe.json").exists())
        self.run_probe_hook(probe_input(challenge["command"]), now="2026-11-17T00:10:00Z")
        self.assertFalse((self.dir / "binding-probe.json").exists())
        code, out, err = self.run_probe_hook(probe_input(challenge["command"]))
        self.assertEqual((code, out), (0, ""))
        proof = json.loads((self.dir / "binding-probe.json").read_text(encoding="utf-8"))
        self.assertEqual(set(proof.keys()), {"session_id", "cwd", "matched_at"})
        self.assertEqual(proof["session_id"], SUP_NATIVE)
        code, out, err = self.run_probe_hook(probe_input(challenge["command"]))
        self.assertEqual((code, out), (0, ""))
        self.assertEqual(json.loads((self.dir / "binding-probe.json").read_text()), proof)

    def test_bind_commit_requires_the_real_proof_and_nonce(self):
        challenge = self.prepare()
        (self.dir / "binding-probe.json").unlink(missing_ok=True)
        code, out, err = controller.run([
            "bind-commit", "--state-dir", str(self.dir), "--confirm-session-id", SUP_NATIVE,
            "--challenge", challenge["nonce"], "--settings", str(self.settings),
        ], stdin_text="", now=RUN)
        self.assertNotEqual(code, 0)
        self.run_probe_hook(probe_input(challenge["command"]))
        code, out, err = controller.run([
            "bind-commit", "--state-dir", str(self.dir), "--confirm-session-id", "wrong-id",
            "--challenge", challenge["nonce"], "--settings", str(self.settings),
        ], stdin_text="", now=RUN)
        self.assertNotEqual(code, 0)
        code, out, err = controller.run([
            "bind-commit", "--state-dir", str(self.dir), "--confirm-session-id", SUP_NATIVE,
            "--challenge", challenge["nonce"], "--settings", str(self.settings),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        state = sm.load_state(self.dir)
        self.assertEqual(state["binding"]["supervisor_hook_session_id"], SUP_NATIVE)
        self.assertTrue(state["binding"]["capability"]["probe_verified"])
        self.assertTrue(state["binding"]["enabled"])
        settings_data = json.loads(self.settings.read_text(encoding="utf-8"))
        probe_entries = [entry for entry in settings_data.get("hooks", {}).get("PostToolUse", [])
                         if any("--probe" in hook.get("args", []) for hook in entry.get("hooks", []))]
        self.assertEqual(probe_entries, [])


class FreshStopCycleTests(Harness):
    def ingest_wait(self, receipt: str):
        state = sm.load_state(self.dir)
        path = Path(self._tmp.name) / f"{receipt}.json"
        path.write_text(json.dumps({
            "schema_version": "global-team-event/v1", "event_kind": "WAIT_OBSERVED",
            "task_id": "T1", "task_revision": 1, "head": HEAD,
            "issuer_role": "supervisor", "issuer_session_id": SUP_NATIVE,
            "receipt_id": receipt,
            "payload": {"reason": "WAIT_OWNER", "owner_role": "technical",
                        "evidence": "REVIEW_ACTIVE"},
        }), encoding="utf-8")
        code, out, err = controller.run([
            "ingest", "--state-dir", str(self.dir), "--input", str(path),
            "--expected-revision", str(state["revision"]),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)

    def acknowledge(self):
        code, out, err = controller.run(["next", "--state-dir", str(self.dir)],
                                        stdin_text="", now=RUN)
        ready = json.loads(out)
        self.assertEqual(ready["action_kind"], "RECONCILE_STAGE")
        revision = sm.load_state(self.dir)["revision"]
        code, out, err = controller.run([
            "claim", "--state-dir", str(self.dir), "--action-id", ready["action_id"],
            "--actor", SUP_NATIVE, "--expected-revision", str(revision),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        lease = json.loads(out)["lease_id"]
        result = Path(self._tmp.name) / "reconciled.json"
        result.write_text(json.dumps({"result": "DONE", "checkpoint": "RECONCILED",
                                      "resolution": "RECONCILED"}), encoding="utf-8")
        code, out, err = controller.run([
            "finish", "--state-dir", str(self.dir), "--action-id", ready["action_id"],
            "--lease-id", lease, "--result-file", str(result),
            "--expected-revision", str(sm.load_state(self.dir)["revision"]),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        return ready["action_id"]

    def test_fresh_stop_and_reentry_use_one_cycle(self):
        state = self.persist()
        self.deliver(state)
        self.ingest_wait("wait_1")
        code, out, _ = self.hook(stop_input(active=False))
        first = json.loads(out)
        self.assertEqual(first["decision"], "block")
        code, out, _ = self.hook(stop_input(active=True))
        reentry = json.loads(out)
        self.assertEqual(reentry["reason"].split()[1], first["reason"].split()[1])
        first_id = self.acknowledge()
        # Reconciling surfaces the technical handoff; send it so the owner wait is real.
        code, out, err = controller.run(["next", "--state-dir", str(self.dir)],
                                        stdin_text="", now=RUN)
        handoff = json.loads(out)
        self.assertEqual(handoff["action_kind"], "HANDOFF")
        code, out, err = controller.run([
            "claim", "--state-dir", str(self.dir), "--action-id", handoff["action_id"],
            "--actor", WRITER, "--expected-revision", str(sm.load_state(self.dir)["revision"]),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        lease = json.loads(out)["lease_id"]
        sent = Path(self._tmp.name) / "sent.json"
        sent.write_text(json.dumps({"result": "DONE", "checkpoint": "SENT"}), encoding="utf-8")
        code, out, err = controller.run([
            "finish", "--state-dir", str(self.dir), "--action-id", handoff["action_id"],
            "--lease-id", lease, "--result-file", str(sent),
            "--expected-revision", str(sm.load_state(self.dir)["revision"]),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        # The continued Stop after the real ACK may end.
        code, out, _ = self.hook(stop_input(active=True))
        self.assertEqual((code, out), (0, ""))
        # The next fresh Stop opens exactly one new cycle with a new action id.
        code, out, _ = self.hook(stop_input(active=False))
        second = json.loads(out)
        self.assertEqual(second["decision"], "block")
        self.assertNotEqual(second["reason"].split()[1], first_id)
        # Claiming that new cycle action succeeds (it is a real ledger entry).
        code, out, err = controller.run(["next", "--state-dir", str(self.dir)],
                                        stdin_text="", now=RUN)
        ready = json.loads(out)
        self.assertEqual(ready["action_kind"], "RECONCILE_STAGE")
        revision = sm.load_state(self.dir)["revision"]
        code, out, err = controller.run([
            "claim", "--state-dir", str(self.dir), "--action-id", ready["action_id"],
            "--actor", SUP_NATIVE, "--expected-revision", str(revision),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        lease = json.loads(out)["lease_id"]
        result = Path(self._tmp.name) / "reconciled2.json"
        result.write_text(json.dumps({"result": "DONE", "checkpoint": "RECONCILED",
                                      "resolution": "RECONCILED"}), encoding="utf-8")
        code, out, err = controller.run([
            "finish", "--state-dir", str(self.dir), "--action-id", ready["action_id"],
            "--lease-id", lease, "--result-file", str(result),
            "--expected-revision", str(sm.load_state(self.dir)["revision"]),
        ], stdin_text="", now=RUN)
        self.assertEqual(code, 0, err)
        # Unhandled repeats of the same cycle are bounded by the original Stop cap.
        code, out, _ = self.hook(stop_input(active=False))
        self.assertEqual(json.loads(out)["decision"], "block")
        for _ in range(2):
            code, out, _ = self.hook(stop_input(active=False))
            self.assertEqual(json.loads(out)["decision"], "block")
        code, out, _ = self.hook(stop_input(active=False))
        self.assertIn("GLOBAL_TEAM_ACTION_BLOCKED", json.loads(out)["reason"])
        self.assertTrue(sm.load_state(self.dir)["guard"].get("blocked"))


if __name__ == "__main__":
    unittest.main()
