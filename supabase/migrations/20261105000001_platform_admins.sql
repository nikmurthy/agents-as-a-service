-- Platform admins: people who can see and manage every business through the admin web app.
-- Not tenant data, so no tenant_id. Only the platform's own role can read or change it; app_tenant has no grant.
create table platform_admins (
  user_id uuid primary key,                 -- Supabase auth user
  email text not null,
  created_at timestamptz not null default now()
);

alter table platform_admins enable row level security;
alter table platform_admins force row level security;
do $$ begin
  execute format('create policy platform_admin on platform_admins for all to %I using (true) with check (true)', current_user);
end $$;

-- Business owners edit their own business's name and settings from the web app.
-- Status (active/paused) stays a platform-level change, so it is not granted here.
create policy tenant_self_update on tenants for update to app_tenant
  using (id = app_current_tenant()) with check (id = app_current_tenant());
grant update (name, settings) on tenants to app_tenant;
