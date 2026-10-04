-- Time-limited permissions: maps a permission key to an ISO timestamp after
-- which it stops applying, e.g. {"events": "2026-10-05T14:00:00.000Z"}. A key
-- in users.permissions with no entry here is permanent. Additive and idempotent.
alter table users add column if not exists permission_expires jsonb not null default '{}'::jsonb;
