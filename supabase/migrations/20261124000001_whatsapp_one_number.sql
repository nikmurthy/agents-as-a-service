-- One WhatsApp number for a sole trader: their WhatsApp Business app number, shared with the platform (Meta "coexistence").
-- Personal chats on that number must be left alone, and replies the owner sends from the app replace our draft.

-- A draft the owner made unnecessary by replying to the customer themselves in the WhatsApp Business app.
alter table drafts drop constraint drafts_status_check;
alter table drafts add constraint drafts_status_check
  check (status in ('pending_approval', 'approved', 'rejected', 'sent', 'manual', 'failed', 'expired', 'superseded'));

-- "Ignore this person": nothing from them is stored or answered on any channel.
alter table contacts add column ignored_at timestamptz;

-- People saved in the owner's phone (synced once from the WhatsApp Business app). Only a keyed hash of each
-- number is kept: no names, and the numbers can't be read back. Used to leave friends and family alone.
create table wa_saved_contacts (
  tenant_id uuid not null references tenants(id) on delete cascade,
  phone_hash text not null,
  primary key (tenant_id, phone_hash)
);

alter table wa_saved_contacts enable row level security;
alter table wa_saved_contacts force row level security;
create policy tenant_isolation on wa_saved_contacts for all to app_tenant
  using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
grant select, insert, update, delete on wa_saved_contacts to app_tenant;
do $$ begin
  execute format('create policy platform_admin on wa_saved_contacts for all to %I using (true) with check (true)', current_user);
end $$;
