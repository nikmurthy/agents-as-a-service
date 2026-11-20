-- Flows: per-business choices for each step, "learn then offer to automate", and asking customers for feedback.

-- Asking for feedback is a use case the business switches on.
alter table tenant_use_cases drop constraint tenant_use_cases_use_case_check;
alter table tenant_use_cases add constraint tenant_use_cases_use_case_check
  check (use_case in ('answer_enquiries', 'book_appointments', 'chase_quotes', 'ask_feedback', 'regulation_watch', 'find_customers'));

-- What kind of reply a draft is (code decides; null = never automated), and whether it went without asking.
alter table drafts drop constraint drafts_kind_check;
alter table drafts add constraint drafts_kind_check check (kind in ('reply', 'chase', 'feedback'));
alter table drafts add column category text;
alter table drafts add column auto_sent boolean not null default false;
create index on drafts (tenant_id, category, decided_at);

-- The owner marked the job as done (for work not booked through the calendar), and when feedback was asked for.
alter table conversations add column completed_at timestamptz;
alter table conversations add column feedback_asked_at timestamptz;

-- Kinds of reply the business has been offered to automate, or switched on.
create table automations (
  tenant_id uuid not null references tenants(id) on delete cascade,
  category text not null,
  state text not null check (state in ('offered', 'on', 'declined')),
  decided_by uuid references tenant_members(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, category)
);

alter table automations enable row level security;
alter table automations force row level security;
create policy tenant_isolation on automations for all to app_tenant
  using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
grant select, insert, update, delete on automations to app_tenant;
do $$ begin
  execute format('create policy platform_admin on automations for all to %I using (true) with check (true)', current_user);
end $$;
