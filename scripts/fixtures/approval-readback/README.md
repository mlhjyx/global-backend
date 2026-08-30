# Approval readback fixtures

These fixtures are bounded, synthetic inputs for the pure Task 3 approval
readback validator. They contain no GitHub response bodies, credentials,
customer data, or external observations.

`review-commands.json` fixes the only accepted one-line review command and a
small representative rejection set. The full security, actor, check, grant,
consumption, revocation, supersession, and TOCTOU mutation matrix is generated
in memory by `scripts/governance-approval-readback.spec.mjs`; it never performs
filesystem, network, shell, or GitHub operations through the production
validator.

