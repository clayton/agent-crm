import type { D1Database } from "@cloudflare/workers-types";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type Row = Record<string, unknown>;

export function rowDict(row: Row | null): Record<string, JsonValue> | null {
  if (!row) return null;
  const result: Record<string, JsonValue> = { ...row } as Record<string, JsonValue>;
  for (const [key, value] of Object.entries(result)) {
    if (key.endsWith("_json") && typeof value === "string") {
      const plain = key.slice(0, -5);
      try {
        result[plain] = JSON.parse(value) as JsonValue;
      } catch {
        result[plain] = value;
      }
      delete result[key];
    } else if ((key === "terminal" || key === "do_not_contact") && value != null) {
      result[key] = Boolean(value);
    }
  }
  return result;
}

export async function all<T extends Row>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await db.prepare(sql).bind(...params).all<T>();
  return results ?? [];
}

export async function first<T extends Row>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...params).first<T>();
}

export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<void> {
  await db.prepare(sql).bind(...params).run();
}

export async function batch(db: D1Database, statements: { sql: string; params?: unknown[] }[]): Promise<void> {
  if (!statements.length) return;
  await db.batch(statements.map(({ sql, params = [] }) => db.prepare(sql).bind(...params)));
}
export async function migrateLocal(db: D1Database): Promise<void> {
  const initial = `-- migrations inlined for worker runtime
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, settings_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pipeline_stages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, key TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)), outcome TEXT CHECK (outcome IN ('won', 'lost', 'disqualified', 'do_not_contact')), UNIQUE(project_id, key), UNIQUE(project_id, position));
CREATE TABLE IF NOT EXISTS stage_transitions (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, from_stage_id TEXT NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE, to_stage_id TEXT NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE, PRIMARY KEY(from_stage_id, to_stage_id));
CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, domain TEXT, website TEXT, linkedin_url TEXT, industry TEXT, employee_count INTEGER, annual_revenue TEXT, location TEXT, description TEXT, tags_json TEXT NOT NULL DEFAULT '[]', custom_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_by TEXT NOT NULL, UNIQUE(project_id, domain));
CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, company_id TEXT REFERENCES companies(id) ON DELETE SET NULL, first_name TEXT, last_name TEXT, full_name TEXT NOT NULL, email TEXT, phone TEXT, title TEXT, department TEXT, seniority TEXT, linkedin_url TEXT, location TEXT, tags_json TEXT NOT NULL DEFAULT '[]', custom_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_by TEXT NOT NULL, UNIQUE(project_id, email));
CREATE TABLE IF NOT EXISTS prospects (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, company_id TEXT REFERENCES companies(id) ON DELETE SET NULL, stage_id TEXT NOT NULL REFERENCES pipeline_stages(id), name TEXT NOT NULL, source TEXT, source_url TEXT, owner TEXT, fit_score INTEGER CHECK (fit_score BETWEEN 0 AND 100), priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')), pain_points TEXT, needs TEXT, budget TEXT, authority TEXT, timing TEXT, qualification_notes TEXT, do_not_contact INTEGER NOT NULL DEFAULT 0 CHECK (do_not_contact IN (0, 1)), lost_reason TEXT, last_contacted_at TEXT, next_contact_at TEXT, stale_after TEXT, tags_json TEXT NOT NULL DEFAULT '[]', custom_json TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, amount REAL, currency TEXT, expected_close_at TEXT, forecast_category TEXT CHECK (forecast_category IN ('pipeline', 'best_case', 'commit', 'closed')), probability INTEGER CHECK (probability BETWEEN 0 AND 100), probability_source TEXT CHECK (probability_source IN ('manual', 'stage_default', 'historical')), next_step TEXT, next_step_due_at TEXT, qualified_at TEXT, close_date_changed_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, prospect_id TEXT REFERENCES prospects(id) ON DELETE CASCADE, contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE, company_id TEXT REFERENCES companies(id) ON DELETE CASCADE, kind TEXT NOT NULL DEFAULT 'general', body TEXT NOT NULL, source_url TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL, CHECK (prospect_id IS NOT NULL OR contact_id IS NOT NULL OR company_id IS NOT NULL));
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, prospect_id TEXT REFERENCES prospects(id) ON DELETE CASCADE, contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, company_id TEXT REFERENCES companies(id) ON DELETE SET NULL, title TEXT NOT NULL, description TEXT, due_at TEXT, priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')), assigned_to TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')), completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activities (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, occurred_at TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS interactions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, prospect_id TEXT REFERENCES prospects(id) ON DELETE CASCADE, contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, company_id TEXT REFERENCES companies(id) ON DELETE SET NULL, channel TEXT NOT NULL CHECK (channel IN ('email', 'call', 'sms', 'linkedin', 'meeting', 'other')), direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')), outcome TEXT, summary TEXT NOT NULL, occurred_at TEXT NOT NULL, external_ref TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL, CHECK (prospect_id IS NOT NULL OR contact_id IS NOT NULL OR company_id IS NOT NULL));
CREATE TABLE IF NOT EXISTS enrichment_attempts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, status TEXT NOT NULL, review_state TEXT NOT NULL, input_json TEXT NOT NULL, identity_json TEXT NOT NULL DEFAULT '{}', providers_json TEXT NOT NULL DEFAULT '[]', proposed_json TEXT NOT NULL DEFAULT '{}', error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL, applied_at TEXT, applied_by TEXT);
CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, actor TEXT NOT NULL, operation TEXT NOT NULL, response_digest TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL);`;
  for (const statement of initial.split(";").map((s) => s.trim()).filter(Boolean)) {
    await run(db, statement);
  }
}

export async function checkIdempotency(
  db: D1Database,
  key: string,
  actor: string,
  operation: string,
): Promise<{ response_json: string } | null> {
  const row = await first<{ actor: string; operation: string; response_json: string }>(
    db,
    "SELECT actor, operation, response_json FROM idempotency_keys WHERE key = ?",
    key,
  );
  if (!row) return null;
  if (row.actor !== actor || row.operation !== operation) {
    throw new Error("Idempotency-Key reused with different actor or operation");
  }
  if (!row.response_json) return null;
  return { response_json: row.response_json };
}

export async function reserveIdempotencyKey(
  db: D1Database,
  key: string,
  actor: string,
  operation: string,
): Promise<"reserved" | { response_json: string }> {
  const createdAt = new Date().toISOString().slice(0, 19);
  const result = await db
    .prepare(
      "INSERT OR IGNORE INTO idempotency_keys (key, actor, operation, response_digest, response_json, created_at) VALUES (?, ?, ?, '', '', ?)",
    )
    .bind(key, actor, operation, createdAt)
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    const cached = await checkIdempotency(db, key, actor, operation);
    if (cached) return cached;
    throw new Error("Idempotency-Key in progress");
  }
  return "reserved";
}

export async function completeIdempotency(
  db: D1Database,
  key: string,
  response: unknown,
): Promise<void> {
  const responseJson = JSON.stringify(response);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(responseJson));
  const responseDigest = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  await run(
    db,
    "UPDATE idempotency_keys SET response_digest = ?, response_json = ? WHERE key = ?",
    responseDigest,
    responseJson,
    key,
  );
}

export async function storeIdempotency(
  db: D1Database,
  key: string,
  actor: string,
  operation: string,
  response: unknown,
): Promise<void> {
  const responseJson = JSON.stringify(response);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(responseJson));
  const responseDigest = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const createdAt = new Date().toISOString().slice(0, 19);
  await run(
    db,
    "INSERT INTO idempotency_keys (key, actor, operation, response_digest, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    key,
    actor,
    operation,
    responseDigest,
    responseJson,
    createdAt,
  );
}
