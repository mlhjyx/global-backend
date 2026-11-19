// Operator-only conservative Grant allocation. Never signs a SaaS Grant,
// changes a product BudgetStore, refunds a slice, or dispatches a request.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DIGEST = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SAFE_ID = /^[a-zA-Z0-9_.:/-]{1,200}$/u;
const PURPOSES = new Set([
  "icp.design",
  "icp.query_plan",
  "discovery.run",
  "understanding.run",
  "contact.verify",
  "contact.enrich",
]);
function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function campaignConfiguration(input) {
  if (
    !input ||
    typeof input.campaignId !== "string" ||
    !SAFE_ID.test(input.campaignId) ||
    !positive(input.capMicrousd) ||
    input.capMicrousd > 5_000_000 ||
    typeof input.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(input.expiresAt)) ||
    new Date(input.expiresAt).toISOString() !== input.expiresAt ||
    !input.arms ||
    Object.keys(input.arms).sort().join(",") !== "A,B"
  )
    fail("CANDIDATE_CAMPAIGN_INVALID");
  const arms = Object.fromEntries(
    ["A", "B"].map((arm) => {
      const value = input.arms[arm];
      if (
        !value ||
        !UUID.test(value.workspaceId) ||
        !positive(value.capMicrousd) ||
        value.capMicrousd > 2_500_000
      )
        fail("CANDIDATE_CAMPAIGN_INVALID");
      return [
        arm,
        { workspaceId: value.workspaceId, capMicrousd: value.capMicrousd },
      ];
    }),
  );
  if (
    arms.A.workspaceId === arms.B.workspaceId ||
    arms.A.capMicrousd + arms.B.capMicrousd > input.capMicrousd
  )
    fail("CANDIDATE_CAMPAIGN_INVALID");
  return {
    campaignId: input.campaignId,
    expiresAt: input.expiresAt,
    capMicrousd: input.capMicrousd,
    arms,
  };
}
function privateDatabasePath(input) {
  const path = resolve(input),
    parent = dirname(path);
  let directory;
  try {
    directory = lstatSync(parent);
  } catch {
    fail("CANDIDATE_LEDGER_PATH_INVALID");
  }
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid() ||
    (directory.mode & 0o077) !== 0 ||
    realpathSync(parent) !== parent
  )
    fail("CANDIDATE_LEDGER_PATH_INVALID");
  try {
    closeSync(
      openSync(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_RDWR,
        0o600,
      ),
    );
  } catch (error) {
    if (error.code !== "EEXIST") fail("CANDIDATE_LEDGER_PATH_INVALID");
  }
  const file = lstatSync(path);
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.nlink !== 1 ||
    file.uid !== process.getuid() ||
    (file.mode & 0o077) !== 0
  )
    fail("CANDIDATE_LEDGER_PATH_INVALID");
  return path;
}

export class CandidateBudgetLedger {
  #db;
  #config;
  #now;
  constructor(path, configuration, { now = Date.now } = {}) {
    this.#config = campaignConfiguration(configuration);
    this.#now = now;
    this.#db = new DatabaseSync(privateDatabasePath(path));
    try {
      this.#db.exec(
        "PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;",
      );
      this.#transaction(() => {
        this.#db
          .exec(`CREATE TABLE IF NOT EXISTS campaign (singleton INTEGER PRIMARY KEY CHECK(singleton=1), configuration TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS allocation (
            id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, arm TEXT NOT NULL,
            workspace_id TEXT NOT NULL, purpose TEXT NOT NULL, quote_sha256 TEXT NOT NULL,
            cap_microusd INTEGER NOT NULL CHECK(cap_microusd>0),
            state TEXT NOT NULL CHECK(state IN ('ALLOCATED','ISSUING','BOUND','UNKNOWN')),
            account_key TEXT UNIQUE, grant_sha256 TEXT UNIQUE);`);
        const encoded = JSON.stringify(this.#config);
        const prior = this.#db
          .prepare("SELECT configuration FROM campaign WHERE singleton=1")
          .get();
        if (prior && prior.configuration !== encoded)
          fail("CANDIDATE_CAMPAIGN_CONFLICT");
        if (!prior)
          this.#db.prepare("INSERT INTO campaign VALUES(1,?)").run(encoded);
      });
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  #transaction(action) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = action();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  #fresh() {
    const now = this.#now();
    if (!Number.isFinite(now) || now >= Date.parse(this.#config.expiresAt))
      fail("CANDIDATE_CAMPAIGN_EXPIRED");
  }
  #row(id) {
    const row = this.#db.prepare("SELECT * FROM allocation WHERE id=?").get(id);
    if (!row) fail("CANDIDATE_ALLOCATION_NOT_FOUND");
    return row;
  }
  #public(row) {
    return {
      id: row.id,
      requestKey: row.request_key,
      arm: row.arm,
      workspaceId: row.workspace_id,
      purpose: row.purpose,
      quoteSha256: row.quote_sha256,
      capMicrousd: row.cap_microusd,
      state: row.state,
      accountKey: row.account_key,
      grantSha256: row.grant_sha256,
    };
  }
  allocate(input) {
    const arm = input && this.#config.arms[input.arm];
    if (
      !arm ||
      input.workspaceId !== arm.workspaceId ||
      !DIGEST.test(input.requestKey) ||
      !DIGEST.test(input.quoteSha256) ||
      !PURPOSES.has(input.purpose) ||
      !positive(input.capMicrousd)
    )
      fail("CANDIDATE_ALLOCATION_INVALID");
    return this.#transaction(() => {
      const prior = this.#db
        .prepare("SELECT * FROM allocation WHERE request_key=?")
        .get(input.requestKey);
      if (prior) {
        if (
          prior.arm !== input.arm ||
          prior.workspace_id !== input.workspaceId ||
          prior.purpose !== input.purpose ||
          prior.quote_sha256 !== input.quoteSha256 ||
          prior.cap_microusd !== input.capMicrousd
        )
          fail("CANDIDATE_ALLOCATION_CONFLICT");
        return this.#public(prior);
      }
      this.#fresh();
      if (
        this.#db.prepare("SELECT count(*) AS count FROM allocation").get()
          .count >= 128
      )
        fail("CANDIDATE_ALLOCATION_LIMIT");
      const status = this.status();
      if (
        status.allocatedMicrousd + input.capMicrousd >
          this.#config.capMicrousd ||
        status.arms[input.arm].allocatedMicrousd + input.capMicrousd >
          arm.capMicrousd
      )
        fail("CANDIDATE_BUDGET_EXCEEDED");
      const id = createHash("sha256")
        .update(`${this.#config.campaignId}:${input.requestKey}`)
        .digest("hex");
      this.#db
        .prepare(
          "INSERT INTO allocation(id,request_key,arm,workspace_id,purpose,quote_sha256,cap_microusd,state) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          input.requestKey,
          input.arm,
          input.workspaceId,
          input.purpose,
          input.quoteSha256,
          input.capMicrousd,
          "ALLOCATED",
        );
      return this.#public(this.#row(id));
    });
  }
  beginIssuance(id) {
    return this.#transaction(() => {
      this.#fresh();
      const row = this.#row(id);
      if (row.state !== "ALLOCATED") fail("CANDIDATE_GRANT_ALREADY_DISPATCHED");
      this.#db
        .prepare("UPDATE allocation SET state='ISSUING' WHERE id=?")
        .run(id);
      return this.#public(this.#row(id));
    });
  }
  bind(
    id,
    {
      accountKey,
      grantSha256,
      workspaceId,
      purpose,
      requestSha256,
      capMicrousd,
    },
  ) {
    if (
      typeof accountKey !== "string" ||
      !SAFE_ID.test(accountKey) ||
      !DIGEST.test(grantSha256)
    )
      fail("CANDIDATE_BINDING_INVALID");
    return this.#transaction(() => {
      const row = this.#row(id);
      // These values must come from the normal cryptographic Grant verifier,
      // not from decoding an unverified JWS or trusting an issuer response.
      if (
        workspaceId !== row.workspace_id ||
        purpose !== row.purpose ||
        requestSha256 !== row.request_key ||
        !positive(capMicrousd) ||
        capMicrousd > row.cap_microusd
      )
        fail("CANDIDATE_GRANT_SCOPE_MISMATCH");
      if (
        row.account_key &&
        (row.account_key !== accountKey || row.grant_sha256 !== grantSha256)
      )
        fail("CANDIDATE_ALLOCATION_CONFLICT");
      if (!["ISSUING", "UNKNOWN", "BOUND"].includes(row.state))
        fail("CANDIDATE_GRANT_NOT_DISPATCHED");
      const prior = this.#db
        .prepare(
          "SELECT id FROM allocation WHERE id!=? AND (account_key=? OR grant_sha256=?)",
        )
        .get(id, accountKey, grantSha256);
      if (prior) fail("CANDIDATE_BINDING_REUSED");
      this.#db
        .prepare(
          "UPDATE allocation SET state='BOUND',account_key=?,grant_sha256=? WHERE id=?",
        )
        .run(accountKey, grantSha256, id);
      return this.#public(this.#row(id));
    });
  }
  markUnknown(id) {
    return this.#transaction(() => {
      const row = this.#row(id);
      if (!["ISSUING", "BOUND", "UNKNOWN"].includes(row.state))
        fail("CANDIDATE_GRANT_NOT_DISPATCHED");
      this.#db
        .prepare("UPDATE allocation SET state='UNKNOWN' WHERE id=?")
        .run(id);
      return this.#public(this.#row(id));
    });
  }
  status() {
    const rows = this.#db
      .prepare(
        "SELECT arm,SUM(cap_microusd) AS amount FROM allocation GROUP BY arm",
      )
      .all();
    const arms = Object.fromEntries(
      ["A", "B"].map((arm) => [
        arm,
        {
          capMicrousd: this.#config.arms[arm].capMicrousd,
          allocatedMicrousd: rows.find((row) => row.arm === arm)?.amount ?? 0,
        },
      ]),
    );
    return {
      campaignId: this.#config.campaignId,
      capMicrousd: this.#config.capMicrousd,
      allocatedMicrousd: arms.A.allocatedMicrousd + arms.B.allocatedMicrousd,
      arms,
      basis: "non-reclaimable Grant upper bounds; not actual charges",
    };
  }
  exportAllocations(authorizationSha256) {
    if (!DIGEST.test(authorizationSha256)) fail("CANDIDATE_BINDING_INVALID");
    return this.#transaction(() => ({
      schemaVersion: "development-candidate-budget-allocations/v1",
      authorizationSha256,
      campaignId: this.#config.campaignId,
      expiresAt: this.#config.expiresAt,
      capMicrousd: this.#config.capMicrousd,
      arms: this.#config.arms,
      allocations: this.#db
        .prepare("SELECT * FROM allocation ORDER BY id")
        .all()
        .map((row) => this.#public(row)),
    }));
  }
  close() {
    this.#db.close();
  }
}
