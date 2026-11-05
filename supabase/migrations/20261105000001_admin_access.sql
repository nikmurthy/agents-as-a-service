-- Access for the admin web app.
-- platform_admins: Supabase logins that can see and manage every business. Only the platform (the connection's own
-- role) can read or change this table; tenant work never touches it.
create table platform_admins (
  user_id uuid primary key,
  email text,
  created_at timestamptz not null default now()
);
alter table platform_admins enable row level security;
alter table platform_admins force row level security;
do $$ begin
  execute format('create policy platform_admin on platform_admins for all to %I using (true) with check (true)', current_user);
end $$;

-- A login belongs to a business at most once.
create unique index tenant_members_tenant_user on tenant_members (tenant_id, user_id) where user_id is not null;
create index tenant_members_user on tenant_members (user_id) where user_id is not null;

-- Owners edit their own business's name and settings through the app. Column-level grant: status, slug and pack
-- stay out of reach of the tenant role.
grant update (name, settings) on tenants to app_tenant;
create policy tenant_self_update on tenants for update to app_tenant
  using (id = app_current_tenant()) with check (id = app_current_tenant());

-- People are invited by email: one person per address per business, and a quick way to find who an address belongs to
-- when they first sign in.
create unique index tenant_members_tenant_email on tenant_members (tenant_id, lower(email)) where email is not null;
create index tenant_members_email_unclaimed on tenant_members (lower(email)) where user_id is null and email is not null;
