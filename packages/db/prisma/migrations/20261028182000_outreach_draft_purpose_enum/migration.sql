-- BI-15 / L5: the outreach draft endpoint consumes a workspace grant whose purpose is
-- outreach.draft. PostgreSQL requires a newly added enum value to commit before later
-- schema objects (the authority CHECK and consume function) may reference it, so the
-- addition is its own forward-only phase; 20261028183000 applies the use.
ALTER TYPE "execution_budget_purpose"
  ADD VALUE IF NOT EXISTS 'outreach.draft' AFTER 'contact.verify';
