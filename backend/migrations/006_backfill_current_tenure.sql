-- Safe, targeted backfill for a database that ALREADY has an active tenure
-- (use this instead of 001 — 001 recomputes and overwrites opening balances).
-- It only ever fills in missing values; it never changes or deletes a row that
-- already has data, and never touches any tenure's opening/closing balances.
-- Idempotent: safe to run again at any time (e.g. right after a deploy, to
-- tag anything the previous version of the app saved without a tenure).
--
--   1. Records with no tenure get the tenure whose dates contain them.
--   2. Each member's dues for the active tenure are copied from the old
--      members.annual_dues column, but only where no dues row exists yet.
begin;

update transactions t set tenure_id = tn.id
from tenures tn
where t.tenure_id is null and t.date between tn.start_date and tn.end_date;

update events e set tenure_id = tn.id
from tenures tn
where e.tenure_id is null and e.date is not null and e.date between tn.start_date and tn.end_date;

update bills b set tenure_id = tn.id
from tenures tn
where b.tenure_id is null and b.date between tn.start_date and tn.end_date;

-- An undated event can't be placed by date: put it in the active tenure.
update events set tenure_id = (select id from tenures where status = 'active' order by start_date desc limit 1)
where tenure_id is null and exists (select 1 from tenures where status = 'active');

insert into member_tenure_dues (member_id, tenure_id, dues_amount)
select m.id, tn.id, m.annual_dues
from members m
cross join (select id from tenures where status = 'active' order by start_date desc limit 1) tn
on conflict (member_id, tenure_id) do nothing;

commit;
