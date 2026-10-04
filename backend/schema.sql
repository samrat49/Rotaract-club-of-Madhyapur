-- Club Finance Tracker — Postgres schema
-- Run with: psql -d club_finance -f schema.sql

create extension if not exists pgcrypto; -- gives us gen_random_uuid()

-- Officer accounts (whoever can log in and edit data)
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text unique not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- Self-reported club position (e.g. "Treasurer") shown on the account page.
-- Independent of members.designation, which is the club roster's own field —
-- this is the login account holder's own title, editable by themselves.
alter table users add column if not exists position text not null default '';

-- Single-row table holding club-wide settings
create table if not exists club_settings (
  id int primary key default 1,
  club_name text not null default 'Rotaract Club of Madhyapur Finance Tracker',
  opening_cash numeric not null default 0,
  opening_online numeric not null default 0,
  opening_bank numeric not null default 0,
  constraint single_row check (id = 1)
);
insert into club_settings (id) values (1) on conflict (id) do nothing;

-- Migration for databases created before the "Cash in Online" account was added.
alter table club_settings add column if not exists opening_online numeric not null default 0;

create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  designation text not null default '',
  phone text,
  annual_dues numeric not null default 0,
  created_at timestamptz not null default now()
);

-- Migration for databases created before club board designations were added.
alter table members add column if not exists designation text not null default '';

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  date date,
  budget numeric default 0,
  expected_income numeric default 0,
  expected_expense numeric default 0,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  description text not null,
  type text not null check (type in ('Income','Expense')),
  category text not null,
  account text not null check (account in ('Cash','Online','Bank')),
  amount numeric not null check (amount > 0),
  payment_method text,
  notes text,
  member_id uuid references members(id) on delete set null,
  event_id uuid references events(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_transactions_date on transactions(date);
create index if not exists idx_transactions_member on transactions(member_id);
create index if not exists idx_transactions_event on transactions(event_id);

-- Migration for databases created before "Cash in Online" was added as a
-- third account (previously just Cash / Bank).
alter table transactions drop constraint if exists transactions_account_check;
alter table transactions add constraint transactions_account_check check (account in ('Cash','Online','Bank'));

-- Liabilities: money the club owes — to a vendor/other source, or to a
-- member (e.g. reimbursing them). Optionally linked to a member so their
-- pending liability can be weighed against dues they still owe the club.
create table if not exists liabilities (
  id uuid primary key default gen_random_uuid(),
  payee_name text not null,
  member_id uuid references members(id) on delete set null,
  event_id uuid references events(id) on delete set null,
  category text,
  amount numeric not null check (amount > 0),
  paid_amount numeric not null default 0 check (paid_amount >= 0),
  status text not null default 'pending' check (status in ('pending','paid')),
  date date not null,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_liabilities_member on liabilities(member_id);
create index if not exists idx_liabilities_status on liabilities(status);

-- Migration for databases created before liabilities could be filed under an
-- event — must run before the index below, since it needs this column to exist.
alter table liabilities add column if not exists event_id uuid references events(id) on delete set null;
create index if not exists idx_liabilities_event on liabilities(event_id);

-- Each payment against a liability is recorded as a normal expense
-- transaction, tagged back to the liability it paid down — same pattern as
-- member_id / event_id above.
alter table transactions add column if not exists liability_id uuid references liabilities(id) on delete set null;
create index if not exists idx_transactions_liability on transactions(liability_id);

-- Bill images/PDFs, filed under an event the same way transactions are.
-- file_data holds a base64 data: URL. Fine for an MVP at moderate volume;
-- if bill volume grows a lot, move file_data to object storage (e.g. S3)
-- and keep just a URL here.
create table if not exists bills (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id) on delete set null,
  file_name text not null,
  file_type text not null,
  file_data text not null,
  description text,
  date date not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_bills_event on bills(event_id);

-- Activity log: records every deletion/edit made anywhere in the app, for
-- transparency. Rows are inserted by the API and never updated or deleted —
-- enforced below at the database level so this holds even for a direct
-- psql session, not just through the app.
create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  action text not null check (action in ('delete','update')),
  entity_type text not null check (entity_type in ('transaction','member','event','bill','liability')),
  entity_id uuid,
  summary text not null,
  before_data jsonb,
  after_data jsonb,
  performed_by_id uuid,
  performed_by_name text,
  performed_by_email text,
  created_at timestamptz not null default now()
);

create index if not exists idx_activity_log_created on activity_log(created_at desc);

-- eSewa monthly statement imports — a standalone read-only ledger of what
-- eSewa's own "Statement Report" export reports each month. Deliberately
-- kept separate from `transactions` / account balances: this is a copy of
-- the merchant's records for reference, not a manually entered transaction.
create table if not exists esewa_uploads (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  from_date_raw text,
  to_date_raw text,
  parsed_count int not null default 0,
  inserted_count int not null default 0,
  duplicate_count int not null default 0,
  uploaded_by_id uuid,
  uploaded_by_name text,
  created_at timestamptz not null default now()
);

create table if not exists esewa_transactions (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid references esewa_uploads(id) on delete cascade,
  reference_code text,
  txn_date date not null,
  txn_time time,
  description text not null,
  type text not null check (type in ('Income','Expense')),
  amount numeric not null check (amount > 0),
  balance numeric,
  status text,
  channel text,
  month_key text not null,
  created_at timestamptz not null default now(),
  -- Lets re-uploading an overlapping date range silently skip rows already
  -- on file, instead of double-counting income/expense.
  unique (reference_code, txn_date, txn_time, description, type, amount)
);

create index if not exists idx_esewa_txn_month on esewa_transactions(month_key);
create index if not exists idx_esewa_txn_upload on esewa_transactions(upload_id);

-- Lets a raw eSewa statement row be "transferred" into the real ledger —
-- copied into `transactions` as a normal income/expense entry — while
-- keeping a link back so the same row can't be transferred twice. Set back
-- to null if the linked transaction is later deleted, so the eSewa row just
-- goes back to "not yet transferred" instead of erroring.
alter table esewa_transactions add column if not exists linked_transaction_id uuid references transactions(id) on delete set null;

-- Rotary tenures ("2026-27" etc, July 1 – June 30). The source of truth for
-- account opening/closing balances going forward — club_settings'
-- opening_cash/online/bank below are deprecated in favor of this, left in
-- place only as a historical seed value for the very first tenure.
create table if not exists tenures (
  id uuid primary key default gen_random_uuid(),
  label text not null unique,
  start_date date not null,
  end_date date not null,
  status text not null default 'active' check (status in ('active','closed')),
  opening_cash numeric not null default 0,
  opening_online numeric not null default 0,
  opening_bank numeric not null default 0,
  closing_cash numeric,
  closing_online numeric,
  closing_bank numeric,
  closed_at timestamptz,
  closed_by uuid references users(id),
  created_at timestamptz not null default now()
);

-- At most one tenure can be active at a time — enforced at the DB level so
-- a bug can't leave two tenures both claiming to be "current".
create unique index if not exists idx_tenures_single_active on tenures (status) where status = 'active';

-- transactions/events/bills are point-in-time entities scoped to whichever
-- tenure they happened in. members and liabilities deliberately get no
-- tenure_id — the roster and unpaid debts persist across tenure boundaries.
alter table transactions add column if not exists tenure_id uuid references tenures(id);
alter table events add column if not exists tenure_id uuid references tenures(id);
alter table bills add column if not exists tenure_id uuid references tenures(id);
create index if not exists idx_transactions_tenure on transactions(tenure_id);
create index if not exists idx_events_tenure on events(tenure_id);
create index if not exists idx_bills_tenure on bills(tenure_id);

-- Per-member, per-tenure dues — replaces the flat members.annual_dues below
-- (left in place, deprecated, not dropped) so a member's dues status can be
-- tracked independently each rotary year.
create table if not exists member_tenure_dues (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id) on delete cascade,
  tenure_id uuid not null references tenures(id) on delete cascade,
  dues_amount numeric not null default 0 check (dues_amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (member_id, tenure_id)
);
create index if not exists idx_member_tenure_dues_tenure on member_tenure_dues(tenure_id);
create index if not exists idx_member_tenure_dues_member on member_tenure_dues(member_id);

-- Canonical activity_log constraints, kept up to date in place rather than
-- as a chain of narrower historical migrations (a narrower intermediate
-- constraint would fail against rows already using a value it doesn't
-- include, e.g. re-running this on a DB with existing 'esewa' rows).
alter table activity_log drop constraint if exists activity_log_entity_type_check;
alter table activity_log add constraint activity_log_entity_type_check check (entity_type in ('transaction','member','event','bill','liability','esewa','tenure'));
alter table activity_log drop constraint if exists activity_log_action_check;
alter table activity_log add constraint activity_log_action_check check (action in ('delete','update','create'));

create or replace function prevent_activity_log_mutation() returns trigger as $$
begin
  raise exception 'activity_log rows are immutable and cannot be updated or deleted';
end;
$$ language plpgsql;

drop trigger if exists trg_activity_log_no_update on activity_log;
create trigger trg_activity_log_no_update
  before update on activity_log
  for each row execute function prevent_activity_log_mutation();

drop trigger if exists trg_activity_log_no_delete on activity_log;
create trigger trg_activity_log_no_delete
  before delete on activity_log
  for each row execute function prevent_activity_log_mutation();

-- Login/activity tracking shown on the admin page (see migrations/002_user_activity.sql).
alter table users add column if not exists last_login_at timestamptz;
alter table users add column if not exists last_seen_at timestamptz;

-- Per-member permissions (see migrations/003_user_permissions.sql).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'permissions'
  ) then
    alter table users add column permissions text[] not null default '{}';
    update users set permissions =
      array['members','transactions','event_transactions','esewa','events','bills'];
  end if;
end $$;

-- Time-limited permissions (see migrations/004_permission_expiry.sql).
alter table users add column if not exists permission_expires jsonb not null default '{}'::jsonb;

-- Admin sign-in credentials (see migrations/005_admin_credentials.sql).
create table if not exists admin_credentials (
  id int primary key default 1 check (id = 1),
  email text not null,
  password_hash text not null,
  version int not null default 1,
  updated_at timestamptz not null default now()
);
