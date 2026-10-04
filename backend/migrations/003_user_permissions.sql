-- Per-member permissions, granted by the admin (see lib/permissions.js).
-- Idempotent: the backfill runs ONLY the first time the column is created, so
-- re-running this never overwrites permissions the admin has since set.
--
-- Existing members keep what they can do today (everything except Settings),
-- so rolling this out doesn't suddenly lock the team out of data entry.
-- Accounts created afterwards start with no permissions (view-only) until an
-- admin grants some.
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
