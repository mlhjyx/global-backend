"""Handoff controller state machine: schema validation, atomic file transactions,
pure reducer, unique ready action and action ledger (Python standard library only).

Design inputs: /home/xin/.claude/plans/global-team-handoff-controller-task-v0.1-2026-11-17.md
Pure functions take an injected `now` string. No network, no shell, no model calls.
"""
from __future__ import annotations

import copy
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import time
from pathlib import Path

SCHEMA_VERSION = "global-team-controller/v1"
TASK_SCHEMA_VERSION = "global-team-task/v1"
EVENT_SCHEMA_VERSION = "global-team-event/v1"

ROLES = ("supervisor", "engineering", "technical", "product", "designer")
ALLOWED_REPOS = ("mlhjyx/global-backend", "mlhjyx/gain-saas")
EVENT_KINDS = (
    "ENGINEERING_DELIVERED", "HANDOFF_ACK", "TECH_RESULT", "PRODUCT_RESULT",
    "CI_OBSERVED", "HEAD_OBSERVED", "PR_OBSERVED", "ACTION_RESULT",
    "TRANSPORT_FAILURE", "WAIT_OBSERVED",
)
ACTION_KINDS = (
    "RECONCILE_INPUT", "RECONCILE_STAGE", "RECONCILE_MERGE", "REQUEST_CHECKPOINT",
    "HANDOFF", "OBSERVE_PR", "MERGE_PR", "DISPATCH_TASK",
)
ACTION_STATES = ("READY", "CLAIMED", "WAITING", "UNKNOWN", "APPLIED", "BLOCKED", "STALE")
RECONCILE_STAGES = ("reconcile", "readback")
CONFIDENCE = ("PASS", "FAIL", "UNKNOWN", "UNVERIFIED", "NOT_REQUIRED", "DELIVERED", "MISSING")
MERGE_STATES = ("NONE", "UNKNOWN", "MERGED", "MERGED_OUTSIDE_RECORDED_GATES")

MAX_TASKS = 64
MAX_ACTIONS = 1024
MAX_EVENTS = 4096
MAX_STATE_BYTES = 4 * 1024 * 1024
MAX_EVENT_BYTES = 64 * 1024
MAX_PAYLOAD_FIELD = 200
LEASE_SECONDS = 120
CI_FRESH_SECONDS = 60
STOP_MAX_ROUNDS = 3

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
HEAD_RE = re.compile(r"^[0-9a-f]{40}$")
SAFE_CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
TASK_ID_RE = re.compile(r"^[A-Z0-9][A-Z0-9_-]{0,63}$")
BRANCH_RE = re.compile(r"^[a-z0-9][a-z0-9._/-]{0,127}$")
ARTIFACT_RE = re.compile(r"^(?!/)(?!.*(?:^|/)\.\.(?:/|$))[A-Za-z0-9._/-]{1,200}$")


class ControllerError(Exception):
    """Stable error with a fixed code; never contains raw input text."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _fail(code: str) -> "ControllerError":
    return ControllerError(code)


def canonical_json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _parse_strict(text: str):
    def pairs(items):
        seen = {}
        for key, value in items:
            if key in seen:
                raise _fail("STATE_CORRUPT")
            seen[key] = value
        return seen

    def reject_constant(_):
        raise _fail("STATE_CORRUPT")

    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=reject_constant)
    except ControllerError:
        raise
    except (ValueError, TypeError):
        raise _fail("STATE_CORRUPT")


def _epoch(iso: str) -> float:
    try:
        parsed = time.strptime(iso, "%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, TypeError):
        raise _fail("TIME_INVALID")
    return time.mktime(parsed) - time.timezone


def _now_plus(now: str, seconds: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(_epoch(now) + seconds))


def _is_safe_code(value: object) -> bool:
    return isinstance(value, str) and SAFE_CODE_RE.match(value) is not None


def _is_hex(value: object, pattern) -> bool:
    return isinstance(value, str) and pattern.match(value) is not None


def _is_int(value: object, minimum: int = 0, maximum: int = 2**53 - 1) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= maximum


def _require_keys(record: dict, keys: tuple, code: str = "STATE_CORRUPT") -> None:
    if not isinstance(record, dict) or sorted(record.keys()) != sorted(keys):
        raise _fail(code)


def _required_keys(record: dict, required: tuple, allowed: tuple | None = None,
                   code: str = "STATE_CORRUPT") -> None:
    allowed = tuple(allowed if allowed is not None else required)
    if not isinstance(record, dict) or any(key not in record for key in required) \
            or any(key not in allowed for key in record):
        raise _fail(code)


# ---------------------------------------------------------------------------
# File transactions
# ---------------------------------------------------------------------------

def _ensure_dir(state_dir: Path) -> None:
    info = os.lstat(state_dir)
    if not stat.S_ISDIR(info.st_mode):
        raise _fail("STATE_PERMISSIONS")
    if info.st_uid != os.geteuid():
        raise _fail("STATE_PERMISSIONS")
    if info.st_mode & 0o077:
        raise _fail("STATE_PERMISSIONS")


def _open_secure(path: Path, flags: int, mode: int):
    return os.open(path, flags | os.O_NOFOLLOW | os.O_CLOEXEC, mode)


def _read_snapshot(state_dir: Path) -> dict:
    snapshot = state_dir / "snapshot.json"
    try:
        info = os.lstat(snapshot)
    except FileNotFoundError:
        raise _fail("STATE_MISSING")
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise _fail("STATE_CORRUPT")
    fd = _open_secure(snapshot, os.O_RDONLY, 0o600)
    try:
        raw = os.read(fd, MAX_STATE_BYTES + 1)
    finally:
        os.close(fd)
    if len(raw) > MAX_STATE_BYTES:
        raise _fail("STATE_CAPACITY_EXCEEDED")
    return _parse_strict(raw.decode("utf-8", "strict"))


def _write_atomic(state_dir: Path, state: dict) -> None:
    payload = canonical_json(state)
    if len(payload) > MAX_STATE_BYTES:
        raise _fail("STATE_CAPACITY_EXCEEDED")
    tmp = state_dir / f".snapshot.tmp.{os.getpid()}.{secrets.token_hex(4)}"
    fd = _open_secure(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.replace(tmp, state_dir / "snapshot.json")
        dir_fd = os.open(state_dir, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _lock(state_dir: Path):
    lock_path = state_dir / "state.lock"
    try:
        info = os.lstat(lock_path)
    except FileNotFoundError:
        fd = _open_secure(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        info = os.lstat(lock_path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise _fail("STATE_PERMISSIONS")
    fd = _open_secure(lock_path, os.O_WRONLY, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


def _unlock(fd: int) -> None:
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def load_state(state_dir) -> dict:
    state_dir = Path(state_dir)
    _ensure_dir(state_dir)
    state = _read_snapshot(state_dir)
    validate_state(state)
    return state


def init_state(state_dir, team_id: str, workspace_root: str, roles: dict, now: str) -> dict:
    state_dir = Path(state_dir)
    if not state_dir.exists():
        state_dir.mkdir(mode=0o700)
    _ensure_dir(state_dir)
    if (state_dir / "snapshot.json").exists():
        raise _fail("STATE_EXISTS")
    if not isinstance(team_id, str) or not team_id or len(team_id) > 64:
        raise _fail("TEAM_INVALID")
    if not isinstance(workspace_root, str) or not workspace_root.startswith("/"):
        raise _fail("TEAM_INVALID")
    clean_roles = {}
    for role, session in roles.items():
        if role not in ROLES or not isinstance(session, str) or not session:
            raise _fail("TEAM_INVALID")
        clean_roles[role] = session
    fd = _lock(state_dir)
    try:
        state = {
            "schema_version": SCHEMA_VERSION,
            "revision": 0,
            "team_id": team_id,
            "workspace_root": workspace_root,
            "created_at": now,
            "binding": {
                "roles": clean_roles,
                "supervisor_ccd_session_id": None,
                "supervisor_hook_session_id": None,
                "enabled": False,
                "capability": {"probe_verified": False, "stop_verified": False},
            },
            "paused": {"active": False, "reason": None, "by": None, "at": None},
            "input_pending": {"active": False, "marked_at": None},
            "active_task_id": None,
            "tasks": {},
            "ready_action": None,
            "actions": {},
            "events": {},
            "guard": {"stop_counts": {}, "round": 0, "blocked": False},
        }
        validate_state(state)
        _write_atomic(state_dir, state)
        return state
    finally:
        _unlock(fd)


def locked_update(state_dir, expected_revision: int, operation, now: str) -> dict:
    state_dir = Path(state_dir)
    _ensure_dir(state_dir)
    fd = _lock(state_dir)
    try:
        state = _read_snapshot(state_dir)
        validate_state(state)
        if not _is_int(expected_revision) or state["revision"] != expected_revision:
            raise _fail("REVISION_CONFLICT")
        updated = operation(state)
        validate_state(updated)
        _write_atomic(state_dir, updated)
        return updated
    finally:
        _unlock(fd)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_state(state: dict) -> None:
    _require_keys(state, (
        "schema_version", "revision", "team_id", "workspace_root", "created_at",
        "binding", "paused", "input_pending", "active_task_id", "tasks",
        "ready_action", "actions", "events", "guard",
    ))
    if state["schema_version"] != SCHEMA_VERSION or not _is_int(state["revision"]):
        raise _fail("STATE_CORRUPT")
    binding = state["binding"]
    _require_keys(binding, ("roles", "supervisor_ccd_session_id", "supervisor_hook_session_id",
                            "enabled", "capability"))
    _require_keys(binding["capability"], ("probe_verified", "stop_verified"))
    paused = state["paused"]
    _require_keys(paused, ("active", "reason", "by", "at"))
    pending = state["input_pending"]
    _require_keys(pending, ("active", "marked_at"))
    guard = state["guard"]
    _require_keys(guard, ("stop_counts", "round", "blocked"))
    if not isinstance(state["tasks"], dict) or len(state["tasks"]) > MAX_TASKS:
        raise _fail("STATE_CORRUPT")
    if not isinstance(state["actions"], dict) or len(state["actions"]) > MAX_ACTIONS:
        raise _fail("STATE_CORRUPT")
    if not isinstance(state["events"], dict) or len(state["events"]) > MAX_EVENTS:
        raise _fail("STATE_CORRUPT")
    if state["active_task_id"] is not None and state["active_task_id"] not in state["tasks"]:
        raise _fail("STATE_CORRUPT")
    for task in state["tasks"].values():
        _validate_task(task)
    for action in state["actions"].values():
        _validate_action(action)
    for entry in state["events"].values():
        _require_keys(entry, ("payload_digest", "result"))
        if not _is_hex(entry["payload_digest"], SHA256_RE) or not _is_safe_code(entry["result"]):
            raise _fail("STATE_CORRUPT")


def _validate_task(task: dict) -> None:
    _require_keys(task, (
        "task_id", "approval_source", "scope_digest", "task_revision", "repo", "branch",
        "pr", "head", "owner_role", "writer_role", "applicability", "depends_on",
        "required_checks", "seq", "dispatched", "awaiting_checkpoint", "gates",
        "merge", "handoffs", "wait", "rework_rounds", "phase",
    ))
    if not TASK_ID_RE.match(task["task_id"]):
        raise _fail("STATE_CORRUPT")
    if not _is_hex(task["scope_digest"], SHA256_RE):
        raise _fail("STATE_CORRUPT")
    if task["repo"] not in ALLOWED_REPOS or not isinstance(task["branch"], str):
        raise _fail("STATE_CORRUPT")
    if task["head"] is not None and not _is_hex(task["head"], HEAD_RE):
        raise _fail("STATE_CORRUPT")
    gates = task["gates"]
    _require_keys(gates, ("engineering", "technical", "product", "ci"))
    if not isinstance(task["merge"], dict) or task["merge"].get("state") not in MERGE_STATES:
        raise _fail("STATE_CORRUPT")


def _validate_action(action: dict) -> None:
    _require_keys(action, (
        "action_id", "task_id", "action_kind", "target_stage", "target_role", "head",
        "state", "actor", "lease_id", "lease_until", "attempts", "checkpoint",
        "blocked_reason", "round", "source_action_id",
    ))
    if not _is_hex(action["action_id"], SHA256_RE) or action["action_kind"] not in ACTION_KINDS \
            or action["state"] not in ACTION_STATES or action["target_role"] not in ROLES:
        raise _fail("STATE_CORRUPT")
    if not _is_int(action["attempts"], 0, 3) or not _is_int(action["round"], 0, 4096):
        raise _fail("STATE_CORRUPT")
    if action["lease_id"] is not None and not _is_safe_code(action["lease_id"]):
        raise _fail("STATE_CORRUPT")
    source = action["source_action_id"]
    if source is not None and not _is_hex(source, SHA256_RE):
        raise _fail("STATE_CORRUPT")
    if action["action_kind"] == "RECONCILE_STAGE" \
            and action["target_stage"] not in RECONCILE_STAGES:
        raise _fail("STATE_CORRUPT")


def validate_event(event: dict, state: dict) -> None:
    _require_keys(event, (
        "schema_version", "event_kind", "task_id", "task_revision", "head",
        "issuer_role", "issuer_session_id", "receipt_id", "payload",
    ), code="EVENT_INVALID")
    if event["schema_version"] != EVENT_SCHEMA_VERSION:
        raise _fail("EVENT_INVALID")
    if event["event_kind"] not in EVENT_KINDS:
        raise _fail("EVENT_INVALID")
    if not isinstance(event["task_id"], str) or not TASK_ID_RE.match(event["task_id"]):
        raise _fail("EVENT_INVALID")
    if not _is_int(event["task_revision"], 1):
        raise _fail("EVENT_INVALID")
    if event["head"] is not None and not _is_hex(event["head"], HEAD_RE):
        raise _fail("EVENT_INVALID")
    if event["issuer_role"] not in ROLES:
        raise _fail("EVENT_INVALID")
    if not isinstance(event["issuer_session_id"], str) or not event["issuer_session_id"]:
        raise _fail("EVENT_INVALID")
    if not isinstance(event["receipt_id"], str) or not SAFE_CODE_RE.match(event["receipt_id"]):
        raise _fail("EVENT_INVALID")
    payload = event["payload"]
    if not isinstance(payload, dict) or len(canonical_json(payload)) > MAX_EVENT_BYTES:
        raise _fail("EVENT_INVALID")


def event_digest(event: dict) -> str:
    return sha256_hex(canonical_json(event["payload"]))


def event_key(state: dict, event: dict) -> str:
    identity = [
        state["team_id"], event["task_id"], str(event["task_revision"]),
        event["event_kind"], event["head"] or "", event["issuer_role"], event["receipt_id"],
    ]
    return sha256_hex(canonical_json(identity))


# ---------------------------------------------------------------------------
# Reducer helpers
# ---------------------------------------------------------------------------

def _bump(state: dict) -> dict:
    state = copy.deepcopy(state)
    state["revision"] += 1
    _recompute(state)
    return state


def _verified(state: dict, event: dict) -> bool:
    return state["binding"]["roles"].get(event["issuer_role"]) == event["issuer_session_id"]


def _remember(state: dict, key: str, digest: str, result: str) -> dict:
    state = copy.deepcopy(state)
    state["events"][key] = {"payload_digest": digest, "result": result}
    return state


def _empty_gates(applicability: dict) -> dict:
    return {
        "engineering": {"status": "MISSING", "head": None, "receipt_id": None,
                        "artifact_sha256": None, "artifact_relpath": None, "limitations": []},
        "technical": {"status": "UNKNOWN", "head": None, "receipt_id": None, "review_mode": None,
                      "artifact_sha256": None, "artifact_relpath": None, "blockers": [],
                      "accepted_limitations": []},
        "product": {"status": "NOT_REQUIRED" if applicability.get("product") == "NOT_REQUIRED"
                    else "UNKNOWN",
                    "head": None, "receipt_id": None, "artifact_sha256": None,
                    "artifact_relpath": None},
        "ci": {"status": "UNKNOWN", "head": None, "pr": None, "observed_at": None,
               "required_checks": []},
    }


def _validate_spec(spec: dict) -> dict:
    _require_keys(spec, (
        "schema_version", "task_id", "approval_source", "scope_digest", "repo", "branch",
        "pr", "head", "owner_role", "writer_role", "applicability", "depends_on",
        "required_checks",
    ), code="TASK_INVALID")
    if spec["schema_version"] != TASK_SCHEMA_VERSION:
        raise _fail("TASK_INVALID")
    if not isinstance(spec["task_id"], str) or not TASK_ID_RE.match(spec["task_id"]):
        raise _fail("TASK_INVALID")
    if not isinstance(spec["approval_source"], str) or not spec["approval_source"] \
            or len(spec["approval_source"]) > MAX_PAYLOAD_FIELD:
        raise _fail("TASK_INVALID")
    if not _is_hex(spec["scope_digest"], SHA256_RE):
        raise _fail("TASK_INVALID")
    if spec["repo"] not in ALLOWED_REPOS:
        raise _fail("TASK_INVALID")
    branch = spec["branch"]
    if not isinstance(branch, str) or not BRANCH_RE.match(branch) or ".." in branch:
        raise _fail("TASK_INVALID")
    if spec["pr"] is not None and not _is_int(spec["pr"], 1):
        raise _fail("TASK_INVALID")
    if spec["head"] is not None and not _is_hex(spec["head"], HEAD_RE):
        raise _fail("TASK_INVALID")
    if spec["owner_role"] not in ROLES or spec["writer_role"] not in ROLES:
        raise _fail("TASK_INVALID")
    applicability = spec["applicability"]
    _require_keys(applicability, ("product",), code="TASK_INVALID")
    if applicability["product"] not in ("REQUIRED", "NOT_REQUIRED"):
        raise _fail("TASK_INVALID")
    checks = spec["required_checks"]
    if not isinstance(checks, list) or not 1 <= len(checks) <= 64 \
            or any(not isinstance(name, str) or not name or len(name) > 128 for name in checks) \
            or len(set(checks)) != len(checks):
        raise _fail("TASK_INVALID")
    deps = spec["depends_on"]
    if not isinstance(deps, list) or any(
            not isinstance(dep, str) or not TASK_ID_RE.match(dep) or dep == spec["task_id"]
            for dep in deps):
        raise _fail("TASK_INVALID")
    return spec


def register_task(state: dict, spec: dict, now: str, expected_revision: int | None = None) -> dict:
    spec = _validate_spec(spec)
    if expected_revision is not None and state["revision"] != expected_revision:
        raise _fail("REVISION_CONFLICT")
    task_id = spec["task_id"]
    if task_id in state["tasks"]:
        existing = state["tasks"][task_id]
        if existing["scope_digest"] == spec["scope_digest"] and existing["repo"] == spec["repo"] \
                and existing["branch"] == spec["branch"]:
            return state
        raise _fail("TASK_CONFLICT")
    for dep in spec["depends_on"]:
        if dep not in state["tasks"]:
            raise _fail("TASK_INVALID")
    if len(state["tasks"]) >= MAX_TASKS:
        raise _fail("STATE_CAPACITY_EXCEEDED")
    state = copy.deepcopy(state)
    state["tasks"][task_id] = {
        "task_id": task_id,
        "approval_source": spec["approval_source"],
        "scope_digest": spec["scope_digest"],
        "task_revision": 1,
        "repo": spec["repo"],
        "branch": spec["branch"],
        "pr": spec["pr"],
        "head": spec["head"],
        "owner_role": spec["owner_role"],
        "writer_role": spec["writer_role"],
        "applicability": dict(spec["applicability"]),
        "depends_on": list(spec["depends_on"]),
        "required_checks": list(spec["required_checks"]),
        "seq": len(state["tasks"]),
        "dispatched": True,
        "awaiting_checkpoint": False,
        "gates": _empty_gates(spec["applicability"]),
        "merge": {"state": "NONE", "merge_commit": None, "head": None, "pr_state": None},
        "handoffs": {},
        "wait": None,
        "rework_rounds": 0,
        "phase": "IMPLEMENTING",
    }
    if state["active_task_id"] is None:
        state["active_task_id"] = task_id
        state["tasks"][task_id]["dispatched"] = True
    return _bump(state)


# ---------------------------------------------------------------------------
# Ready action computation (pure)
# ---------------------------------------------------------------------------

def _artifact_ok(payload: dict, code: str) -> tuple[str, str]:
    sha = payload.get("artifact_sha256")
    relpath = payload.get("artifact_relpath")
    if not _is_hex(sha, SHA256_RE):
        raise _fail(code)
    if not isinstance(relpath, str) or not ARTIFACT_RE.match(relpath):
        raise _fail(code)
    return sha, relpath


def _limitations_ok(value: object, code: str) -> list:
    if not isinstance(value, list) or len(value) > 16 or any(not _is_safe_code(item) for item in value):
        raise _fail(code)
    return list(value)


def _gates_satisfied(task: dict) -> bool:
    head = task["head"]
    if head is None:
        return False
    gates = task["gates"]
    if gates["engineering"]["status"] != "DELIVERED" or gates["engineering"]["head"] != head:
        return False
    technical = gates["technical"]
    if technical["status"] != "PASS" or technical["head"] != head \
            or technical["review_mode"] != "FINAL_COMMIT" or technical["blockers"]:
        return False
    product = gates["product"]
    if task["applicability"]["product"] == "NOT_REQUIRED":
        if product["status"] != "NOT_REQUIRED":
            return False
    elif product["status"] != "PASS" or product["head"] != head:
        return False
    ci = gates["ci"]
    return (ci["status"] == "SUCCESS" and ci["head"] == head and ci["pr"] == task["pr"]
            and ci["observed_at"] is not None
            and sorted(check["name"] for check in ci["required_checks"])
            == sorted(task["required_checks"])
            and all(check["conclusion"] == "SUCCESS" for check in ci["required_checks"]))


def _open_handoff(state: dict, task: dict, target: str) -> dict | None:
    for action in state["actions"].values():
        if action["task_id"] == task["task_id"] and action["action_kind"] == "HANDOFF" \
                and action["target_stage"] == target and action["head"] == task["head"] \
                and action["state"] in (
                "CLAIMED", "WAITING", "UNKNOWN", "APPLIED", "BLOCKED"):
            return action
    return None


def _action_id(state: dict, task: dict, kind: str, stage: str | None, round_no: int = 0,
               source_action_id: str | None = None) -> str:
    identity = [state["team_id"], task["task_id"], str(task["task_revision"]),
                task["head"] or "", kind, stage or "", str(round_no), source_action_id or ""]
    return sha256_hex(canonical_json(identity))


def _make_action(state: dict, task: dict, kind: str, target_role: str,
                 stage: str | None = None, round_no: int = 0,
                 source_action_id: str | None = None) -> dict:
    return {
        "action_id": _action_id(state, task, kind, stage, round_no),
        "task_id": task["task_id"],
        "action_kind": kind,
        "target_stage": stage,
        "target_role": target_role,
        "head": task["head"],
        "state": "READY",
        "actor": None,
        "lease_id": None,
        "lease_until": None,
        "attempts": 0,
        "checkpoint": None,
        "blocked_reason": None,
        "round": round_no,
        "source_action_id": source_action_id,
    }




def task_phase(task: dict) -> str:
    merge = task["merge"]["state"]
    if merge == "MERGED":
        return "COMPLETED"
    if merge == "MERGED_OUTSIDE_RECORDED_GATES":
        return "BLOCKED"
    if merge == "UNKNOWN":
        return "MERGE_UNKNOWN"
    gates = task["gates"]
    if gates["engineering"]["status"] != "DELIVERED":
        return "IMPLEMENTING"
    technical = gates["technical"]["status"]
    if technical in ("UNKNOWN", "UNVERIFIED"):
        return "REVIEW_PENDING"
    if technical == "FAIL":
        return "REWORK"
    if task["applicability"]["product"] == "REQUIRED":
        product = gates["product"]["status"]
        if product in ("UNKNOWN", "UNVERIFIED"):
            return "ACCEPTANCE_PENDING"
        if product == "FAIL":
            return "REWORK"
    ci = gates["ci"]
    if ci["status"] != "SUCCESS" or ci["head"] != task["head"]:
        return "CI_PENDING"
    return "MERGE_READY"

def _expire_leases(state: dict, now: str) -> bool:
    changed = False
    for action in state["actions"].values():
        if action["state"] == "CLAIMED" and action["lease_until"] is not None \
                and _epoch(now) > _epoch(action["lease_until"]):
            action["state"] = "UNKNOWN"
            action["checkpoint"] = "LEASE_EXPIRED"
            action["lease_id"] = None
            action["lease_until"] = None
            action["actor"] = None
            changed = True
    return changed


def compute_ready_action(state: dict, now: str) -> dict | None:
    if state["paused"]["active"]:
        return None
    if state["input_pending"]["active"]:
        task = state["tasks"].get(state["active_task_id"] or "")
        return _view(state, _make_action(state, task or _placeholder_task(state),
                                         "RECONCILE_INPUT", "supervisor"))
    for action in sorted(state["actions"].values(), key=lambda item: item["action_id"]):
        if action["state"] != "UNKNOWN":
            continue
        task = state["tasks"].get(action["task_id"])
        if task is None:
            continue
        if action["action_kind"] == "MERGE_PR":
            return _view(state, _make_action(state, task, "RECONCILE_MERGE", "supervisor", None, 0,
                                             action["action_id"]))
        return _view(state, _make_action(state, task, "RECONCILE_STAGE", "supervisor", "readback",
                                         0, action["action_id"]))
    task = state["tasks"].get(state["active_task_id"] or "")
    if task is None:
        return None
    if task["merge"]["state"] in ("MERGED", "MERGED_OUTSIDE_RECORDED_GATES"):
        return None
    if task["wait"] is not None and not _stale_wait(task):
        return _view(state, _make_action(state, task, "RECONCILE_STAGE", "supervisor", "reconcile"))
    gates = task["gates"]
    engineering = gates["engineering"]["status"]
    if engineering != "DELIVERED":
        if task["awaiting_checkpoint"]:
            return _view(state, _make_action(state, task, "REQUEST_CHECKPOINT", task["writer_role"]))
        if not task["dispatched"]:
            return _view(state, _make_action(state, task, "DISPATCH_TASK", task["owner_role"]))
        return None
    technical = gates["technical"]["status"]
    if technical in ("UNKNOWN", "UNVERIFIED"):
        if _open_handoff(state, task, "technical") is None:
            return _view(state, _make_action(state, task, "HANDOFF", "engineering", "technical"))
        return None
    if technical == "FAIL":
        if _open_handoff(state, task, "rework") is None:
            return _view(state, _make_action(state, task, "HANDOFF", "engineering", "rework",
                                             task["rework_rounds"]))
        return None
    if technical != "PASS":
        return None
    product_required = task["applicability"]["product"] == "REQUIRED"
    product = gates["product"]["status"]
    if product_required and product in ("UNKNOWN", "UNVERIFIED"):
        if _open_handoff(state, task, "product") is None:
            return _view(state, _make_action(state, task, "HANDOFF", "engineering", "product"))
        return None
    if product_required and product == "FAIL":
        if _open_handoff(state, task, "rework") is None:
            return _view(state, _make_action(state, task, "HANDOFF", "engineering", "rework",
                                             task["rework_rounds"]))
        return None
    if product != ("NOT_REQUIRED" if not product_required else "PASS"):
        return None
    ci = gates["ci"]
    fresh = (ci["observed_at"] is not None
             and 0 <= _epoch(now) - _epoch(ci["observed_at"]) <= CI_FRESH_SECONDS)
    if ci["head"] != task["head"] or ci["status"] == "UNKNOWN" or not fresh:
        return _view(state, _make_action(state, task, "OBSERVE_PR", "supervisor"))
    if ci["status"] != "SUCCESS":
        return None
    if task["pr"] is None or task["merge"]["pr_state"] != "OPEN":
        return None
    if _gates_satisfied(task):
        return _view(state, _make_action(state, task, "MERGE_PR", "supervisor"))
    return None

def _refresh_phases(state: dict) -> None:
    for task in state["tasks"].values():
        task["phase"] = task_phase(task)


def _placeholder_task(state: dict) -> dict:
    return {
        "task_id": state["active_task_id"] or "NONE",
        "task_revision": 1,
        "head": None,
    }


def _stale_wait(task: dict) -> bool:
    return task["wait"] is not None and task["wait"].get("stale") is True


def _view(state: dict, action: dict) -> dict:
    view = {
        "action_id": action["action_id"],
        "task_id": action["task_id"],
        "action_kind": action["action_kind"],
        "target_stage": action["target_stage"],
        "target_role": action["target_role"],
        "head": action["head"],
    }
    if action.get("source_action_id"):
        view["source_action_id"] = action["source_action_id"]
    return view


def _recompute(state: dict) -> None:
    _expire_leases(state, state.get("_now", "1970-01-01T00:00:00Z"))
    _refresh_phases(state)
    ready = compute_ready_action(state, state.get("_now", "1970-01-01T00:00:00Z"))
    state["ready_action"] = ready
    if ready is not None:
        existing = state["actions"].get(ready["action_id"])
        if existing is None:
            if len(state["actions"]) >= MAX_ACTIONS:
                raise _fail("STATE_CAPACITY_EXCEEDED")
            action = _make_action(
                state,
                state["tasks"].get(ready["task_id"]) or _placeholder_task(state),
                ready["action_kind"], ready["target_role"], ready["target_stage"],
                _round_for(state, ready), ready.get("source_action_id"),
            )
            state["actions"][action["action_id"]] = action
        elif existing["state"] == "STALE":
            existing["state"] = "READY"
    for action in state["actions"].values():
        if action["state"] == "READY" and (ready is None or action["action_id"] != ready["action_id"]):
            action["state"] = "STALE"


def _round_for(state: dict, ready: dict) -> int:
    task = state["tasks"].get(ready["task_id"])
    if task is not None and ready["action_kind"] == "HANDOFF" and ready["target_stage"] == "rework":
        return task["rework_rounds"]
    return 0


# ---------------------------------------------------------------------------
# Event application
# ---------------------------------------------------------------------------

def reduce_event(state: dict, event: dict, now: str, expected_revision: int | None = None) -> dict:
    validate_event(event, state)
    key = event_key(state, event)
    digest = event_digest(event)
    known = state["events"].get(key)
    if known is not None:
        if known["payload_digest"] != digest:
            raise _fail("EVENT_CONFLICT")
        return state
    if expected_revision is not None and state["revision"] != expected_revision:
        raise _fail("REVISION_CONFLICT")
    if len(state["events"]) >= MAX_EVENTS:
        raise _fail("STATE_CAPACITY_EXCEEDED")
    task = state["tasks"].get(event["task_id"])
    if task is None:
        raise _fail("EVENT_INVALID")
    if event["task_revision"] != task["task_revision"]:
        return _remember(state, key, digest, "EVENT_STALE")
    head_bound = event["event_kind"] in ("ENGINEERING_DELIVERED", "TECH_RESULT",
                                         "PRODUCT_RESULT", "CI_OBSERVED")
    if head_bound and (event["head"] is None or task["head"] is None):
        raise _fail("EVENT_INVALID")
    if head_bound and event["head"] != task["head"]:
        return _remember(state, key, digest, "EVENT_STALE")
    verified = _verified(state, event)
    state = copy.deepcopy(state)
    task = state["tasks"][event["task_id"]]
    kind = event["event_kind"]
    payload = event["payload"]
    if kind == "ENGINEERING_DELIVERED":
        _require_keys(payload, ("scope_digest", "artifact_sha256", "artifact_relpath",
                                "limitations"), code="EVENT_INVALID")
        sha, relpath = _artifact_ok(payload, "EVENT_INVALID")
        limitations = _limitations_ok(payload["limitations"], "EVENT_INVALID")
        if payload["scope_digest"] != task["scope_digest"]:
            raise _fail("EVENT_INVALID")
        gate = task["gates"]["engineering"]
        if verified and event["issuer_role"] == task["writer_role"] and event["head"] == task["head"]:
            gate.update({"status": "DELIVERED", "head": event["head"],
                         "receipt_id": event["receipt_id"], "artifact_sha256": sha,
                         "artifact_relpath": relpath, "limitations": limitations})
            task["awaiting_checkpoint"] = False
            task["wait"] = None
        else:
            gate.update({"status": "UNVERIFIED", "head": event["head"],
                         "receipt_id": event["receipt_id"]})
    elif kind == "TECH_RESULT":
        _required_keys(payload, ("conclusion", "review_mode", "artifact_sha256",
                                 "artifact_relpath", "accepted_limitations"),
                       allowed=("conclusion", "review_mode", "artifact_sha256",
                                "artifact_relpath", "accepted_limitations", "blockers"),
                       code="EVENT_INVALID")
        if payload["conclusion"] not in ("PASS", "FAIL"):
            raise _fail("EVENT_INVALID")
        sha, relpath = _artifact_ok(payload, "EVENT_INVALID")
        accepted = _limitations_ok(payload["accepted_limitations"], "EVENT_INVALID")
        blockers = payload.get("blockers", [])
        blockers = _limitations_ok(blockers, "EVENT_INVALID")
        if payload["conclusion"] == "PASS" and blockers:
            raise _fail("EVENT_INVALID")
        if payload["conclusion"] == "FAIL" and not blockers:
            raise _fail("EVENT_INVALID")
        gate = task["gates"]["technical"]
        trusted = (verified and event["issuer_role"] == "technical"
                   and event["head"] == task["head"]
                   and payload["review_mode"] == "FINAL_COMMIT"
                   and event["issuer_role"] != task["writer_role"])
        if trusted:
            gate.update({"status": payload["conclusion"], "head": event["head"],
                         "receipt_id": event["receipt_id"],
                         "review_mode": payload["review_mode"],
                         "artifact_sha256": sha, "artifact_relpath": relpath,
                         "blockers": blockers, "accepted_limitations": accepted})
            task["wait"] = None
            if payload["conclusion"] == "FAIL":
                task["rework_rounds"] += 1
        else:
            gate.update({"status": "UNVERIFIED", "head": event["head"],
                         "receipt_id": event["receipt_id"]})
    elif kind == "PRODUCT_RESULT":
        _require_keys(payload, ("conclusion", "artifact_sha256", "artifact_relpath"),
                      code="EVENT_INVALID")
        if payload["conclusion"] not in ("PASS", "FAIL", "NOT_REQUIRED"):
            raise _fail("EVENT_INVALID")
        if payload["conclusion"] == "NOT_REQUIRED" \
                and task["applicability"]["product"] != "NOT_REQUIRED":
            raise _fail("EVENT_INVALID")
        sha, relpath = _artifact_ok(payload, "EVENT_INVALID")
        gate = task["gates"]["product"]
        if verified and event["issuer_role"] == "product":
            if payload["conclusion"] != "NOT_REQUIRED" or \
                    task["applicability"]["product"] == "NOT_REQUIRED":
                gate.update({"status": payload["conclusion"], "head": event["head"],
                             "receipt_id": event["receipt_id"], "artifact_sha256": sha,
                             "artifact_relpath": relpath})
                task["wait"] = None
        else:
            gate.update({"status": "UNVERIFIED", "head": event["head"],
                         "receipt_id": event["receipt_id"]})
    elif kind == "CI_OBSERVED":
        _require_keys(payload, ("conclusion", "pr", "required_checks", "observed_at"),
                      code="EVENT_INVALID")
        if payload["conclusion"] not in ("SUCCESS", "PENDING", "FAIL") \
                or not _is_int(payload["pr"], 1):
            raise _fail("EVENT_INVALID")
        observed_at = payload["observed_at"]
        if not isinstance(observed_at, str):
            raise _fail("EVENT_INVALID")
        try:
            observed_epoch = _epoch(observed_at)
        except ControllerError:
            raise _fail("EVENT_INVALID")
        if observed_epoch > _epoch(now) + 300:
            raise _fail("EVENT_INVALID")
        checks = payload["required_checks"]
        if not isinstance(checks, list) or not 1 <= len(checks) <= 64:
            raise _fail("EVENT_INVALID")
        clean_checks = []
        for check in checks:
            _require_keys(check, ("name", "conclusion"), code="EVENT_INVALID")
            if not isinstance(check["name"], str) or not check["name"] \
                    or len(check["name"]) > 128:
                raise _fail("EVENT_INVALID")
            if check["conclusion"] not in ("SUCCESS", "FAILURE", "PENDING", "SKIPPED"):
                raise _fail("EVENT_INVALID")
            clean_checks.append({"name": check["name"], "conclusion": check["conclusion"]})
        names = [check["name"] for check in clean_checks]
        if len(set(names)) != len(names) or sorted(names) != sorted(task["required_checks"]):
            raise _fail("EVENT_INVALID")
        if not verified or event["issuer_role"] != "supervisor":
            task["gates"]["ci"].update({"status": "UNVERIFIED", "head": event["head"]})
        else:
            if payload["conclusion"] == "SUCCESS" and any(
                    check["conclusion"] != "SUCCESS" for check in clean_checks):
                conclusion = ("FAIL" if any(check["conclusion"] == "FAILURE"
                                            for check in clean_checks) else "PENDING")
            else:
                conclusion = payload["conclusion"]
            task["gates"]["ci"] = {
                "status": conclusion, "head": task["head"], "pr": payload["pr"],
                "observed_at": observed_at, "required_checks": clean_checks,
            }
            task["wait"] = None
    elif kind == "PR_OBSERVED":
        _required_keys(payload, ("pr", "state", "head"),
                       allowed=("pr", "state", "head", "merge_commit"), code="EVENT_INVALID")
        if not _is_int(payload["pr"], 1) or payload["state"] not in ("OPEN", "CLOSED", "MERGED"):
            raise _fail("EVENT_INVALID")
        if not _is_hex(payload["head"], HEAD_RE):
            raise _fail("EVENT_INVALID")
        if not verified or event["issuer_role"] != "supervisor":
            raise _fail("EVENT_INVALID")
        if payload["head"] != task["head"]:
            raise _fail("EVENT_INVALID")
        if task["pr"] is None:
            task["pr"] = payload["pr"]
        elif task["pr"] != payload["pr"]:
            raise _fail("EVENT_INVALID")
        task["merge"]["pr_state"] = payload["state"]
        if payload["state"] == "MERGED":
            merge_commit = payload.get("merge_commit")
            if not _is_hex(merge_commit, SHA256_RE) and not _is_hex(merge_commit, HEAD_RE):
                raise _fail("EVENT_INVALID")
            for candidate in state["actions"].values():
                if candidate["task_id"] == task["task_id"] \
                        and candidate["action_kind"] == "MERGE_PR" \
                        and candidate["state"] == "UNKNOWN":
                    candidate["state"] = "APPLIED"
                    candidate["checkpoint"] = "READBACK_MERGED"
            already = task["merge"]["state"] in ("MERGED", "MERGED_OUTSIDE_RECORDED_GATES")
            if not already:
                satisfied = _gates_satisfied(task)
                task["merge"] = {
                    "state": "MERGED" if satisfied else "MERGED_OUTSIDE_RECORDED_GATES",
                    "merge_commit": merge_commit, "head": task["head"], "pr_state": "MERGED",
                }
                if satisfied:
                    _close_task(state, task)
    elif kind == "HEAD_OBSERVED":
        _required_keys(payload, ("head",), allowed=("head", "pr"), code="EVENT_INVALID")
        if not _is_hex(payload["head"], HEAD_RE):
            raise _fail("EVENT_INVALID")
        if not verified or event["issuer_role"] != "supervisor":
            raise _fail("EVENT_INVALID")
        if payload["head"] != task["head"]:
            task["head"] = payload["head"]
            task["gates"]["engineering"].update({"status": "MISSING", "head": None})
            task["gates"]["technical"].update({"status": "UNKNOWN", "head": None})
            if task["applicability"]["product"] != "NOT_REQUIRED":
                task["gates"]["product"].update({"status": "UNKNOWN", "head": None})
            task["gates"]["ci"] = {"status": "UNKNOWN", "head": None, "pr": task["pr"],
                                   "observed_at": None, "required_checks": []}
            task["merge"] = {"state": "NONE", "merge_commit": None, "head": None,
                             "pr_state": task["merge"]["pr_state"]}
            task["awaiting_checkpoint"] = True
            task["wait"] = None
            task["handoffs"] = {}
            for action in state["actions"].values():
                if action["task_id"] == task["task_id"] and action["state"] in (
                        "READY", "CLAIMED", "WAITING", "UNKNOWN"):
                    action["state"] = "STALE"
    elif kind == "HANDOFF_ACK":
        _require_keys(payload, ("handoff_action_id", "status"), code="EVENT_INVALID")
        if not _is_hex(payload["handoff_action_id"], SHA256_RE) \
                or payload["status"] not in ("ACCEPTED", "ACKED"):
            raise _fail("EVENT_INVALID")
        action = state["actions"].get(payload["handoff_action_id"])
        if action is None or action["task_id"] != task["task_id"] \
                or action["action_kind"] != "HANDOFF" \
                or action["target_stage"] != event["issuer_role"]:
            raise _fail("EVENT_INVALID")
        receipt = task["handoffs"].setdefault(payload["handoff_action_id"], {})
        if payload["status"] == "ACCEPTED":
            receipt["accepted"] = True
        else:
            receipt["accepted"] = True
            receipt["acked"] = True
    elif kind == "WAIT_OBSERVED":
        _require_keys(payload, ("reason", "owner_role", "evidence"), code="EVENT_INVALID")
        if not _is_safe_code(payload["reason"]) or payload["owner_role"] not in ROLES \
                or not _is_safe_code(payload["evidence"]):
            raise _fail("EVENT_INVALID")
        if not verified or event["issuer_role"] != "supervisor":
            raise _fail("EVENT_INVALID")
        task["wait"] = {"reason": payload["reason"], "owner_role": payload["owner_role"],
                        "evidence": payload["evidence"], "since": now, "stale": False}
    elif kind == "TRANSPORT_FAILURE":
        _require_keys(payload, ("action_id",), code="EVENT_INVALID")
        action = state["actions"].get(payload["action_id"])
        if action is None:
            raise _fail("EVENT_INVALID")
        action["attempts"] = action["attempts"] + 0  # attempts only increase on claim
    elif kind == "ACTION_RESULT":
        _require_keys(payload, ("action_id", "result", "checkpoint"), code="EVENT_INVALID")
        action = state["actions"].get(payload["action_id"])
        if action is None or action["state"] != "CLAIMED" or not verified:
            raise _fail("EVENT_INVALID")
        state = _apply_result(state, action, {
            "result": payload["result"], "checkpoint": payload["checkpoint"],
        }, now)
    state = _remember(state, key, digest, "APPLIED")
    state["revision"] += 1
    _recompute_pending(state, now)
    return state


def _recompute_pending(state: dict, now: str) -> None:
    _expire_leases(state, now)
    _refresh_phases(state)
    state["_now"] = now
    ready = compute_ready_action(state, now)
    state["ready_action"] = ready
    if ready is not None:
        existing = state["actions"].get(ready["action_id"])
        if existing is None:
            if len(state["actions"]) >= MAX_ACTIONS:
                raise _fail("STATE_CAPACITY_EXCEEDED")
            action = _make_action(
                state,
                state["tasks"].get(ready["task_id"]) or _placeholder_task(state),
                ready["action_kind"], ready["target_role"], ready["target_stage"],
                _round_for(state, ready), ready.get("source_action_id"),
            )
            state["actions"][action["action_id"]] = action
        elif existing["state"] == "STALE":
            existing["state"] = "READY"
    for action in state["actions"].values():
        if action["state"] == "READY" and (ready is None or action["action_id"] != ready["action_id"]):
            action["state"] = "STALE"
    state.pop("_now", None)


def _close_task(state: dict, task: dict) -> None:
    if state["active_task_id"] != task["task_id"]:
        return
    candidates = []
    for other in state["tasks"].values():
        if other["task_id"] == task["task_id"]:
            continue
        if other["merge"]["state"] == "MERGED":
            continue
        if other["seq"] <= task["seq"]:
            continue
        if all(state["tasks"].get(dep, {}).get("merge", {}).get("state") == "MERGED"
               for dep in other["depends_on"]) and other["merge"]["state"] == "NONE":
            candidates.append(other)
    if candidates:
        nxt = min(candidates, key=lambda item: item["seq"])
        nxt["dispatched"] = False
        nxt["awaiting_checkpoint"] = False
        state["active_task_id"] = nxt["task_id"]
    else:
        state["active_task_id"] = None


# ---------------------------------------------------------------------------
# Claim / finish / lifecycle commands
# ---------------------------------------------------------------------------

def _require_revision(state: dict, expected_revision) -> None:
    if not _is_int(expected_revision) or state["revision"] != expected_revision:
        raise _fail("REVISION_CONFLICT")


def claim_action(state: dict, action_id: str, actor: str, expected_revision: int, now: str,
                 allow_kinds: set | frozenset = frozenset()) -> tuple[dict, dict]:
    _require_revision(state, expected_revision)
    if state["paused"]["active"]:
        raise _fail("PAUSED")
    action = state["actions"].get(action_id)
    if action is None:
        raise _fail("ACTION_UNKNOWN")
    if state["input_pending"]["active"] and action["action_kind"] not in allow_kinds \
            and action["action_kind"] != "RECONCILE_INPUT":
        raise _fail("INPUT_UNCOORDINATED")
    expected_actor = state["binding"]["roles"].get(action["target_role"])
    if actor != expected_actor:
        raise _fail("ACTOR_MISMATCH")
    if action["state"] == "CLAIMED":
        raise _fail("CLAIM_CONFLICT")
    if action["state"] != "READY":
        raise _fail("ACTION_UNKNOWN")
    # A lease must still be the unique action the reducer would emit right now:
    # stale CI observations, new heads or changed gates invalidate the permission.
    current = compute_ready_action(state, now)
    if current is None or current["action_id"] != action_id:
        raise _fail("GATE_UNSATISFIED")
    if action["attempts"] >= 3:
        action["blocked_reason"] = "BLOCKED_TRANSPORT"
        action["state"] = "BLOCKED"
        action["lease_id"] = None
        action["lease_until"] = None
        _recompute_pending(state, now)
        return state, {}
    state = copy.deepcopy(state)
    action = state["actions"][action_id]
    action["state"] = "CLAIMED"
    action["actor"] = actor
    action["lease_id"] = secrets.token_hex(16)
    action["lease_until"] = _now_plus(now, LEASE_SECONDS)
    action["attempts"] += 1
    state["revision"] += 1
    _recompute_pending(state, now)
    return state, dict(action)


def finish_action(state: dict, action_id: str, lease_id: str, result: dict, now: str) -> dict:
    action = state["actions"].get(action_id)
    if action is None or action["state"] != "CLAIMED" or action["lease_id"] != lease_id:
        raise _fail("CLAIM_CONFLICT")
    if _epoch(now) > _epoch(action["lease_until"]):
        raise _fail("LEASE_EXPIRED")
    state = copy.deepcopy(state)
    action = state["actions"][action_id]
    state = _apply_result(state, action, result, now)
    state["revision"] += 1
    _recompute_pending(state, now)
    return state


def _apply_result(state: dict, action: dict, result: dict, now: str) -> dict:
    allowed = ("result", "checkpoint", "merged_head", "merge_commit", "pr", "resolution")
    if not isinstance(result, dict) or any(key not in allowed for key in result):
        raise _fail("ACTION_RESULT_INVALID")
    verdict = result.get("result")
    if verdict not in ("DONE", "FAILED", "UNKNOWN"):
        raise _fail("ACTION_RESULT_INVALID")
    checkpoint = result.get("checkpoint")
    if checkpoint is not None and not _is_safe_code(checkpoint):
        raise _fail("ACTION_RESULT_INVALID")
    resolution = result.get("resolution")
    if resolution is not None and resolution not in ("DELIVERED", "NOT_DELIVERED", "RECONCILED"):
        raise _fail("ACTION_RESULT_INVALID")
    if action["action_kind"] in ("RECONCILE_STAGE", "RECONCILE_MERGE") and verdict == "DONE" \
            and resolution is None:
        raise _fail("ACTION_RESULT_INVALID")
    action["checkpoint"] = checkpoint
    task = state["tasks"][action["task_id"]]
    if verdict == "DONE":
        action["state"] = "APPLIED"
        action["lease_id"] = None
        action["lease_until"] = None
        if action["action_kind"] == "MERGE_PR":
            merged_head = result.get("merged_head")
            merge_commit = result.get("merge_commit")
            if not _is_hex(merged_head, HEAD_RE) or merged_head != task["head"] \
                    or not _is_hex(merge_commit, HEAD_RE):
                raise _fail("ACTION_RESULT_INVALID")
            task["merge"] = {"state": "MERGED", "merge_commit": merge_commit,
                             "head": task["head"], "pr_state": "MERGED"}
            _close_task(state, task)
        elif action["action_kind"] == "RECONCILE_STAGE":
            source = state["actions"].get(action["source_action_id"] or "")
            if source is None:
                if resolution != "RECONCILED":
                    raise _fail("ACTION_RESULT_INVALID")
                task["wait"] = None
            elif resolution == "DELIVERED":
                source["state"] = "APPLIED"
                source["checkpoint"] = "READBACK_DELIVERED"
                source["lease_id"] = None
                source["lease_until"] = None
                source["actor"] = None
            elif resolution == "NOT_DELIVERED":
                source["state"] = "READY"
                source["lease_id"] = None
                source["lease_until"] = None
                source["actor"] = None
            else:
                raise _fail("ACTION_RESULT_INVALID")
        elif action["action_kind"] == "RECONCILE_MERGE":
            source = state["actions"].get(action["source_action_id"] or "")
            if source is None or source["action_kind"] != "MERGE_PR":
                raise _fail("ACTION_RESULT_INVALID")
            if resolution == "DELIVERED":
                merged_head = result.get("merged_head")
                merge_commit = result.get("merge_commit")
                if not _is_hex(merged_head, HEAD_RE) or merged_head != task["head"] \
                        or not _is_hex(merge_commit, HEAD_RE):
                    raise _fail("ACTION_RESULT_INVALID")
                source["state"] = "APPLIED"
                source["checkpoint"] = "READBACK_MERGED"
                source["lease_id"] = None
                source["lease_until"] = None
                source["actor"] = None
                task["merge"] = {"state": "MERGED", "merge_commit": merge_commit,
                                 "head": task["head"], "pr_state": "MERGED"}
                _close_task(state, task)
            elif resolution == "NOT_DELIVERED":
                source["state"] = "READY"
                source["checkpoint"] = "READBACK_NOT_MERGED"
                source["lease_id"] = None
                source["lease_until"] = None
                source["actor"] = None
                if task["merge"]["state"] == "UNKNOWN":
                    task["merge"]["state"] = "NONE"
            else:
                raise _fail("ACTION_RESULT_INVALID")
        elif action["action_kind"] == "HANDOFF":
            task["handoffs"].setdefault(action["action_id"], {})["delivered"] = True
        elif action["action_kind"] == "DISPATCH_TASK":
            target = state["tasks"].get(action["task_id"])
            if target is not None:
                target["dispatched"] = True
        elif action["action_kind"] == "OBSERVE_PR":
            pass
    elif verdict == "UNKNOWN":
        action["state"] = "UNKNOWN"
        action["lease_id"] = None
        action["lease_until"] = None
        if action["action_kind"] == "MERGE_PR":
            task["merge"]["state"] = "UNKNOWN"
    else:  # FAILED
        action["lease_id"] = None
        action["lease_until"] = None
        if action["attempts"] >= 3:
            action["state"] = "BLOCKED"
            action["blocked_reason"] = "BLOCKED_TRANSPORT"
        else:
            action["state"] = "READY"
    return state


def set_paused(state: dict, reason: str, by: str, now: str) -> dict:
    if not _is_safe_code(reason):
        raise _fail("PAUSE_INVALID")
    state = copy.deepcopy(state)
    state["paused"] = {"active": True, "reason": reason, "by": by, "at": now}
    state["revision"] += 1
    _recompute_pending(state, now)
    return state


def set_resumed(state: dict, by: str, now: str) -> dict:
    state = copy.deepcopy(state)
    state["paused"] = {"active": False, "reason": None, "by": by, "at": now}
    state["revision"] += 1
    _recompute_pending(state, now)
    return state


def mark_input_pending(state: dict, now: str) -> dict:
    state = copy.deepcopy(state)
    state["input_pending"] = {"active": True, "marked_at": now}
    state["revision"] += 1
    _recompute_pending(state, now)
    return state


def observe_input(state: dict, result: dict, by: str, now: str) -> dict:
    if not isinstance(result, dict) or result.get("coordinated") is not True:
        raise _fail("INPUT_UNCOORDINATED")
    state = copy.deepcopy(state)
    state["input_pending"] = {"active": False, "marked_at": None}
    adopt = result.get("adopt_external_merge")
    if adopt is not None:
        if not isinstance(adopt, str) or not TASK_ID_RE.match(adopt):
            raise _fail("INPUT_UNCOORDINATED")
        adopted = state["tasks"].get(adopt)
        if adopted is None or adopted["merge"]["state"] != "MERGED_OUTSIDE_RECORDED_GATES":
            raise _fail("INPUT_UNCOORDINATED")
        adopted["merge"]["state"] = "MERGED"
        _close_task(state, adopted)
    if result.get("wait"):
        if not _is_safe_code(result["wait"]):
            raise _fail("INPUT_UNCOORDINATED")
        task = state["tasks"].get(state["active_task_id"] or "")
        if task is not None:
            task["wait"] = {"reason": result["wait"], "owner_role": "supervisor",
                            "evidence": "SUPERVISOR_RECONCILE", "since": now, "stale": False}
    state["revision"] += 1
    _recompute_pending(state, now)
    return state
