CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL
);

CREATE TABLE pipeline_stages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)),
    outcome TEXT CHECK (outcome IN ('won', 'lost', 'disqualified', 'do_not_contact')),
    UNIQUE(project_id, key),
    UNIQUE(project_id, position)
);

CREATE TABLE stage_transitions (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    from_stage_id TEXT NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE,
    to_stage_id TEXT NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE,
    PRIMARY KEY(from_stage_id, to_stage_id)
);

CREATE TABLE companies (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    domain TEXT,
    website TEXT,
    linkedin_url TEXT,
    industry TEXT,
    employee_count INTEGER,
    annual_revenue TEXT,
    location TEXT,
    description TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    custom_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    UNIQUE(project_id, domain)
);

CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
    first_name TEXT,
    last_name TEXT,
    full_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    title TEXT,
    department TEXT,
    seniority TEXT,
    linkedin_url TEXT,
    location TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    custom_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    UNIQUE(project_id, email)
);

CREATE TABLE prospects (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
    company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
    stage_id TEXT NOT NULL REFERENCES pipeline_stages(id),
    name TEXT NOT NULL,
    source TEXT,
    source_url TEXT,
    owner TEXT,
    fit_score INTEGER CHECK (fit_score BETWEEN 0 AND 100),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    pain_points TEXT,
    needs TEXT,
    budget TEXT,
    authority TEXT,
    timing TEXT,
    qualification_notes TEXT,
    do_not_contact INTEGER NOT NULL DEFAULT 0 CHECK (do_not_contact IN (0, 1)),
    lost_reason TEXT,
    last_contacted_at TEXT,
    next_contact_at TEXT,
    stale_after TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    custom_json TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1,
    amount REAL,
    currency TEXT,
    expected_close_at TEXT,
    forecast_category TEXT CHECK (forecast_category IN ('pipeline', 'best_case', 'commit', 'closed')),
    probability INTEGER CHECK (probability BETWEEN 0 AND 100),
    probability_source TEXT CHECK (probability_source IN ('manual', 'stage_default', 'historical')),
    next_step TEXT,
    next_step_due_at TEXT,
    qualified_at TEXT,
    close_date_changed_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL
);

CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    prospect_id TEXT REFERENCES prospects(id) ON DELETE CASCADE,
    contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
    company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'general',
    body TEXT NOT NULL,
    source_url TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    CHECK (prospect_id IS NOT NULL OR contact_id IS NOT NULL OR company_id IS NOT NULL)
);

CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    prospect_id TEXT REFERENCES prospects(id) ON DELETE CASCADE,
    contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
    company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    due_at TEXT,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    assigned_to TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL
);

CREATE TABLE activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE interactions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    prospect_id TEXT REFERENCES prospects(id) ON DELETE CASCADE,
    contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
    company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'call', 'sms', 'linkedin', 'meeting', 'other')),
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),
    outcome TEXT,
    summary TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    external_ref TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    CHECK (prospect_id IS NOT NULL OR contact_id IS NOT NULL OR company_id IS NOT NULL)
);

CREATE TABLE enrichment_attempts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN
        ('running', 'ready', 'manual_review', 'unresolved', 'no_email', 'pending', 'failed', 'applied')),
    review_state TEXT NOT NULL CHECK (review_state IN
        ('not_applicable', 'pending_approval', 'manual_review', 'applied')),
    input_json TEXT NOT NULL,
    identity_json TEXT NOT NULL DEFAULT '{}',
    providers_json TEXT NOT NULL DEFAULT '[]',
    proposed_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    applied_at TEXT,
    applied_by TEXT
);

CREATE INDEX idx_contacts_project_name ON contacts(project_id, full_name);
CREATE INDEX idx_companies_project_name ON companies(project_id, name);
CREATE INDEX idx_prospects_project_stage ON prospects(project_id, stage_id);
CREATE INDEX idx_prospects_updated ON prospects(project_id, updated_at);
CREATE INDEX idx_tasks_due ON tasks(project_id, status, due_at);
CREATE INDEX idx_activities_entity ON activities(entity_type, entity_id, occurred_at);
CREATE INDEX idx_interactions_prospect ON interactions(prospect_id, occurred_at);
CREATE INDEX idx_interactions_project ON interactions(project_id, occurred_at);
CREATE INDEX idx_prospects_close_date ON prospects(project_id, expected_close_at);
CREATE INDEX idx_enrichment_attempts_contact ON enrichment_attempts(contact_id, created_at DESC);
