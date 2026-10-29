alter table public.listing_collection_runs
  add column worker_manifest_ingest_status text not null default 'pending'
    check (worker_manifest_ingest_status in ('pending','processing','completed','failed')),
  add column worker_manifest_ingest_started_at timestamptz,
  add column worker_manifest_ingested_at timestamptz,
  add column worker_manifest_digest text,
  add column worker_manifest_ingest_error text;

create table public.owner_discovery_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id uuid not null references public.listing_sources(id) on delete cascade,
  city text not null check (length(trim(city)) between 2 and 120),
  country_code char(2) not null check (country_code ~ '^[A-Z]{2}$'),
  result_limit integer not null default 20 check (result_limit between 1 and 50),
  cadence_hours integer not null default 24 check (cadence_hours between 24 and 168),
  authorization_reference text not null check (length(trim(authorization_reference)) between 3 and 500),
  authorization_scope text not null check (length(trim(authorization_scope)) between 10 and 2000),
  authorization_expires_at timestamptz not null,
  enabled boolean not null default false,
  next_run_at timestamptz,
  lease_expires_at timestamptz,
  last_run_id uuid references public.listing_collection_runs(id) on delete set null,
  last_run_at timestamptz,
  last_run_status text check (last_run_status is null or last_run_status in ('completed','degraded','failed')),
  last_run_error text,
  created_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, city),
  unique (id, organization_id)
);

create index owner_discovery_policies_due_idx
  on public.owner_discovery_policies(next_run_at, lease_expires_at)
  where enabled = true;

alter table public.owner_discovery_policies enable row level security;
create policy owner_discovery_policies_manager_read
  on public.owner_discovery_policies for select
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
revoke insert, update, delete on public.owner_discovery_policies from anon, authenticated;
grant select on public.owner_discovery_policies to authenticated;
grant all on public.owner_discovery_policies to service_role;

create or replace function public.claim_due_owner_discovery_policy()
returns table (
  policy_id uuid,
  organization_id uuid,
  source_id uuid,
  run_id uuid,
  source_key text,
  source_name text,
  source_type text,
  source_url text,
  city text,
  country_code text,
  result_limit integer,
  authorization_reference text,
  authorization_scope text,
  authorization_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  policy_row public.owner_discovery_policies%rowtype;
  source_row public.listing_sources%rowtype;
  inserted_run_id uuid;
begin
  select p.* into policy_row
  from public.owner_discovery_policies p
  where p.enabled = true
    and p.next_run_at is not null
    and p.next_run_at <= now()
    and (p.lease_expires_at is null or p.lease_expires_at <= now())
    and p.authorization_expires_at > now()
  order by p.next_run_at asc, p.created_at asc
  for update skip locked
  limit 1;

  if not found then return; end if;

  select s.* into source_row
  from public.listing_sources s
  where s.id = policy_row.source_id
    and s.organization_id = policy_row.organization_id
    and s.approved = true
    and s.active = true;

  if not found then
    update public.owner_discovery_policies
      set enabled = false,
          lease_expires_at = null,
          last_run_status = 'failed',
          last_run_error = 'Source is no longer approved and active.',
          updated_at = now()
      where id = policy_row.id;
    return;
  end if;

  update public.owner_discovery_policies
    set next_run_at = now() + make_interval(hours => policy_row.cadence_hours),
        lease_expires_at = now() + interval '30 minutes',
        updated_at = now()
    where id = policy_row.id;

  insert into public.listing_collection_runs (
    organization_id, source_id, provider, status, worker_configuration,
    worker_progress, worker_heartbeat_at, authorization_reference
  ) values (
    policy_row.organization_id,
    source_row.id,
    'leadforge_scraper_worker',
    'running',
    jsonb_build_object(
      'policyId', policy_row.id,
      'sourceKey', source_row.source_key,
      'sourceId', source_row.id,
      'sourceName', source_row.name,
      'sourceType', source_row.source_type,
      'sourceApproved', source_row.approved,
      'sourceActive', source_row.active,
      'authorizationConfirmed', true,
      'authorizationScope', policy_row.authorization_scope,
      'authorizationExpiresAt', policy_row.authorization_expires_at,
      'liveCollectionEnabled', false,
      'sourceUrl', source_row.source_url,
      'countryCode', policy_row.country_code,
      'city', policy_row.city,
      'propertyType', 'all',
      'listingIntent', 'sale',
      'resultLimit', policy_row.result_limit,
      'scheduled', true
    ),
    jsonb_build_object('stage','dispatching','message','Waiting for authorized worker acknowledgement','pages_processed',0,'rows_seen',0),
    now(),
    policy_row.authorization_reference
  ) returning id into inserted_run_id;

  update public.owner_discovery_policies
    set last_run_id = inserted_run_id,
        last_run_at = now(),
        last_run_status = null,
        last_run_error = null,
        updated_at = now()
  where id = policy_row.id;

  return query select
    policy_row.id,
    policy_row.organization_id,
    source_row.id,
    inserted_run_id,
    source_row.source_key,
    source_row.name,
    source_row.source_type::text,
    source_row.source_url,
    policy_row.city,
    policy_row.country_code::text,
    policy_row.result_limit,
    policy_row.authorization_reference,
    policy_row.authorization_scope,
    policy_row.authorization_expires_at;
end;
$$;

revoke all on function public.claim_due_owner_discovery_policy() from public, anon, authenticated;
grant execute on function public.claim_due_owner_discovery_policy() to service_role;

create or replace function public.approve_lead_batch(target_batch uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  batch_row public.lead_batches%rowtype;
  qualifying_count integer;
  total_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into batch_row from public.lead_batches where id = target_batch for update;
  if not found or not public.has_org_role(batch_row.organization_id, array['owner','admin','manager']::public.member_role[]) then raise exception 'Manager permission required'; end if;
  if batch_row.status <> 'ready_for_review' then raise exception 'Batch is not ready for review'; end if;
  select count(*) into qualifying_count
  from public.lead_batch_items bi
    join public.listings l on l.id = bi.listing_id and l.organization_id = bi.organization_id
    join public.listing_sources ls on ls.id = l.source_id and ls.organization_id = l.organization_id and ls.approved = true and ls.active = true
  where bi.batch_id = batch_row.id and bi.organization_id = batch_row.organization_id
    and l.country_code = batch_row.country_code and lower(trim(l.city)) = lower(trim(batch_row.city))
    and l.currency = batch_row.currency and l.owner_led_claim = true
    and l.has_contact_information = true
    and l.status not in ('closed','suppressed') and l.suppressed_at is null
    and l.source_url ~ '^https://[^/?#]+([/?#].*)?$'
    and coalesce(l.last_seen_at, l.created_at) >= now() - make_interval(days => batch_row.minimum_freshness_days)
    and exists (
      select 1 from public.owners o
      where o.organization_id = l.organization_id and o.listing_id = l.id
        and o.verification_status = 'verified'
    )
    and exists (
      select 1 from public.owner_contacts oc
      join public.owners o on o.id = oc.owner_id and o.organization_id = oc.organization_id
      where o.organization_id = l.organization_id and o.listing_id = l.id
        and oc.contact_permission <> 'opted_out' and oc.opted_out_at is null
    )
    and not exists (select 1 from public.lead_listing_sales s where s.listing_id = l.id and s.revoked_at is null);
  select count(*) into total_count from public.lead_batch_items bi where bi.batch_id = batch_row.id and bi.organization_id = batch_row.organization_id;
  if qualifying_count < 20 or qualifying_count <> total_count then
    raise exception 'At least 20 fresh, human-verified owner leads with a non-opted-out contact are required; every batch record must still pass qualification';
  end if;
  update public.lead_batches set status = 'approved', approved_by = auth.uid(), approved_at = now(), updated_at = now() where id = batch_row.id;
end $$;

-- A trial is one verified lead per agent, not one sample shared by an entire organization.
drop index if exists public.lead_purchases_one_sample_per_org;
create unique index if not exists lead_purchases_one_sample_per_agent
  on public.lead_purchases (agent_id)
  where purchase_type = 'sample';

create or replace function public.prepare_owner_lead_access(target_interest uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  request_row public.interest_requests%rowtype;
  listing_row public.listings%rowtype;
  agent_row public.agents%rowtype;
  owner_status text;
  sample_exists boolean;
  purchase_status text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select ir.* into request_row
  from public.interest_requests ir
  where ir.id = target_interest
  for update;
  if not found then raise exception 'Interest request not found'; end if;
  if not public.has_org_role(request_row.organization_id, array['owner','admin','manager']::public.member_role[]) then
    raise exception 'Manager permission required';
  end if;

  select l.* into listing_row
  from public.matches m
  join public.listings l on l.id = m.listing_id and l.organization_id = request_row.organization_id
  where m.id = request_row.match_id;
  if not found or not listing_row.owner_led_claim then return 'not_required'; end if;

  select o.verification_status into owner_status
  from public.owners o
  where o.listing_id = listing_row.id and o.organization_id = request_row.organization_id;
  if owner_status is distinct from 'verified' then return 'verification_required'; end if;

  select lp.status into purchase_status
  from public.lead_purchases lp
  where lp.interest_request_id = request_row.id;
  if found then return purchase_status; end if;

  select a.* into agent_row
  from public.agents a
  where a.id = request_row.agent_id and a.organization_id = request_row.organization_id
  for update;
  if not found or not agent_row.active then raise exception 'Active organization agent is required'; end if;

  select exists (
    select 1 from public.lead_purchases lp
    where lp.agent_id = agent_row.id and lp.purchase_type = 'sample'
  ) into sample_exists;

  if not sample_exists then
    insert into public.lead_purchases (
      organization_id, listing_id, agent_id, interest_request_id,
      purchase_type, status, amount_cents, currency
    ) values (
      request_row.organization_id, listing_row.id, request_row.agent_id, request_row.id,
      'sample', 'sample', 0, 'usd'
    );
    return 'sample';
  end if;

  insert into public.lead_purchases (
    organization_id, listing_id, agent_id, interest_request_id,
    purchase_type, status, amount_cents, currency
  ) values (
    request_row.organization_id, listing_row.id, request_row.agent_id, request_row.id,
    'paid', 'payment_required', 2500, 'usd'
  );
  return 'payment_required';
end;
$$;


-- Keep ambiguous scraper records out of agent-sale listings while making them
-- visible to organization managers for exception review. Do not store contacts.
alter table public.listing_collection_runs
  add column held_count integer not null default 0 check (held_count >= 0);

create table public.scraper_candidate_holds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id uuid not null references public.listing_sources(id) on delete cascade,
  run_id uuid not null references public.listing_collection_runs(id) on delete cascade,
  external_id text not null,
  title text not null,
  listing_url text not null,
  city text not null,
  country_code char(2) not null,
  reason_code text not null,
  evidence_codes text[] not null default '{}',
  payload_fingerprint text not null,
  review_status text not null default 'open' check (review_status in ('open', 'dismissed')),
  dismissed_by uuid references auth.users(id),
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (run_id, source_id, external_id),
  check ((review_status = 'open' and dismissed_by is null and dismissed_at is null)
      or (review_status = 'dismissed' and dismissed_by is not null and dismissed_at is not null))
);

create index scraper_candidate_holds_org_open_idx
  on public.scraper_candidate_holds (organization_id, created_at desc)
  where review_status = 'open';

alter table public.scraper_candidate_holds enable row level security;
create policy scraper_candidate_holds_manager_read
  on public.scraper_candidate_holds for select
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy scraper_candidate_holds_manager_update
  on public.scraper_candidate_holds for update
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
grant select, update on public.scraper_candidate_holds to authenticated;
grant all on public.scraper_candidate_holds to service_role;

-- Prepare one-lead trial outreach only after human ownership verification.
-- Drafts contain no seller contact data and deliberately have no send/paid state.
create table public.trial_outreach_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  listing_id uuid not null,
  agent_directory_id uuid not null,
  channel text not null check (channel in ('email','phone','whatsapp','manual')),
  message text not null check (length(trim(message)) between 1 and 4000),
  status text not null default 'draft' check (status in ('draft','dismissed')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  dismissed_by uuid references auth.users(id),
  dismissed_at timestamptz,
  unique (listing_id, agent_directory_id),
  foreign key (listing_id, organization_id) references public.listings(id, organization_id) on delete cascade,
  foreign key (agent_directory_id, organization_id) references public.agent_directory(id, organization_id) on delete cascade,
  check ((status = 'draft' and dismissed_by is null and dismissed_at is null)
      or (status = 'dismissed' and dismissed_by is not null and dismissed_at is not null))
);

create index trial_outreach_drafts_org_open_idx
  on public.trial_outreach_drafts (organization_id, created_at desc)
  where status = 'draft';

alter table public.trial_outreach_drafts enable row level security;
create policy trial_outreach_drafts_manager_read
  on public.trial_outreach_drafts for select
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy trial_outreach_drafts_manager_update
  on public.trial_outreach_drafts for update
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
grant select, update on public.trial_outreach_drafts to authenticated;
grant all on public.trial_outreach_drafts to service_role;
