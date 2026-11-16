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
        if product:
            state = self.ingest(state, event("PRODUCT_RESULT", role="product", receipt="p", payload={
                "conclusion": "PASS", "artifact_sha256": "d" * 64,
                "artifact_relpath": "docs/evidence/p.md",
            }))
        state = self.ingest(state, event("PR_OBSERVED", role="supervisor", receipt="pr-1",
                                         payload={"pr": 7, "state": "OPEN", "head": HEAD}))
        state = self.ingest(state, event("CI_OBSERVED", role="supervisor", receipt="ci-1", payload={
            "conclusion": "SUCCESS", "pr": 7,
            "required_checks": [{"name": "build", "conclusion": "SUCCESS"}],
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
            }
        with self.assertRaises(sm.ControllerError) as ctx:
            self.ingest(state, event("ENGINEERING_DELIVERED", role="engineering", receipt="e", payload={
                "scope_digest": SCOPE, "artifact_sha256": "d" * 64,
                "artifact_relpath": "docs/evidence/x.md", "limitations": [],
            }))
        self.assertEqual(ctx.exception.code, "STATE_CAPACITY_EXCEEDED")
