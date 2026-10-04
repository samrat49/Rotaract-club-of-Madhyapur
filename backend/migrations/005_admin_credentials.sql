-- Admin sign-in credentials, editable from the admin Settings page. A single
-- row (id is pinned to 1). While no row exists the server falls back to the
-- ADMIN_EMAIL / ADMIN_PASSWORD_HASH env vars; once a row exists it wins.
-- `version` goes up on every change and is baked into admin tokens, so changing
-- the email or password signs out every other admin session.
-- Additive and idempotent; touches no existing data.
create table if not exists admin_credentials (
  id int primary key default 1 check (id = 1),
  email text not null,
  password_hash text not null,
  version int not null default 1,
  updated_at timestamptz not null default now()
);
