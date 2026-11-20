-- Checkatrade leads: the owner (or an assistant) decides "I'm interested" or "Not for me" in Checkatrade by hand,
-- because Checkatrade doesn't allow automated access. We suggest which, record what they chose, and once
-- "I'm interested" shows them the customer's phone or email, they give it to us so later replies can go direct.

create table checkatrade_leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  message_id uuid not null unique references messages(id) on delete cascade,
  job_ref text,
  job_url text,
  suggestion text not null check (suggestion in ('interested', 'not_for_me')),
  suggestion_reason text,
  decision text not null default 'pending' check (decision in ('pending', 'interested', 'not_for_me')),
  decided_by uuid references tenant_members(id) on delete set null,
  decided_at timestamptz,
  details_added_at timestamptz,
  created_at timestamptz not null default now()
);
create index on checkatrade_leads (tenant_id, conversation_id);

alter table checkatrade_leads enable row level security;
alter table checkatrade_leads force row level security;
create policy tenant_isolation on checkatrade_leads for all to app_tenant
  using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
grant select, insert, update, delete on checkatrade_leads to app_tenant;
do $$ begin
  execute format('create policy platform_admin on checkatrade_leads for all to %I using (true) with check (true)', current_user);
end $$;

-- After "I'm interested", the owner can send the customer's phone or email to the platform number on WhatsApp.
alter table approval_requests drop constraint approval_requests_state_check;
alter table approval_requests add constraint approval_requests_state_check check (state in ('sent', 'awaiting_edit', 'awaiting_details', 'done'));
