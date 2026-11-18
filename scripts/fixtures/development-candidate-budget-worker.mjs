import { CandidateBudgetLedger } from "../development-candidate-budget.mjs";

const [ledgerPath, config, now, request] = process.argv.slice(2);
const ledger = new CandidateBudgetLedger(ledgerPath, JSON.parse(config), { now: () => Number(now) });
try {
  ledger.allocate(JSON.parse(request));
  process.stdout.write("allocated");
} catch (error) {
  if (error.code !== "CANDIDATE_BUDGET_EXCEEDED") throw error;
  process.stdout.write("denied");
} finally {
  ledger.close();
}
