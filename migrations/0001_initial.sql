PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','engineer')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, revoked_at TEXT, ip_hash TEXT
);
CREATE TABLE login_attempts (
  id TEXT PRIMARY KEY, identifier_hash TEXT NOT NULL, attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  succeeded INTEGER NOT NULL DEFAULT 0 CHECK(succeeded IN (0,1))
);
CREATE TABLE clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT, notes TEXT,
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, archived_at TEXT
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), name TEXT NOT NULL, address TEXT,
  contract_piastres INTEGER NOT NULL DEFAULT 0 CHECK(contract_piastres >= 0), start_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','suspended')),
  notes TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, archived_at TEXT
);
CREATE TABLE project_assignments (
  project_id TEXT NOT NULL REFERENCES projects(id), engineer_id TEXT NOT NULL REFERENCES users(id),
  assigned_by TEXT NOT NULL REFERENCES users(id), assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, unassigned_at TEXT,
  PRIMARY KEY(project_id, engineer_id)
);
CREATE TABLE expense_categories (id TEXT PRIMARY KEY, name_ar TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1);
INSERT INTO expense_categories VALUES ('materials','مواد ومشتريات',1),('transport','مواصلات',1),('labor','عمالة وأجور',1),('equipment','معدات وأدوات',1),('other','مصروفات أخرى',1);
CREATE TABLE client_payments (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), amount_piastres INTEGER NOT NULL CHECK(amount_piastres > 0),
  paid_on TEXT NOT NULL, reference TEXT, notes TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, voided_at TEXT, voided_by TEXT REFERENCES users(id)
);
CREATE TABLE advances (
  id TEXT PRIMARY KEY, engineer_id TEXT NOT NULL REFERENCES users(id), amount_piastres INTEGER NOT NULL CHECK(amount_piastres > 0),
  kind TEXT NOT NULL CHECK(kind IN ('handover','return')),
  occurred_on TEXT NOT NULL, notes TEXT, processed_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, voided_at TEXT, voided_by TEXT REFERENCES users(id)
);
CREATE TABLE advance_requests (
  id TEXT PRIMARY KEY, engineer_id TEXT NOT NULL REFERENCES users(id), amount_piastres INTEGER NOT NULL CHECK(amount_piastres > 0), reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, decided_at TEXT, decided_by TEXT REFERENCES users(id), decision_note TEXT
);
CREATE TABLE expenses (
  id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, engineer_id TEXT NOT NULL REFERENCES users(id), project_id TEXT NOT NULL REFERENCES projects(id),
  category_id TEXT NOT NULL REFERENCES expense_categories(id), amount_piastres INTEGER NOT NULL CHECK(amount_piastres > 0), description TEXT,
  no_receipt_reason TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','returned','cancellation_requested','cancelled')),
  submission_key TEXT NOT NULL UNIQUE, submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT, decided_by TEXT REFERENCES users(id), decision_note TEXT, corrected_from TEXT REFERENCES expenses(id), cancelled_at TEXT, cancelled_by TEXT REFERENCES users(id)
);
CREATE TABLE expense_attachments (
  id TEXT PRIMARY KEY, expense_id TEXT NOT NULL REFERENCES expenses(id), object_key TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL, bytes INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE expense_history (
  id TEXT PRIMARY KEY, expense_id TEXT NOT NULL REFERENCES expenses(id), from_status TEXT, to_status TEXT NOT NULL, note TEXT, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE cancellation_requests (
  id TEXT PRIMARY KEY, expense_id TEXT NOT NULL UNIQUE REFERENCES expenses(id), requested_by TEXT NOT NULL REFERENCES users(id), reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, decided_by TEXT REFERENCES users(id), decided_at TEXT, decision_note TEXT
);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id), action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, metadata TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_expenses_project_status ON expenses(project_id,status); CREATE INDEX idx_expenses_engineer_status ON expenses(engineer_id,status); CREATE INDEX idx_sessions_token ON sessions(token_hash); CREATE INDEX idx_audit_entity ON audit_logs(entity_type,entity_id);
CREATE INDEX idx_login_attempts_identifier ON login_attempts(identifier_hash,attempted_at);
