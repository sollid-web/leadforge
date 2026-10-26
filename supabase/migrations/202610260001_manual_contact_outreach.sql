create table public.listing_contact_permissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  contact_type text not null check (contact_type in ('listing_agent', 'listing_office', 'owner')),
  status text not null default 'unknown' check (status in ('unknown', 'permitted', 'opted_out')),
  lawful_basis text,
  evidence_reference text,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (listing_id, contact_type),
  check (
    status <> 'permitted'
    or (lawful_basis is not null and evidence_reference is not null and reviewed_by is not null and reviewed_at is not null)
  )
);

create table public.listing_contact_outreach (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  permission_id uuid not null references public.listing_contact_permissions(id),
  contact_type text not null check (contact_type in ('listing_agent', 'listing_office', 'owner')),
  recipient_fingerprint text not null,
  content_fingerprint text not null,
  status text not null default 'processing' check (status in ('processing', 'sent', 'failed')),
  provider_message_id text,
  failure_reason text,
  sent_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create unique index listing_contact_outreach_in_flight
  on public.listing_contact_outreach (listing_id, recipient_fingerprint)
  where status = 'processing';

create index listing_contact_outreach_org_created_idx
  on public.listing_contact_outreach (organization_id, created_at desc);

create table public.listing_contact_opt_out_tokens (
  token_hash text primary key,
  permission_id uuid not null references public.listing_contact_permissions(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.listing_contact_permissions enable row level security;
alter table public.listing_contact_outreach enable row level security;
alter table public.listing_contact_opt_out_tokens enable row level security;

create policy contact_permissions_manager_access
  on public.listing_contact_permissions
  for all
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));

create policy contact_outreach_manager_read
  on public.listing_contact_outreach
  for select
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));

create policy contact_outreach_manager_insert
  on public.listing_contact_outreach
  for insert
  with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));

create policy contact_outreach_manager_update
  on public.listing_contact_outreach
  for update
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));

grant select, insert, update on public.listing_contact_permissions to authenticated;
grant select, insert, update on public.listing_contact_outreach to authenticated;
grant all on public.listing_contact_permissions, public.listing_contact_outreach, public.listing_contact_opt_out_tokens to service_role;
