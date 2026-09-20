import path from "node:path";
import { hasExactKeys } from "./governance-organization-identity-controller-contracts.mjs";
const hold = () => ({ status: "HOLD", code: "CHILD_PROFILE_INPUT_INVALID" });
const keys = ["cwd", "home", "config", "temporary", "helpers"];
function valid(layout) {
  if (
    !hasExactKeys(layout, keys) ||
    !keys.every(
      (k) =>
        typeof layout[k] === "string" &&
        layout[k].length <= 4096 &&
        !layout[k].endsWith("/") &&
        !layout[k].includes(path.delimiter) &&
        path.isAbsolute(layout[k]) &&
        path.normalize(layout[k]) === layout[k] &&
        !layout[k].includes("\0"),
    )
  )
    return false;
  const paths = keys.map((k) => layout[k]);
  return paths.every((a, i) =>
    paths.every(
      (b, j) =>
        i === j ||
        (a !== b && !a.startsWith(b + "/") && !b.startsWith(a + "/")),
    ),
  );
}

// Public, credential-free descriptors. No filesystem observation, executable
// authorization or transport-completeness claim is made by this constructor.
export function buildReadOnlyChildProfile(role, layout) {
  if (!["GIT", "GH"].includes(role) || !valid(layout)) return hold();
  const common = {
    HOME: layout.home,
    XDG_CONFIG_HOME: layout.config,
    TMPDIR: layout.temporary,
    PATH: layout.helpers,
    LC_ALL: "C",
  };
  let argv, environment, credentialBinding;
  if (role === "GIT") {
    const options = [
      "credential.helper=",
      "credential.interactive=false",
      "http.proxy=",
      "http.followRedirects=false",
      "http.sslVerify=true",
      "http.extraHeader=",
      "protocol.allow=never",
      "protocol.https.allow=always",
      "core.hooksPath=/dev/null",
      "core.fsmonitor=false",
      "protocol.version=2",
    ];
    argv = [
      "--no-pager",
      "--no-replace-objects",
      ...options.flatMap((option) => ["-c", option]),
      "--config-env=http.extraHeader=IDENTITY_GIT_AUTHORIZATION",
      "ls-remote",
      "--exit-code",
      "--refs",
      "https://github.com/mlhjyx/global-backend.git",
      "refs/heads/main",
    ];
    environment = {
      ...common,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "0",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_ALLOW_PROTOCOL: "https",
      GIT_EXEC_PATH: layout.helpers,
      GIT_CEILING_DIRECTORIES: layout.cwd,
    };
    credentialBinding = {
      name: "IDENTITY_GIT_AUTHORIZATION",
      encoding: "HTTP_BASIC_X_ACCESS_TOKEN",
    };
  } else {
    argv = [
      "api",
      "repos/mlhjyx/global-backend/branches/main",
      "--method",
      "GET",
      "--jq",
      "[.name,.commit.sha,.protected] | @tsv",
    ];
    environment = {
      ...common,
      GH_HOST: "github.com",
      GH_REPO: "github.com/mlhjyx/global-backend",
      GH_CONFIG_DIR: layout.config,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
    };
    credentialBinding = { name: "GH_TOKEN", encoding: "RAW" };
  }
  return Object.freeze({
    status: "PASS",
    evidenceClass: "LOCAL_COMMAND_PROFILE_ONLY",
    admissionGranted: false,
    networkReadiness: "UNVERIFIED",
    operation: "PROTECTED_MAIN_READBACK",
    role,
    cwd: layout.cwd,
    argv: Object.freeze(argv),
    environment: Object.freeze(environment),
    credentialBinding: Object.freeze(credentialBinding),
    timeoutMs: 15000,
    maxOutputBytes: 4096,
  });
}
