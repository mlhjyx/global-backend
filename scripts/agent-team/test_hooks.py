"""Hook adapter tests: identity matrix, Stop guard protocol, probe binding.

All inputs are synthetic stdin payloads against TemporaryDirectory state.
No real settings, sessions, repositories or services are touched.
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
SCOPE = "c" * 64
RUN = "2026-11-17T00:00:00Z"

ROLES = {"supervisor": SUP_NATIVE, "engineering": WRITER, "technical": TECH, "product": PROD}


def stop_input(session=SUP_NATIVE, cwd=ROOT, agent_id=None, active=False, extra=None) -> dict:
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
    if extra:
        payload.update(extra)
    return payload


class Harness(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name) / "state"
        self.dir.mkdir(mode=0o700)
        self.state = sm.init_state(self.dir, team_id=TEAM, workspace_root=ROOT,
                                   roles=ROLES, now=RUN)
        with open(self.dir / "snapshot.json", "r", encoding="utf-8") as handle:
            pass
        state = self.state
        state["binding"]["supervisor_hook_session_id"] = SUP_NATIVE
        state["binding"]["supervisor_ccd_session_id"] = SUP_CCD
        state["binding"]["enabled"] = True
        sm._write_atomic(self.dir, state)

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
        }
        spec.update(overrides)
        return spec

    def persist(self, expected=0):
        return sm.locked_update(
            self.dir, expected_revision=expected,
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

    def hook(self, payload: dict, now: str = RUN):
        return controller.run(
            ["hook", "--event", payload["hook_event_name"], "--state-dir", str(self.dir)],
            stdin_text=json.dumps(payload), now=now,
        )

    def snapshot_bytes(self) -> bytes:
        return (self.dir / "snapshot.json").read_bytes()


class IdentityTests(Harness):
    def test_non_supervisor_sessions_are_untouched_noops(self):
        self.persist()
        self.deliver(self.state if False else sm.load_state(self.dir))
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
        state = sm.set_paused(state, reason="owner-pause", by="supervisor", now=RUN)
        sm._write_atomic(self.dir, state)
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
        # The next Stop ends without another block; no state churn.
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
        active = stop_input(active=True)
        code, out, err = controller.run(
            ["hook", "--event", "Stop", "--state-dir", str(target),
             "--supervisor-hook-session-id", SUP_NATIVE],
            stdin_text=json.dumps(active), now=RUN,
        )
        self.assertEqual((code, out), (0, ""))

    def test_wait_only_state_gets_one_reconcile_stage_block(self):
        state = self.persist()
        state = self.deliver(state)
        action_id = state["ready_action"]["action_id"]
        state, claim = sm.claim_action(state, action_id, actor=WRITER,
                                       expected_revision=state["revision"], now=RUN)
        state = sm.finish_action(state, action_id, claim["lease_id"], {
            "result": "DONE", "checkpoint": "SENT",
        }, now=RUN)
        sm._write_atomic(self.dir, state)
        code, out, err = self.hook(stop_input())
        self.assertEqual(code, 0)
        self.assertIn("GLOBAL_TEAM_RECONCILE_STAGE", json.loads(out)["reason"])
        code, out, err = self.hook(stop_input())
        self.assertEqual((code, out), (0, ""))


class ProbeTests(Harness):
    def prepare(self, settings_path: Path) -> dict:
        code, out, err = controller.run(
            ["prepare-bind", "--state-dir", str(self.dir), "--settings", str(settings_path)],
            stdin_text="", now=RUN,
        )
        self.assertEqual(code, 0)
        return json.loads(out)

    def probe_input(self, command: str, session: str = SUP_NATIVE, agent_id=None) -> dict:
        payload = {
            "session_id": session,
            "cwd": ROOT,
            "hook_event_name": "PostToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": command},
            "tool_response": {"stdout": "SHOULD-BE-DROPPED"},
        }
        if agent_id:
            payload["agent_id"] = agent_id
        return payload

    def run_probe_hook(self, payload: dict, now: str = RUN):
        return controller.run(
            ["hook", "--event", "PostToolUse", "--probe", "--state-dir", str(self.dir)],
            stdin_text=json.dumps(payload), now=now,
        )

    def test_prepare_bind_emits_a_harmless_command_and_no_plaintext_nonce(self):
        settings = Path(self._tmp.name) / "settings.local.json"
        settings.write_text("{}", encoding="utf-8")
        settings.chmod(0o600)
        challenge = self.prepare(settings)
        self.assertIn("GLOBAL-TEAM-BIND-", challenge["command"])
        pending = json.loads((self.dir / "binding-probe-pending.json").read_text(encoding="utf-8"))
        self.assertNotIn(challenge["nonce"], json.dumps(pending))
        self.assertEqual(pending["consumed"], False)
        # The probe entry was appended to the settings file and nothing else changed.
        settings_data = json.loads(settings.read_text(encoding="utf-8"))
        self.assertIn("PostToolUse", settings_data["hooks"])

    def test_probe_accepts_only_the_exact_command_once(self):
        settings = Path(self._tmp.name) / "settings.local.json"
        settings.write_text("{}", encoding="utf-8")
        settings.chmod(0o600)
        challenge = self.prepare(settings)
        # Unrelated Bash command never collects anything.
        self.run_probe_hook(self.probe_input("ls /tmp"))
        self.assertFalse((self.dir / "binding-probe.json").exists())
        # Wrong nonce command is ignored.
        self.run_probe_hook(self.probe_input("printf 'GLOBAL-TEAM-BIND-deadbeef'"))
        self.assertFalse((self.dir / "binding-probe.json").exists())
        # Subagents never bind.
        self.run_probe_hook(self.probe_input(challenge["command"], agent_id="sub"))
        self.assertFalse((self.dir / "binding-probe.json").exists())
        # Expired challenges are refused.
        self.run_probe_hook(self.probe_input(challenge["command"]), now="2026-11-17T00:10:00Z")
        self.assertFalse((self.dir / "binding-probe.json").exists())
        # The exact command under the supervisor session writes a minimal proof.
        code, out, err = self.run_probe_hook(self.probe_input(challenge["command"]))
        self.assertEqual((code, out), (0, ""))
        proof = json.loads((self.dir / "binding-probe.json").read_text(encoding="utf-8"))
        self.assertEqual(set(proof.keys()), {"session_id", "cwd", "matched_at"})
        self.assertEqual(proof["session_id"], SUP_NATIVE)
        # A second identical call is ignored; the proof is not rewritten.
        code, out, err = self.run_probe_hook(self.probe_input(challenge["command"]))
        self.assertEqual((code, out), (0, ""))
        self.assertEqual(json.loads((self.dir / "binding-probe.json").read_text()), proof)

    def test_bind_commit_requires_the_real_proof_and_nonce(self):
        settings = Path(self._tmp.name) / "settings.local.json"
        settings.write_text("{}", encoding="utf-8")
        settings.chmod(0o600)
        challenge = self.prepare(settings)
        # Candidate ids alone are insufficient.
        code, out, err = controller.run(
            ["bind-commit", "--state-dir", str(self.dir), "--confirm-session-id", SUP_NATIVE,
             "--challenge", challenge["nonce"], "--settings", str(settings)],
            stdin_text="", now=RUN,
        )
        self.assertNotEqual(code, 0)
        self.run_probe_hook(self.probe_input(challenge["command"]))
        code, out, err = controller.run(
            ["bind-commit", "--state-dir", str(self.dir), "--confirm-session-id", "wrong-id",
             "--challenge", challenge["nonce"], "--settings", str(settings)],
            stdin_text="", now=RUN,
        )
        self.assertNotEqual(code, 0)
        code, out, err = controller.run(
            ["bind-commit", "--state-dir", str(self.dir), "--confirm-session-id", SUP_NATIVE,
             "--challenge", challenge["nonce"], "--settings", str(settings)],
            stdin_text="", now=RUN,
        )
        self.assertEqual(code, 0)
        state = sm.load_state(self.dir)
        self.assertEqual(state["binding"]["supervisor_hook_session_id"], SUP_NATIVE)
        self.assertTrue(state["binding"]["capability"]["probe_verified"])
        # The temporary PostToolUse entry was removed by bind-commit.
        settings_data = json.loads(settings.read_text(encoding="utf-8"))
        self.assertNotIn("PostToolUse", settings_data.get("hooks", {}))


if __name__ == "__main__":
    unittest.main()
