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

-- Single-row table holding club-wide settings
create table if not exists club_settings (
  id int primary key default 1,
  club_name text not null default 'Club Finance Tracker',
  opening_cash numeric not null default 0,
  opening_bank numeric not null default 0,
  constraint single_row check (id = 1)
);
insert into club_settings (id) values (1) on conflict (id) do nothing;

create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  annual_dues numeric not null default 0,
  created_at timestamptz not null default now()
);

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
  account text not null check (account in ('Cash','Bank')),
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
