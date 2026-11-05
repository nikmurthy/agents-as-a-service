-- Chase quotes: when the owner marks a quote as sent and the customer goes quiet, draft one polite follow-up
-- for the owner to approve. The follow-up goes through the same approval path as every other reply.

alter table tenant_use_cases drop constraint tenant_use_cases_use_case_check;
alter table tenant_use_cases add constraint tenant_use_cases_use_case_check
  check (use_case in ('answer_enquiries', 'book_appointments', 'chase_quotes', 'regulation_watch', 'find_customers'));

alter table conversations add column quoted_at timestamptz;   -- owner marked a quote as sent
alter table conversations add column chased_at timestamptz;   -- the follow-up was drafted (once per quote)
create index on conversations (tenant_id, quoted_at) where quoted_at is not null and chased_at is null;

alter table drafts add column kind text not null default 'reply' check (kind in ('reply', 'chase'));
