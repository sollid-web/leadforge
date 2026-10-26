alter table public.business_prospect_outreach
  add column reply_token_hash text unique;

create table public.business_prospect_replies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  prospect_id uuid not null references public.business_prospects(id) on delete cascade,
  outreach_id uuid not null references public.business_prospect_outreach(id) on delete cascade,
  provider_email_id text not null unique,
  sender_email text not null,
  subject text not null,
  message text not null,
  provider_message_id text,
  status text not null default 'received'
    check (status in ('received', 'drafted', 'sending', 'sent', 'failed')),
  ai_draft text,
  reply_body text,
  reply_provider_message_id text,
  received_at timestamptz not null default now(),
  drafted_at timestamptz,
  replied_at timestamptz,
  created_at timestamptz not null default now()
);

create index business_prospect_replies_org_received_idx
  on public.business_prospect_replies (organization_id, received_at desc);

create index business_prospect_replies_prospect_received_idx
  on public.business_prospect_replies (prospect_id, received_at desc);

alter table public.business_prospect_replies enable row level security;

create policy business_prospect_replies_manager_read
  on public.business_prospect_replies
  for select
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));

grant select on public.business_prospect_replies to authenticated;
grant all on public.business_prospect_replies to service_role;
grant update (ai_draft, reply_body, status, reply_provider_message_id, replied_at)
  on public.business_prospect_replies to service_role;

create unique index audit_logs_unique_business_prospect_reply_received
  on public.audit_logs (entity_id)
  where action = 'business_prospect.reply_received';
