-- Supabase's own API roles (anon, authenticated) get access to new tables in "public" by default. The platform never
-- uses that API: the admin app talks to our server, and the server connects directly. So:
-- 1. Row-Level Security on the two tables that didn't have it (Supabase flagged these).
-- 2. Take every table and sequence away from Supabase's API roles, now and for tables made later.

alter table agent_definitions enable row level security;
create policy agent_definitions_read on agent_definitions for select to app_tenant using (true);

alter table schema_migrations enable row level security; -- only the migration runner (the owner) uses it

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
    end if;
  end loop;
end $$;
