#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { backupGraph, createCandidate, promoteCandidate, restoreGraph, unlockGraph, verifyGraph, MemoryCtlError } from "./memoryctl-lib.mjs";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  return { command, args };
}

function options(args) {
  return {
    auditDir: args["audit-dir"],
    backupDir: args["backup-dir"],
    codexConfigPath: args["codex-config"],
    graphPath: args.graph ?? process.env.MEMORY_FILE_PATH ?? "/root/.codex/mcp-memory/knowledge-graph.jsonl",
    inboxDir: args["inbox-dir"],
  };
}

function usage() {
  return `Usage:\n  memoryctl candidate --input candidate.json [--graph path]\n  memoryctl promote --candidate inbox/id.json --expected-candidate-hash sha256 --expected-graph-hash sha256 [--graph path]\n  memoryctl verify [--graph path] [--codex-config /root/.codex/config.toml]\n  memoryctl backup [--graph path]\n  memoryctl restore --backup backup.jsonl --expected-graph-hash sha256 [--graph path]\n  memoryctl unlock --expected-lock-hash sha256 --expected-graph-hash sha256 --reason text [--graph path]\n\nThe CLI never accepts free-form graph mutations. Promotion, restore, and audited unlock require exact hashes.`;
}

try {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (!command || command === "help") {
    console.log(usage());
  } else if (command === "candidate") {
    const input = JSON.parse(await readFile(args.input, "utf8"));
    const result = await createCandidate(input, options(args));
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "promote") {
    const result = await promoteCandidate(args.candidate, {
      ...options(args),
      expectedCandidateHash: args["expected-candidate-hash"],
      expectedGraphHash: args["expected-graph-hash"],
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "verify") {
    console.log(JSON.stringify(await verifyGraph(options(args)), null, 2));
  } else if (command === "backup") {
    console.log(JSON.stringify(await backupGraph(options(args)), null, 2));
  } else if (command === "restore") {
    console.log(JSON.stringify(await restoreGraph(args.backup, { ...options(args), expectedGraphHash: args["expected-graph-hash"] }), null, 2));
  } else if (command === "unlock") {
    console.log(JSON.stringify(await unlockGraph({ ...options(args), expectedGraphHash: args["expected-graph-hash"], expectedLockHash: args["expected-lock-hash"], reason: args.reason }), null, 2));
  } else {
    throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  const safe = error instanceof MemoryCtlError ? { code: error.code, message: error.message, details: error.details } : { code: "MEMORYCTL_ERROR", message: error.message };
  console.error(JSON.stringify(safe));
  process.exitCode = 1;
}
