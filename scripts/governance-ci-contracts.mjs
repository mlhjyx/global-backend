import {
  SHA_40,
  asArray,
  isNonEmptyString,
  isObject,
  issue,
  result,
  uniqueStrings,
} from "./governance-evidence-provider-contracts.mjs";

function workflowContextNames(workflows) {
  const names = new Set();
  for (const text of workflows.values()) {
    for (const line of String(text).split(/\r?\n/)) {
      const match = line.match(/^ {4}name:\s*["']?(.+?)["']?\s*$/);
      if (match) names.add(match[1].trim());
    }
  }
  return names;
}

function workflowDeclaresEvent(text, eventName) {
  const lines = String(text).split(/\r?\n/);
  const onIndex = lines.findIndex((line) => /^on:\s*/.test(line));
  if (onIndex < 0) return false;
  const inline = lines[onIndex].replace(/^on:\s*/, "").trim();
  if (inline) {
    return new RegExp(`(?:^|[\\s,\\[])${eventName}(?:$|[\\s,\\]])`).test(
      inline,
    );
  }
  for (let index = onIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && !/^\s/.test(line)) break;
    if (new RegExp(`^ {2}${eventName}:`).test(line)) return true;
  }
  return false;
}

function workflowPinsNodeMajor(text, nodeMajor) {
  return (
    /uses:\s*actions\/setup-node@[^\s]+/.test(String(text)) &&
    new RegExp(
      `^\\s*node-version:\\s*["']?${nodeMajor}(?:\\.x)?["']?\\s*(?:#.*)?$`,
      "m",
    ).test(String(text))
  );
}

function workflowActions(text) {
  const actions = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?\s*$/,
    );
    if (!match) continue;
    const reference = match[1];
    const separator = reference.lastIndexOf("@");
    actions.push({
      action: separator > 0 ? reference.slice(0, separator) : reference,
      revision: separator > 0 ? reference.slice(separator + 1) : "",
      version: match[2] ?? null,
    });
  }
  return actions;
}

function codeownerRules(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/).join(" "));
}

function validateWorkflowActionPins(policy, workflows, issues) {
  const pins = asArray(policy?.workflow_action_pins);
  const identities = pins.map((pin) => `${pin?.workflow}\0${pin?.action}`);
  if (
    pins.length === 0 ||
    pins.some(
      (pin) =>
        !isObject(pin) ||
        !isNonEmptyString(pin.workflow) ||
        !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(pin.action ?? "") ||
        !SHA_40.test(pin.revision ?? "") ||
        !/^v[0-9]+(?:\.[0-9]+){0,2}$/.test(pin.version ?? ""),
    ) ||
    !uniqueStrings(identities)
  ) {
    issues.push(
      issue(
        "WORKFLOW_ACTION_PIN_POLICY_INVALID",
        "workflow_action_pins must contain unique workflow/action pairs with a full revision and version comment",
      ),
    );
  }

  for (const pin of pins) {
    if (!isObject(pin) || !isNonEmptyString(pin.workflow)) continue;
    const actions = workflowActions(workflows.get(pin.workflow) ?? "");
    const declared = actions.find((item) => item.action === pin.action);
    if (!declared) {
      issues.push(
        issue(
          "WORKFLOW_ACTION_PIN_MISSING",
          `${pin.workflow} does not use required action ${pin.action}`,
        ),
      );
    } else if (
      declared.revision !== pin.revision ||
      declared.version !== pin.version ||
      !SHA_40.test(declared.revision)
    ) {
      issues.push(
        issue(
          "WORKFLOW_ACTION_UNPINNED",
          `${pin.workflow} must pin ${pin.action} to ${pin.revision} with comment ${pin.version}`,
        ),
      );
    }
  }

  for (const [workflowPath, workflow] of workflows) {
    for (const declared of workflowActions(workflow)) {
      if (declared.action.startsWith("./")) continue;
      const matchingPin = pins.find(
        (pin) =>
          pin?.workflow === workflowPath &&
          pin?.action === declared.action &&
          pin?.revision === declared.revision &&
          pin?.version === declared.version,
      );
      if (!SHA_40.test(declared.revision) || !matchingPin) {
        issues.push(
          issue(
            "WORKFLOW_ACTION_UNPINNED",
            `${workflowPath} contains an unapproved action reference ${declared.action}@${declared.revision}`,
          ),
        );
      }
    }
  }
}

function validateCodeownerProtection(policy, repositoryContext, issues) {
  const requirements = policy?.codeowner_requirements;
  const patterns = asArray(requirements?.terminal_patterns);
  if (
    !isObject(requirements) ||
    !/^@[A-Za-z0-9_.-]+$/.test(requirements.owner ?? "") ||
    patterns.length === 0 ||
    patterns.some((pattern) => !isNonEmptyString(pattern)) ||
    !uniqueStrings(patterns)
  ) {
    issues.push(
      issue(
        "CODEOWNER_POLICY_INVALID",
        "codeowner_requirements must define one owner and unique terminal patterns",
      ),
    );
    return;
  }
  const expected = patterns.map((pattern) => `${pattern} ${requirements.owner}`);
  const actualRules = codeownerRules(repositoryContext?.codeowners);
  const terminalRules = actualRules.slice(-expected.length);
  if (
    terminalRules.length !== expected.length ||
    expected.some((rule, index) => terminalRules[index] !== rule)
  ) {
    issues.push(
      issue(
        "CODEOWNER_PROTECTION_MISSING",
        "CODEOWNERS must end with the complete governance ownership block so later rules cannot override it",
      ),
    );
  }
}

export function validateRequiredContexts(
  policy,
  workflows = new Map(),
  repositoryContext = {},
) {
  const issues = [];
  if (!isObject(policy) || policy.schema_version !== "required-contexts/v1") {
    issues.push(
      issue(
        "REQUIRED_CONTEXT_POLICY_INVALID",
        "schema_version must equal required-contexts/v1",
      ),
    );
  }
  const requiredContexts = asArray(policy?.required_contexts);
  if (
    requiredContexts.length === 0 ||
    requiredContexts.some((name) => !isNonEmptyString(name)) ||
    !uniqueStrings(requiredContexts)
  ) {
    issues.push(
      issue(
        "REQUIRED_CONTEXTS_INVALID",
        "required_contexts must contain unique non-empty names",
      ),
    );
  }
  const ruleset = policy?.external_ruleset_requirements;
  if (
    !isObject(ruleset) ||
    !Number.isInteger(ruleset.required_approving_reviews) ||
    ruleset.required_approving_reviews < 1 ||
    ruleset.require_code_owner_review !== true ||
    ruleset.dismiss_stale_reviews !== true ||
    ruleset.require_conversation_resolution !== true ||
    ruleset.allow_force_push !== false ||
    ruleset.allow_deletion !== false ||
    !isNonEmptyString(ruleset.user_authorization) ||
    !isNonEmptyString(ruleset.merge_evidence)
  ) {
    issues.push(
      issue(
        "EXTERNAL_RULESET_REQUIREMENTS_UNSAFE",
        "external ruleset requirements must retain review, CODEOWNERS, conversation, and history protections",
      ),
    );
  }
  const implemented = workflowContextNames(workflows);
  const implementations = asArray(policy?.context_implementations);
  const implementationNames = implementations.map((item) => item?.name);
  if (
    implementations.length !== requiredContexts.length ||
    implementations.some(
      (item) =>
        !isObject(item) ||
        !isNonEmptyString(item.name) ||
        !isNonEmptyString(item.workflow) ||
        !isNonEmptyString(item.event),
    ) ||
    !uniqueStrings(implementationNames)
  ) {
    issues.push(
      issue(
        "REQUIRED_CONTEXT_IMPLEMENTATIONS_INVALID",
        "each required context needs one unique workflow/event implementation",
      ),
    );
  }
  const implementationsByName = new Map(
    implementations
      .filter((item) => isObject(item) && isNonEmptyString(item.name))
      .map((item) => [item.name, item]),
  );
  for (const contextName of requiredContexts) {
    const implementation = implementationsByName.get(contextName);
    const workflow = implementation
      ? workflows.get(implementation.workflow)
      : undefined;
    if (!implementation || !workflow) {
      issues.push(
        issue(
          "REQUIRED_CONTEXT_IMPLEMENTATION_MISSING",
          `required context has no declared workflow implementation: ${contextName}`,
        ),
      );
    }
    if (!implemented.has(contextName) || !workflowContextNames(new Map([["declared", workflow ?? ""]])).has(contextName)) {
      issues.push(
        issue(
          "REQUIRED_CONTEXT_NOT_IMPLEMENTED",
          `required context is not implemented by a workflow: ${contextName}`,
        ),
      );
    }
    if (
      workflow &&
      !workflowDeclaresEvent(workflow, implementation.event)
    ) {
      issues.push(
        issue(
          "REQUIRED_CONTEXT_EVENT_MISSING",
          `${implementation.workflow} does not declare ${implementation.event} for ${contextName}`,
        ),
      );
    }
  }
  const runtimeRequirements = asArray(policy?.workflow_runtime_requirements);
  const runtimeWorkflowPaths = runtimeRequirements.map(
    (requirement) => requirement?.workflow,
  );
  if (
    runtimeRequirements.length === 0 ||
    runtimeRequirements.some(
      (requirement) =>
        !isObject(requirement) ||
        !isNonEmptyString(requirement.workflow) ||
        !Number.isInteger(requirement.node_major) ||
        requirement.node_major < 20,
    ) ||
    !uniqueStrings(runtimeWorkflowPaths)
  ) {
    issues.push(
      issue(
        "WORKFLOW_RUNTIME_REQUIREMENTS_INVALID",
        "workflow_runtime_requirements must pin unique workflow paths to supported Node majors",
      ),
    );
  }
  for (const requirement of runtimeRequirements) {
    if (
      isObject(requirement) &&
      isNonEmptyString(requirement.workflow) &&
      Number.isInteger(requirement.node_major) &&
      !workflowPinsNodeMajor(
        workflows.get(requirement.workflow) ?? "",
        requirement.node_major,
      )
    ) {
      issues.push(
        issue(
          "WORKFLOW_NODE_RUNTIME_UNPINNED",
          `${requirement.workflow} must pin Node ${requirement.node_major} with actions/setup-node`,
        ),
      );
    }
  }
  validateWorkflowActionPins(policy, workflows, issues);
  validateCodeownerProtection(policy, repositoryContext, issues);
  return result(issues, {
    implemented_contexts: Object.freeze([...implemented].sort()),
  });
}
