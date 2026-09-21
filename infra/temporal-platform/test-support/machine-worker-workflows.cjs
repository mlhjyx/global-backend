// Isolated native authorization fixture; never imported by product composition.
const { proxyActivities, sleep } = require("@temporalio/workflow");
const activities = proxyActivities({
  startToCloseTimeout: "10s",
  heartbeatTimeout: "5s",
});
exports.MachineWorkerProof = async function MachineWorkerProof() {
  const first = await activities.machineProofActivity("first");
  await sleep("100ms");
  const second = await activities.machineProofActivity("second");
  return `${first}:${second}`;
};
// The preceding baseline Schedule proof uses this registered test-only type on
// the same approved queue; let the real Worker drain it without unknown-type retries.
exports.PlatformAutomationProofWorkflow = exports.MachineWorkerProof;
