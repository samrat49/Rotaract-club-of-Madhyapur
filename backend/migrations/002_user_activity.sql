-- Additive, idempotent: tracks when each account last signed in and was last
-- active, for the admin page. Safe to run more than once; touches no data.
alter table users add column if not exists last_login_at timestamptz;
alter table users add column if not exists last_seen_at timestamptz;
