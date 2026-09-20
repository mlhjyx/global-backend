import {
  constants,
  lstatSync,
  realpathSync,
  readdirSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJsonBytes,
  hasExactKeys,
} from "./governance-organization-identity-controller-contracts.mjs";
import {
  verifyPinnedFileSet,
  recheckPinnedFileSet,
  collectTrustedParentIdentities,
} from "./governance-organization-identity-file-pins.mjs";
import { buildReadOnlyChildProfile } from "./governance-organization-identity-child-profile.mjs";
const hold = (code) => ({ status: "HOLD", code, admissionGranted: false });
const required = ["NODE", "GIT", "GH", "GIT_REMOTE_HTTPS"];
function workspace(layout) {
  const facts = [];
  for (const [key, p] of Object.entries(layout)) {
    const parents = collectTrustedParentIdentities(p);
    const stat = lstatSync(p, { bigint: true });
    if (
      realpathSync(p) !== p ||
      !stat.isDirectory() ||
      stat.uid !== 0n ||
      stat.gid !== 0n ||
      (stat.mode & 0o7777n) !== 0o700n
    )
      throw Error("workspace unsafe");
    const contents = readdirSync(p).sort();
    if (
      key === "helpers"
        ? contents.length !== 1 || contents[0] !== "git-remote-https"
        : contents.length !== 0
    )
      throw Error("workspace not empty");
    facts.push({
      parents,
      key,
      path: p,
      dev: String(stat.dev),
      ino: String(stat.ino),
      mode: String(stat.mode),
      uid: String(stat.uid),
      gid: String(stat.gid),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
    });
  }
  return facts;
}
// Offline inspection only. This entry point intentionally has no process runner,
// credential reader, journal writer or GitHub mutation dependency.
export function inspectBrokerPreparation(manifest) {
  try {
    if (
      !hasExactKeys(manifest, ["schemaVersion", "layout", "filePins"]) ||
      manifest.schemaVersion !== "identity-broker-local-preflight/v1"
    )
      return hold("BROKER_PREFLIGHT_MANIFEST_INVALID");
    const profiles = ["GIT", "GH"].map((role) =>
      buildReadOnlyChildProfile(role, manifest.layout),
    );
    if (profiles.some((p) => p.status !== "PASS"))
      return hold("BROKER_PREFLIGHT_LAYOUT_INVALID");
    const pins = verifyPinnedFileSet(manifest.filePins);
    if (pins.status !== "PASS")
      return hold("BROKER_PREFLIGHT_FILE_PINS_INVALID");
    if (
      !required.every((role) =>
        manifest.filePins.some((p) => p.role === role && p.mode === 0o555),
      ) ||
      manifest.filePins.find((p) => p.role === "GIT_REMOTE_HTTPS")?.path !==
        path.join(manifest.layout.helpers, "git-remote-https")
    )
      return hold("BROKER_PREFLIGHT_REQUIRED_TOOLS_MISSING");
    const before = workspace(manifest.layout),
      afterPins = recheckPinnedFileSet(pins);
    if (
      afterPins.status !== "PASS" ||
      !canonicalJsonBytes(before).equals(
        canonicalJsonBytes(workspace(manifest.layout)),
      )
    )
      return hold("BROKER_PREFLIGHT_FILESYSTEM_DRIFT");
    return {
      ...hold("BROKER_EXECUTION_NOT_ADMITTED"),
      evidenceClass: "LOCAL_PREFLIGHT_ONLY",
      localChecks: "PASS",
      fileObservation: afterPins,
      profiles,
      remainingGates: [
        "COMPLETE_TRANSPORT_CLOSURE_REVIEW",
        "FIXED_CONTROLLER_AND_RECEIPT_PRODUCER",
        "EXACT_MATERIALIZATION_AND_OPERATION_AUTHORIZATION",
        "INDEPENDENT_AUTHORITY_READBACK",
      ],
    };
  } catch {
    return hold("BROKER_PREFLIGHT_FILESYSTEM_INVALID");
  }
}
function readManifest(p) {
  if (
    typeof p !== "string" ||
    !path.isAbsolute(p) ||
    path.normalize(p) !== p ||
    realpathSync(p) !== p
  )
    throw Error("path");
  const fd = openSync(
    p,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const s = fstatSync(fd, { bigint: true }),
      before = lstatSync(p, { bigint: true });
    if (
      !s.isFile() ||
      s.nlink !== 1n ||
      s.uid !== 0n ||
      s.gid !== 0n ||
      (s.mode & 0o7777n) !== 0o600n ||
      s.size <= 0n ||
      s.size > 131072n ||
      s.dev !== before.dev ||
      s.ino !== before.ino
    )
      throw Error("metadata");
    const bytes = Buffer.alloc(Number(s.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true }),
      afterPath = lstatSync(p, { bigint: true });
    const keys = [
      "dev",
      "ino",
      "mode",
      "uid",
      "gid",
      "nlink",
      "size",
      "mtimeNs",
      "ctimeNs",
    ];
    if (
      offset !== Number(s.size) ||
      keys.some((k) => s[k] !== after[k] || s[k] !== afterPath[k]) ||
      realpathSync(p) !== p
    )
      throw Error("drift");
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, offset),
      ),
    );
    if (!canonicalJsonBytes(value).equals(bytes.subarray(0, offset)))
      throw Error("canonical");
    return value;
  } finally {
    closeSync(fd);
  }
}
export function brokerPreflightCli(argv) {
  if (argv.length !== 2 || argv[0] !== "inspect")
    return { exitCode: 64, result: hold("BROKER_PREFLIGHT_ARGUMENTS_INVALID") };
  try {
    return {
      exitCode: 2,
      result: inspectBrokerPreparation(readManifest(argv[1])),
    };
  } catch {
    return { exitCode: 2, result: hold("BROKER_PREFLIGHT_MANIFEST_INVALID") };
  }
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const { exitCode, result } = brokerPreflightCli(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = exitCode;
}
