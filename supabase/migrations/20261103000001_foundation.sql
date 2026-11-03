-- Foundation schema for the agent platform.
-- Every business is a tenant. Every tenant-owned row carries tenant_id and is protected by row-level security.
-- Application code runs tenant work as the role app_tenant with app.tenant_id set for the transaction (see src/db.ts).
-- Platform-level work (routing webhooks to tenants, onboarding) runs as the connection's own privileged role.

create extension if not exists pgcrypto;

-- Role used for all tenant-scoped work. No login, no RLS bypass.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_tenant') then
    create role app_tenant nologin;
  end if;
end $$;
grant app_tenant to current_user;
grant usage on schema public to app_tenant;

create or replace function app_current_tenant() returns uuid
language sql stable as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- ---------------------------------------------------------------- tenants and people
create table tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{3,40}$'),
  name text not null,
  pack text not null,                       -- sector pack: flooring, trades, practitioner...
  settings jsonb not null default '{}',     -- tone, services, price guide, reply routes, working hours, retention...
  status text not null default 'onboarding' check (status in ('onboarding', 'active', 'paused', 'closed')),
  created_at timestamptz not null default now()
);

create table tenant_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid,                             -- Supabase auth user, once they have a login
  name text not null,
  role text not null default 'owner' check (role in ('owner', 'staff')),
  email text,
  whatsapp_phone text,                      -- E.164; where approval requests go
  is_approver boolean not null default true,
  approver_last_inbound_at timestamptz,     -- opens WhatsApp's 24-hour window for interactive messages
  created_at timestamptz not null default now()
);
create index on tenant_members (whatsapp_phone);

create table tenant_use_cases (
  tenant_id uuid not null references tenants(id) on delete cascade,
  use_case text not null check (use_case in ('answer_enquiries', 'book_appointments', 'regulation_watch', 'find_customers')),
  enabled boolean not null default true,
  config jsonb not null default '{}',
  primary key (tenant_id, use_case)
);

-- ---------------------------------------------------------------- channel connections
create table channel_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null check (kind in ('gmail', 'google_calendar', 'whatsapp', 'web_form', 'checkatrade_webhook')),
  external_id text not null,                -- email address, calendar id, WhatsApp phone_number_id, form token...
  label text,
  status text not null default 'active' check (status in ('active', 'error', 'disconnected')),
  secret_ciphertext text,                   -- AES-256-GCM, see src/crypto.ts. Never stored in plain text.
  config jsonb not null default '{}',
  cursor jsonb not null default '{}',       -- e.g. Gmail historyId
  last_error text,
  created_at timestamptz not null default now(),
  unique (kind, external_id)
);
create index on channel_connections (tenant_id);

-- ---------------------------------------------------------------- contacts and conversations
create table contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text,
  erased_at timestamptz,
  created_at timestamptz not null default now()
);
create index on contacts (tenant_id);

create table contact_identities (
  tenant_id uuid not null references tenants(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  kind text not null check (kind in ('email', 'phone')),
  value text not null,
  primary key (tenant_id, kind, value)
);
create index on contact_identities (contact_id);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'closed')),
  last_inbound_at timestamptz,
  whatsapp_window_closes_at timestamptz,
  email_thread jsonb,                       -- { threadId, messageId, subject } for replying in thread
  created_at timestamptz not null default now()
);
create index on conversations (tenant_id, contact_id, status);

create table messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  channel text not null,
  channel_message_id text,
  subject text,
  body text,                                -- nulled by retention and erasure
  structured jsonb,
  attachments jsonb,
  from_name text,
  data_tags text[] not null default '{}',
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index messages_dedupe on messages (tenant_id, channel, channel_message_id) where direction = 'in' and channel_message_id is not null;
create index on messages (conversation_id, received_at);

-- ---------------------------------------------------------------- agents and runs
create table agent_definitions (
  agent_key text not null,
  version text not null,
  definition jsonb not null,
  created_at timestamptz not null default now(),
  primary key (agent_key, version)
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  message_id uuid references messages(id) on delete set null,
  use_case text not null,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  triage jsonb,
  booking jsonb,
  outcome text,
  outcome_reason text,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index on runs (tenant_id, created_at desc);

create table run_events (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  run_id uuid not null references runs(id) on delete cascade,
  at timestamptz not null default now(),
  step text not null,
  agent text,
  agent_version text,
  model text,
  input_tokens int,
  output_tokens int,
  ms int,
  detail text
);
create index on run_events (run_id);

-- ---------------------------------------------------------------- drafts, approvals, sending
create table drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  run_id uuid references runs(id) on delete set null,
  conversation_id uuid not null references conversations(id) on delete cascade,
  reply_route text not null,                -- whatsapp, email, checkatrade_message, sms, phone
  body text not null,
  original_body text not null,
  review jsonb,
  needs_attention boolean not null default false,
  attention_reason text,
  status text not null default 'pending_approval'
    check (status in ('pending_approval', 'approved', 'rejected', 'sent', 'manual', 'failed', 'expired')),
  decided_by uuid references tenant_members(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index on drafts (tenant_id, status);

create table approval_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  draft_id uuid not null references drafts(id) on delete cascade,
  member_id uuid not null references tenant_members(id) on delete cascade,
  wa_message_id text,
  state text not null default 'sent' check (state in ('sent', 'awaiting_edit', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on approval_requests (member_id, state);

create table outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  draft_id uuid references drafts(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  route text not null,
  to_address text,
  body text not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'manual', 'failed')),
  attempts int not null default 0,
  provider_message_id text,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

-- ---------------------------------------------------------------- bookings
create table holds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  calendar_connection_id uuid references channel_connections(id) on delete set null,
  calendar_event_id text,
  service text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'held' check (status in ('held', 'confirmed', 'released', 'expired', 'cancelled')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  check (end_at > start_at)
);
create index on holds (tenant_id, status, start_at);
create index on holds (conversation_id);

-- ---------------------------------------------------------------- data assurance
create table suppression (
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null check (kind in ('email', 'phone')),
  value text not null,
  reason text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, kind, value)
);

create table data_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  kind text not null check (kind in ('export', 'erase')),
  requested_by text not null,
  status text not null default 'done',
  created_at timestamptz not null default now()
);

-- Append-only audit trail. Rows can be added, never changed or removed.
create table audit_log (
  id bigserial primary key,
  tenant_id uuid references tenants(id) on delete set null,
  at timestamptz not null default now(),
  actor text not null,                      -- system, agent:triage, member:<id>, admin:<name>
  action text not null,
  entity text,
  entity_id text,
  detail jsonb
);
create index on audit_log (tenant_id, at desc);

create or replace function audit_log_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.tenant_id is null and old.tenant_id is not null
     and new.id = old.id and new.action = old.action and new.at = old.at then
    return new; -- allow the foreign key's "set null" when a tenant is deleted
  end if;
  raise exception 'audit_log is append-only';
end $$;
create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function audit_log_immutable();

-- ---------------------------------------------------------------- row-level security
do $$
declare t text;
begin
  foreach t in array array[
    'tenant_members', 'tenant_use_cases', 'channel_connections', 'contacts', 'contact_identities',
    'conversations', 'messages', 'runs', 'run_events', 'drafts', 'approval_requests', 'outbox',
    'holds', 'suppression', 'data_requests'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I for all to app_tenant using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    execute format('grant select, insert, update, delete on %I to app_tenant', t);
  end loop;
end $$;

alter table tenants enable row level security;
alter table tenants force row level security;
create policy tenant_self on tenants for select to app_tenant using (id = app_current_tenant());
grant select on tenants to app_tenant;

alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy audit_tenant on audit_log for all to app_tenant using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
grant select, insert on audit_log to app_tenant;
grant usage on sequence audit_log_id_seq, run_events_id_seq to app_tenant;

grant select on agent_definitions to app_tenant;

-- The connection's own role (postgres on Supabase) is the platform admin path. FORCE RLS applies to table owners too,
-- so give it an explicit bypass policy on every table.
do $$
declare t text;
begin
  foreach t in array array[
    'tenants', 'tenant_members', 'tenant_use_cases', 'channel_connections', 'contacts', 'contact_identities',
    'conversations', 'messages', 'runs', 'run_events', 'drafts', 'approval_requests', 'outbox',
    'holds', 'suppression', 'data_requests', 'audit_log'
  ] loop
    execute format('create policy platform_admin on %I for all to %I using (true) with check (true)', t, current_user);
  end loop;
end $$;

-- Supabase logins (for a future dashboard): members can read their own business's data.
do $$
declare t text;
begin
  if exists (select 1 from pg_namespace where nspname = 'auth') and exists (select 1 from pg_roles where rolname = 'authenticated') then
    foreach t in array array['tenant_members', 'tenant_use_cases', 'contacts', 'conversations', 'messages', 'runs', 'drafts', 'holds'] loop
      execute format(
        'create policy member_read on %I for select to authenticated using (tenant_id in (select m.tenant_id from tenant_members m where m.user_id = auth.uid()))', t);
      execute format('grant select on %I to authenticated', t);
    end loop;
    create policy member_read on tenants for select to authenticated
      using (id in (select m.tenant_id from tenant_members m where m.user_id = auth.uid()));
    grant select on tenants to authenticated;
  end if;
end $$;
