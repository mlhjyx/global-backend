import { runLeadQualityLabelOperator } from "../src/lead-quality-labels/lead-quality-label.operator-cli";

try {
  process.exitCode = await runLeadQualityLabelOperator(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "operator failed");
  process.exitCode = 1;
}
