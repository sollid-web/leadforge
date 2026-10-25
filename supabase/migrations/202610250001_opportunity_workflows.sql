create type public.source_kind as enum ('manual', 'approved_feed', 'partner_feed', 'public_api');
create type public.opportunity_status as enum ('new', 'review', 'matched', 'closed', 'suppressed');
create type public.interest_status as enum ('pending', 'approved', 'rejected', 'withdrawn');
create type public.approval_status as enum ('pending', 'approved', 'rejected', 'revoked');

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  team_id uuid references public.teams(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table public.agent_profiles (
  agent_id uuid primary key references public.agents(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  display_name text not null,
  service_areas text[] not null default '{}',
  specialties text[] not null default '{}',
  currency text,
  min_budget numeric,
  max_budget numeric,
  updated_at timestamptz not null default now()
);

create table public.agent_preferences (
  agent_id uuid primary key references public.agents(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  notify_in_app boolean not null default true,
  notify_email boolean not null default false,
  quiet_hours jsonb not null default '{}'::jsonb,
  opt_out_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.listing_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  source_key text not null,
  source_type public.source_kind not null,
  source_url text,
  ingestion_token_hash text unique,
  approved boolean not null default false,
  active boolean not null default true,
  opt_out_instructions text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (organization_id, source_key)
);

create table public.listings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id uuid not null references public.listing_sources(id),
  dedupe_key text not null,
  external_id text,
  title text not null,
  summary text not null,
  description text,
  property_type text not null check (property_type in ('house', 'apartment', 'land', 'commercial', 'other')),
  area text not null,
  city text not null,
  region text,
  country_code char(2) not null,
  price numeric,
  currency char(3) not null,
  owner_led_claim boolean not null default false,
  source_url text,
  first_seen_at timestamptz not null default now(),
  status public.opportunity_status not null default 'new',
  suppressed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, dedupe_key)
);

create table public.source_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id uuid not null references public.listing_sources(id) on delete cascade,
  listing_id uuid references public.listings(id) on delete set null,
  external_id text,
  payload_fingerprint text not null,
  sanitized_metadata jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now()
);

create table public.owners (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  verification_status text not null default 'unverified' check (verification_status in ('unverified', 'pending', 'verified', 'rejected')),
  created_at timestamptz not null default now(),
  unique (listing_id)
);

create table public.owner_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  owner_id uuid not null references public.owners(id) on delete cascade,
  encrypted_payload text not null,
  encryption_iv text not null,
  encryption_auth_tag text not null,
  key_version text not null,
  contact_permission text not null default 'unknown' check (contact_permission in ('unknown', 'permitted', 'opted_out')),
  opted_out_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.listing_private_details (
  listing_id uuid primary key references public.listings(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  key_version text not null,
  created_at timestamptz not null default now()
);

create table public.listing_verifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  reviewer_id uuid references auth.users(id),
  status text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  evidence_reference text,
  notes text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.listing_scores (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  score integer not null check (score between 0 and 100),
  trust_score integer not null check (trust_score between 0 and 100),
  owner_led_score integer not null check (owner_led_score between 0 and 100),
  urgency_score integer not null check (urgency_score between 0 and 100),
  quality_score integer not null check (quality_score between 0 and 100),
  rule_version text not null,
  factors jsonb not null,
  scored_at timestamptz not null default now()
);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  score integer not null check (score between 0 and 100),
  reasons jsonb not null default '[]'::jsonb,
  status text not null default 'suggested' check (status in ('suggested', 'notified', 'interested', 'dismissed')),
  created_at timestamptz not null default now(),
  unique (listing_id, agent_id)
);

create table public.interest_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  match_id uuid not null references public.matches(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  status public.interest_status not null default 'pending',
  message text,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id),
  unique (match_id)
);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  interest_request_id uuid not null references public.interest_requests(id) on delete cascade,
  reviewer_id uuid references auth.users(id),
  status public.approval_status not null default 'pending',
  reason text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (interest_request_id)
);

create table public.outreach_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  match_id uuid not null references public.matches(id) on delete cascade,
  channel text not null default 'in_app' check (channel in ('in_app', 'email')),
  summary text not null,
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'approved', 'sent', 'failed', 'cancelled')),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.outreach_messages
  add column recipient text,
  add column subject text,
  add column body text,
  add column provider_message_id text,
  add column failure_reason text;

create unique index outreach_messages_one_email_per_match
  on public.outreach_messages (match_id)
  where channel = 'email';

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'completed')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  provider text,
  provider_customer_id text,
  provider_subscription_id text,
  status text not null default 'trialing',
  plan text not null default 'starter',
  current_period_end timestamptz,
  created_at timestamptz not null default now()
);

create table public.source_health (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id uuid not null references public.listing_sources(id) on delete cascade,
  status text not null default 'unknown' check (status in ('healthy', 'degraded', 'failed', 'unknown')),
  last_checked_at timestamptz,
  last_success_at timestamptz,
  consecutive_failures integer not null default 0,
  message text,
  unique (source_id)
);

create index listings_org_status_idx on public.listings(organization_id, status, created_at desc);
create index listings_org_city_idx on public.listings(organization_id, city);
create index matches_agent_created_idx on public.matches(agent_id, created_at desc);
create index interest_org_status_idx on public.interest_requests(organization_id, status, requested_at desc);
create index snapshots_source_captured_idx on public.source_snapshots(source_id, captured_at desc);

create or replace function public.agent_can_reveal_listing(target_listing uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.interest_requests ir
    join public.matches m on m.id = ir.match_id
    join public.agents a on a.id = ir.agent_id
    join public.approvals ap on ap.interest_request_id = ir.id
    join public.listings l on l.id = m.listing_id
    where m.listing_id = target_listing
      and l.suppressed_at is null
      and l.status <> 'suppressed'
      and a.user_id = auth.uid()
      and a.active
      and ir.status = 'approved'
      and ap.status = 'approved'
  );
$$;

create or replace function public.create_organization(organization_name text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  created_organization_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if length(trim(organization_name)) < 2 or length(trim(organization_name)) > 120 then
    raise exception 'Organization name must be between 2 and 120 characters';
  end if;
  insert into public.organizations(name) values (trim(organization_name))
  returning id into created_organization_id;
  insert into public.organization_members(organization_id, user_id, role)
  values (created_organization_id, auth.uid(), 'owner');
  insert into public.users(id, full_name)
  select auth.uid(), raw_user_meta_data ->> 'full_name'
  from auth.users where id = auth.uid()
  on conflict (id) do update set full_name = excluded.full_name, updated_at = now();
  return created_organization_id;
end;
$$;

revoke all on function public.create_organization(text) from public, anon;
grant execute on function public.create_organization(text) to authenticated;

revoke all on function public.is_org_member(uuid) from public, anon;
grant execute on function public.is_org_member(uuid) to authenticated, service_role;
revoke all on function public.has_org_role(uuid, public.member_role[]) from public, anon;
grant execute on function public.has_org_role(uuid, public.member_role[]) to authenticated, service_role;
revoke all on function public.agent_can_reveal_listing(uuid) from public, anon;
grant execute on function public.agent_can_reveal_listing(uuid) to authenticated, service_role;

alter table public.users enable row level security;
alter table public.teams enable row level security;
alter table public.agents enable row level security;
alter table public.agent_profiles enable row level security;
alter table public.agent_preferences enable row level security;
alter table public.listing_sources enable row level security;
alter table public.listings enable row level security;
alter table public.source_snapshots enable row level security;
alter table public.owners enable row level security;
alter table public.owner_contacts enable row level security;
alter table public.listing_private_details enable row level security;
alter table public.listing_verifications enable row level security;
alter table public.listing_scores enable row level security;
alter table public.matches enable row level security;
alter table public.interest_requests enable row level security;
alter table public.approvals enable row level security;
alter table public.outreach_messages enable row level security;
alter table public.campaigns enable row level security;
alter table public.subscriptions enable row level security;
alter table public.source_health enable row level security;

create policy user_profile_read_self on public.users for select using (id = auth.uid());
create policy user_profile_insert_self on public.users for insert with check (id = auth.uid());
create policy user_profile_update_self on public.users for update using (id = auth.uid()) with check (id = auth.uid());
create policy teams_org_read on public.teams for select using (public.is_org_member(organization_id));
create policy agents_org_read on public.agents for select using (
  public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])
  or user_id = auth.uid()
);
create policy agents_admin_manage on public.agents for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy agents_self_register on public.agents for insert with check (user_id = auth.uid() and public.is_org_member(organization_id));
create policy agent_profiles_org_read on public.agent_profiles for select using (
  public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])
  or exists (select 1 from public.agents a where a.id = agent_id and a.user_id = auth.uid())
);
create policy agent_profiles_admin_manage on public.agent_profiles for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy agent_profiles_self_setup on public.agent_profiles for insert with check (exists (select 1 from public.agents a where a.id = agent_id and a.user_id = auth.uid() and a.organization_id = organization_id));
create policy preferences_self_read on public.agent_preferences for select using (exists (select 1 from public.agents a where a.id = agent_id and a.user_id = auth.uid()));
create policy preferences_self_manage on public.agent_preferences for all using (exists (select 1 from public.agents a where a.id = agent_id and a.user_id = auth.uid())) with check (exists (select 1 from public.agents a where a.id = agent_id and a.user_id = auth.uid()));
create policy sources_org_read on public.listing_sources for select using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy sources_admin_manage on public.listing_sources for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy listings_org_read on public.listings for select using (public.is_org_member(organization_id));
create policy listings_admin_manage on public.listings for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy snapshots_org_read on public.source_snapshots for select using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy snapshots_admin_manage on public.source_snapshots for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy owners_org_read on public.owners for select using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy owners_admin_manage on public.owners for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy owner_contacts_revealed_read on public.owner_contacts for select using (public.agent_can_reveal_listing((select o.listing_id from public.owners o where o.id = owner_id)));
create policy owner_contacts_admin_manage on public.owner_contacts for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy private_details_revealed_read on public.listing_private_details for select using (public.agent_can_reveal_listing(listing_id));
create policy private_details_admin_manage on public.listing_private_details for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy verifications_org_read on public.listing_verifications for select using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy verifications_admin_manage on public.listing_verifications for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy scores_org_read on public.listing_scores for select using (public.is_org_member(organization_id));
create policy scores_admin_manage on public.listing_scores for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy matches_org_read on public.matches for select using (
  public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])
  or exists (select 1 from public.agents a where a.id = agent_id and a.user_id = auth.uid())
);
create policy matches_admin_manage on public.matches for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy interests_self_or_admin_read on public.interest_requests for select using (exists (select 1 from public.agents a where a.id = agent_id and a.user_id = auth.uid()) or public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy interests_agent_insert on public.interest_requests for insert with check (exists (select 1 from public.agents a where a.id = agent_id and a.user_id = auth.uid() and a.organization_id = organization_id));
create policy interests_admin_update on public.interest_requests for update using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy approvals_admin_access on public.approvals for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy outreach_org_read on public.outreach_messages for select using (
  public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])
  or exists (select 1 from public.matches m join public.agents a on a.id = m.agent_id where m.id = match_id and a.user_id = auth.uid())
);
create policy outreach_admin_manage on public.outreach_messages for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy campaigns_org_access on public.campaigns for all using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy subscriptions_admin_read on public.subscriptions for select using (public.has_org_role(organization_id, array['owner','admin']::public.member_role[]));
create policy source_health_org_read on public.source_health for select using (public.is_org_member(organization_id));
create policy source_health_admin_manage on public.source_health for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));

create policy audit_logs_actor_insert on public.audit_logs for insert with check (public.is_org_member(organization_id) and actor_id = auth.uid());
create policy audit_logs_manager_read on public.audit_logs as restrictive for select using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
