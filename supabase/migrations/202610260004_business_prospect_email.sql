create table public.business_prospect_email_opt_outs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email_fingerprint text not null,
  opted_out_at timestamptz not null default now(),
  source text not null default 'email_link',
  unique (organization_id, email_fingerprint)
);

create table public.business_prospect_outreach (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  prospect_id uuid not null references public.business_prospects(id) on delete cascade,
  recipient_fingerprint text not null,
  content_fingerprint text not null,
  subject text not null,
  body text not null,
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed')),
  provider_message_id text,
  failure_reason text,
  sent_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create unique index business_prospect_outreach_in_flight
  on public.business_prospect_outreach (prospect_id, recipient_fingerprint)
  where status = 'sending';

create index business_prospect_outreach_org_created_idx
  on public.business_prospect_outreach (organization_id, created_at desc);

create table public.business_prospect_opt_out_tokens (
  token_hash text primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  prospect_id uuid not null references public.business_prospects(id) on delete cascade,
  email_fingerprint text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.business_prospect_email_opt_outs enable row level security;
alter table public.business_prospect_outreach enable row level security;
alter table public.business_prospect_opt_out_tokens enable row level security;

create policy business_prospect_email_opt_outs_manager_read
  on public.business_prospect_email_opt_outs
  for select
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));

create policy business_prospect_outreach_manager_access
  on public.business_prospect_outreach
  for all
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));

grant select, insert, update, delete on public.business_prospect_email_opt_outs, public.business_prospect_outreach to authenticated;
grant all on public.business_prospect_email_opt_outs, public.business_prospect_outreach, public.business_prospect_opt_out_tokens to service_role;

create unique index audit_logs_unique_business_prospect_email_opt_out
  on public.audit_logs (entity_id, (metadata->>'email_fingerprint'))
  where action = 'business_prospect.email_opted_out';

create or replace function public.reserve_business_prospect_email(
  target_organization uuid,
  target_prospect uuid,
  target_recipient_fingerprint text,
  target_content_fingerprint text,
  target_subject text,
  target_body text
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  now_at timestamptz := clock_timestamp();
  outreach_id uuid;
begin
  if auth.uid() is null or not public.has_org_role(
    target_organization,
    array['owner','admin','manager']::public.member_role[]
  ) then
    raise exception 'Manager permission required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_organization::text, 0));

  if not exists (
    select 1 from public.business_prospects
    where id = target_prospect and organization_id = target_organization
  ) then
    raise exception 'Business prospect not found';
  end if;

  if exists (
    select 1 from public.business_prospect_email_opt_outs
    where organization_id = target_organization
      and email_fingerprint = target_recipient_fingerprint
  ) then
    raise exception 'This business email address has opted out';
  end if;

  if exists (
    select 1 from public.business_prospect_outreach
    where prospect_id = target_prospect
      and recipient_fingerprint = target_recipient_fingerprint
      and status = 'sent'
      and sent_at > now_at - interval '30 days'
  ) then
    raise exception 'This prospect was emailed in the last 30 days';
  end if;

  if (
    select count(*) from public.business_prospect_outreach
    where organization_id = target_organization
      and created_at > now_at - interval '24 hours'
  ) >= 20 then
    raise exception 'Workspace email limit reached: at most 20 prospect emails per 24 hours';
  end if;

  insert into public.business_prospect_outreach (
    organization_id, prospect_id, recipient_fingerprint, content_fingerprint, subject, body, sent_by
  ) values (
    target_organization, target_prospect, target_recipient_fingerprint,
    target_content_fingerprint, target_subject, target_body, auth.uid()
  ) returning id into outreach_id;

  return jsonb_build_object('id', outreach_id);
end;
$$;

revoke all on function public.reserve_business_prospect_email(uuid, uuid, text, text, text, text) from public, anon;
grant execute on function public.reserve_business_prospect_email(uuid, uuid, text, text, text, text) to authenticated;
grant execute on function public.reserve_business_prospect_email(uuid, uuid, text, text, text, text) to service_role;
