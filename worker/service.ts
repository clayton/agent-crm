import type { D1Database } from "@cloudflare/workers-types";
import { rowDict, all, first, batch, type JsonValue } from "./db";

export class CRMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CRMError";
  }
}

type Row = Record<string, JsonValue>;

const DEFAULT_STAGES: [string, string, boolean, string | null][] = [
  ["identified", "Identified", false, null],
  ["researching", "Researching", false, null],
  ["qualified", "Qualified", false, null],
  ["ready_to_contact", "Ready to Contact", false, null],
  ["contacted", "Contacted", false, null],
  ["replied", "Replied", false, null],
  ["meeting_booked", "Meeting Booked", false, null],
  ["won", "Won", true, "won"],
  ["lost", "Lost", true, "lost"],
  ["not_a_fit", "Not a Fit", true, "disqualified"],
  ["do_not_contact", "Do Not Contact", true, "do_not_contact"],
];

const COMPANY_FIELDS = new Set([
  "name", "domain", "website", "linkedin_url", "industry", "employee_count",
  "annual_revenue", "location", "description",
]);

const CONTACT_FIELDS = new Set([
  "company_id", "first_name", "last_name", "full_name", "email", "phone", "title",
  "department", "seniority", "linkedin_url", "location",
]);

const PROSPECT_FIELDS = new Set([
  "contact_id", "company_id", "name", "source", "source_url", "owner",
  "fit_score", "priority", "pain_points", "needs", "budget", "authority",
  "timing", "qualification_notes", "do_not_contact", "lost_reason",
  "last_contacted_at", "next_contact_at", "stale_after", "amount",
  "currency", "expected_close_at", "forecast_category", "probability",
  "probability_source", "next_step", "next_step_due_at", "qualified_at",
]);

const SIGNAL_WEIGHTS: Record<string, number> = { S: 100, A: 85, B: 70, C: 50, D: 25, F: 0 };

const EXPERIMENT_OUTCOMES = [
  "meaningful_reply", "workflow_confirmed", "fit_call_booked", "fit_call_held",
  "qualified_opportunity", "paid_blueprint", "not_a_fit",
] as const;

function sortedJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => sortedJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(",")}}`;
}

export function now(): string {
  return new Date().toISOString().slice(0, 19);
}

function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function requireActor(actor: string | null | undefined): string {
  const trimmed = (actor ?? "").trim();
  if (!trimmed) {
    throw new CRMError("A write actor is required (--actor or CRM_ACTOR).");
  }
  return trimmed;
}

export function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new CRMError("A non-empty project slug is required.");
  }
  return slug;
}

function activityInsert(
  projectId: string,
  entityType: string,
  entityId: string,
  action: string,
  actor: string,
  details: Record<string, unknown> | null = null,
): { sql: string; params: unknown[] } {
  return {
    sql: "INSERT INTO activities(project_id, entity_type, entity_id, action, actor, occurred_at, details_json) VALUES(?,?,?,?,?,?,?)",
    params: [projectId, entityType, entityId, action, actor, now(), sortedJson(details ?? {})],
  };
}

export async function resolveProject(db: D1Database, project: string): Promise<Row> {
  const row = await first(db, "SELECT * FROM projects WHERE id = ? OR slug = ?", project, project);
  if (!row) {
    throw new CRMError(`Project not found: ${project}`);
  }
  return rowDict(row) ?? {};
}

export async function validateLink(
  db: D1Database,
  table: string,
  entityId: string | null | undefined,
  projectId: string,
): Promise<void> {
  if (!entityId) return;
  if (!["companies", "contacts", "prospects"].includes(table)) {
    throw new CRMError(`Unsupported link type: ${table}`);
  }
  const row = await first(db, `SELECT project_id FROM ${table} WHERE id=?`, entityId);
  if (!row) {
    throw new CRMError(`Linked ${table.slice(0, -1)} not found: ${entityId}`);
  }
  if (row.project_id !== projectId) {
    throw new CRMError(`Cross-project ${table.slice(0, -1)} link rejected: ${entityId}`);
  }
}

export async function createProject(
  db: D1Database,
  name: string,
  actor: string,
  slug?: string | null,
  description?: string | null,
): Promise<Row> {
  const resolvedActor = requireActor(actor);
  const projectId = uid("prj");
  const timestamp = now();
  const projectSlug = slugify(slug ?? name);

  const stmts: { sql: string; params: unknown[] }[] = [
    {
      sql: "INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)",
      params: [projectId, projectSlug, name, description ?? null, "{}", timestamp, timestamp, resolvedActor, resolvedActor],
    },
  ];
  const stageIds: Record<string, string> = {};
  for (let position = 0; position < DEFAULT_STAGES.length; position++) {
    const [key, label, terminal, outcome] = DEFAULT_STAGES[position];
    const stageId = uid("stg");
    stageIds[key] = stageId;
    stmts.push({
      sql: "INSERT INTO pipeline_stages VALUES(?,?,?,?,?,?,?)",
      params: [stageId, projectId, key, label, position, terminal ? 1 : 0, outcome],
    });
  }
  const linear = DEFAULT_STAGES.filter(([, , terminal]) => !terminal).map(([key]) => key).concat(["won"]);
  for (let i = 0; i < linear.length - 1; i++) {
    stmts.push({
      sql: "INSERT INTO stage_transitions VALUES(?,?,?)",
      params: [projectId, stageIds[linear[i]], stageIds[linear[i + 1]]],
    });
  }
  const terminalKeys = ["lost", "not_a_fit", "do_not_contact"];
  for (const [fromKey, , terminal] of DEFAULT_STAGES) {
    if (!terminal) {
      for (const toKey of terminalKeys) {
        stmts.push({
          sql: "INSERT INTO stage_transitions VALUES(?,?,?)",
          params: [projectId, stageIds[fromKey], stageIds[toKey]],
        });
      }
    }
  }
  stmts.push(activityInsert(projectId, "project", projectId, "created", resolvedActor, { name, slug: projectSlug }));
  await batch(db, stmts);

  return getProject(db, projectId);
}

export async function getProject(db: D1Database, project: string): Promise<Row> {
  const result = await resolveProject(db, project);
  const stages = await all(db, "SELECT * FROM pipeline_stages WHERE project_id = ? ORDER BY position", result.id);
  result.stages = stages.map((row) => rowDict(row) ?? {});
  return result;
}

export async function listProjects(db: D1Database): Promise<Row[]> {
  const rows = await all(db, "SELECT * FROM projects ORDER BY name");
  return rows.map((row) => rowDict(row) ?? {});
}

async function createEntity(
  db: D1Database,
  table: string,
  prefix: string,
  project: string,
  actor: string,
  values: Record<string, unknown>,
  allowed: Set<string>,
  tags?: string[] | null,
  custom?: Record<string, unknown> | null,
): Promise<Row> {
  const resolvedActor = requireActor(actor);
  const projectRow = await resolveProject(db, project);
  const unknown = Object.keys(values).filter((k) => !allowed.has(k));
  if (unknown.length) {
    throw new CRMError(`Unsupported ${table} fields: ${unknown.sort().join(", ")}`);
  }
  const entityId = uid(prefix);
  const timestamp = now();
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined) record[key] = value;
  }
  Object.assign(record, {
    id: entityId,
    project_id: projectRow.id,
    tags_json: sortedJson(tags ?? []),
    custom_json: sortedJson(custom ?? {}),
    created_at: timestamp,
    updated_at: timestamp,
    created_by: resolvedActor,
    updated_by: resolvedActor,
  });
  const columns = Object.keys(record).join(",");
  const placeholders = Object.keys(record).map(() => "?").join(",");
  const recordValues = Object.values(record);

  await batch(db, [
    { sql: `INSERT INTO ${table} (${columns}) VALUES (${placeholders})`, params: recordValues },
    activityInsert(String(projectRow.id), table.slice(0, -1), entityId, "created", resolvedActor, values),
  ]);

  const row = await first(db, `SELECT * FROM ${table} WHERE id = ?`, entityId);
  return rowDict(row) ?? {};
}

export async function createCompany(
  db: D1Database,
  project: string,
  name: string,
  actor: string,
  fields: Record<string, unknown> = {},
): Promise<Row> {
  const { tags, custom, ...rest } = fields;
  return createEntity(
    db, "companies", "cmp", project, actor, { name, ...rest }, COMPANY_FIELDS,
    tags as string[] | undefined, custom as Record<string, unknown> | undefined,
  );
}

export async function createContact(
  db: D1Database,
  project: string,
  fullName: string,
  actor: string,
  fields: Record<string, unknown> = {},
): Promise<Row> {
  const { tags, custom, ...rest } = fields;
  const projectRow = await resolveProject(db, project);
  await validateLink(db, "companies", rest.company_id as string | undefined, String(projectRow.id));
  return createEntity(
    db, "contacts", "con", project, actor, { full_name: fullName, ...rest }, CONTACT_FIELDS,
    tags as string[] | undefined, custom as Record<string, unknown> | undefined,
  );
}

async function getEntity(db: D1Database, table: string, entityId: string): Promise<Row> {
  if (!["companies", "contacts"].includes(table)) {
    throw new CRMError(`Unsupported entity type: ${table}`);
  }
  const row = await first(db, `SELECT * FROM ${table} WHERE id=?`, entityId);
  if (!row) {
    throw new CRMError(`${table.slice(0, -1).charAt(0).toUpperCase()}${table.slice(1, -1)} not found: ${entityId}`);
  }
  return rowDict(row) ?? {};
}

export async function getCompany(db: D1Database, companyId: string): Promise<Row> {
  const result = await getEntity(db, "companies", companyId);
  const contacts = await all(db, "SELECT * FROM contacts WHERE company_id=? ORDER BY full_name", companyId);
  result.contacts = contacts.map((r) => rowDict(r) ?? {});
  const prospects = await all(
    db,
    "SELECT p.*, s.key AS stage FROM prospects p JOIN pipeline_stages s ON s.id=p.stage_id WHERE p.company_id=? ORDER BY p.updated_at DESC",
    companyId,
  );
  result.prospects = prospects.map((r) => rowDict(r) ?? {});
  return result;
}

function maskedEmail(value: string | null | undefined): string | null | undefined {
  if (!value || !value.includes("@")) return value;
  const [local, domain] = value.split("@", 2);
  return `${local.slice(0, 1)}${"*".repeat(Math.max(3, local.length - 1))}@${domain}`;
}

function maskEnrichmentEmails(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(obj)) {
      result[key] = key === "email" ? maskedEmail(item as string) : maskEnrichmentEmails(item);
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskEnrichmentEmails(item));
  }
  return value;
}

function publicEnrichment(attempt: Row): Row {
  return maskEnrichmentEmails({ ...attempt }) as Row;
}

export async function enrichmentAttempt(db: D1Database, attemptId: string, isPublic = true): Promise<Row> {
  const row = await first(db, "SELECT * FROM enrichment_attempts WHERE id=?", attemptId);
  if (!row) {
    throw new CRMError(`Enrichment attempt not found: ${attemptId}`);
  }
  const result = rowDict(row) ?? {};
  return isPublic ? publicEnrichment(result) : result;
}

export async function getContact(db: D1Database, contactId: string): Promise<Row> {
  const result = await getEntity(db, "contacts", contactId);
  if (result.company_id) {
    result.company = await getEntity(db, "companies", String(result.company_id));
  }
  const prospects = await all(
    db,
    "SELECT p.*, s.key AS stage FROM prospects p JOIN pipeline_stages s ON s.id=p.stage_id WHERE p.contact_id=? ORDER BY p.updated_at DESC",
    contactId,
  );
  result.prospects = prospects.map((r) => rowDict(r) ?? {});
  const attempts = await all(
    db,
    "SELECT * FROM enrichment_attempts WHERE contact_id=? ORDER BY created_at DESC",
    contactId,
  );
  result.enrichment_attempts = attempts.map((r) => publicEnrichment(rowDict(r) ?? {}));
  return result;
}

async function listEntities(db: D1Database, table: string, project: string, limit: number): Promise<Row[]> {
  if (!["companies", "contacts"].includes(table)) {
    throw new CRMError(`Unsupported entity type: ${table}`);
  }
  const projectRow = await resolveProject(db, project);
  const order = table === "companies" ? "name" : "full_name";
  const clamped = Math.min(Math.max(limit, 1), 1000);
  const rows = await all(db, `SELECT * FROM ${table} WHERE project_id=? ORDER BY ${order} LIMIT ?`, projectRow.id, clamped);
  return rows.map((r) => rowDict(r) ?? {});
}

export async function listCompanies(db: D1Database, project: string, limit = 100): Promise<Row[]> {
  return listEntities(db, "companies", project, limit);
}

export async function listContacts(db: D1Database, project: string, limit = 100): Promise<Row[]> {
  return listEntities(db, "contacts", project, limit);
}

async function updateEntity(
  db: D1Database,
  table: string,
  entityId: string,
  actor: string,
  fields: Record<string, unknown>,
  allowed: Set<string>,
): Promise<Row> {
  const resolvedActor = requireActor(actor);
  const current = await getEntity(db, table, entityId);
  const unknown = Object.keys(fields).filter((k) => !allowed.has(k) && k !== "tags" && k !== "custom");
  if (unknown.length) {
    throw new CRMError(`Unsupported ${table.slice(0, -1)} fields: ${unknown.sort().join(", ")}`);
  }
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === "tags" || k === "custom") {
      clean[`${k}_json`] = sortedJson(v);
    } else {
      clean[k] = v;
    }
  }
  clean.updated_at = now();
  clean.updated_by = resolvedActor;
  const assignments = Object.keys(clean).map((key) => `${key}=?`).join(",");
  const values = [...Object.values(clean), entityId];

  await batch(db, [
    { sql: `UPDATE ${table} SET ${assignments} WHERE id=?`, params: values },
    activityInsert(String(current.project_id), table.slice(0, -1), entityId, "updated", resolvedActor, fields),
  ]);

  return getEntity(db, table, entityId);
}

export async function updateCompany(
  db: D1Database,
  companyId: string,
  actor: string,
  fields: Record<string, unknown>,
): Promise<Row> {
  return updateEntity(db, "companies", companyId, actor, fields, COMPANY_FIELDS);
}

export async function updateContact(
  db: D1Database,
  contactId: string,
  actor: string,
  fields: Record<string, unknown>,
): Promise<Row> {
  const current = await getEntity(db, "contacts", contactId);
  await validateLink(db, "companies", fields.company_id as string | undefined, String(current.project_id));
  return updateEntity(db, "contacts", contactId, actor, fields, CONTACT_FIELDS);
}

async function stage(db: D1Database, projectId: string, key: string): Promise<Row> {
  const row = await first(db, "SELECT * FROM pipeline_stages WHERE project_id = ? AND key = ?", projectId, key);
  if (!row) {
    throw new CRMError(`Pipeline stage not found: ${key}`);
  }
  return rowDict(row) ?? {};
}

export async function createProspect(
  db: D1Database,
  project: string,
  name: string,
  actor: string,
  stageKey = "identified",
  fields: Record<string, unknown> = {},
): Promise<Row> {
  const { tags, custom, ...rest } = fields;
  const projectRow = await resolveProject(db, project);
  await validateLink(db, "contacts", rest.contact_id as string | undefined, String(projectRow.id));
  await validateLink(db, "companies", rest.company_id as string | undefined, String(projectRow.id));
  const stageRow = await stage(db, String(projectRow.id), stageKey);
  const values: Record<string, unknown> = { name, stage_id: stageRow.id };
  for (const [k, v] of Object.entries(rest)) {
    if (v !== null && v !== undefined) values[k] = v;
  }
  const unknown = Object.keys(values).filter((k) => !PROSPECT_FIELDS.has(k) && k !== "stage_id");
  if (unknown.length) {
    throw new CRMError(`Unsupported prospect fields: ${unknown.sort().join(", ")}`);
  }
  const resolvedActor = requireActor(actor);
  const prospectId = uid("pro");
  const timestamp = now();
  const record: Record<string, unknown> = {
    id: prospectId,
    project_id: projectRow.id,
    ...values,
    tags_json: sortedJson(tags ?? []),
    custom_json: sortedJson(custom ?? {}),
    created_at: timestamp,
    updated_at: timestamp,
    created_by: resolvedActor,
    updated_by: resolvedActor,
  };

  const columns = Object.keys(record).join(",");
  const placeholders = Object.keys(record).map(() => "?").join(",");
  await batch(db, [
    { sql: `INSERT INTO prospects (${columns}) VALUES (${placeholders})`, params: Object.values(record) },
    activityInsert(String(projectRow.id), "prospect", prospectId, "created", resolvedActor, { name, stage: stageKey }),
  ]);

  return getProspect(db, prospectId);
}

export async function getProspect(db: D1Database, prospectId: string): Promise<Row> {
  const row = await first(
    db,
    `SELECT p.*, s.key AS stage, s.name AS stage_name,
            c.full_name AS contact_name, c.email AS contact_email,
            c.phone AS contact_phone, c.title AS contact_title,
            co.name AS company_name, co.domain AS company_domain
     FROM prospects p JOIN pipeline_stages s ON s.id=p.stage_id
     LEFT JOIN contacts c ON c.id=p.contact_id LEFT JOIN companies co ON co.id=p.company_id
     WHERE p.id=?`,
    prospectId,
  );
  if (!row) {
    throw new CRMError(`Prospect not found: ${prospectId}`);
  }
  const result = rowDict(row) ?? {};
  const openTasks = await all(
    db,
    "SELECT * FROM tasks WHERE prospect_id=? AND status='open' ORDER BY due_at IS NULL, due_at",
    prospectId,
  );
  result.open_tasks = openTasks.map((r) => rowDict(r) ?? {});
  const notes = await all(db, "SELECT * FROM notes WHERE prospect_id=? ORDER BY created_at DESC", prospectId);
  result.notes = notes.map((r) => rowDict(r) ?? {});
  const interactions = await all(
    db,
    "SELECT * FROM interactions WHERE prospect_id=? ORDER BY occurred_at DESC",
    prospectId,
  );
  result.interactions = interactions.map((r) => rowDict(r) ?? {});
  return result;
}

export async function listProspects(
  db: D1Database,
  project: string,
  stageKey?: string | null,
  owner?: string | null,
  limit = 100,
): Promise<Row[]> {
  const projectRow = await resolveProject(db, project);
  let sql = `SELECT p.*, s.key AS stage, c.full_name AS contact_name, co.name AS company_name
             FROM prospects p JOIN pipeline_stages s ON s.id=p.stage_id
             LEFT JOIN contacts c ON c.id=p.contact_id LEFT JOIN companies co ON co.id=p.company_id
             WHERE p.project_id=?`;
  const params: unknown[] = [projectRow.id];
  if (stageKey) {
    sql += " AND s.key=?";
    params.push(stageKey);
  }
  if (owner) {
    sql += " AND p.owner=?";
    params.push(owner);
  }
  sql += " ORDER BY p.updated_at DESC LIMIT ?";
  params.push(Math.min(Math.max(limit, 1), 1000));
  const rows = await all(db, sql, ...params);
  return rows.map((row) => rowDict(row) ?? {});
}

export async function transitionProspect(
  db: D1Database,
  prospectId: string,
  toStage: string,
  actor: string,
  reason?: string | null,
  expectedVersion?: number | null,
): Promise<Row> {
  const resolvedActor = requireActor(actor);
  const current = await getProspect(db, prospectId);
  if (expectedVersion != null && current.version !== expectedVersion) {
    throw new CRMError(`Version conflict: expected ${expectedVersion}, found ${current.version}`);
  }
  const target = await stage(db, String(current.project_id), toStage);
  const allowed = await first(
    db,
    "SELECT 1 FROM stage_transitions WHERE from_stage_id=? AND to_stage_id=?",
    current.stage_id, target.id,
  );
  if (!allowed) {
    throw new CRMError(`Transition not allowed: ${current.stage} -> ${toStage}`);
  }
  const timestamp = now();
  const extra: Record<string, unknown> = {};
  if (toStage === "do_not_contact") extra.do_not_contact = 1;
  if ((toStage === "lost" || toStage === "not_a_fit") && reason) extra.lost_reason = reason;
  if (toStage === "won") {
    extra.forecast_category = "closed";
    extra.probability = 100;
  }
  const assignments = ["stage_id=?", "updated_at=?", "updated_by=?", "version=version+1", ...Object.keys(extra).map((k) => `${k}=?`)];
  const params = [target.id, timestamp, resolvedActor, ...Object.values(extra), prospectId];

  await batch(db, [
    { sql: `UPDATE prospects SET ${assignments.join(",")} WHERE id=?`, params: params },
    activityInsert(String(current.project_id), "prospect", prospectId, "stage_changed", resolvedActor, {
      from: current.stage, to: toStage, reason,
    }),
  ]);

  return getProspect(db, prospectId);
}

export async function updateProspect(
  db: D1Database,
  prospectId: string,
  actor: string,
  fields: Record<string, unknown>,
  expectedVersion?: number | null,
): Promise<Row> {
  const resolvedActor = requireActor(actor);
  const current = await getProspect(db, prospectId);
  const unknown = Object.keys(fields).filter((k) => !PROSPECT_FIELDS.has(k) && k !== "tags" && k !== "custom");
  if (unknown.length) {
    throw new CRMError(`Unsupported prospect fields: ${unknown.sort().join(", ")}`);
  }
  if (expectedVersion != null && current.version !== expectedVersion) {
    throw new CRMError(`Version conflict: expected ${expectedVersion}, found ${current.version}`);
  }
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === "tags" || k === "custom") {
      clean[`${k}_json`] = sortedJson(v);
    } else {
      clean[k] = v;
    }
  }
  const closeDateChanged = (
    "expected_close_at" in fields
    && current.expected_close_at
    && fields.expected_close_at
    && String(fields.expected_close_at) > String(current.expected_close_at)
  );
  clean.updated_at = now();
  clean.updated_by = resolvedActor;
  const assignments = [...Object.keys(clean).map((key) => `${key}=?`), "version=version+1"];
  if (closeDateChanged) assignments.push("close_date_changed_count=close_date_changed_count+1");

  await batch(db, [
    { sql: `UPDATE prospects SET ${assignments.join(",")} WHERE id=?`, params: [...Object.values(clean), prospectId] },
    activityInsert(String(current.project_id), "prospect", prospectId, "updated", resolvedActor, fields),
  ]);

  return getProspect(db, prospectId);
}

export async function addNote(
  db: D1Database,
  project: string,
  actor: string,
  body: string,
  prospectId?: string | null,
  contactId?: string | null,
  companyId?: string | null,
  kind = "general",
  sourceUrl?: string | null,
): Promise<Row> {
  const resolvedActor = requireActor(actor);
  const projectRow = await resolveProject(db, project);
  const projectId = String(projectRow.id);
  await validateLink(db, "prospects", prospectId, projectId);
  await validateLink(db, "contacts", contactId, projectId);
  await validateLink(db, "companies", companyId, projectId);
  const noteId = uid("not");
  const timestamp = now();

  const parentType = prospectId ? "prospect" : contactId ? "contact" : "company";
  const parentId = prospectId ?? contactId ?? companyId ?? "";
  await batch(db, [
    {
      sql: "INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?)",
      params: [noteId, projectId, prospectId ?? null, contactId ?? null, companyId ?? null, kind, body, sourceUrl ?? null, timestamp, resolvedActor],
    },
    activityInsert(projectId, parentType, parentId, "note_added", resolvedActor, { note_id: noteId, kind }),
  ]);

  const row = await first(db, "SELECT * FROM notes WHERE id=?", noteId);
  return rowDict(row) ?? {};
}

export async function createTask(
  db: D1Database,
  project: string,
  actor: string,
  title: string,
  dueAt?: string | null,
  prospectId?: string | null,
  contactId?: string | null,
  companyId?: string | null,
  description?: string | null,
  priority = "normal",
  assignedTo?: string | null,
): Promise<Row> {
  const resolvedActor = requireActor(actor);
  const projectRow = await resolveProject(db, project);
  const projectId = String(projectRow.id);
  await validateLink(db, "prospects", prospectId, projectId);
  await validateLink(db, "contacts", contactId, projectId);
  await validateLink(db, "companies", companyId, projectId);
  const taskId = uid("tsk");
  const timestamp = now();

  await batch(db, [
    {
      sql: "INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      params: [
        taskId, projectId, prospectId ?? null, contactId ?? null, companyId ?? null, title, description ?? null,
        dueAt ?? null, priority, assignedTo ?? null, "open", null, timestamp, timestamp, resolvedActor, resolvedActor,
      ],
    },
    activityInsert(projectId, "task", taskId, "created", resolvedActor, { title, due_at: dueAt }),
  ]);

  const row = await first(db, "SELECT * FROM tasks WHERE id=?", taskId);
  return rowDict(row) ?? {};
}

export async function completeTask(db: D1Database, taskId: string, actor: string): Promise<Row> {
  const resolvedActor = requireActor(actor);
  const row = await first(db, "SELECT * FROM tasks WHERE id=?", taskId);
  if (!row) {
    throw new CRMError(`Task not found: ${taskId}`);
  }
  const task = rowDict(row) ?? {};
  const timestamp = now();

  await batch(db, [
    {
      sql: "UPDATE tasks SET status='completed', completed_at=?, updated_at=?, updated_by=? WHERE id=?",
      params: [timestamp, timestamp, resolvedActor, taskId],
    },
    activityInsert(String(task.project_id), "task", taskId, "completed", resolvedActor),
  ]);

  const updated = await first(db, "SELECT * FROM tasks WHERE id=?", taskId);
  return rowDict(updated) ?? {};
}

export async function logInteraction(
  db: D1Database,
  project: string,
  actor: string,
  channel: string,
  direction: string,
  summary: string,
  prospectId?: string | null,
  contactId?: string | null,
  companyId?: string | null,
  outcome?: string | null,
  occurredAt?: string | null,
  externalRef?: string | null,
): Promise<Row> {
  const resolvedActor = requireActor(actor);
  const projectRow = await resolveProject(db, project);
  const projectId = String(projectRow.id);
  await validateLink(db, "prospects", prospectId, projectId);
  await validateLink(db, "contacts", contactId, projectId);
  await validateLink(db, "companies", companyId, projectId);
  if (!prospectId && !contactId && !companyId) {
    throw new CRMError("An interaction must link to a prospect, contact, or company.");
  }
  if (!["email", "call", "sms", "linkedin", "meeting", "other"].includes(channel)) {
    throw new CRMError(`Unsupported interaction channel: ${channel}`);
  }
  if (!["inbound", "outbound", "internal"].includes(direction)) {
    throw new CRMError(`Unsupported interaction direction: ${direction}`);
  }
  const interactionId = uid("int");
  const createdAt = now();
  const occurred = occurredAt ?? createdAt;

  const entityType = prospectId ? "prospect" : contactId ? "contact" : "company";
  const entityId = prospectId ?? contactId ?? companyId ?? "";
  const stmts: { sql: string; params: unknown[] }[] = [
    {
      sql: "INSERT INTO interactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      params: [
        interactionId, projectId, prospectId ?? null, contactId ?? null, companyId ?? null, channel, direction,
        outcome ?? null, summary, occurred, externalRef ?? null, createdAt, resolvedActor,
      ],
    },
  ];
  if (prospectId && (direction === "inbound" || direction === "outbound")) {
    stmts.push({
      sql: "UPDATE prospects SET last_contacted_at=?, updated_at=?, updated_by=?, version=version+1 WHERE id=?",
      params: [occurred, createdAt, resolvedActor, prospectId],
    });
  }
  stmts.push(
    activityInsert(projectId, entityType, entityId, "interaction_logged", resolvedActor, {
      interaction_id: interactionId, channel, direction, outcome,
    }),
  );
  await batch(db, stmts);

  const row = await first(db, "SELECT * FROM interactions WHERE id=?", interactionId);
  return rowDict(row) ?? {};
}

export async function listInteractions(
  db: D1Database,
  project: string,
  prospectId?: string | null,
  channel?: string | null,
  limit = 100,
): Promise<Row[]> {
  const projectRow = await resolveProject(db, project);
  const projectId = String(projectRow.id);
  let sql = "SELECT * FROM interactions WHERE project_id=?";
  const params: unknown[] = [projectId];
  if (prospectId) {
    await validateLink(db, "prospects", prospectId, projectId);
    sql += " AND prospect_id=?";
    params.push(prospectId);
  }
  if (channel) {
    sql += " AND channel=?";
    params.push(channel);
  }
  sql += " ORDER BY occurred_at DESC LIMIT ?";
  params.push(Math.min(Math.max(limit, 1), 1000));
  const rows = await all(db, sql, ...params);
  return rows.map((r) => rowDict(r) ?? {});
}

function addDaysIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 19);
}

function subtractDaysIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 19);
}

export async function inbox(
  db: D1Database,
  project?: string | null,
  actor?: string | null,
  dueWithinDays = 7,
  staleDays = 30,
  limit = 100,
): Promise<Record<string, unknown>> {
  const rowLimit = Math.min(Math.max(limit, 1), 500);
  const timestamp = now();
  const horizon = addDaysIso(dueWithinDays);
  const params: unknown[] = [];
  let projectClause = "";
  let projectId: string | null = null;
  if (project) {
    projectId = String((await resolveProject(db, project)).id);
    projectClause = " AND t.project_id=?";
    params.push(projectId);
  }
  let actorClause = "";
  if (actor) {
    actorClause = " AND t.assigned_to=?";
    params.push(actor);
  }
  const taskBase = `SELECT t.*, p.name AS prospect_name, pr.slug AS project_slug FROM tasks t
                    JOIN projects pr ON pr.id=t.project_id LEFT JOIN prospects p ON p.id=t.prospect_id
                    WHERE t.status='open'`;
  const overdueRows = await all(
    db,
    taskBase + " AND t.due_at IS NOT NULL AND t.due_at < ?" + projectClause + actorClause + " ORDER BY t.due_at LIMIT ?",
    timestamp, ...params, rowLimit,
  );
  const dueSoonRows = await all(
    db,
    taskBase + " AND t.due_at >= ? AND t.due_at <= ?" + projectClause + actorClause + " ORDER BY t.due_at LIMIT ?",
    timestamp, horizon, ...params, rowLimit,
  );
  const staleCutoff = subtractDaysIso(staleDays);
  let staleSql = `SELECT p.*, s.key AS stage, pr.slug AS project_slug FROM prospects p
                  JOIN pipeline_stages s ON s.id=p.stage_id JOIN projects pr ON pr.id=p.project_id
                  WHERE s.terminal=0 AND p.updated_at < ?`;
  const staleParams: unknown[] = [staleCutoff];
  if (projectId) {
    staleSql += " AND p.project_id=?";
    staleParams.push(projectId);
  }
  if (actor) {
    staleSql += " AND p.owner=?";
    staleParams.push(actor);
  }
  staleSql += " ORDER BY p.updated_at LIMIT ?";
  staleParams.push(rowLimit);
  const staleRows = await all(db, staleSql, ...staleParams);
  const overdue = overdueRows.map((r) => rowDict(r) ?? {});
  const dueSoon = dueSoonRows.map((r) => rowDict(r) ?? {});
  const stale = staleRows.map((r) => rowDict(r) ?? {});
  return {
    generated_at: timestamp,
    overdue,
    due_soon: dueSoon,
    stale_prospects: stale,
    counts: { overdue: overdue.length, due_soon: dueSoon.length, stale_prospects: stale.length },
  };
}

function signalPriority(item: Row): [string | null, number] {
  const custom = (item.custom as Record<string, JsonValue>) ?? {};
  const tier = custom.signal_tier != null ? String(custom.signal_tier) : null;
  const defaultWeight = tier ? (SIGNAL_WEIGHTS[tier] ?? 0) : 0;
  const weight = custom.priority_weight != null ? Number(custom.priority_weight) : defaultWeight;
  return [tier, Math.max(0, Math.min(Math.trunc(weight), 100))];
}

function projectSettings(projectRow: Row): Record<string, unknown> {
  return { ...((projectRow.settings as Record<string, unknown>) ?? {}) };
}

function periodBounds(period?: string | null): [string, string, string] {
  const current = new Date();
  let resolved = period ?? null;
  if (!resolved) {
    const quarter = Math.floor(current.getUTCMonth() / 3) + 1;
    resolved = `${current.getUTCFullYear()}-Q${quarter}`;
  }
  const quarterMatch = /^(\d{4})-Q([1-4])$/.exec(resolved);
  const monthMatch = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(resolved);
  let start: Date;
  let end: Date;
  if (quarterMatch) {
    const year = parseInt(quarterMatch[1], 10);
    const q = parseInt(quarterMatch[2], 10);
    const startMonth = (q - 1) * 3 + 1;
    start = new Date(Date.UTC(year, startMonth - 1, 1));
    end = startMonth === 10
      ? new Date(Date.UTC(year + 1, 0, 1))
      : new Date(Date.UTC(year, startMonth + 2, 1));
  } else if (monthMatch) {
    const year = parseInt(monthMatch[1], 10);
    const month = parseInt(monthMatch[2], 10);
    start = new Date(Date.UTC(year, month - 1, 1));
    end = month === 12
      ? new Date(Date.UTC(year + 1, 0, 1))
      : new Date(Date.UTC(year, month, 1));
  } else {
    throw new CRMError("Period must be YYYY-Q1..Q4 or YYYY-MM.");
  }
  return [resolved, start.toISOString().slice(0, 19), end.toISOString().slice(0, 19)];
}

export async function pipeline(
  db: D1Database,
  project: string,
  includeTerminal = false,
): Promise<Record<string, unknown>> {
  const projectRow = await resolveProject(db, project);
  let stageSql = "SELECT * FROM pipeline_stages WHERE project_id=?";
  const stageParams: unknown[] = [projectRow.id];
  if (!includeTerminal) {
    stageSql += " AND terminal=0";
  }
  stageSql += " ORDER BY position";
  const stageRows = await all(db, stageSql, ...stageParams);
  let prospectSql = `SELECT p.id, p.name, p.owner, p.priority, p.fit_score, p.next_contact_at,
              p.last_contacted_at, p.updated_at, p.version, p.amount,
              p.currency, p.expected_close_at, p.forecast_category,
              p.probability, p.next_step, p.next_step_due_at, p.custom_json, p.stage_id,
              c.full_name AS contact_name, co.name AS company_name
       FROM prospects p
       LEFT JOIN contacts c ON c.id=p.contact_id
       LEFT JOIN companies co ON co.id=p.company_id
       WHERE p.project_id=?`;
  const prospectParams: unknown[] = [projectRow.id];
  if (!includeTerminal) {
    prospectSql += " AND p.stage_id IN (SELECT id FROM pipeline_stages WHERE project_id=? AND terminal=0)";
    prospectParams.push(projectRow.id);
  }
  const allProspectRows = await all(db, prospectSql, ...prospectParams);
  const prospectsByStage = new Map<string, (typeof allProspectRows)[number][]>();
  for (const row of allProspectRows) {
    const stageId = String(row.stage_id);
    const list = prospectsByStage.get(stageId) ?? [];
    list.push(row);
    prospectsByStage.set(stageId, list);
  }
  const stages: Record<string, unknown>[] = [];
  let total = 0;
  for (const stageRow of stageRows) {
    const stageData = rowDict(stageRow) ?? {};
    const prospectRows = prospectsByStage.get(String(stageData.id)) ?? [];
    const prospects = prospectRows.map((row) => rowDict(row) ?? {});
    const prospectsWithMeta = prospects.map((p) => {
      const [signalTier, priorityWeight] = signalPriority(p);
      p.signal_tier = signalTier;
      p.priority_weight = priorityWeight;
      return p;
    });
    prospectsWithMeta.sort((a, b) => {
      const priorityOrder: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
      const pa = priorityOrder[String(a.priority)] ?? 2;
      const pb = priorityOrder[String(b.priority)] ?? 2;
      if (pa !== pb) return pa - pb;
      const updated = String(b.updated_at).localeCompare(String(a.updated_at));
      if (updated !== 0) return updated;
      const pw = Number(b.priority_weight) - Number(a.priority_weight);
      if (pw !== 0) return pw;
      return String(a.name).localeCompare(String(b.name));
    });
    stages.push({
      key: stageData.key,
      name: stageData.name,
      position: stageData.position,
      terminal: Boolean(stageData.terminal),
      outcome: stageData.outcome,
      count: prospectsWithMeta.length,
      prospects: prospectsWithMeta,
    });
    total += prospectsWithMeta.length;
  }
  return {
    project: { id: projectRow.id, slug: projectRow.slug, name: projectRow.name },
    stages,
    total_prospects: total,
    includes_terminal_stages: includeTerminal,
  };
}

export async function bootstrap(
  db: D1Database,
  project: string,
  actor: string,
  targetAmount?: number | null,
  targetPeriod?: string | null,
  currency?: string | null,
  defaultOwner?: string | null,
  staleDays?: number | null,
): Promise<Record<string, unknown>> {
  const resolvedActor = requireActor(actor);
  const projectRow = await resolveProject(db, project);
  const settings = projectSettings(projectRow);
  const supplied: Record<string, unknown> = {
    target_amount: targetAmount,
    target_period: targetPeriod,
    currency,
    default_owner: defaultOwner,
    stale_days: staleDays,
  };
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(supplied)) {
    if (value != null && settings[key] !== value) changed[key] = value;
  }
  if (targetPeriod != null) periodBounds(targetPeriod);
  if (targetAmount != null && targetAmount < 0) {
    throw new CRMError("Target amount cannot be negative.");
  }
  if (staleDays != null && staleDays < 1) {
    throw new CRMError("Stale days must be at least 1.");
  }
  if (Object.keys(changed).length) {
    const timestamp = now();
    await batch(db, [
      {
        sql: "UPDATE projects SET settings_json=?, updated_at=?, updated_by=? WHERE id=?",
        params: [sortedJson({ ...settings, ...changed }), timestamp, resolvedActor, projectRow.id],
      },
      activityInsert(String(projectRow.id), "project", String(projectRow.id), "bootstrapped", resolvedActor, changed),
    ]);
    Object.assign(settings, changed);
  }

  const countsRow = await first(
    db,
    `SELECT
       COUNT(*) AS prospects,
       COALESCE(SUM(CASE WHEN owner IS NULL OR owner='' THEN 1 ELSE 0 END), 0) AS missing_owner,
       COALESCE(SUM(CASE WHEN contact_id IS NULL AND company_id IS NULL THEN 1 ELSE 0 END), 0) AS missing_relationship,
       COALESCE(SUM(CASE WHEN qualified_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS opportunities,
       COALESCE(SUM(CASE WHEN qualified_at IS NOT NULL AND
           (amount IS NULL OR expected_close_at IS NULL OR next_step IS NULL) THEN 1 ELSE 0 END), 0)
           AS incomplete_opportunities
     FROM prospects WHERE project_id=?`,
    projectRow.id,
  );
  const values = rowDict(countsRow) ?? {};
  const checks = [
    { key: "currency", complete: Boolean(settings.currency), message: "Set the default forecast currency." },
    {
      key: "target",
      complete: settings.target_amount != null && Boolean(settings.target_period),
      message: "Set a revenue target and target period.",
    },
    {
      key: "owner",
      complete: Boolean(settings.default_owner) || Number(values.missing_owner) === 0,
      message: "Set a default owner or assign every active prospect.",
    },
    { key: "pipeline", complete: Number(values.prospects) > 0, message: "Add the first prospect." },
    {
      key: "forecast_data",
      complete: Number(values.incomplete_opportunities) === 0,
      message: "Complete amount, close date, and next step for qualified opportunities.",
    },
  ];
  return {
    project: { id: projectRow.id, slug: projectRow.slug, name: projectRow.name },
    settings,
    changed,
    checks,
    complete: checks.every((item) => item.complete),
    counts: values,
    next_steps: checks.filter((item) => !item.complete).map((item) => item.message),
  };
}

export async function qualifyOpportunity(
  db: D1Database,
  prospectId: string,
  actor: string,
  amount: number,
  expectedCloseAt: string,
  nextStep: string,
  currency?: string | null,
  forecastCategory = "pipeline",
  probability?: number | null,
  nextStepDueAt?: string | null,
  expectedVersion?: number | null,
): Promise<Row> {
  const current = await getProspect(db, prospectId);
  const settings = projectSettings(await resolveProject(db, String(current.project_id)));
  if (amount < 0) {
    throw new CRMError("Opportunity amount cannot be negative.");
  }
  if (!["pipeline", "best_case", "commit"].includes(forecastCategory)) {
    throw new CRMError("Open opportunity forecast category must be pipeline, best_case, or commit.");
  }
  const stageProbabilities: Record<string, number> = {
    identified: 5, researching: 10, qualified: 25,
    ready_to_contact: 30, contacted: 40, replied: 55,
    meeting_booked: 75,
  };
  const source = probability != null ? "manual" : "stage_default";
  const resolvedProbability = probability ?? stageProbabilities[String(current.stage)] ?? 25;
  const fields: Record<string, unknown> = {
    amount,
    currency: currency ?? settings.currency ?? "USD",
    expected_close_at: expectedCloseAt,
    forecast_category: forecastCategory,
    probability: resolvedProbability,
    probability_source: source,
    next_step: nextStep,
    next_step_due_at: nextStepDueAt,
    qualified_at: current.qualified_at ?? now(),
  };
  return updateProspect(db, prospectId, actor, fields, expectedVersion);
}

export async function forecast(
  db: D1Database,
  project: string,
  period?: string | null,
): Promise<Record<string, unknown>> {
  const projectRow = await resolveProject(db, project);
  const settings = projectSettings(projectRow);
  const [resolvedPeriod, start, end] = periodBounds(period ?? (settings.target_period as string | undefined));
  const allRowsRaw = await all(
    db,
    `SELECT p.id, p.name, p.amount, p.currency, p.expected_close_at,
            p.forecast_category, p.probability, p.probability_source,
            p.next_step, p.next_step_due_at, p.close_date_changed_count,
            p.owner, p.qualified_at, p.last_contacted_at,
            s.key AS stage, s.terminal, s.outcome, c.name AS company_name
     FROM prospects p JOIN pipeline_stages s ON s.id=p.stage_id
     LEFT JOIN companies c ON c.id=p.company_id
     WHERE p.project_id=? AND p.qualified_at IS NOT NULL`,
    projectRow.id,
  );
  const allRows = allRowsRaw.map((row) => rowDict(row) ?? {});
  const rows = allRows.filter(
    (row) => row.expected_close_at && String(row.expected_close_at) >= start && String(row.expected_close_at) < end,
  );
  const forecastCurrency = (settings.currency as string) ?? (rows[0]?.currency as string) ?? "USD";
  const currencyMismatches = rows
    .filter((row) => row.currency !== forecastCurrency)
    .map((row) => ({ id: row.id, name: row.name, currency: row.currency }));
  const comparableRows = rows.filter((row) => row.currency === forecastCurrency);
  const openRows = comparableRows.filter((row) => !row.terminal);
  const wonRows = comparableRows.filter((row) => row.outcome === "won");
  const openPipeline = openRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const weighted = openRows.reduce(
    (sum, row) => sum + (Number(row.amount) || 0) * (Number(row.probability) || 0) / 100,
    0,
  );
  const commit = openRows
    .filter((row) => row.forecast_category === "commit")
    .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const bestCase = openRows
    .filter((row) => row.forecast_category === "commit" || row.forecast_category === "best_case")
    .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const closedWon = wonRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const target = settings.target_period === resolvedPeriod ? settings.target_amount : null;
  const missing = allRows
    .filter((row) => ["amount", "expected_close_at", "next_step", "probability"].some((key) => row[key] == null))
    .map((row) => ({
      id: row.id,
      name: row.name,
      missing: ["amount", "expected_close_at", "next_step", "probability"].filter((key) => row[key] == null),
    }));
  return {
    project: { id: projectRow.id, slug: projectRow.slug, name: projectRow.name },
    period: resolvedPeriod,
    currency: forecastCurrency,
    target,
    closed_won: closedWon,
    open_pipeline: openPipeline,
    weighted_forecast: Math.round(weighted * 100) / 100,
    best_case: bestCase,
    commit,
    pipeline_coverage: target ? Math.round((openPipeline / Number(target)) * 100) / 100 : null,
    commit_attainment: target ? Math.round(((closedWon + commit) / Number(target)) * 100) / 100 : null,
    opportunities: rows,
    missing_data: missing,
    excluded_currency_mismatches: currencyMismatches,
  };
}

export async function conversionReport(db: D1Database, project: string): Promise<Record<string, unknown>> {
  const projectRow = await resolveProject(db, project);
  const stages = (await all(
    db,
    "SELECT * FROM pipeline_stages WHERE project_id=? ORDER BY position",
    projectRow.id,
  )).map((row) => rowDict(row) ?? {});
  const createdRow = await first<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM prospects WHERE project_id=?",
    projectRow.id,
  );
  const created = Number(createdRow?.count ?? 0);
  const transitionRows = await all<{ stage: string; count: number }>(
    db,
    `SELECT json_extract(details_json, '$.to') AS stage, COUNT(DISTINCT entity_id) AS count
     FROM activities
     WHERE project_id=? AND entity_type='prospect' AND action='stage_changed'
     GROUP BY json_extract(details_json, '$.to')`,
    projectRow.id,
  );
  const transitions: Record<string, number> = {};
  for (const row of transitionRows) {
    if (row.stage) transitions[String(row.stage)] = Number(row.count);
  }
  transitions.identified = Math.max(transitions.identified ?? 0, created);
  const ordered = stages.filter(
    (s) => !["lost", "not_a_fit", "do_not_contact"].includes(String(s.key)),
  );
  const stageMetrics: Record<string, unknown>[] = [];
  let previous: number | null = null;
  for (const stageItem of ordered) {
    const reached = transitions[String(stageItem.key)] ?? 0;
    stageMetrics.push({
      stage: stageItem.key,
      reached,
      conversion_from_previous: previous ? Math.round((reached / previous) * 1000) / 1000 : null,
      conversion_from_created: created ? Math.round((reached / created) * 1000) / 1000 : null,
    });
    previous = reached;
  }
  const won = transitions.won ?? 0;
  return {
    project: { id: projectRow.id, slug: projectRow.slug, name: projectRow.name },
    prospects_created: created,
    won,
    overall_win_rate: created ? Math.round((won / created) * 1000) / 1000 : null,
    stages: stageMetrics,
    sample_warning: created < 30
      ? "Conversion rates are directional until enough historical stage transitions exist."
      : null,
  };
}

export async function pipelineRisks(
  db: D1Database,
  project: string,
  createTasks = false,
  actor?: string | null,
  staleDays?: number | null,
): Promise<Record<string, unknown>> {
  const projectRow = await resolveProject(db, project);
  const settings = projectSettings(projectRow);
  const resolvedStaleDays = staleDays ?? (settings.stale_days as number) ?? 30;
  const timestamp = now();
  const staleCutoff = subtractDaysIso(resolvedStaleDays);
  const prospectRows = await all(
    db,
    `SELECT p.id, p.name, p.owner, p.amount, p.next_contact_at, p.next_step_due_at,
            p.next_step, p.expected_close_at, p.updated_at, p.qualified_at,
            s.key AS stage, c.email, c.phone, co.name AS company_name
     FROM prospects p JOIN pipeline_stages s ON s.id=p.stage_id
     LEFT JOIN contacts c ON c.id=p.contact_id
     LEFT JOIN companies co ON co.id=p.company_id
     WHERE p.project_id=? AND s.terminal=0`,
    projectRow.id,
  );
  const prospects = prospectRows.map((row) => rowDict(row) ?? {});
  const risks: Record<string, unknown>[] = [];
  const openTaskProspects = new Set<string>();
  const prospectIds = prospects.map((item) => String(item.id));
  for (let i = 0; i < prospectIds.length; i += 50) {
    const chunk = prospectIds.slice(i, i + 50);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await all(
      db,
      `SELECT DISTINCT prospect_id FROM tasks WHERE status='open' AND prospect_id IN (${placeholders})`,
      ...chunk,
    );
    for (const row of rows) openTaskProspects.add(String(row.prospect_id));
  }

  const add = (
    prospect: Row,
    kind: string,
    severity: string,
    message: string,
    actionText: string,
  ) => {
    risks.push({
      kind,
      severity,
      prospect_id: prospect.id,
      prospect_name: prospect.name,
      stage: prospect.stage,
      amount: prospect.amount,
      message,
      recommended_action: actionText,
    });
  };

  for (const item of prospects) {
    const openTask = openTaskProspects.has(String(item.id));
    if (!item.owner) {
      add(item, "missing_owner", "high", "Active prospect has no owner.", "Assign an accountable owner.");
    }
    if (!openTask && !item.next_contact_at && !item.next_step_due_at) {
      add(item, "no_next_action", "high", "No open task or scheduled next action.", "Schedule the next concrete step.");
    }
    if (item.next_step_due_at && String(item.next_step_due_at) < timestamp) {
      add(item, "overdue_next_step", "critical", "The opportunity next step is overdue.", String(item.next_step ?? "Review the opportunity."));
    }
    if (item.expected_close_at && String(item.expected_close_at) < timestamp) {
      add(item, "expired_close_date", "critical", "Expected close date is in the past.", "Re-qualify or close the opportunity.");
    }
    if (String(item.updated_at) < staleCutoff) {
      add(item, "stale", "medium", `No CRM update in at least ${resolvedStaleDays} days.`, "Review status and schedule a next step.");
    }
    if (item.stage === "ready_to_contact" && !(item.email || item.phone)) {
      add(item, "not_contactable", "high", "Ready-to-contact prospect has no email or phone.", "Enrich the contact record.");
    }
    if (item.qualified_at && ["amount", "expected_close_at", "next_step"].some((key) => item[key] == null)) {
      add(item, "incomplete_forecast", "high", "Qualified opportunity is missing forecast evidence.", "Add amount, close date, and next step.");
    }
  }

  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  risks.sort((a, b) => {
    const sev = severityOrder[String(a.severity)] - severityOrder[String(b.severity)];
    if (sev !== 0) return sev;
    const amt = (Number(b.amount) || 0) - (Number(a.amount) || 0);
    if (amt !== 0) return amt;
    return String(a.prospect_name).localeCompare(String(b.prospect_name));
  });

  const createdTaskIds: string[] = [];
  if (createTasks) {
    const resolvedActor = requireActor(actor);
    for (const risk of risks) {
      const title = `CRM risk: ${risk.recommended_action}`;
      const exists = await first(
        db,
        "SELECT id FROM tasks WHERE prospect_id=? AND status='open' AND title=?",
        risk.prospect_id, title,
      );
      if (!exists) {
        const task = await createTask(
          db, project, resolvedActor, title,
          undefined, String(risk.prospect_id),
          undefined, undefined, undefined,
          risk.severity === "critical" ? "urgent" : "high",
        );
        createdTaskIds.push(String(task.id));
      }
    }
  }

  return {
    project: { id: projectRow.id, slug: projectRow.slug, name: projectRow.name },
    generated_at: timestamp,
    risks,
    counts: {
      critical: risks.filter((r) => r.severity === "critical").length,
      high: risks.filter((r) => r.severity === "high").length,
      medium: risks.filter((r) => r.severity === "medium").length,
      low: risks.filter((r) => r.severity === "low").length,
    },
    created_task_ids: createdTaskIds,
  };
}

export async function nextActions(
  db: D1Database,
  project: string,
  actor?: string | null,
  limit = 5,
  staleDays?: number | null,
  mode = "balanced",
  timeBudget?: number | null,
  precomputedRisks?: Record<string, unknown>[] | null,
): Promise<Record<string, unknown>> {
  if (!["balanced", "close", "pipeline_build"].includes(mode)) {
    throw new CRMError("Mode must be balanced, close, or pipeline_build.");
  }
  const projectRow = await resolveProject(db, project);
  const clampedLimit = Math.min(Math.max(limit, 3), 5);
  const timestamp = now();
  let taskSql = `SELECT t.*, p.name AS prospect_name, p.amount, p.forecast_category,
                        s.key AS stage, c.name AS company_name
                 FROM tasks t
                 LEFT JOIN prospects p ON p.id=t.prospect_id
                 LEFT JOIN pipeline_stages s ON s.id=p.stage_id
                 LEFT JOIN companies c ON c.id=COALESCE(t.company_id, p.company_id)
                 WHERE t.project_id=? AND t.status='open'`;
  const params: unknown[] = [projectRow.id];
  if (actor) {
    taskSql += " AND (t.assigned_to=? OR t.assigned_to IS NULL)";
    params.push(actor);
  }
  const taskRows = await all(db, taskSql, ...params);
  const candidates: Record<string, unknown>[] = [];
  const priorityScore: Record<string, number> = { urgent: 35, high: 25, normal: 15, low: 5 };

  for (const taskRow of taskRows) {
    const task = rowDict(taskRow) ?? {};
    let score = priorityScore[String(task.priority ?? "normal")] ?? 15;
    const why: string[] = [`${task.priority ?? "normal"} priority task`];
    const dueAt = task.due_at != null ? String(task.due_at) : null;
    if (dueAt && dueAt < timestamp) {
      score += 70;
      why.push("overdue");
    } else if (dueAt && dueAt.slice(0, 10) <= timestamp.slice(0, 10)) {
      score += 30;
      why.push("due today");
    } else if (dueAt) {
      score += 10;
      why.push("scheduled");
    }
    const amount = Number(task.amount) || 0;
    if (amount) {
      score += Math.min(Math.trunc(amount / 5000), 20);
      why.push(`${amount} in pipeline`);
    }
    if (task.forecast_category === "commit") {
      score += 20;
      why.push("commit opportunity");
    }
    if (mode === "close" && (task.stage === "replied" || task.stage === "meeting_booked")) {
      score += 20;
    }
    if (mode === "pipeline_build" && ["identified", "researching", "ready_to_contact"].includes(String(task.stage))) {
      score += 20;
    }
    candidates.push({
      type: "task",
      id: task.id,
      title: task.title,
      score: Math.min(score, 100),
      why_now: why,
      reason: why[0],
      suggested_action: task.title,
      estimated_effort_minutes: 15,
      priority: task.priority,
      due_at: dueAt,
      prospect_id: task.prospect_id,
      prospect_name: task.prospect_name,
      company_name: task.company_name,
      stage: task.stage,
      amount: amount || null,
    });
  }

  const risks = precomputedRisks
    ?? (((await pipelineRisks(db, project, false, null, staleDays ?? null)).risks as Record<string, unknown>[]) ?? []);
  const riskScore: Record<string, number> = { critical: 90, high: 75, medium: 55, low: 35 };
  for (const risk of risks) {
    if (actor) {
      const ownerRow = await first(db, "SELECT owner FROM prospects WHERE id=?", risk.prospect_id);
      if (ownerRow?.owner != null && ownerRow.owner !== actor) continue;
    }
    let score = riskScore[String(risk.severity)] ?? 35;
    if (risk.amount) {
      score += Math.min(Math.trunc(Number(risk.amount) / 10000), 10);
    }
    if (mode === "close" && (risk.stage === "replied" || risk.stage === "meeting_booked")) {
      score += 10;
    }
    if (mode === "pipeline_build" && (risk.kind === "not_contactable" || risk.kind === "missing_owner")) {
      score += 10;
    }
    candidates.push({
      type: "pipeline_risk",
      id: `${risk.kind}:${risk.prospect_id}`,
      title: risk.recommended_action,
      score: Math.min(score, 100),
      why_now: [risk.message, `${risk.severity} pipeline risk`],
      reason: risk.kind,
      suggested_action: risk.recommended_action,
      estimated_effort_minutes: 15,
      priority: risk.severity,
      due_at: null,
      prospect_id: risk.prospect_id,
      prospect_name: risk.prospect_name,
      company_name: null,
      stage: risk.stage,
      amount: risk.amount,
    });
  }

  candidates.sort((a, b) => {
    const scoreDiff = Number(b.score) - Number(a.score);
    if (scoreDiff !== 0) return scoreDiff;
    return String(a.title).localeCompare(String(b.title));
  });

  const selected: Record<string, unknown>[] = [];
  let usedMinutes = 0;
  const seen = new Set<string>();
  const seenProspects = new Set<string>();
  for (const item of candidates) {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) continue;
    if (item.prospect_id && seenProspects.has(String(item.prospect_id))) continue;
    const effort = Number(item.estimated_effort_minutes);
    if (timeBudget != null && selected.length && usedMinutes + effort > timeBudget) continue;
    selected.push(item);
    seen.add(key);
    if (item.prospect_id) seenProspects.add(String(item.prospect_id));
    usedMinutes += effort;
    if (selected.length >= clampedLimit) break;
  }

  return {
    project: { id: projectRow.id, slug: projectRow.slug, name: projectRow.name },
    generated_at: timestamp,
    mode,
    time_budget_minutes: timeBudget,
    estimated_total_minutes: usedMinutes,
    actions: selected,
    count: selected.length,
  };
}

export async function croReview(
  db: D1Database,
  project: string,
  period?: string | null,
): Promise<Record<string, unknown>> {
  const forecastData = await forecast(db, project, period);
  const riskData = await pipelineRisks(db, project);
  const findings: Record<string, unknown>[] = [];
  for (const risk of (riskData.risks as Record<string, unknown>[]) ?? []) {
    if (risk.severity === "critical" || risk.severity === "high") {
      findings.push({
        severity: risk.severity,
        finding: risk.message,
        evidence: {
          prospect_id: risk.prospect_id,
          prospect_name: risk.prospect_name,
          amount: risk.amount,
          stage: risk.stage,
        },
        recommended_action: risk.recommended_action,
      });
    }
  }
  const target = forecastData.target;
  const pipelineCoverage = forecastData.pipeline_coverage as number | null;
  if (target && pipelineCoverage != null && pipelineCoverage < 3) {
    findings.push({
      severity: pipelineCoverage < 1 ? "critical" : "high",
      finding: "Open pipeline coverage is below 3x target.",
      evidence: {
        target,
        open_pipeline: forecastData.open_pipeline,
        coverage: pipelineCoverage,
      },
      recommended_action: "Increase qualified pipeline or revise the forecast.",
    });
  }
  const currencyMismatches = forecastData.excluded_currency_mismatches as Record<string, unknown>[];
  if (currencyMismatches?.length) {
    findings.push({
      severity: "high",
      finding: "Some opportunities were excluded because their currency does not match the project forecast currency.",
      evidence: {
        forecast_currency: forecastData.currency,
        opportunities: currencyMismatches,
      },
      recommended_action: "Normalize opportunity currency before relying on the aggregate forecast.",
    });
  }
  const opportunities = (forecastData.opportunities as Row[]) ?? [];
  const commitRows = opportunities.filter((row) => row.forecast_category === "commit" && !row.terminal);
  const engagementCutoff = subtractDaysIso(14);
  const unsupportedCommit = commitRows.filter(
    (row) => !row.next_step
      || Number(row.close_date_changed_count ?? 0) >= 2
      || !row.last_contacted_at
      || String(row.last_contacted_at) < engagementCutoff,
  );
  if (unsupportedCommit.length) {
    findings.push({
      severity: "critical",
      finding: "Commit contains opportunities without credible supporting evidence.",
      evidence: {
        opportunity_count: unsupportedCommit.length,
        amount: unsupportedCommit.reduce((sum, row) => sum + (Number(row.amount) || 0), 0),
        prospect_ids: unsupportedCommit.map((row) => row.id),
      },
      recommended_action: "Re-qualify these opportunities or remove them from commit.",
    });
  }
  const slipped = opportunities.filter(
    (row) => !row.terminal && Number(row.close_date_changed_count ?? 0) >= 2,
  );
  if (slipped.length) {
    findings.push({
      severity: "high",
      finding: "Multiple opportunity close dates have been pushed at least twice.",
      evidence: {
        opportunity_count: slipped.length,
        amount: slipped.reduce((sum, row) => sum + (Number(row.amount) || 0), 0),
        prospect_ids: slipped.map((row) => row.id),
      },
      recommended_action: "Re-confirm buying process and timing instead of rolling dates forward.",
    });
  }
  const openRows = opportunities.filter((row) => !row.terminal);
  const openAmount = openRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  if (openAmount) {
    const largest = openRows.reduce((best, row) =>
      (Number(row.amount) || 0) > (Number(best.amount) || 0) ? row : best,
    );
    const concentration = (Number(largest.amount) || 0) / openAmount;
    if (concentration >= 0.5) {
      findings.push({
        severity: "high",
        finding: "The forecast is highly concentrated in one opportunity.",
        evidence: {
          prospect_id: largest.id,
          prospect_name: largest.name,
          amount: largest.amount,
          share_of_open_pipeline: Math.round(concentration * 100) / 100,
        },
        recommended_action: "Build additional qualified coverage and scenario-plan without this deal.",
      });
    }
  }
  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => severityOrder[String(a.severity)] - severityOrder[String(b.severity)]);
  const hasCritical = findings.some((item) => item.severity === "critical");
  return {
    project: forecastData.project,
    period: forecastData.period,
    headline: {
      target,
      closed_won: forecastData.closed_won,
      commit: forecastData.commit,
      weighted_forecast: forecastData.weighted_forecast,
      pipeline_coverage: forecastData.pipeline_coverage,
    },
    findings,
    finding_count: findings.length,
    verdict: hasCritical ? "at_risk" : findings.length ? "needs_attention" : "healthy",
  };
}

export async function sdrQueue(
  db: D1Database,
  project: string,
  limit = 25,
): Promise<Record<string, unknown>> {
  const projectRow = await resolveProject(db, project);
  const clampedLimit = Math.min(Math.max(limit, 1), 100);
  const fetchLimit = Math.min(clampedLimit * 10, 500);
  const rows = (await all(
    db,
    `SELECT p.id, p.name, p.stage_id, p.fit_score, p.priority, p.source_url,
            p.pain_points, p.qualification_notes, p.last_contacted_at, p.custom_json,
            s.key AS stage, c.full_name AS contact_name, c.email, c.phone,
            c.title, co.name AS company_name, co.domain, co.industry
     FROM prospects p JOIN pipeline_stages s ON s.id=p.stage_id
     LEFT JOIN contacts c ON c.id=p.contact_id
     LEFT JOIN companies co ON co.id=p.company_id
     WHERE p.project_id=? AND s.terminal=0
       AND s.key IN ('identified','researching','qualified','ready_to_contact')
     ORDER BY p.fit_score DESC, p.updated_at DESC
     LIMIT ?`,
    projectRow.id, fetchLimit,
  )).map((row) => rowDict(row) ?? {});

  const queue: Record<string, unknown>[] = [];
  for (const item of rows) {
    const custom = (item.custom as Record<string, JsonValue>) ?? {};
    const publicBusinessRoute = custom.public_business_route;
    const contactable = Boolean(item.email || item.phone || publicBusinessRoute);
    const completeness = [
      item.company_name, item.domain, item.contact_name, item.title,
      item.pain_points, item.source_url, contactable,
    ].filter(Boolean).length;
    const [signalTier, priorityWeight] = signalPriority(item);
    const score = priorityWeight + completeness * 2 + (contactable ? 10 : 0) + Math.trunc(Number(item.fit_score ?? 0) / 20);
    const missing = [
      [item.company_name, "company"],
      [item.domain, "company domain"],
      [item.contact_name, "contact"],
      [item.title, "contact title"],
      [contactable, "public business route"],
      [item.pain_points, "pain hypothesis"],
      [item.source_url, "source"],
    ].filter(([value]) => !value).map(([, label]) => label);
    const coreReady = Boolean(item.company_name && item.domain && item.pain_points && item.source_url);
    queue.push({
      ...item,
      signal_tier: signalTier,
      priority_weight: priorityWeight,
      public_business_route: publicBusinessRoute,
      score: Math.min(score, 100),
      research_completeness: Math.round((completeness / 7) * 100) / 100,
      contactable,
      missing,
      recommended_action: contactable && coreReady ? "prepare_outreach" : "enrich",
    });
  }
  queue.sort((a, b) => {
    const scoreDiff = Number(b.score) - Number(a.score);
    if (scoreDiff !== 0) return scoreDiff;
    return String(a.name).localeCompare(String(b.name));
  });
  return {
    project: { id: projectRow.id, slug: projectRow.slug, name: projectRow.name },
    queue: queue.slice(0, clampedLimit),
    count: Math.min(queue.length, clampedLimit),
  };
}

export async function experimentReport(
  db: D1Database,
  project: string,
  experimentId: string,
): Promise<Record<string, unknown>> {
  const projectRow = await resolveProject(db, project);
  const rows = (await all(
    db,
    `SELECT p.id, p.name, p.custom_json, s.key AS stage, co.name AS company_name
     FROM prospects p JOIN pipeline_stages s ON s.id=p.stage_id
     LEFT JOIN companies co ON co.id=p.company_id
     WHERE p.project_id=? AND json_extract(p.custom_json, '$.experiment_id')=?`,
    projectRow.id, experimentId,
  )).map((row) => rowDict(row) ?? {});

  const prospects: Record<string, unknown>[] = [];
  for (const item of rows) {
    const interactions = (await all(
      db,
      "SELECT direction, outcome, occurred_at FROM interactions WHERE prospect_id=? ORDER BY occurred_at",
      item.id,
    )).map((row) => rowDict(row) ?? {});
    const outcomes = new Set(
      interactions.map((entry) => entry.outcome).filter((o) => o != null).map(String),
    );
    const custom = (item.custom as Record<string, JsonValue>) ?? {};
    const prospectEntry: Record<string, unknown> = {
      prospect_id: item.id,
      prospect: item.name,
      company: item.company_name,
      cohort: custom.cohort,
      signal_tier: custom.signal_tier,
      priority_weight: custom.priority_weight ?? 0,
      stage: item.stage,
      contacted: interactions.some((entry) => entry.direction === "outbound"),
      replied: interactions.some((entry) => entry.direction === "inbound"),
    };
    for (const outcome of EXPERIMENT_OUTCOMES) {
      prospectEntry[outcome] = outcomes.has(outcome);
    }
    prospects.push(prospectEntry);
  }

  const cohortNames = [...new Set(prospects.map((p) => p.cohort).filter(Boolean))].sort() as string[];
  const cohorts: Record<string, Record<string, number>> = {};
  for (const cohort of cohortNames) {
    const selected = prospects.filter((p) => p.cohort === cohort);
    const entry: Record<string, number> = {
      accounts: selected.length,
      contacted: selected.filter((p) => p.contacted).length,
      replied: selected.filter((p) => p.replied).length,
    };
    for (const outcome of EXPERIMENT_OUTCOMES) {
      entry[outcome] = selected.filter((p) => p[outcome]).length;
    }
    cohorts[cohort] = entry;
  }

  const totals: Record<string, number> = {
    contacted: prospects.filter((p) => p.contacted).length,
    replied: prospects.filter((p) => p.replied).length,
  };
  for (const outcome of EXPERIMENT_OUTCOMES) {
    totals[outcome] = prospects.filter((p) => p[outcome]).length;
  }

  prospects.sort((a, b) => {
    const pw = Number(b.priority_weight) - Number(a.priority_weight);
    if (pw !== 0) return pw;
    return String(a.prospect).localeCompare(String(b.prospect));
  });

  return {
    project: { id: projectRow.id, slug: projectRow.slug, name: projectRow.name },
    experiment_id: experimentId,
    accounts: prospects.length,
    cohorts,
    totals,
    prospects,
  };
}

export async function researchBrief(db: D1Database, prospectId: string): Promise<Record<string, unknown>> {
  const prospect = await getProspect(db, prospectId);
  const notes = (prospect.notes as Row[]) ?? [];
  const sourcedNotes = notes.filter((note) => note.source_url);
  const unsourcedNotes = notes.filter((note) => !note.source_url);
  const publicBusinessRoute = ((prospect.custom as Record<string, JsonValue>) ?? {}).public_business_route;
  const hasRoute = Boolean(prospect.contact_email || prospect.contact_phone || publicBusinessRoute);
  const missing = [
    [prospect.company_name, "company"],
    [prospect.contact_name, "contact"],
    [prospect.source_url, "prospect source"],
    [prospect.pain_points, "pain hypothesis"],
    [prospect.needs, "needs"],
    [prospect.authority, "buying authority"],
    [prospect.timing, "timing"],
    [hasRoute, "public business route"],
  ].filter(([value]) => !value).map(([, label]) => label);

  return {
    prospect: {
      id: prospect.id,
      name: prospect.name,
      stage: prospect.stage,
      company_name: prospect.company_name,
      contact_name: prospect.contact_name,
      fit_score: prospect.fit_score,
      source_url: prospect.source_url,
    },
    verified_facts: sourcedNotes,
    unsourced_context: unsourcedNotes,
    missing_information: missing,
    research_questions: missing.map((item) => `Find and verify: ${item}.`),
    public_business_route: publicBusinessRoute,
    ready_for_outreach: !(missing as string[]).some((item) => ["company", "pain hypothesis", "public business route"].includes(item)),
  };
}

export async function outreachBrief(db: D1Database, prospectId: string): Promise<Record<string, unknown>> {
  const prospect = await getProspect(db, prospectId);
  const research = await researchBrief(db, prospectId);
  const prior = ((prospect.interactions as Row[]) ?? []).slice(0, 5);
  const publicBusinessRoute = ((prospect.custom as Record<string, JsonValue>) ?? {}).public_business_route;
  const hasRoute = Boolean(prospect.contact_email || prospect.contact_phone || publicBusinessRoute);
  const missing: string[] = [];
  if (!prospect.pain_points) missing.push("pain hypothesis");
  if (!hasRoute) missing.push("public business route");

  return {
    prospect: research.prospect,
    recommended_angle: prospect.pain_points ?? prospect.needs,
    qualification_context: prospect.qualification_notes,
    suggested_channel: prospect.contact_email ? "email"
      : prospect.contact_phone ? "call"
      : publicBusinessRoute ? "business_route"
      : "research",
    public_business_route: publicBusinessRoute,
    prior_interactions: prior,
    verified_facts: research.verified_facts,
    missing_prerequisites: missing,
    ready: !missing.length && !prospect.do_not_contact,
    safety_note: "This brief prepares outreach context; Agent CRM does not send messages.",
  };
}

export async function search(
  db: D1Database,
  project: string,
  query: string,
  limit = 50,
): Promise<Record<string, Row[]>> {
  const projectRow = await resolveProject(db, project);
  const pattern = `%${query}%`;
  const companies = (await all(
    db,
    "SELECT * FROM companies WHERE project_id=? AND (name LIKE ? OR domain LIKE ? OR description LIKE ?) LIMIT ?",
    projectRow.id, pattern, pattern, pattern, limit,
  )).map((r) => rowDict(r) ?? {});
  const contacts = (await all(
    db,
    "SELECT * FROM contacts WHERE project_id=? AND (full_name LIKE ? OR email LIKE ? OR title LIKE ?) LIMIT ?",
    projectRow.id, pattern, pattern, pattern, limit,
  )).map((r) => rowDict(r) ?? {});
  const prospects = (await all(
    db,
    "SELECT * FROM prospects WHERE project_id=? AND (name LIKE ? OR pain_points LIKE ? OR qualification_notes LIKE ?) LIMIT ?",
    projectRow.id, pattern, pattern, pattern, limit,
  )).map((r) => rowDict(r) ?? {});
  const notes = (await all(
    db,
    "SELECT * FROM notes WHERE project_id=? AND body LIKE ? LIMIT ?",
    projectRow.id, pattern, limit,
  )).map((r) => rowDict(r) ?? {});
  return { companies, contacts, prospects, notes };
}

export async function timeline(
  db: D1Database,
  entityType: string,
  entityId: string,
  limit = 100,
): Promise<Row[]> {
  const rows = await all(
    db,
    "SELECT * FROM activities WHERE entity_type=? AND entity_id=? ORDER BY occurred_at DESC, id DESC LIMIT ?",
    entityType, entityId, Math.min(Math.max(limit, 1), 1000),
  );
  return rows.map((r) => rowDict(r) ?? {});
}

