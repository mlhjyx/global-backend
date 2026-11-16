#!/usr/bin/python3
"""Thin CLI + hook adapter + binding probe + minimal installer for the agent-team
handoff controller (standard library only).

Pinned entry: /usr/bin/python3 -I <pinned>/controller.py ...
The hook path never calls gh/MCP/models, never executes event-carried shell and
never reads transcript bodies.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import secrets
import stat
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAX_HOOK_STDIN = 16 * 1024 * 1024
INSTALL_FILES = ("controller.py", "state_machine.py", "schema-v1.json")


def _load_state_machine(directory: Path | None = None):
    target = Path(directory or HERE) / "state_machine.py"
    spec = importlib.util.spec_from_file_location("agent_team_state_machine_pinned", target)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sm = _load_state_machine()


class HookInputError(Exception):
    pass


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _emit(text: str) -> None:
    sys.stdout.write(text)


def _diagnose(code: str) -> None:
    sys.stderr.write(code + "\n")


# ---------------------------------------------------------------------------
# Secure small files
# ---------------------------------------------------------------------------

def _secure_read(path: Path) -> bytes:
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise sm.ControllerError("STATE_PERMISSIONS")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        return os.read(fd, sm.MAX_STATE_BYTES + 1)
    finally:
        os.close(fd)


def _secure_write(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}.{secrets.token_hex(4)}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)


def _read_json_file(path: Path):
    return json.loads(_secure_read(path).decode("utf-8"))


# ---------------------------------------------------------------------------
# Settings merge (only owned hook entries are touched)
# ---------------------------------------------------------------------------

def _entry_fingerprint(entry) -> str:
    return _sha(_canonical(entry))


def _read_settings(path: Path) -> tuple[dict, str, bytes]:
    if not path.exists():
        return {}, _sha(b""), b""
    raw = _secure_read(path)
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict):
        raise sm.ControllerError("SETTINGS_INVALID")
    return data, _sha(raw), raw


def _save_settings_checked(path: Path, data: dict, expected_digest: str) -> str:
    """Re-read the settings file right before saving; any concurrent writer wins."""
    _, current_digest, _ = _read_settings(path)
    if current_digest != expected_digest:
        raise sm.ControllerError("SETTINGS_CONFLICT")
    return _write_settings(path, data)


def _write_settings(path: Path, data: dict) -> str:
    raw = json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8") + b"\n"
    mode = 0o600
    if path.exists():
        info = os.lstat(path)
        if info.st_mode & 0o077:
            raise sm.ControllerError("SETTINGS_INVALID")
        mode = stat.S_IMODE(info.st_mode)
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}.{secrets.token_hex(4)}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    try:
        os.write(fd, raw)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)
    return _sha(raw)


def _owned_stop_entry(controller_path: Path, state_dir: str, native_id: str, ccd_id: str | None) -> dict:
    args = ["-I", str(controller_path), "hook", "--event", "Stop", "--state-dir", state_dir,
            "--supervisor-hook-session-id", native_id]
    if ccd_id:
        args += ["--supervisor-ccd-session-id", ccd_id]
    return {"hooks": [{"type": "command", "command": "/usr/bin/python3", "args": args,
                       "timeout": 5}]}


def _probe_entry(controller_path: Path, state_dir: str) -> dict:
    return {"hooks": [{"type": "command", "command": "/usr/bin/python3",
                       "args": ["-I", str(controller_path), "hook", "--event", "PostToolUse",
                                "--probe", "--state-dir", state_dir],
                       "timeout": 5}]}


def _append_hook(settings: dict, event_name: str, entry: dict) -> bool:
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise sm.ControllerError("SETTINGS_INVALID")
    entries = hooks.setdefault(event_name, [])
    if not isinstance(entries, list):
        raise sm.ControllerError("SETTINGS_INVALID")
    fingerprint = _entry_fingerprint(entry)
    if any(_entry_fingerprint(existing) == fingerprint for existing in entries):
        return False
    entries.append(entry)
    return True


def _remove_hooks(settings: dict, fingerprints: set[str]) -> None:
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        return
    for event_name in list(hooks.keys()):
        entries = hooks[event_name]
        if not isinstance(entries, list):
            continue
        kept = [entry for entry in entries if _entry_fingerprint(entry) not in fingerprints]
        if kept:
            hooks[event_name] = kept
        else:
            del hooks[event_name]
    if not hooks:
        settings.pop("hooks", None)


# ---------------------------------------------------------------------------
# Installer
# ---------------------------------------------------------------------------

def _receipt_path(state_dir: Path) -> Path:
    return state_dir / "install-receipt.json"


def cmd_install_hooks(args, now: str):
    state_dir = Path(args.state_dir)
    state = sm.load_state(state_dir)
    commit = args.tool_commit
    if not (isinstance(commit, str) and sm.HEAD_RE.match(commit)):
        raise sm.ControllerError("TOOL_COMMIT_INVALID")
    native_id = state["binding"]["supervisor_hook_session_id"]
    if not native_id:
        raise sm.ControllerError("BINDING_REQUIRED")
    source = Path(args.source_dir)
    install_root = Path(args.install_root)
    install_dir = install_root / commit
    install_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(install_dir, 0o700)
    digests = {}
    for name in INSTALL_FILES:
        src = source / name
        if not src.is_file():
            raise sm.ControllerError("TOOL_SOURCE_INVALID")
        payload = src.read_bytes()
        target = install_dir / name
        if target.exists():
            if target.read_bytes() != payload:
                raise sm.ControllerError("INSTALL_CONFLICT")
        else:
            _secure_write(target, payload)
        digests[name] = _sha(payload)

    settings_path = Path(args.settings)
    settings, preimage_digest, _ = _read_settings(settings_path)
    receipt_path = _receipt_path(state_dir)
    receipt = None
    if receipt_path.exists():
        receipt = _read_json_file(receipt_path)
        if receipt.get("postimage_digest") != preimage_digest:
            raise sm.ControllerError("SETTINGS_CONFLICT")
    entry = _owned_stop_entry(install_dir / "controller.py", str(state_dir), native_id,
                              state["binding"]["supervisor_ccd_session_id"])
    _append_hook(settings, "Stop", entry)
    postimage_digest = _save_settings_checked(settings_path, settings, preimage_digest)
    owned = set()
    if receipt:
        owned.update(receipt.get("entry_fingerprints", []))
    owned.add(_entry_fingerprint(entry))
    receipt_data = {
        "tool_commit": commit,
        "entry_fingerprints": sorted(owned),
        "preimage_digest": preimage_digest,
        "postimage_digest": postimage_digest,
        "file_digests": digests,
    }
    _secure_write(receipt_path, _canonical(receipt_data))
    return 0, json.dumps({"installed": str(install_dir), "entry": _entry_fingerprint(entry)}), ""


def cmd_uninstall_hooks(args, now: str):
    state_dir = Path(args.state_dir)
    settings_path = Path(args.settings)
    receipt_path = _receipt_path(state_dir)
    if not receipt_path.exists():
        return 0, json.dumps({"removed": 0}), ""
    receipt = _read_json_file(receipt_path)
    settings, preimage_digest, _ = _read_settings(settings_path)
    fingerprints = set(receipt.get("entry_fingerprints", []))
    # Only remove entries this controller installed, never a whole-file restore.
    _remove_hooks(settings, fingerprints)
    _save_settings_checked(settings_path, settings, preimage_digest)
    receipt_path.unlink()
    return 0, json.dumps({"removed": len(fingerprints)}), ""


# ---------------------------------------------------------------------------
# Probe / binding
# ---------------------------------------------------------------------------

def _probe_pending_path(state_dir: Path) -> Path:
    return state_dir / "binding-probe-pending.json"


def _probe_proof_path(state_dir: Path) -> Path:
    return state_dir / "binding-probe.json"


def cmd_prepare_bind(args, now: str):
    state_dir = Path(args.state_dir)
    sm.load_state(state_dir)
    nonce = secrets.token_hex(16)
    command = f"printf 'GLOBAL-TEAM-BIND-{nonce}'"
    pending = {
        "nonce_sha256": _sha(nonce.encode()),
        "command_sha256": _sha(command.encode()),
        "expires_at": sm._now_plus(now, sm.LEASE_SECONDS),
        "consumed": False,
        "proof_written": False,
        "probe_entry_fingerprint": None,
    }
    if args.settings:
        settings_path = Path(args.settings)
        settings, preimage_digest, _ = _read_settings(settings_path)
        entry = _probe_entry(HERE / "controller.py", str(state_dir))
        _append_hook(settings, "PostToolUse", entry)
        _save_settings_checked(settings_path, settings, preimage_digest)
        pending["probe_entry_fingerprint"] = _entry_fingerprint(entry)
    _secure_write(_probe_pending_path(state_dir), _canonical(pending))
    return 0, json.dumps({"nonce": nonce, "command": command}), ""


def cmd_bind_commit(args, now: str):
    state_dir = Path(args.state_dir)
    pending_path = _probe_pending_path(state_dir)
    proof_path = _probe_proof_path(state_dir)
    if not pending_path.exists() or not proof_path.exists():
        raise sm.ControllerError("PROBE_MISSING")
    pending = _read_json_file(pending_path)
    if pending.get("consumed") or _sha(args.challenge.encode()) != pending.get("nonce_sha256"):
        raise sm.ControllerError("CHALLENGE_INVALID")
    if sm._epoch(now) > sm._epoch(pending["expires_at"]):
        raise sm.ControllerError("CHALLENGE_EXPIRED")
    proof = _read_json_file(proof_path)
    state = sm.load_state(state_dir)
    if proof.get("session_id") != args.confirm_session_id or proof.get("cwd") != state["workspace_root"]:
        raise sm.ControllerError("PROBE_MISMATCH")

    def op(current):
        current["binding"]["supervisor_hook_session_id"] = args.confirm_session_id
        current["binding"]["capability"]["probe_verified"] = True
        current["binding"]["enabled"] = True
        if args.supervisor_ccd_session_id:
            current["binding"]["supervisor_ccd_session_id"] = args.supervisor_ccd_session_id
        current["revision"] += 1
        return current

    state = sm.locked_update(state_dir, expected_revision=state["revision"], operation=op, now=now)
    if args.settings and pending.get("probe_entry_fingerprint"):
        settings_path = Path(args.settings)
        settings, preimage_digest, _ = _read_settings(settings_path)
        _remove_hooks(settings, {pending["probe_entry_fingerprint"]})
        _save_settings_checked(settings_path, settings, preimage_digest)
    pending["consumed"] = True
    _secure_write(pending_path, _canonical(pending))
    return 0, json.dumps({"bound_session_id": args.confirm_session_id}), ""


# ---------------------------------------------------------------------------
# Hook adapter
# ---------------------------------------------------------------------------

def _parse_hook_stdin(stdin_text: str | None) -> dict:
    if stdin_text is None:
        stdin_text = sys.stdin.read(MAX_HOOK_STDIN + 1)
    if len(stdin_text) > MAX_HOOK_STDIN:
        raise HookInputError("HOOK_INPUT_TOO_LARGE")
    try:
        data = json.loads(stdin_text, parse_constant=lambda _: (_ for _ in ()).throw(HookInputError()))
    except (ValueError, HookInputError):
        raise HookInputError("HOOK_INPUT_INVALID")
    if not isinstance(data, dict):
        raise HookInputError("HOOK_INPUT_INVALID")
    return data


def _hook_identity(data: dict, args) -> tuple[str, str] | None:
    session = data.get("session_id")
    cwd = data.get("cwd")
    if not isinstance(session, str) or not session:
        return None
    if data.get("agent_id") or data.get("agent_type"):
        return None
    if not isinstance(cwd, str):
        return None
    if getattr(args, "supervisor_hook_session_id", None) and session != args.supervisor_hook_session_id:
        return None
    return session, cwd


def _block(reason: str) -> tuple[int, str, str]:
    return 0, json.dumps({"decision": "block", "reason": reason}), ""


def cmd_hook(args, now: str, stdin_text: str | None):
    try:
        data = _parse_hook_stdin(stdin_text)
    except HookInputError:
        return 0, "", "HOOK_INPUT_INVALID"
    identity = _hook_identity(data, args)
    if identity is None:
        return 0, "", ""
    session, cwd = identity
    if args.event == "PostToolUse":
        return _hook_probe(args, now, data, session, cwd)
    state_dir = Path(args.state_dir)
    try:
        state = sm.load_state(state_dir)
    except sm.ControllerError as error:
        if error.code in ("STATE_MISSING", "STATE_CORRUPT", "STATE_PERMISSIONS"):
            if getattr(args, "supervisor_hook_session_id", None) == session and not data.get("stop_hook_active"):
                return _block(
                    "GLOBAL_TEAM_STATE_ERROR state unusable; run the controller status command "
                    "to inspect and repair (no auto-init); claim stays refused")
            return 0, "", ""
        return 0, "", error.code
    if not state["binding"]["enabled"]:
        return 0, "", ""
    binding_native = state["binding"]["supervisor_hook_session_id"]
    if binding_native and session != binding_native:
        return 0, "", ""
    if cwd != state["workspace_root"]:
        return 0, "", ""
    if args.event == "UserPromptSubmit":
        return _hook_prompt(args, now, state_dir, state)
    if args.event != "Stop":
        return 0, "", ""
    return _hook_stop(args, now, state_dir, state, data)


def _hook_probe(args, now, data, session, cwd):
    state_dir = Path(args.state_dir)
    pending_path = _probe_pending_path(state_dir)
    if not pending_path.exists():
        return 0, "", ""
    try:
        pending = _read_json_file(pending_path)
    except (sm.ControllerError, ValueError):
        return 0, "", ""
    if pending.get("consumed") or pending.get("proof_written"):
        return 0, "", ""
    if sm._epoch(now) > sm._epoch(pending["expires_at"]):
        return 0, "", ""
    tool_input = data.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(command, str):
        return 0, "", ""
    if _sha(command.encode()) != pending.get("command_sha256"):
        return 0, "", ""
    state = sm.load_state(state_dir)
    bound = state["binding"]["supervisor_hook_session_id"]
    if cwd != state["workspace_root"]:
        return 0, "", ""
    if bound is not None and session != bound:
        return 0, "", ""
    proof = {"session_id": session, "cwd": cwd, "matched_at": now}
    _secure_write(_probe_proof_path(state_dir), _canonical(proof))
    pending["proof_written"] = True
    _secure_write(pending_path, _canonical(pending))
    return 0, "", ""


def _hook_prompt(args, now, state_dir, state):
    def op(current):
        current["input_pending"] = {"active": True, "marked_at": now}
        current["revision"] += 1
        ready = sm.compute_ready_action(current, now)
        current["ready_action"] = ready
        return current

    try:
        state = sm.locked_update(state_dir, expected_revision=state["revision"], operation=op, now=now)
    except sm.ControllerError as error:
        if error.code == "REVISION_CONFLICT":
            return 0, "", ""
        return 0, "", error.code
    context = "GLOBAL_TEAM_INPUT_PENDING coordinate this input with the controller next command"
    return 0, json.dumps({"hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit", "additionalContext": context}}), ""


def _hook_stop(args, now, state_dir, state, data):
    if state["paused"]["active"]:
        return 0, "", ""
    if state["guard"].get("blocked"):
        return 0, "", ""
    task = state["tasks"].get(state["active_task_id"] or "")
    if task is None:
        return 0, "", ""
    ready = state["ready_action"]
    claimed = next((action for action in state["actions"].values()
                    if action["task_id"] == task["task_id"] and action["state"] == "CLAIMED"), None)
    if ready is not None:
        key = ready["action_id"]
        kind = "ACTION_REQUIRED"
        summary = (f"task={task['task_id']} action={key} kind={ready['action_kind']} "
                   f"owner={ready['target_role']} head={task['head'] or 'NONE'}")
    elif claimed is not None:
        key = claimed["action_id"]
        kind = "ACTION_REQUIRED"
        summary = (f"task={task['task_id']} action={key} kind={claimed['action_kind']} "
                   f"owner={claimed['target_role']} head={claimed['head'] or 'NONE'}")
    elif state["input_pending"]["active"]:
        key = f"INPUT:{task['task_id']}:{state['input_pending']['marked_at']}"
        kind = "RECONCILE_INPUT"
        summary = f"task={task['task_id']} pending input requires coordination"
    else:
        return 0, "", ""

    outcome = {"reason": None}

    def op(current):
        guard = current["guard"]
        counts = guard["stop_counts"]
        count = counts.get(key, 0) + 1
        counts[key] = count
        if count > sm.STOP_MAX_ROUNDS:
            guard["blocked"] = True
            outcome["reason"] = ("GLOBAL_TEAM_ACTION_BLOCKED repeated no-progress Stop rounds; "
                                 "supervisor must reconcile the recorded action before automation continues")
        else:
            outcome["reason"] = f"GLOBAL_TEAM_{kind} {summary}; run the controller next command to continue"
        current["revision"] += 1
        return current

    try:
        sm.locked_update(state_dir, expected_revision=state["revision"], operation=op, now=now)
    except sm.ControllerError as error:
        if error.code == "REVISION_CONFLICT":
            return 0, "", ""
        return 0, "", error.code
    return _block(outcome["reason"])


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _read_input_file(path: str):
    raw = Path(path).read_bytes()
    if len(raw) > sm.MAX_EVENT_BYTES:
        raise sm.ControllerError("INPUT_TOO_LARGE")
    return json.loads(raw.decode("utf-8"))


def _locked(args, operation, now):
    state = sm.load_state(Path(args.state_dir))
    return sm.locked_update(Path(args.state_dir),
                            expected_revision=args.expected_revision,
                            operation=operation, now=now)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-team-controller")
    sub = parser.add_subparsers(dest="command")

    def add(name):
        return sub.add_parser(name)

    init = add("init")
    init.add_argument("--state-dir", required=True)
    init.add_argument("--team-id", required=True)
    init.add_argument("--workspace-root", required=True)
    init.add_argument("--roles-file", required=True)

    register = add("register-task")
    register.add_argument("--state-dir", required=True)
    register.add_argument("--input", required=True)
    register.add_argument("--expected-revision", type=int, required=True)

    ingest = add("ingest")
    ingest.add_argument("--state-dir", required=True)
    ingest.add_argument("--input", required=True)
    ingest.add_argument("--expected-revision", type=int, required=True)

    for name in ("status", "next"):
        status = add(name)
        status.add_argument("--state-dir", required=True)

    claim = add("claim")
    claim.add_argument("--state-dir", required=True)
    claim.add_argument("--action-id", required=True)
    claim.add_argument("--actor", required=True)
    claim.add_argument("--expected-revision", type=int, required=True)

    finish = add("finish")
    finish.add_argument("--state-dir", required=True)
    finish.add_argument("--action-id", required=True)
    finish.add_argument("--lease-id", required=True)
    finish.add_argument("--result-file", required=True)
    finish.add_argument("--expected-revision", type=int, required=True)

    for name in ("pause", "resume"):
        cmd = add(name)
        cmd.add_argument("--state-dir", required=True)
        cmd.add_argument("--by", required=True)
        cmd.add_argument("--expected-revision", type=int, required=True)
        if name == "pause":
            cmd.add_argument("--reason", required=True)

    observe = add("observe-input")
    observe.add_argument("--state-dir", required=True)
    observe.add_argument("--result-file", required=True)
    observe.add_argument("--by", required=True)
    observe.add_argument("--expected-revision", type=int, required=True)

    prepare = add("prepare-bind")
    prepare.add_argument("--state-dir", required=True)
    prepare.add_argument("--settings")

    bind = add("bind-commit")
    bind.add_argument("--state-dir", required=True)
    bind.add_argument("--confirm-session-id", required=True)
    bind.add_argument("--challenge", required=True)
    bind.add_argument("--settings")
    bind.add_argument("--supervisor-ccd-session-id")

    install = add("install-hooks")
    install.add_argument("--state-dir", required=True)
    install.add_argument("--settings", required=True)
    install.add_argument("--tool-commit", required=True)
    install.add_argument("--source-dir", required=True)
    install.add_argument("--install-root", required=True)

    uninstall = add("uninstall-hooks")
    uninstall.add_argument("--state-dir", required=True)
    uninstall.add_argument("--settings", required=True)

    hook = add("hook")
    hook.add_argument("--event", required=True)
    hook.add_argument("--state-dir", required=True)
    hook.add_argument("--probe", action="store_true")
    hook.add_argument("--supervisor-hook-session-id")
    hook.add_argument("--supervisor-ccd-session-id")
    return parser


def run(argv, stdin_text: str | None = None, now: str | None = None):
    now = now or _now()
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "init":
            roles = json.loads(Path(args.roles_file).read_text(encoding="utf-8"))
            state = sm.init_state(Path(args.state_dir), team_id=args.team_id,
                                  workspace_root=args.workspace_root, roles=roles, now=now)
            return 0, json.dumps({"revision": state["revision"]}), ""
        if args.command == "register-task":
            spec = _read_input_file(args.input)
            state = _locked(args, lambda current: sm.register_task(
                current, spec, now=now, expected_revision=current["revision"]), now)
            return 0, json.dumps({"revision": state["revision"],
                                  "ready_action": state["ready_action"]}), ""
        if args.command == "ingest":
            event = _read_input_file(args.input)
            state = _locked(args, lambda current: sm.reduce_event(current, event, now=now), now)
            return 0, json.dumps({"revision": state["revision"],
                                  "ready_action": state["ready_action"]}), ""
        if args.command in ("status", "next"):
            state = sm.load_state(Path(args.state_dir))
            task = state["tasks"].get(state["active_task_id"] or "")
            payload = {
                "revision": state["revision"],
                "paused": state["paused"]["active"],
                "input_pending": state["input_pending"]["active"],
                "active_task": state["active_task_id"],
                "phase": task["phase"] if task else None,
                "wait": task["wait"] if task else None,
                "ready_action": state["ready_action"],
            }
            if args.command == "next":
                payload = state["ready_action"] or {"stop": True}
            return 0, json.dumps(payload), ""
        if args.command == "claim":
            preloaded = sm.load_state(Path(args.state_dir))
            if sm._expire_leases(preloaded, now):
                sm.locked_update(Path(args.state_dir),
                                 expected_revision=preloaded["revision"],
                                 operation=lambda current: current, now=now)
                raise sm.ControllerError("LEASE_EXPIRED")
            claim_out = {}

            def claim_op(current):
                new_state, claim = sm.claim_action(
                    current, args.action_id, actor=args.actor,
                    expected_revision=current["revision"], now=now)
                claim_out.update(claim)
                return new_state

            sm.locked_update(Path(args.state_dir), expected_revision=args.expected_revision,
                             operation=claim_op, now=now)
            return 0, json.dumps({"lease_id": claim_out.get("lease_id"),
                                  "action_id": claim_out.get("action_id")}), ""
        if args.command == "finish":
            result = _read_input_file(args.result_file)
            state = _locked(args, lambda current: sm.finish_action(
                current, args.action_id, args.lease_id, result, now=now), now)
            return 0, json.dumps({"revision": state["revision"],
                                  "ready_action": state["ready_action"]}), ""
        if args.command == "pause":
            state = _locked(args, lambda current: sm.set_paused(
                current, reason=args.reason, by=args.by, now=now), now)
            return 0, json.dumps({"revision": state["revision"]}), ""
        if args.command == "resume":
            state = _locked(args, lambda current: sm.set_resumed(
                current, by=args.by, now=now), now)
            return 0, json.dumps({"revision": state["revision"],
                                  "ready_action": state["ready_action"]}), ""
        if args.command == "observe-input":
            result = _read_input_file(args.result_file)
            state = _locked(args, lambda current: sm.observe_input(
                current, result, by=args.by, now=now), now)
            return 0, json.dumps({"revision": state["revision"],
                                  "ready_action": state["ready_action"]}), ""
        if args.command == "prepare-bind":
            return cmd_prepare_bind(args, now)
        if args.command == "bind-commit":
            return cmd_bind_commit(args, now)
        if args.command == "install-hooks":
            return cmd_install_hooks(args, now)
        if args.command == "uninstall-hooks":
            return cmd_uninstall_hooks(args, now)
        if args.command == "hook":
            return cmd_hook(args, now, stdin_text)
        parser.error("unknown command")
    except sm.ControllerError as error:
        return 3, "", error.code
    except AttributeError:
        return 3, "", "CLI_PROTOCOL_ERROR"
    except (ValueError, OSError):
        return 3, "", "CONTROLLER_ERROR"


def main() -> int:
    code, out, err = run(sys.argv[1:])
    if out:
        sys.stdout.write(out + ("" if out.endswith("\n") else "\n"))
    if err:
        sys.stderr.write(err + "\n")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
