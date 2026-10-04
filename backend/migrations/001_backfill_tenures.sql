-- !! DO NOT RUN THIS on a database that already has a tenure. It rebuilds the
-- !! tenure list and OVERWRITES opening/closing balances. For a database that
-- !! already has an active tenure, use 006_backfill_current_tenure.sql instead.
-- One-off data migration: backfills tenures for transactions/events/bills
-- that existed before the tenure system was added. NOT part of schema.sql —
-- run this by hand, exactly once, against a database that already has the
-- schema.sql changes applied (the `tenures` table and `tenure_id` columns
-- must exist first).
--
-- BEFORE RUNNING: take a backup (e.g. `pg_dump`). This inserts tenure rows
-- and updates every existing transaction/event/bill.
--
-- Run with: psql "$DATABASE_URL" -f backend/migrations/001_backfill_tenures.sql

begin;

-- Step 1: one tenure row per distinct July-June period found in the data.
-- Uses today's server date to decide which bucket is still "active".
with all_dates as (
  select date as d from transactions
  union all select date from events where date is not null
  union all select date from bills
),
buckets as (
  select distinct
    case when extract(month from d) >= 7
      then extract(year from d)::int
      else extract(year from d)::int - 1
    end as start_year
  from all_dates
)
insert into tenures (label, start_date, end_date, status)
select
  start_year || '-' || right((start_year + 1)::text, 2),
  make_date(start_year, 7, 1),
  make_date(start_year + 1, 6, 30),
  case when make_date(start_year + 1, 6, 30) < current_date then 'closed' else 'active' end
from buckets
order by start_year
on conflict (label) do nothing;

-- Step 2: stamp tenure_id on existing rows by date range.
update transactions t set tenure_id = tn.id
from tenures tn
where t.tenure_id is null and t.date between tn.start_date and tn.end_date;

update events e set tenure_id = tn.id
from tenures tn
where e.tenure_id is null and e.date is not null and e.date between tn.start_date and tn.end_date;

-- Events with no date can't be bucketed by date — default to the most
-- recent tenure and flag for the treasurer to hand-correct afterward.
update events e set tenure_id = (select id from tenures order by start_date desc limit 1)
where e.tenure_id is null;

update bills b set tenure_id = tn.id
from tenures tn
where b.tenure_id is null and b.date between tn.start_date and tn.end_date;

-- Step 3: reconstruct opening/closing balances.
-- The earliest tenure's opening balances come from club_settings — that's
-- exactly what those fields represented before tenures existed.
update tenures set opening_cash = cs.opening_cash, opening_online = cs.opening_online, opening_bank = cs.opening_bank
from club_settings cs
where cs.id = 1 and tenures.id = (select id from tenures order by start_date asc limit 1);

-- Chain every later tenure's opening balance from the previous tenure's
-- computed closing balance (opening + income - expense of its own
-- transactions), oldest to newest.
do $$
declare
  t record;
  prev_closing_cash numeric;
  prev_closing_online numeric;
  prev_closing_bank numeric;
  delta record;
  d_cash numeric; d_online numeric; d_bank numeric;
begin
  for t in select * from tenures order by start_date asc loop
    if t.opening_cash is null or (t.start_date <> (select min(start_date) from tenures)) then
      update tenures set opening_cash = prev_closing_cash, opening_online = prev_closing_online, opening_bank = prev_closing_bank
      where id = t.id;
    end if;

    select coalesce(sum(case when type = 'Income' and account = 'Cash' then amount when type = 'Expense' and account = 'Cash' then -amount else 0 end), 0),
           coalesce(sum(case when type = 'Income' and account = 'Online' then amount when type = 'Expense' and account = 'Online' then -amount else 0 end), 0),
           coalesce(sum(case when type = 'Income' and account = 'Bank' then amount when type = 'Expense' and account = 'Bank' then -amount else 0 end), 0)
    into d_cash, d_online, d_bank
    from transactions where tenure_id = t.id;

    select opening_cash, opening_online, opening_bank into prev_closing_cash, prev_closing_online, prev_closing_bank
    from tenures where id = t.id;

    prev_closing_cash := prev_closing_cash + d_cash;
    prev_closing_online := prev_closing_online + d_online;
    prev_closing_bank := prev_closing_bank + d_bank;

    update tenures
    set closing_cash = case when status = 'closed' then prev_closing_cash else closing_cash end,
        closing_online = case when status = 'closed' then prev_closing_online else closing_online end,
        closing_bank = case when status = 'closed' then prev_closing_bank else closing_bank end
    where id = t.id;
  end loop;
end $$;

commit;

-- MANUAL SIGN-OFF REQUIRED: the reconstructed opening/closing balances above
-- are best-effort, derived from bucketing existing transactions by date —
-- they are not a real historical closeout. Compare against known real-world
-- balances before trusting them, and correct any tenures.opening_*/closing_*
-- values by hand if they don't match.

-- Verify no NULLs remain before tightening constraints:
--   select count(*) from transactions where tenure_id is null;
--   select count(*) from events where tenure_id is null;
--   select count(*) from bills where tenure_id is null;
-- Then, once verified:
--   alter table transactions alter column tenure_id set not null;
--   alter table events alter column tenure_id set not null;
--   alter table bills alter column tenure_id set not null;
