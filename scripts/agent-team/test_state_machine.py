"""Unit tests for the handoff controller state machine (stdlib only).

Every test uses TemporaryDirectory and synthetic data. No real settings,
sessions, repositories or services are touched.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import state_machine as sm  # noqa: E402

TEAM = "team-test"
ROOT = "/global"
SUP = "local_sup_test"
WRITER = "local_writer_test"
TECH = "local_tech_test"
PROD = "local_prod_test"
HEAD = "a" * 40
HEAD2 = "b" * 40
SCOPE = "c" * 64
RUN = "2026-11-17T00:00:00Z"


def roles() -> dict:
    return {
        "supervisor": SUP,
        "engineering": WRITER,
        "technical": TECH,
        "product": PROD,
    }


def event(kind: str, task_id: str = "T1", revision: int = 1, head=HEAD, role="technical",
          session=None, receipt="r1", payload=None) -> dict:
    return {
        "schema_version": "global-team-event/v1",
        "event_kind": kind,
        "task_id": task_id,
        "task_revision": revision,
        "head": head,
        "issuer_role": role,
        "issuer_session_id": session if session is not None else {
            "supervisor": SUP, "engineering": WRITER, "technical": TECH, "product": PROD,
        }[role],
        "receipt_id": receipt,
        "payload": payload or {},
    }


def task_spec(**overrides) -> dict:
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


class StateDirMixin(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name) / "state"
        self.dir.mkdir(mode=0o700)

    def init(self) -> dict:
        return sm.init_state(self.dir, team_id=TEAM, workspace_root=ROOT,
                             roles=roles(), now=RUN)

    def register(self, **overrides) -> dict:
        state = self.init()
        return sm.register_task(state, task_spec(**overrides), now=RUN)

    def ingest(self, state: dict, ev: dict) -> dict:
        return sm.reduce_event(state, ev, now=RUN)


class InitTests(StateDirMixin):
    def test_init_creates_owner_only_state_and_refuses_overwrite(self):
        state = self.init()
        self.assertEqual(state["schema_version"], sm.SCHEMA_VERSION)
        self.assertEqual(state["revision"], 0)
        self.assertIsNone(state["ready_action"])
        snapshot = self.dir / "snapshot.json"
        lock = self.dir / "state.lock"
        self.assertTrue(snapshot.is_file())
        self.assertTrue(lock.is_file())
        self.assertEqual(snapshot.stat().st_mode & 0o777, 0o600)
        self.assertEqual(lock.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(sm.ControllerError) as ctx:
            sm.init_state(self.dir, team_id=TEAM, workspace_root=ROOT, roles=roles(), now=RUN)
        self.assertEqual(ctx.exception.code, "STATE_EXISTS")

    def test_missing_state_is_an_error_not_an_auto_init(self):
        with self.assertRaises(sm.ControllerError) as ctx:
            sm.load_state(self.dir)
        self.assertEqual(ctx.exception.code, "STATE_MISSING")

    def test_corrupt_state_is_not_repaired(self):
        self.init()
        (self.dir / "snapshot.json").write_text("{not json", encoding="utf-8")
        with self.assertRaises(sm.ControllerError) as ctx:
            sm.load_state(self.dir)
        self.assertEqual(ctx.exception.code, "STATE_CORRUPT")

    def test_duplicate_json_keys_are_rejected(self):
        self.init()
        (self.dir / "snapshot.json").write_text(
            '{"schema_version":"global-team-controller/v1","revision":0,"revision":1}',
            encoding="utf-8",
        )
        with self.assertRaises(sm.ControllerError) as ctx:
            sm.load_state(self.dir)
        self.assertEqual(ctx.exception.code, "STATE_CORRUPT")

    def test_group_writable_state_dir_is_refused(self):
        os.chmod(self.dir, 0o770)
        with self.assertRaises(sm.ControllerError) as ctx:
            sm.init_state(self.dir, team_id=TEAM, workspace_root=ROOT,
                          roles=roles(), now=RUN)
        self.assertEqual(ctx.exception.code, "STATE_PERMISSIONS")

    def test_symlinked_snapshot_is_refused(self):
        self.init()
        real = self.dir / "snapshot.json"
        outside = Path(self._tmp.name) / "outside.json"
        outside.write_text(real.read_text(encoding="utf-8"), encoding="utf-8")
        real.unlink()
        os.symlink(outside, real)
        with self.assertRaises(sm.ControllerError) as ctx:
            sm.load_state(self.dir)
        self.assertEqual(ctx.exception.code, "STATE_CORRUPT")


class RegisterTaskTests(StateDirMixin):
    def test_register_requires_a_known_repo_and_approval_source(self):
        for overrides, code in (
            ({"repo": "attacker/repo"}, "TASK_INVALID"),
            ({"approval_source": ""}, "TASK_INVALID"),
            ({"scope_digest": "short"}, "TASK_INVALID"),
            ({"head": "abc123"}, "TASK_INVALID"),
        ):
            with self.subTest(code=code, overrides=overrides), \
                    tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp) / "state"
                directory.mkdir(mode=0o700)
                state = sm.init_state(directory, team_id=TEAM, workspace_root=ROOT,
                                      roles=roles(), now=RUN)
                with self.assertRaises(sm.ControllerError) as ctx:
                    sm.register_task(state, task_spec(**overrides), now=RUN)
                self.assertEqual(ctx.exception.code, code)

    def test_register_activates_the_first_task_without_ready_action(self):
        state = self.register()
        self.assertEqual(state["active_task_id"], "T1")
        task = state["tasks"]["T1"]
        self.assertEqual(task["phase"], "IMPLEMENTING")
        self.assertIsNone(state["ready_action"])
        self.assertEqual(task["applicability"]["product"], "REQUIRED")

    def test_registration_is_a_supervisor_only_command_with_revision_guard(self):
        state = self.init()
        with self.assertRaises(sm.ControllerError) as ctx:
            sm.register_task(state, task_spec(), now=RUN, expected_revision=5)
        self.assertEqual(ctx.exception.code, "REVISION_CONFLICT")
        state2 = sm.register_task(state, task_spec(), now=RUN, expected_revision=0)
        self.assertEqual(state2["revision"], 1)

    def test_duplicate_task_id_is_refused(self):
        state = self.register()
        state = sm.register_task(state, task_spec(), now=RUN)
        self.assertEqual(state["revision"], 1)  # idempotent registration no-op

    def test_capacity_of_tasks_is_enforced(self):
        state = self.init()
        for index in range(64):
            state = sm.register_task(
                state,
                task_spec(task_id=f"T{index}", branch=f"claude/t{index}"),
                now=RUN,
            )
        with self.assertRaises(sm.ControllerError) as ctx:
            sm.register_task(state, task_spec(task_id="T64", branch="claude/t64"), now=RUN)
        self.assertEqual(ctx.exception.code, "STATE_CAPACITY_EXCEEDED")


class EventIngestTests(StateDirMixin):
    def delivered(self) -> dict:
        payload = {
            "scope_digest": SCOPE,
            "artifact_sha256": "d" * 64,
            "artifact_relpath": "docs/evidence/x.md",
            "limitations": [],
        }
        return event("ENGINEERING_DELIVERED", role="engineering", receipt="eng-1", payload=payload)

    def test_delivery_opens_technical_handoff(self):
        state = self.register()
        state = self.ingest(state, self.delivered())
        task = state["tasks"]["T1"]
        self.assertEqual(task["gates"]["engineering"]["status"], "DELIVERED")
        self.assertEqual(state["ready_action"]["action_kind"], "HANDOFF")
        self.assertEqual(state["ready_action"]["target_stage"], "technical")

    def test_duplicate_event_is_idempotent_with_old_revision(self):
        state = self.register()
        state = self.ingest(state, self.delivered())
        revision = state["revision"]
        again = sm.reduce_event(state, self.delivered(), now=RUN, expected_revision=0)
        self.assertEqual(again["revision"], revision)
        self.assertEqual(again["ready_action"], state["ready_action"])

    def test_same_event_key_with_different_payload_conflicts(self):
        state = self.register()
        state = self.ingest(state, self.delivered())
        tampered = self.delivered()
        tampered["payload"]["artifact_sha256"] = "e" * 64
        with self.assertRaises(sm.ControllerError) as ctx:
            sm.reduce_event(state, tampered, now=RUN)
        self.assertEqual(ctx.exception.code, "EVENT_CONFLICT")

    def test_unverified_issuer_cannot_satisfy_a_gate(self):
        state = self.register()
        ev = self.delivered()
        ev["issuer_session_id"] = "impostor"
        state = self.ingest(state, ev)
        self.assertEqual(state["tasks"]["T1"]["gates"]["engineering"]["status"], "UNVERIFIED")
        self.assertNotEqual(state["ready_action"]["action_kind"] if state["ready_action"] else None,
                            "HANDOFF")

    def test_self_review_cannot_pass_the_technical_gate(self):
        state = self.register()
        state = self.ingest(state, self.delivered())
        pass_ev = event("TECH_RESULT", role="engineering", receipt="t-1", payload={
            "conclusion": "PASS", "review_mode": "FINAL_COMMIT",
            "artifact_sha256": "d" * 64, "artifact_relpath": "docs/evidence/r.md",
            "accepted_limitations": [],
        })
        state = self.ingest(state, pass_ev)
        self.assertNotEqual(state["tasks"]["T1"]["gates"]["technical"]["status"], "PASS")

    def test_technical_pass_requires_final_commit_mode(self):
        state = self.register()
        state = self.ingest(state, self.delivered())
        ev = event("TECH_RESULT", payload={
            "conclusion": "PASS", "review_mode": "DRAFT",
            "artifact_sha256": "d" * 64, "artifact_relpath": "docs/evidence/r.md",
            "accepted_limitations": [],
        })
        state = self.ingest(state, ev)
        self.assertEqual(state["tasks"]["T1"]["gates"]["technical"]["status"], "UNVERIFIED")

    def test_technical_pass_dispatches_product_handoff(self):
        state = self.register()
        state = self.ingest(state, self.delivered())
        state = self.ingest(state, event("TECH_RESULT", payload={
            "conclusion": "PASS", "review_mode": "FINAL_COMMIT",
            "artifact_sha256": "d" * 64, "artifact_relpath": "docs/evidence/r.md",
            "accepted_limitations": [],
        }))
        self.assertEqual(state["tasks"]["T1"]["gates"]["technical"]["status"], "PASS")
        self.assertEqual(state["ready_action"]["action_kind"], "HANDOFF")
        self.assertEqual(state["ready_action"]["target_stage"], "product")

    def test_product_not_required_only_when_frozen_at_registration(self):
        state = self.register(applicability={"product": "NOT_REQUIRED"})
        state = self.ingest(state, self.delivered())
        state = self.ingest(state, event("TECH_RESULT", payload={
            "conclusion": "PASS", "review_mode": "FINAL_COMMIT",
            "artifact_sha256": "d" * 64, "artifact_relpath": "docs/evidence/r.md",
            "accepted_limitations": [],
        }))
        # No product handoff for a frozen NOT_REQUIRED.
        self.assertEqual(state["tasks"]["T1"]["gates"]["product"]["status"], "NOT_REQUIRED")
        self.assertEqual(state["ready_action"]["action_kind"], "OBSERVE_PR")

    def test_late_product_not_required_cannot_override_required(self):
        state = self.register()
        state = self.ingest(state, self.delivered())
        ev = event("PRODUCT_RESULT", role="product", receipt="p-1", payload={
            "conclusion": "NOT_REQUIRED", "artifact_sha256": "d" * 64,
            "artifact_relpath": "docs/evidence/p.md",
        })
        with self.assertRaises(sm.ControllerError) as ctx:
            self.ingest(state, ev)
        self.assertEqual(ctx.exception.code, "EVENT_INVALID")

    def test_fail_routes_back_to_the_writer(self):
        state = self.register()
        state = self.ingest(state, self.delivered())
        state = self.ingest(state, event("TECH_RESULT", receipt="t-fail", payload={
            "conclusion": "FAIL", "review_mode": "FINAL_COMMIT",
            "artifact_sha256": "d" * 64, "artifact_relpath": "docs/evidence/r.md",
            "accepted_limitations": [], "blockers": ["B1"],
        }))
        self.assertEqual(state["ready_action"]["action_kind"], "HANDOFF")
        self.assertEqual(state["ready_action"]["target_stage"], "rework")

    def test_new_head_invalidates_old_passes(self):
        state = self.register()
        state = self.ingest(state, self.delivered())
        state = self.ingest(state, event("TECH_RESULT", payload={
            "conclusion": "PASS", "review_mode": "FINAL_COMMIT",
            "artifact_sha256": "d" * 64, "artifact_relpath": "docs/evidence/r.md",
            "accepted_limitations": [],
        }))
        state = self.ingest(state, event("HEAD_OBSERVED", role="supervisor",
                                         receipt="h-1", payload={"head": HEAD2, "pr": 7}))
        gates = state["tasks"]["T1"]["gates"]
        self.assertEqual(state["tasks"]["T1"]["head"], HEAD2)
        for gate in ("technical", "product"):
            self.assertNotEqual(gates[gate]["status"], "PASS")
        self.assertEqual(state["ready_action"]["action_kind"], "REQUEST_CHECKPOINT")

    def test_stale_head_event_cannot_override_current_gates(self):
        state = self.register()
        state = self.ingest(state, self.delivered())
        state = self.ingest(state, event("HEAD_OBSERVED", role="supervisor",
                                         receipt="h-1", payload={"head": HEAD2, "pr": 7}))
        # A pass for the old head arriving late stays stale.
        late = self.ingest(state, event("TECH_RESULT", head=HEAD, receipt="t-late", payload={
            "conclusion": "PASS", "review_mode": "FINAL_COMMIT",
            "artifact_sha256": "d" * 64, "artifact_relpath": "docs/evidence/r.md",
            "accepted_limitations": [],
        }))
        self.assertNotEqual(late["tasks"]["T1"]["gates"]["technical"]["status"], "PASS")
        self.assertEqual(late["revision"], state["revision"])

    def test_capacity_of_events_is_enforced(self):
        state = self.register()
        for index in range(4096):
            key = f"k{index}"
            state["events"][key] = {"payload_digest": "0" * 64, "result": "APPLIED"}
        with self.assertRaises(sm.ControllerError) as ctx:
            self.ingest(state, self.delivered())
        self.assertEqual(ctx.exception.code, "STATE_CAPACITY_EXCEEDED")


class MergeGateTests(StateDirMixin):
    def to_merge_ready(self, product=True) -> dict:
        state = self.register(pr=7, required_checks=["build", "smoke"])
        state = self.ingest(state, event("ENGINEERING_DELIVERED", role="engineering", receipt="e", payload={
            "scope_digest": SCOPE, "artifact_sha256": "d" * 64,
            "artifact_relpath": "docs/evidence/x.md", "limitations": [],
        }))
        state = self.ingest(state, event("TECH_RESULT", receipt="t", payload={
            "conclusion": "PASS", "review_mode": "FINAL_COMMIT",
            "artifact_sha256": "d" * 64, "artifact_relpath": "docs/evidence/r.md",
            "accepted_limitations": [],
        }))
        if product:
            state = self.ingest(state, event("PRODUCT_RESULT", role="product", receipt="p", payload={
                "conclusion": "PASS", "artifact_sha256": "d" * 64,
                "artifact_relpath": "docs/evidence/p.md",
            }))
        state = self.ingest(state, event("PR_OBSERVED", role="supervisor", receipt="pr-1",
                                         payload={"pr": 7, "state": "OPEN", "head": HEAD}))
        state = self.ingest(state, event("CI_OBSERVED", role="supervisor", receipt="ci-1", payload={
            "conclusion": "SUCCESS", "pr": 7,
            "required_checks": [
                {"name": "build", "conclusion": "SUCCESS"},
                {"name": "smoke", "conclusion": "SUCCESS"},
            ],
            "observed_at": RUN,
        }))
        return state

    def test_full_gates_produce_a_single_supervisor_merge_action(self):
        state = self.to_merge_ready()
        self.assertEqual(state["tasks"]["T1"]["phase"], "MERGE_READY")
        self.assertEqual(state["ready_action"]["action_kind"], "MERGE_PR")
        self.assertEqual(state["ready_action"]["target_role"], "supervisor")

    def test_pending_or_skipped_required_checks_do_not_open_merge(self):
        state = self.to_merge_ready()
        state2 = self.ingest(state, event("CI_OBSERVED", role="supervisor", receipt="ci-2", payload={
            "conclusion": "SUCCESS", "pr": 7,
            "required_checks": [
                {"name": "build", "conclusion": "SUCCESS"},
                {"name": "smoke", "conclusion": "SKIPPED"},
            ],
            "observed_at": RUN,
        }))
        self.assertNotEqual((state2["ready_action"] or {}).get("action_kind"), "MERGE_PR")

    def test_stale_ci_observation_forces_a_fresh_observe(self):
        state = self.to_merge_ready()
        later = "2026-11-17T00:02:00Z"
        action = sm.compute_ready_action(state, now=later)
        self.assertEqual(action["action_kind"], "OBSERVE_PR")

    def test_merge_claim_sets_lease_and_blocks_second_claim(self):
        state = self.to_merge_ready()
        action_id = state["ready_action"]["action_id"]
        state, claim = sm.claim_action(state, action_id, actor=SUP, expected_revision=state["revision"], now=RUN)
        self.assertEqual(claim["action_id"], action_id)
        self.assertEqual(claim["lease_id"], state["actions"][action_id]["lease_id"])
        with self.assertRaises(sm.ControllerError) as ctx:
            sm.claim_action(state, action_id, actor=SUP, expected_revision=state["revision"], now=RUN)
        self.assertEqual(ctx.exception.code, "CLAIM_CONFLICT")

    def test_unsatisfied_gates_refuse_claim(self):
        state = self.register(pr=7)
        with self.assertRaises(sm.ControllerError) as ctx:
            sm.claim_action(state, "f" * 64, actor=SUP, expected_revision=state["revision"], now=RUN)
        self.assertIn(ctx.exception.code, {"ACTION_UNKNOWN", "GATE_UNSATISFIED"})

    def test_merge_unknown_requires_readback_then_merged_tombstone(self):
        state = self.to_merge_ready()
        action_id = state["ready_action"]["action_id"]
        state, claim = sm.claim_action(state, action_id, actor=SUP, expected_revision=state["revision"], now=RUN)
        state = sm.finish_action(state, action_id, claim["lease_id"], {
            "result": "UNKNOWN", "checkpoint": "MERGE_CALL_EOF",
        }, now=RUN)
        self.assertEqual(state["ready_action"]["action_kind"], "RECONCILE_MERGE")
        state = self.ingest(state, event("PR_OBSERVED", role="supervisor", receipt="pr-merged",
                                         payload={"pr": 7, "state": "MERGED", "head": HEAD,
                                                  "merge_commit": "9" * 40}))
        task = state["tasks"]["T1"]
        self.assertEqual(task["phase"], "COMPLETED")
        self.assertEqual(task["merge"]["state"], "MERGED")
        self.assertIsNone(state["ready_action"])

    def test_merged_tombstone_is_never_merged_twice(self):
        state = self.to_merge_ready()
        action_id = state["ready_action"]["action_id"]
        state, claim = sm.claim_action(state, action_id, actor=SUP, expected_revision=state["revision"], now=RUN)
        state = sm.finish_action(state, action_id, claim["lease_id"], {
            "result": "DONE", "checkpoint": "MERGED", "merged_head": HEAD,
            "merge_commit": "9" * 40,
        }, now=RUN)
        self.assertEqual(state["tasks"]["T1"]["merge"]["state"], "MERGED")
        self.assertIsNone(state["ready_action"])

    def test_external_merge_without_gates_records_outside_gates(self):
        state = self.register(pr=7)
        state = self.ingest(state, event("PR_OBSERVED", role="supervisor", receipt="pr-x",
                                         payload={"pr": 7, "state": "MERGED", "head": HEAD,
                                                  "merge_commit": "9" * 40}))
        task = state["tasks"]["T1"]
        self.assertEqual(task["merge"]["state"], "MERGED_OUTSIDE_RECORDED_GATES")
        self.assertIsNone(state["ready_action"])
        # No auto-close and no next dispatch: the task stays active for supervisor adoption.
        self.assertEqual(state["active_task_id"], "T1")
        self.assertEqual(state["tasks"]["T1"]["phase"], "BLOCKED")

    def test_supervisor_adoption_is_the_only_path_past_outside_gates(self):
        state = self.register(pr=7)
        state = sm.register_task(state, task_spec(
            task_id="T2", branch="claude/t2", depends_on=["T1"]), now=RUN)
        state = self.ingest(state, event("PR_OBSERVED", role="supervisor", receipt="pr-x",
                                         payload={"pr": 7, "state": "MERGED", "head": HEAD,
                                                  "merge_commit": "9" * 40}))
        # Dependencies never treat an outside-gates merge as completed.
        self.assertEqual(state["active_task_id"], "T1")
        state = sm.observe_input(state, {"coordinated": True, "adopt_external_merge": "T1"},
                                 by="supervisor", now=RUN)
        self.assertEqual(state["tasks"]["T1"]["merge"]["state"], "MERGED")
        self.assertEqual(state["active_task_id"], "T2")
        self.assertEqual(state["ready_action"]["action_kind"], "DISPATCH_TASK")


class PauseAndInputTests(StateDirMixin):
    def test_pause_blocks_claims_and_auto_events_cannot_resume(self):
        state = self.to_delivered()
        state = sm.set_paused(state, reason="owner-pause", by="supervisor", now=RUN)
        action = state["ready_action"]
        self.assertIsNone(action)
        with self.assertRaises(sm.ControllerError) as ctx:
            sm.claim_action(state, "f" * 64, actor=SUP, expected_revision=state["revision"], now=RUN)
        self.assertIn(ctx.exception.code, {"PAUSED", "ACTION_UNKNOWN"})
        state = sm.set_resumed(state, by="supervisor", now=RUN)
        self.assertEqual(state["ready_action"]["action_kind"], "HANDOFF")

    def to_delivered(self) -> dict:
        state = self.register()
        return self.ingest(state, event("ENGINEERING_DELIVERED", role="engineering", receipt="e", payload={
            "scope_digest": SCOPE, "artifact_sha256": "d" * 64,
            "artifact_relpath": "docs/evidence/x.md", "limitations": [],
        }))

    def test_uncoordinated_input_blocks_new_side_effects(self):
        state = self.to_delivered()
        handoff_id = state["ready_action"]["action_id"]
        state = sm.mark_input_pending(state, now=RUN)
        self.assertEqual(state["ready_action"]["action_kind"], "RECONCILE_INPUT")
        # A business handoff cannot be claimed while input is uncoordinated.
        with self.assertRaises(sm.ControllerError) as ctx:
            sm.claim_action(state, handoff_id, actor=WRITER,
                            expected_revision=state["revision"], now=RUN)
        self.assertEqual(ctx.exception.code, "INPUT_UNCOORDINATED")
        state = sm.observe_input(state, {"coordinated": True}, by="supervisor", now=RUN)
        self.assertEqual(state["ready_action"]["action_kind"], "HANDOFF")


class TransportAndRetryTests(StateDirMixin):
    def delivered_state(self) -> dict:
        state = self.register()
        return self.ingest(state, event("ENGINEERING_DELIVERED", role="engineering", receipt="e", payload={
            "scope_digest": SCOPE, "artifact_sha256": "d" * 64,
            "artifact_relpath": "docs/evidence/x.md", "limitations": [],
        }))

    def test_transport_failure_retries_same_action_three_times_then_blocks(self):
        state = self.delivered_state()
        action_id = state["ready_action"]["action_id"]
        for attempt in range(1, 4):
            state, claim = sm.claim_action(state, action_id, actor=WRITER,
                                           expected_revision=state["revision"], now=RUN)
            self.assertEqual(state["actions"][action_id]["attempts"], attempt)
            state = sm.finish_action(state, action_id, claim["lease_id"], {
                "result": "FAILED", "checkpoint": "EOF",
            }, now=RUN)
        self.assertEqual(state["actions"][action_id]["state"], "BLOCKED")
        self.assertEqual(state["actions"][action_id]["blocked_reason"], "BLOCKED_TRANSPORT")
        with self.assertRaises(sm.ControllerError):
            sm.claim_action(state, action_id, actor=WRITER,
                            expected_revision=state["revision"], now=RUN)
        # Business rework count is untouched by transport attempts.
        self.assertEqual(state["tasks"]["T1"]["rework_rounds"], 0)

    def test_handoff_ack_and_result_flow(self):
        state = self.delivered_state()
        action_id = state["ready_action"]["action_id"]
        state, claim = sm.claim_action(state, action_id, actor=WRITER,
                                       expected_revision=state["revision"], now=RUN)
        state = sm.finish_action(state, action_id, claim["lease_id"], {
            "result": "DONE", "checkpoint": "SENT",
        }, now=RUN)
        state = self.ingest(state, event("HANDOFF_ACK", role="technical", receipt="ack-1", payload={
            "handoff_action_id": action_id, "status": "ACCEPTED",
        }))
        task = state["tasks"]["T1"]
        self.assertEqual(task["handoffs"][action_id]["accepted"], True)
        # accepted is not a review pass and not an ACK.
        self.assertNotEqual(task["gates"]["technical"]["status"], "PASS")


class DispatchTests(StateDirMixin):
    def completed_with_next(self) -> dict:
        state = self.register(pr=7)
        state = sm.register_task(state, task_spec(
            task_id="T2", branch="claude/t2", owner_role="engineering",
            depends_on=["T1"],
        ), now=RUN)
        state = self.ingest(state, event("ENGINEERING_DELIVERED", role="engineering", receipt="e", payload={
            "scope_digest": SCOPE, "artifact_sha256": "d" * 64,
            "artifact_relpath": "docs/evidence/x.md", "limitations": [],
        }))
        state = self.ingest(state, event("TECH_RESULT", receipt="t", payload={
            "conclusion": "PASS", "review_mode": "FINAL_COMMIT",
            "artifact_sha256": "d" * 64, "artifact_relpath": "docs/evidence/r.md",
            "accepted_limitations": [],
        }))
        state = self.ingest(state, event("PRODUCT_RESULT", role="product", receipt="p", payload={
            "conclusion": "PASS", "artifact_sha256": "d" * 64,
            "artifact_relpath": "docs/evidence/p.md",
        }))
        state = self.ingest(state, event("PR_OBSERVED", role="supervisor", receipt="pr", payload={
            "pr": 7, "state": "OPEN", "head": HEAD,
        }))
        state = self.ingest(state, event("CI_OBSERVED", role="supervisor", receipt="ci", payload={
            "conclusion": "SUCCESS", "pr": 7,
            "required_checks": [{"name": "build", "conclusion": "SUCCESS"}],
            "observed_at": RUN,
        }))
        action_id = state["ready_action"]["action_id"]
        state, claim = sm.claim_action(state, action_id, actor=SUP, expected_revision=state["revision"], now=RUN)
        return sm.finish_action(state, action_id, claim["lease_id"], {
            "result": "DONE", "checkpoint": "MERGED", "merged_head": HEAD,
            "merge_commit": "9" * 40,
        }, now=RUN)

    def test_completed_task_dispatches_the_approved_next_without_asking_user(self):
        state = self.completed_with_next()
        self.assertEqual(state["active_task_id"], "T2")
        self.assertEqual(state["ready_action"]["action_kind"], "DISPATCH_TASK")
        self.assertEqual(state["ready_action"]["task_id"], "T2")
        self.assertEqual(state["ready_action"]["target_role"], "engineering")

    def test_no_next_task_means_a_true_stop(self):
        state = self.register(pr=7)
        state = self.ingest(state, event("ENGINEERING_DELIVERED", role="engineering", receipt="e", payload={
            "scope_digest": SCOPE, "artifact_sha256": "d" * 64,
            "artifact_relpath": "docs/evidence/x.md", "limitations": [],
        }))
        state = self.ingest(state, event("TECH_RESULT", receipt="t", payload={
            "conclusion": "PASS", "review_mode": "FINAL_COMMIT",
            "artifact_sha256": "d" * 64, "artifact_relpath": "docs/evidence/r.md",
            "accepted_limitations": [],
        }))
        state = self.ingest(state, event("PRODUCT_RESULT", role="product", receipt="p", payload={
            "conclusion": "PASS", "artifact_sha256": "d" * 64,
            "artifact_relpath": "docs/evidence/p.md",
        }))
        state = self.ingest(state, event("PR_OBSERVED", role="supervisor", receipt="pr", payload={
            "pr": 7, "state": "OPEN", "head": HEAD,
        }))
        state = self.ingest(state, event("CI_OBSERVED", role="supervisor", receipt="ci", payload={
            "conclusion": "SUCCESS", "pr": 7,
            "required_checks": [{"name": "build", "conclusion": "SUCCESS"}],
            "observed_at": RUN,
        }))
        action_id = state["ready_action"]["action_id"]
        state, claim = sm.claim_action(state, action_id, actor=SUP, expected_revision=state["revision"], now=RUN)
        state = sm.finish_action(state, action_id, claim["lease_id"], {
            "result": "DONE", "checkpoint": "MERGED", "merged_head": HEAD,
            "merge_commit": "9" * 40,
        }, now=RUN)
        self.assertIsNone(state["ready_action"])
        self.assertEqual(sm.compute_ready_action(state, now=RUN), None)


class LockedUpdateTests(StateDirMixin):
    def test_revision_conflict_is_refused(self):
        self.init()
        with self.assertRaises(sm.ControllerError) as ctx:
            sm.locked_update(self.dir, expected_revision=3, operation=lambda state: state, now=RUN)
        self.assertEqual(ctx.exception.code, "REVISION_CONFLICT")

    def test_update_is_atomic_and_revision_bumps(self):
        self.init()
        state = sm.locked_update(
            self.dir, expected_revision=0,
            operation=lambda state: sm.register_task(state, task_spec(), now=RUN),
            now=RUN,
        )
        self.assertEqual(state["revision"], 1)
        self.assertEqual(sm.load_state(self.dir)["revision"], 1)


class RejectionAndReplayTests(StateDirMixin):
    def test_events_with_arbitrary_shell_fields_are_rejected(self):
        state = self.register()
        ev = event("ENGINEERING_DELIVERED", role="engineering", receipt="e", payload={
            "scope_digest": SCOPE, "artifact_sha256": "d" * 64,
            "artifact_relpath": "docs/evidence/x.md", "limitations": [],
            "command": "rm -rf /",
        })
        with self.assertRaises(sm.ControllerError) as ctx:
            self.ingest(state, ev)
        self.assertEqual(ctx.exception.code, "EVENT_INVALID")
        poisoned = event("ENGINEERING_DELIVERED", role="engineering", receipt="e")
        poisoned["shell"] = "curl evil"
        with self.assertRaises(sm.ControllerError):
            self.ingest(state, poisoned)

    def test_desensitized_s1_replay_reaches_exactly_one_merge_action(self):
        fixture = json.loads((Path(__file__).resolve().parent / "fixtures" /
                              "s1-handoff.example.json").read_text(encoding="utf-8"))
        roles = {
            "supervisor": "local_supervisor_example",
            "engineering": "local_writer_example",
            "technical": "local_tech_example",
            "product": "local_product_example",
        }
        state = sm.init_state(self.dir, team_id=TEAM, workspace_root=ROOT,
                              roles=roles, now=RUN)
        state = sm.register_task(state, fixture["task"], now=RUN)
        for index, item in enumerate(fixture["events"]):
            state = sm.reduce_event(state, item, now=f"2026-11-17T00:0{index}:00Z")
        self.assertEqual(state["ready_action"]["action_kind"], "MERGE_PR")
        self.assertEqual(state["ready_action"]["target_role"], "supervisor")
        kinds = [action["action_kind"] for action in state["actions"].values()
                 if action["state"] == "READY"]
        self.assertEqual(kinds, ["MERGE_PR"])


def delivered_event(head=HEAD, receipt="e"):
    return event("ENGINEERING_DELIVERED", role="engineering", head=head, receipt=receipt, payload={
        "scope_digest": SCOPE, "artifact_sha256": "d" * 64,
        "artifact_relpath": "docs/evidence/x.md", "limitations": [],
    })


def tech_event(conclusion="PASS", receipt="t", head=HEAD, blockers=None):
    payload = {
        "conclusion": conclusion, "review_mode": "FINAL_COMMIT",
        "artifact_sha256": "d" * 64, "artifact_relpath": "docs/evidence/r.md",
        "accepted_limitations": [],
    }
    if blockers is not None:
        payload["blockers"] = blockers
    return event("TECH_RESULT", head=head, receipt=receipt, payload=payload)


def ci_event(names=("build",), observed=RUN, receipt="ci"):
    return event("CI_OBSERVED", role="supervisor", receipt=receipt, payload={
        "conclusion": "SUCCESS", "pr": 7,
        "required_checks": [{"name": name, "conclusion": "SUCCESS"} for name in names],
        "observed_at": observed,
    })


def delivered_and_open(state_dir, checks=("build",), pr=7):
    """Register + deliver + technical PASS through pure functions."""
    state = sm.init_state(state_dir, team_id=TEAM, workspace_root=ROOT, roles=roles(), now=RUN)
    state = sm.register_task(state, task_spec(pr=pr, required_checks=list(checks)), now=RUN)
    state = sm.reduce_event(state, delivered_event(), now=RUN)
    state = sm.reduce_event(state, tech_event(), now=RUN)
    return state


class FrozenChecksAndGateTests(StateDirMixin):
    def test_registration_rejects_empty_duplicate_or_oversized_checks(self):
        for checks in ([], ["dup", "dup"], ["x" * 200]):
            with self.subTest(checks=checks), tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp) / "state"
                directory.mkdir(mode=0o700)
                state = sm.init_state(directory, team_id=TEAM, workspace_root=ROOT,
                                      roles=roles(), now=RUN)
                with self.assertRaises(sm.ControllerError) as ctx:
                    sm.register_task(state, task_spec(required_checks=checks), now=RUN)
                self.assertEqual(ctx.exception.code, "TASK_INVALID")

    def test_ci_observation_must_mirror_the_frozen_checks(self):
        state = self.register(pr=7, required_checks=["build", "smoke"])
        state = self.ingest(state, delivered_event())
        state = self.ingest(state, tech_event())
        for checks in (
            [{"name": "build", "conclusion": "SUCCESS"}],
            [{"name": "build", "conclusion": "SUCCESS"},
             {"name": "smoke", "conclusion": "SUCCESS"},
             {"name": "extra", "conclusion": "SUCCESS"}],
            [{"name": "build", "conclusion": "SUCCESS"},
             {"name": "build", "conclusion": "SUCCESS"}],
            [],
        ):
            with self.subTest(checks=checks):
                payload = {"conclusion": "SUCCESS", "pr": 7, "required_checks": checks,
                           "observed_at": RUN}
                with self.assertRaises(sm.ControllerError) as ctx:
                    self.ingest(state, event("CI_OBSERVED", role="supervisor",
                                             receipt=f"ci-{len(checks)}", payload=payload))
                self.assertEqual(ctx.exception.code, "EVENT_INVALID")

    def test_ci_observed_at_cannot_be_washed_by_receipt_time(self):
        state = self.register(pr=7)
        state = self.ingest(state, delivered_event())
        state = self.ingest(state, tech_event())
        state = self.ingest(state, event("PRODUCT_RESULT", role="product", receipt="p", payload={
            "conclusion": "PASS", "artifact_sha256": "d" * 64,
            "artifact_relpath": "docs/evidence/p.md"}))
        late = "2026-11-17T00:05:00Z"
        state = sm.reduce_event(state, event("PR_OBSERVED", role="supervisor", receipt="pr",
                                             payload={"pr": 7, "state": "OPEN", "head": HEAD}),
                                now=late)
        state = sm.reduce_event(state, ci_event(observed=RUN, receipt="ci-old"), now=late)
        stored = state["tasks"]["T1"]["gates"]["ci"]
        self.assertEqual(stored["observed_at"], RUN)
        self.assertEqual(state["ready_action"]["action_kind"], "OBSERVE_PR")

    def test_result_events_require_a_concrete_head(self):
        state = self.register()
        for kind, role in (("ENGINEERING_DELIVERED", "engineering"),
                           ("TECH_RESULT", "technical"),
                           ("PRODUCT_RESULT", "product")):
            with self.subTest(kind=kind):
                payload = {
                    "ENGINEERING_DELIVERED": {
                        "scope_digest": SCOPE, "artifact_sha256": "d" * 64,
                        "artifact_relpath": "docs/evidence/x.md", "limitations": []},
                    "TECH_RESULT": {
                        "conclusion": "PASS", "review_mode": "FINAL_COMMIT",
                        "artifact_sha256": "d" * 64, "artifact_relpath": "docs/evidence/r.md",
                        "accepted_limitations": []},
                    "PRODUCT_RESULT": {
                        "conclusion": "PASS", "artifact_sha256": "d" * 64,
                        "artifact_relpath": "docs/evidence/p.md"},
                }[kind]
                with self.assertRaises(sm.ControllerError) as ctx:
                    self.ingest(state, event(kind, role=role, head=None, receipt="n", payload=payload))
                self.assertEqual(ctx.exception.code, "EVENT_INVALID")

    def test_pass_cannot_carry_blockers_and_fail_must_name_one(self):
        state = self.register()
        state = self.ingest(state, delivered_event())
        with self.assertRaises(sm.ControllerError) as ctx:
            self.ingest(state, tech_event(conclusion="PASS", blockers=["B1"]))
        self.assertEqual(ctx.exception.code, "EVENT_INVALID")
        with self.assertRaises(sm.ControllerError) as ctx:
            self.ingest(state, tech_event(conclusion="FAIL", blockers=[]))
        self.assertEqual(ctx.exception.code, "EVENT_INVALID")


class MergeFreshnessTests(StateDirMixin):
    def test_claim_after_the_freshness_window_is_refused(self):
        self.init()
        sm.locked_update(self.dir, expected_revision=0,
                         operation=lambda state: sm.register_task(
                             state, task_spec(pr=7, required_checks=["build"]), now=RUN), now=RUN)
        state = sm.load_state(self.dir)
        for item in (
            delivered_event(),
            tech_event(),
            event("PRODUCT_RESULT", role="product", receipt="p", payload={
                "conclusion": "PASS", "artifact_sha256": "d" * 64,
                "artifact_relpath": "docs/evidence/p.md"}),
            event("PR_OBSERVED", role="supervisor", receipt="pr",
                  payload={"pr": 7, "state": "OPEN", "head": HEAD}),
            ci_event(),
        ):
            state = sm.locked_update(self.dir, expected_revision=state["revision"],
                                     operation=lambda current, item=item: sm.reduce_event(
                                         current, item, now=RUN), now=RUN)
        action_id = state["ready_action"]["action_id"]
        later = "2026-11-17T00:02:00Z"
        with self.assertRaises(sm.ControllerError) as ctx:
            sm.claim_action(state, action_id, actor=SUP,
                            expected_revision=state["revision"], now=later)
        self.assertEqual(ctx.exception.code, "GATE_UNSATISFIED")
        self.assertEqual(sm.compute_ready_action(state, later)["action_kind"], "OBSERVE_PR")


class ReworkIdentityTests(StateDirMixin):
    def test_fail_then_claim_rework_uses_one_identity(self):
        state = self.register()
        state = self.ingest(state, delivered_event())
        state = self.ingest(state, tech_event(conclusion="FAIL", blockers=["B1"]))
        self.assertEqual(state["tasks"]["T1"]["rework_rounds"], 1)
        self.assertEqual(state["ready_action"]["action_kind"], "HANDOFF")
        self.assertEqual(state["ready_action"]["target_stage"], "rework")
        state, claim = sm.claim_action(state, state["ready_action"]["action_id"], actor=WRITER,
                                       expected_revision=state["revision"], now=RUN)
        self.assertTrue(claim.get("lease_id"))
        state = sm.finish_action(state, claim["action_id"], claim["lease_id"],
                                 {"result": "DONE", "checkpoint": "SENT"}, now=RUN)
        self.assertEqual(state["actions"][claim["action_id"]]["state"], "APPLIED")


class HandoffHeadScopingTests(StateDirMixin):
    def test_new_head_requires_a_fresh_technical_handoff(self):
        state = self.register()
        state = self.ingest(state, delivered_event())
        old_action = state["ready_action"]["action_id"]
        state, claim = sm.claim_action(state, old_action, actor=WRITER,
                                       expected_revision=state["revision"], now=RUN)
        state = sm.finish_action(state, old_action, claim["lease_id"],
                                 {"result": "DONE", "checkpoint": "SENT"}, now=RUN)
        state = self.ingest(state, event("HEAD_OBSERVED", role="supervisor", receipt="h",
                                         payload={"head": HEAD2}))
        state = self.ingest(state, delivered_event(head=HEAD2, receipt="e2"))
        ready = state["ready_action"]
        self.assertEqual(ready["action_kind"], "HANDOFF")
        self.assertEqual(ready["target_stage"], "technical")
        self.assertNotEqual(ready["action_id"], old_action)


class UnknownRecoveryTests(StateDirMixin):
    def unknown_handoff(self):
        state = self.register()
        state = self.ingest(state, delivered_event())
        action_id = state["ready_action"]["action_id"]
        state, claim = sm.claim_action(state, action_id, actor=WRITER,
                                       expected_revision=state["revision"], now=RUN)
        state = sm.finish_action(state, action_id, claim["lease_id"],
                                 {"result": "UNKNOWN", "checkpoint": "EOF"}, now=RUN)
        return state, action_id

    def test_unknown_handoff_exposes_a_readback_action(self):
        state, source = self.unknown_handoff()
        ready = state["ready_action"]
        self.assertEqual(ready["action_kind"], "RECONCILE_STAGE")
        self.assertEqual(ready["target_stage"], "readback")
        self.assertEqual(ready["source_action_id"], source)

    def test_readback_resolutions_recover_the_source_boundedly(self):
        state, source = self.unknown_handoff()
        ready = state["ready_action"]
        state, claim = sm.claim_action(state, ready["action_id"], actor=SUP,
                                       expected_revision=state["revision"], now=RUN)
        state = sm.finish_action(state, ready["action_id"], claim["lease_id"],
                                 {"result": "DONE", "checkpoint": "READBACK",
                                  "resolution": "NOT_DELIVERED"}, now=RUN)
        self.assertEqual(state["actions"][source]["state"], "READY")
        self.assertEqual(state["ready_action"]["action_id"], source)
        state, claim2 = sm.claim_action(state, source, actor=WRITER,
                                        expected_revision=state["revision"], now=RUN)
        self.assertEqual(state["actions"][source]["attempts"], 2)

    def test_expired_lease_is_normalized_on_the_next_operation(self):
        state = self.register()
        state = self.ingest(state, delivered_event())
        action_id = state["ready_action"]["action_id"]
        state, claim = sm.claim_action(state, action_id, actor=WRITER,
                                       expected_revision=state["revision"], now=RUN)
        later = "2026-11-17T00:05:00Z"
        with self.assertRaises(sm.ControllerError) as ctx:
            sm.finish_action(state, action_id, claim["lease_id"],
                             {"result": "DONE"}, now=later)
        self.assertEqual(ctx.exception.code, "LEASE_EXPIRED")
        state = sm.reduce_event(state, event("WAIT_OBSERVED", role="supervisor", receipt="w-late",
                                             payload={"reason": "LEASE_CHECK", "owner_role": "technical",
                                                      "evidence": "OP_CHECK"}),
                                now="2026-11-17T00:04:00Z")
        self.assertEqual(state["actions"][action_id]["state"], "UNKNOWN")
        self.assertEqual(state["actions"][action_id]["checkpoint"], "LEASE_EXPIRED")

    def test_merge_unknown_open_readback_then_retry(self):
        state = self.register(pr=7)
        state = self.ingest(state, delivered_event())
        state = self.ingest(state, tech_event())
        state = self.ingest(state, event("PRODUCT_RESULT", role="product", receipt="p", payload={
            "conclusion": "PASS", "artifact_sha256": "d" * 64,
            "artifact_relpath": "docs/evidence/p.md"}))
        state = self.ingest(state, event("PR_OBSERVED", role="supervisor", receipt="pr",
                                         payload={"pr": 7, "state": "OPEN", "head": HEAD}))
        state = self.ingest(state, ci_event())
        merge_id = state["ready_action"]["action_id"]
        state, claim = sm.claim_action(state, merge_id, actor=SUP,
                                       expected_revision=state["revision"], now=RUN)
        state = sm.finish_action(state, merge_id, claim["lease_id"],
                                 {"result": "UNKNOWN", "checkpoint": "MERGE_EOF"}, now=RUN)
        state = self.ingest(state, event("PR_OBSERVED", role="supervisor", receipt="pr-open-2",
                                         payload={"pr": 7, "state": "OPEN", "head": HEAD}))
        ready = state["ready_action"]
        self.assertEqual(ready["action_kind"], "RECONCILE_MERGE")
        self.assertEqual(ready["source_action_id"], merge_id)
        state, claim2 = sm.claim_action(state, ready["action_id"], actor=SUP,
                                        expected_revision=state["revision"], now=RUN)
        state = sm.finish_action(state, ready["action_id"], claim2["lease_id"],
                                 {"result": "DONE", "checkpoint": "READBACK",
                                  "resolution": "NOT_DELIVERED"}, now=RUN)
        self.assertEqual(state["tasks"]["T1"]["merge"]["state"], "NONE")
        self.assertEqual(state["actions"][merge_id]["state"], "READY")
        # Fresh gates still hold, so the same logical merge action is re-armed once.
        self.assertEqual(state["ready_action"]["action_kind"], "MERGE_PR")
        self.assertEqual(state["ready_action"]["action_id"], merge_id)


class WaitActionTests(StateDirMixin):
    def test_wait_observed_exposes_a_claimable_reconcile_action(self):
        state = self.register()
        state = self.ingest(state, delivered_event())
        state = self.ingest(state, event("WAIT_OBSERVED", role="supervisor", receipt="w",
                                         payload={"reason": "CI_PENDING", "owner_role": "supervisor",
                                                  "evidence": "CI_EVENT"}))
        ready = state["ready_action"]
        self.assertEqual(ready["action_kind"], "RECONCILE_STAGE")
        self.assertEqual(ready["target_stage"], "reconcile")
        state, claim = sm.claim_action(state, ready["action_id"], actor=SUP,
                                       expected_revision=state["revision"], now=RUN)
        state = sm.finish_action(state, ready["action_id"], claim["lease_id"],
                                 {"result": "DONE", "checkpoint": "RECONCILED",
                                  "resolution": "RECONCILED"}, now=RUN)
        self.assertTrue(state["tasks"]["T1"]["wait"]["reconciled"])
        self.assertEqual(state["ready_action"]["action_kind"], "HANDOFF")


def delivered_limited(limitations, head=HEAD, receipt="e"):
    return event("ENGINEERING_DELIVERED", role="engineering", head=head, receipt=receipt, payload={
        "scope_digest": SCOPE, "artifact_sha256": "d" * 64,
        "artifact_relpath": "docs/evidence/x.md", "limitations": list(limitations),
    })


def tech_accepting(accepted, conclusion="PASS", receipt="t", head=HEAD, blockers=None):
    payload = {
        "conclusion": conclusion, "review_mode": "FINAL_COMMIT",
        "artifact_sha256": "d" * 64, "artifact_relpath": "docs/evidence/r.md",
        "accepted_limitations": list(accepted),
    }
    if blockers is not None:
        payload["blockers"] = blockers
    return event("TECH_RESULT", head=head, receipt=receipt, payload=payload)


def product_pass(receipt="p"):
    return event("PRODUCT_RESULT", role="product", receipt=receipt, payload={
        "conclusion": "PASS", "artifact_sha256": "d" * 64,
        "artifact_relpath": "docs/evidence/p.md"})


def pr_open(receipt="pr"):
    return event("PR_OBSERVED", role="supervisor", receipt=receipt,
                 payload={"pr": 7, "state": "OPEN", "head": HEAD})


class ReviewRoundTwoTests(StateDirMixin):
    def fresh(self, name):
        directory = Path(self._tmp.name) / name
        directory.mkdir(mode=0o700)
        state = sm.init_state(directory, team_id=TEAM, workspace_root=ROOT,
                              roles=roles(), now=RUN)
        return directory, state

    def to_everything_except_merge(self, limitations=(), accepted=(), head=HEAD,
                                   ci_observed=RUN, now=RUN, name="flow"):
        _, state = self.fresh(name)
        state = sm.register_task(state, task_spec(pr=7, required_checks=["build"],
                                                  head=head), now=RUN)
        state = self.ingest(state, delivered_limited(limitations, head=head))
        state = self.ingest(state, tech_accepting(accepted, head=head))
        state = self.ingest(state, product_pass())
        state = sm.reduce_event(state, pr_open(), now=now)
        state = sm.reduce_event(state, ci_event(observed=ci_observed), now=now)
        return state

    def test_limitations_require_explicit_same_head_acceptance(self):
        # Unaccepted engineering limitation: no merge action at all.
        state = self.to_everything_except_merge(limitations=["UNVERIFIED_REQUIRED_TEST"],
                                                name="unaccepted")
        ready = sm.compute_ready_action(state, RUN)
        self.assertNotEqual((ready or {}).get("action_kind"), "MERGE_PR")
        # Partial acceptance keeps the gate closed.
        partial = self.to_everything_except_merge(
            limitations=["UNVERIFIED_REQUIRED_TEST", "SECOND_LIMIT"],
            accepted=["UNVERIFIED_REQUIRED_TEST"], name="partial")
        self.assertNotEqual((sm.compute_ready_action(partial, RUN) or {}).get("action_kind"),
                            "MERGE_PR")
        # Full same-head acceptance opens exactly the merge action.
        full = self.to_everything_except_merge(
            limitations=["UNVERIFIED_REQUIRED_TEST"],
            accepted=["UNVERIFIED_REQUIRED_TEST"], name="full")
        self.assertEqual(sm.compute_ready_action(full, RUN)["action_kind"], "MERGE_PR")
        # A new head with an unaccepted limitation never inherits the old acceptance.
        state = self.to_everything_except_merge(
            limitations=["UNVERIFIED_REQUIRED_TEST"],
            accepted=["UNVERIFIED_REQUIRED_TEST"], name="newhead",
        )
        state = self.ingest(state, event("HEAD_OBSERVED", role="supervisor", receipt="h2",
                                         payload={"head": HEAD2}))
        state = self.ingest(state, delivered_limited(["NEW_LIMIT"], head=HEAD2, receipt="e2"))
        state = self.ingest(state, tech_accepting(["UNVERIFIED_REQUIRED_TEST"], head=HEAD2,
                                                  receipt="t2"))
        self.assertNotEqual((sm.compute_ready_action(state, RUN) or {}).get("action_kind"),
                            "MERGE_PR")

    def test_acceptance_never_waives_hard_gates(self):
        base = dict(limitations=["UNVERIFIED_REQUIRED_TEST"],
                    accepted=["UNVERIFIED_REQUIRED_TEST"])
        # Pending/skipped/failing/missing CI still blocks even with full acceptance.
        for observed_status in ("PENDING", "SKIPPED_OR_FAIL", "MISSING"):
            with self.subTest(observed_status=observed_status), \
                    tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp) / "state"
                directory.mkdir(mode=0o700)
                state = sm.init_state(directory, team_id=TEAM, workspace_root=ROOT,
                                      roles=roles(), now=RUN)
                state = sm.register_task(state, task_spec(pr=7, required_checks=["build"]), now=RUN)
                if observed_status == "MISSING":
                    pass
                    state = self.ingest(state, delivered_limited(base["limitations"]))
                    state = self.ingest(state, tech_accepting(base["accepted"]))
                    state = self.ingest(state, product_pass())
                    state = self.ingest(state, pr_open())
                else:
                    conclusion = "FAILURE" if observed_status == "SKIPPED_OR_FAIL" else "PENDING"
                    state = sm.reduce_event(state, delivered_limited(base["limitations"]), now=RUN)
                    state = sm.reduce_event(state, tech_accepting(base["accepted"]), now=RUN)
                    state = sm.reduce_event(state, product_pass(), now=RUN)
                    state = sm.reduce_event(state, pr_open(), now=RUN)
                    payload = {"conclusion": "SUCCESS" if observed_status == "SKIPPED_OR_FAIL"
                               else "PENDING", "pr": 7,
                               "required_checks": [{"name": "build", "conclusion": conclusion}],
                               "observed_at": RUN}
                    state = sm.reduce_event(state, event("CI_OBSERVED", role="supervisor",
                                                         receipt=f"ci-{observed_status}",
                                                         payload=payload), now=RUN)
                if observed_status == "MISSING":
                    state = sm.reduce_event(state, delivered_limited(base["limitations"]), now=RUN)
                    state = sm.reduce_event(state, tech_accepting(base["accepted"]), now=RUN)
                    state = sm.reduce_event(state, product_pass(), now=RUN)
                    state = sm.reduce_event(state, pr_open(), now=RUN)
                self.assertNotEqual(
                    (sm.compute_ready_action(state, RUN) or {}).get("action_kind"), "MERGE_PR")
        # Technical blockers keep a FAIL from being waived by acceptance.
        state = self.register(pr=7, required_checks=["build"])
        state = self.ingest(state, delivered_limited(base["limitations"]))
        state = self.ingest(state, tech_accepting(base["accepted"], conclusion="FAIL",
                                                  blockers=["BLOCK_1"]))
        state = self.ingest(state, product_pass())
        state = self.ingest(state, pr_open())
        state = self.ingest(state, ci_event())
        self.assertNotEqual((sm.compute_ready_action(state, RUN) or {}).get("action_kind"),
                            "MERGE_PR")

    def test_unknown_identity_across_sources_and_attempts(self):
        _, state = self.fresh("identity")
        state = sm.register_task(state, task_spec(), now=RUN)
        task = state["tasks"]["T1"]
        first = sm._make_action(state, task, "RECONCILE_STAGE", "supervisor", "readback", 0, "a" * 64)
        second = sm._make_action(state, task, "RECONCILE_STAGE", "supervisor", "readback", 0, "b" * 64)
        self.assertNotEqual(first["action_id"], second["action_id"])

        state = self.ingest(state, delivered_event())
        source = state["ready_action"]["action_id"]
        state, claim = sm.claim_action(state, source, actor=WRITER,
                                       expected_revision=state["revision"], now=RUN)
        state = sm.finish_action(state, source, claim["lease_id"],
                                 {"result": "UNKNOWN", "checkpoint": "EOF_1"}, now=RUN)
        first_ready = state["ready_action"]
        self.assertEqual(first_ready["source_action_id"], source)
        state, rclaim = sm.claim_action(state, first_ready["action_id"], actor=SUP,
                                        expected_revision=state["revision"], now=RUN)
        state = sm.finish_action(state, first_ready["action_id"], rclaim["lease_id"],
                                 {"result": "DONE", "checkpoint": "CHECKED_1",
                                  "resolution": "NOT_DELIVERED"}, now=RUN)
        state, claim2 = sm.claim_action(state, source, actor=WRITER,
                                        expected_revision=state["revision"], now=RUN)
        self.assertEqual(state["actions"][source]["attempts"], 2)
        state = sm.finish_action(state, source, claim2["lease_id"],
                                 {"result": "UNKNOWN", "checkpoint": "EOF_2"}, now=RUN)
        second_ready = state["ready_action"]
        self.assertEqual(second_ready["action_kind"], "RECONCILE_STAGE")
        self.assertEqual(second_ready["source_action_id"], source)
        self.assertNotEqual(second_ready["action_id"], first_ready["action_id"])
        state, rclaim2 = sm.claim_action(state, second_ready["action_id"], actor=SUP,
                                         expected_revision=state["revision"], now=RUN)
        self.assertTrue(rclaim2.get("lease_id"))
        # Repeating the same resolution report never creates another cycle.
        same = sm.reduce_event(state, event("WAIT_OBSERVED", role="supervisor",
                                            receipt="w-duplicate",
                                            payload={"reason": "WAIT_OWNER",
                                                     "owner_role": "technical",
                                                     "evidence": "REVIEW_ACTIVE"}), now=RUN)
        again = sm.reduce_event(same, event("WAIT_OBSERVED", role="supervisor",
                                            receipt="w-duplicate",
                                            payload={"reason": "WAIT_OWNER",
                                                     "owner_role": "technical",
                                                     "evidence": "REVIEW_ACTIVE"}), now=RUN)
        self.assertEqual(again["revision"], same["revision"])

    def test_recovery_attempt_bounds_and_readback_failure(self):
        _, state = self.fresh("cap")
        state = sm.register_task(state, task_spec(), now=RUN)
        state = self.ingest(state, delivered_event())
        source = state["ready_action"]["action_id"]
        for attempt in (1, 2):
            state, claim = sm.claim_action(state, source, actor=WRITER,
                                           expected_revision=state["revision"], now=RUN)
            self.assertEqual(state["actions"][source]["attempts"], attempt)
            state = sm.finish_action(state, source, claim["lease_id"],
                                     {"result": "UNKNOWN", "checkpoint": "EOF"}, now=RUN)
            ready = state["ready_action"]
            self.assertEqual(state["actions"][ready["action_id"]]["state"], "READY")
            state, rclaim = sm.claim_action(state, ready["action_id"], actor=SUP,
                                            expected_revision=state["revision"], now=RUN)
            state = sm.finish_action(state, ready["action_id"], rclaim["lease_id"],
                                     {"result": "DONE", "checkpoint": "CHECKED",
                                      "resolution": "NOT_DELIVERED"}, now=RUN)
        state, claim = sm.claim_action(state, source, actor=WRITER,
                                       expected_revision=state["revision"], now=RUN)
        self.assertEqual(state["actions"][source]["attempts"], 3)
        state = sm.finish_action(state, source, claim["lease_id"],
                                 {"result": "UNKNOWN", "checkpoint": "EOF"}, now=RUN)
        ready = state["ready_action"]
        state, rclaim = sm.claim_action(state, ready["action_id"], actor=SUP,
                                        expected_revision=state["revision"], now=RUN)
        state = sm.finish_action(state, ready["action_id"], rclaim["lease_id"],
                                 {"result": "DONE", "checkpoint": "CHECKED",
                                  "resolution": "NOT_DELIVERED"}, now=RUN)
        self.assertEqual(state["actions"][source]["state"], "BLOCKED")
        self.assertEqual(state["actions"][source]["blocked_reason"], "BLOCKED_TRANSPORT")
        self.assertIsNone(sm.compute_ready_action(state, RUN))

        # A readback that itself keeps failing is bounded on the same action; it never
        # spawns a readback of the readback.
        _, state = self.fresh("readback-fail")
        state = sm.register_task(state, task_spec(), now=RUN)
        state = self.ingest(state, delivered_event())
        source = state["ready_action"]["action_id"]
        state, claim = sm.claim_action(state, source, actor=WRITER,
                                       expected_revision=state["revision"], now=RUN)
        state = sm.finish_action(state, source, claim["lease_id"],
                                 {"result": "UNKNOWN", "checkpoint": "EOF"}, now=RUN)
        readback_id = state["ready_action"]["action_id"]
        for attempt in (1, 2):
            self.assertEqual((state["ready_action"] or {}).get("action_id"), readback_id)
            self.assertEqual(state["actions"][readback_id]["state"], "READY")
            state, rclaim = sm.claim_action(state, readback_id, actor=SUP,
                                            expected_revision=state["revision"], now=RUN)
            self.assertEqual(state["actions"][readback_id]["attempts"], attempt)
            state = sm.finish_action(state, readback_id, rclaim["lease_id"],
                                     {"result": "FAILED", "checkpoint": "READBACK_EOF"}, now=RUN)
            self.assertEqual(state["ready_action"]["action_id"], readback_id)
        state, rclaim = sm.claim_action(state, readback_id, actor=SUP,
                                        expected_revision=state["revision"], now=RUN)
        state = sm.finish_action(state, readback_id, rclaim["lease_id"],
                                 {"result": "FAILED", "checkpoint": "READBACK_EOF"}, now=RUN)
        self.assertEqual(state["actions"][readback_id]["state"], "BLOCKED")
        self.assertEqual(state["actions"][readback_id]["blocked_reason"], "BLOCKED_RECOVERY")
        self.assertIsNone(sm.compute_ready_action(state, RUN))
        spawned = [action for action in state["actions"].values()
                   if action["action_kind"] == "RECONCILE_STAGE"
                   and action.get("source_action_id") == readback_id]
        self.assertEqual(spawned, [])

    def test_merge_unknown_requires_readback_then_fresh_gates(self):
        state = self.register(pr=7)
        state = self.ingest(state, delivered_event())
        state = self.ingest(state, tech_event())
        state = self.ingest(state, product_pass())
        state = self.ingest(state, pr_open())
        state = self.ingest(state, ci_event())
        merge_id = state["ready_action"]["action_id"]
        state, claim = sm.claim_action(state, merge_id, actor=SUP,
                                       expected_revision=state["revision"], now=RUN)
        state = sm.finish_action(state, merge_id, claim["lease_id"],
                                 {"result": "UNKNOWN", "checkpoint": "MERGE_EOF"}, now=RUN)
        state = self.ingest(state, pr_open(receipt="pr-readback"))
        ready = state["ready_action"]
        self.assertEqual(ready["action_kind"], "RECONCILE_MERGE")
        self.assertEqual(ready["source_action_id"], merge_id)
        state, rclaim = sm.claim_action(state, ready["action_id"], actor=SUP,
                                        expected_revision=state["revision"], now=RUN)
        state = sm.finish_action(state, ready["action_id"], rclaim["lease_id"],
                                 {"result": "DONE", "checkpoint": "READBACK",
                                  "resolution": "NOT_DELIVERED"}, now=RUN)
        # The same logical merge source is re-armed, but only while its gates are fresh.
        self.assertEqual(state["ready_action"]["action_id"], merge_id)
        later = "2026-11-17T00:02:00Z"
        self.assertEqual(sm.compute_ready_action(state, later)["action_kind"], "OBSERVE_PR")
        with self.assertRaises(sm.ControllerError) as ctx:
            sm.claim_action(state, merge_id, actor=SUP,
                            expected_revision=state["revision"], now=later)
        self.assertEqual(ctx.exception.code, "GATE_UNSATISFIED")
        # A resolution string alone never records a merge.
        self.assertEqual(state["tasks"]["T1"]["merge"]["state"], "NONE")


if __name__ == "__main__":
    unittest.main()


WORKER = '''
import json, sys
sys.path.insert(0, sys.argv[1])
import state_machine as sm

mode = sys.argv[2]
state_dir = sys.argv[3]
expected = int(sys.argv[4])
payload = json.loads(open(sys.argv[5], encoding="utf-8").read())

try:
    if mode == "ingest":
        state = sm.locked_update(
            state_dir, expected_revision=expected,
            operation=lambda s: sm.reduce_event(s, payload, now="2026-11-17T00:00:00Z"),
            now="2026-11-17T00:00:00Z",
        )
        print("OK", state["revision"])
    elif mode == "claim":
        state = sm.locked_update(
            state_dir, expected_revision=expected,
            operation=lambda s: sm.claim_action(
                s, payload["action_id"], actor=payload["actor"],
                expected_revision=s["revision"], now="2026-11-17T00:00:00Z",
            )[0],
            now="2026-11-17T00:00:00Z",
        )
        print("OK", state["revision"])
    sys.exit(0)
except sm.ControllerError as error:
    print(error.code)
    sys.exit(3)
'''


class ConcurrencyTests(StateDirMixin):
    def _worker(self, mode: str, expected: int, payload: dict):
        import subprocess
        script = Path(self._tmp.name) / "worker.py"
        script.write_text(WORKER, encoding="utf-8")
        payload_file = Path(self._tmp.name) / f"payload-{mode}.json"
        payload_file.write_text(json.dumps(payload), encoding="utf-8")
        return subprocess.Popen(
            [sys.executable, "-I", "-B", str(script), str(Path(sm.__file__).parent),
             mode, str(self.dir), str(expected), str(payload_file)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )

    def test_two_processes_duplicate_event_only_one_applies(self):
        self.init()
        state = sm.locked_update(
            self.dir, expected_revision=0,
            operation=lambda s: sm.register_task(s, task_spec(), now=RUN), now=RUN,
        )
        revision = state["revision"]
        ev = event("ENGINEERING_DELIVERED", role="engineering", receipt="e", payload={
            "scope_digest": SCOPE, "artifact_sha256": "d" * 64,
            "artifact_relpath": "docs/evidence/x.md", "limitations": [],
        })
        first = self._worker("ingest", revision, ev)
        second = self._worker("ingest", revision, ev)
        out_first, _ = first.communicate(timeout=60)
        out_second, _ = second.communicate(timeout=60)
        codes = sorted((first.returncode, second.returncode))
        self.assertEqual(codes, [0, 3])
        self.assertTrue("REVISION_CONFLICT" in (out_first + out_second))
        final = sm.load_state(self.dir)
        self.assertEqual(final["revision"], revision + 1)
        self.assertEqual(len(final["events"]), 1)

        # A retry of the same event at the current revision is an idempotent no-op.
        import subprocess
        script = Path(self._tmp.name) / "worker.py"
        payload_file = Path(self._tmp.name) / "payload-retry.json"
        payload_file.write_text(json.dumps(ev), encoding="utf-8")
        retry = subprocess.run(
            [sys.executable, "-I", "-B", str(script), str(Path(sm.__file__).parent),
             "ingest", str(self.dir), str(final["revision"]), str(payload_file)],
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(retry.returncode, 0)
        self.assertEqual(sm.load_state(self.dir)["revision"], final["revision"])

    def test_two_processes_claim_only_one_wins(self):
        self.init()
        state = sm.locked_update(
            self.dir, expected_revision=0,
            operation=lambda s: sm.register_task(s, task_spec(), now=RUN), now=RUN,
        )
        delivered = event("ENGINEERING_DELIVERED", role="engineering", receipt="e", payload={
            "scope_digest": SCOPE, "artifact_sha256": "d" * 64,
            "artifact_relpath": "docs/evidence/x.md", "limitations": [],
        })
        state = sm.locked_update(
            self.dir, expected_revision=state["revision"],
            operation=lambda s: sm.reduce_event(s, delivered, now=RUN), now=RUN,
        )
        action_id = state["ready_action"]["action_id"]
        revision = state["revision"]
        payload = {"action_id": action_id, "actor": WRITER}
        first = self._worker("claim", revision, payload)
        second = self._worker("claim", revision, payload)
        out_first, _ = first.communicate(timeout=60)
        out_second, _ = second.communicate(timeout=60)
        self.assertEqual(sorted((first.returncode, second.returncode)), [0, 3])
        self.assertTrue("REVISION_CONFLICT" in (out_first + out_second))
        final = sm.load_state(self.dir)
        action = final["actions"][action_id]
        self.assertEqual(action["state"], "CLAIMED")
        self.assertEqual(action["attempts"], 1)


class FaultInjectionTests(StateDirMixin):
    def test_failed_replace_leaves_previous_state_and_no_temp_files(self):
        from unittest import mock
        state = self.init()
        before = (self.dir / "snapshot.json").read_bytes()
        with mock.patch.object(sm.os, "replace", side_effect=OSError("boom")):
            with self.assertRaises(OSError):
                sm.locked_update(
                    self.dir, expected_revision=state["revision"],
                    operation=lambda s: sm.register_task(s, task_spec(), now=RUN),
                    now=RUN,
                )
        self.assertEqual((self.dir / "snapshot.json").read_bytes(), before)
        leftovers = [p.name for p in self.dir.iterdir() if p.name.startswith(".snapshot.tmp.")]
        self.assertEqual(leftovers, [])

    def test_action_capacity_exceeded_is_reported(self):
        state = self.register()
        for index in range(1024):
            action_id = f"{index:064x}"
            state["actions"][action_id] = {
                "action_id": action_id, "task_id": "T1", "action_kind": "OBSERVE_PR",
                "target_stage": None, "target_role": "supervisor",
                "head": HEAD, "state": "APPLIED", "actor": SUP,
                "lease_id": None, "lease_until": None, "attempts": 1,
                "checkpoint": "DONE", "blocked_reason": None, "round": 0,
                "source_action_id": None,
            }
        with self.assertRaises(sm.ControllerError) as ctx:
            self.ingest(state, event("ENGINEERING_DELIVERED", role="engineering", receipt="e", payload={
                "scope_digest": SCOPE, "artifact_sha256": "d" * 64,
                "artifact_relpath": "docs/evidence/x.md", "limitations": [],
            }))
        self.assertEqual(ctx.exception.code, "STATE_CAPACITY_EXCEEDED")
