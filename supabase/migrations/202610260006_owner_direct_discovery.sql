alter table public.listings
  add column listing_type text not null default 'sale'
    check (listing_type in ('sale', 'rental')),
  add column bedrooms integer check (bedrooms is null or bedrooms between 0 and 100),
  add column bathrooms numeric check (bathrooms is null or bathrooms between 0 and 100),
  add column published_at timestamptz,
  add column listing_updated_at timestamptz,
  add column last_seen_at timestamptz not null default now(),
  add column poster_type text not null default 'UNKNOWN'
    check (poster_type in ('OWNER_VERIFIED', 'OWNER_UNVERIFIED', 'AGENT', 'DEVELOPER', 'COMPANY', 'UNKNOWN')),
  add column poster_confidence integer
    check (poster_confidence is null or poster_confidence between 0 and 100),
  add column poster_evidence text,
  add column poster_method text,
  add column has_public_contact boolean not null default false,
  add column has_contact_information boolean not null default false;

update public.listings
set poster_type = case
  when owner_led_claim then 'OWNER_UNVERIFIED'
  else 'UNKNOWN'
end;

create index listings_org_poster_seen_idx
  on public.listings (organization_id, poster_type, last_seen_at desc);

create index listings_org_market_type_idx
  on public.listings (organization_id, country_code, listing_type, property_type);

create table public.listing_source_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  source_id uuid not null references public.listing_sources(id) on delete cascade,
  external_id text,
  canonical_url text,
  source_name text not null,
  attribution text,
  payload_fingerprint text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (listing_id, source_id)
);

create unique index listing_source_links_source_external_id_idx
  on public.listing_source_links (source_id, external_id)
  where external_id is not null;

create index listing_source_links_org_last_seen_idx
  on public.listing_source_links (organization_id, last_seen_at desc);

insert into public.listing_source_links (
  organization_id, listing_id, source_id, external_id, canonical_url, source_name, first_seen_at, last_seen_at
)
select l.organization_id, l.id, l.source_id, l.external_id, l.source_url, s.name, l.first_seen_at, l.updated_at
from public.listings l
join public.listing_sources s on s.id = l.source_id
on conflict (listing_id, source_id) do nothing;

create table public.listing_poster_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  reviewer_id uuid references auth.users(id),
  previous_classification text not null
    check (previous_classification in ('OWNER_VERIFIED', 'OWNER_UNVERIFIED', 'AGENT', 'DEVELOPER', 'COMPANY', 'UNKNOWN')),
  classification text not null
    check (classification in ('OWNER_VERIFIED', 'OWNER_UNVERIFIED', 'AGENT', 'DEVELOPER', 'COMPANY', 'UNKNOWN')),
  verification_method text not null,
  evidence_reference text not null,
  notes text,
  created_at timestamptz not null default now()
);

create index listing_poster_reviews_listing_created_idx
  on public.listing_poster_reviews (listing_id, created_at desc);

create table public.listing_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  source_id uuid references public.listing_sources(id) on delete set null,
  contact_type text not null
    check (contact_type in ('owner', 'listing_agent', 'listing_office', 'property_manager', 'other')),
  encrypted_payload text not null,
  encryption_iv text not null,
  encryption_auth_tag text not null,
  key_version text not null,
  contact_fingerprint text not null,
  source_url text,
  publication_context text,
  verification_status text not null default 'publicly_listed'
    check (verification_status in ('publicly_listed', 'provider_supplied', 'unverified', 'verified', 'stale', 'invalid', 'disputed', 'unavailable')),
  permission_status text not null default 'unknown'
    check (permission_status in ('unknown', 'permitted', 'restricted', 'opted_out')),
  collected_at timestamptz not null default now(),
  last_verified_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (listing_id, contact_fingerprint)
);

create index listing_contacts_org_listing_idx
  on public.listing_contacts (organization_id, listing_id);

create table public.listing_contact_verifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  listing_contact_id uuid not null references public.listing_contacts(id) on delete cascade,
  reviewer_id uuid references auth.users(id),
  previous_status text,
  status text not null
    check (status in ('publicly_listed', 'verified', 'stale', 'invalid', 'disputed', 'unavailable')),
  verification_method text not null,
  evidence_reference text,
  notes text,
  reviewed_at timestamptz not null default now()
);

create table public.listing_collection_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id uuid not null references public.listing_sources(id) on delete cascade,
  provider text not null,
  status text not null default 'running'
    check (status in ('running', 'completed', 'degraded', 'failed')),
  discovered_count integer not null default 0,
  imported_count integer not null default 0,
  duplicate_count integer not null default 0,
  rejected_count integer not null default 0,
  contacts_found_count integer not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index listing_collection_runs_org_started_idx
  on public.listing_collection_runs (organization_id, started_at desc);

create index listing_collection_runs_source_started_idx
  on public.listing_collection_runs (source_id, started_at desc);

alter table public.listing_source_links enable row level security;
alter table public.listing_poster_reviews enable row level security;
alter table public.listing_contacts enable row level security;
alter table public.listing_contact_verifications enable row level security;
alter table public.listing_collection_runs enable row level security;

create policy listing_source_links_manager_read
  on public.listing_source_links for select
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy listing_source_links_manager_insert
  on public.listing_source_links for insert
  with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy listing_source_links_manager_update
  on public.listing_source_links for update
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));

create policy listing_poster_reviews_manager_access
  on public.listing_poster_reviews for all
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));

create policy listing_contacts_manager_insert
  on public.listing_contacts for insert
  with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy listing_contacts_manager_read
  on public.listing_contacts for select
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy listing_contacts_manager_update
  on public.listing_contacts for update
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));

create policy listing_contact_verifications_manager_read
  on public.listing_contact_verifications for select
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));

create policy listing_collection_runs_manager_read
  on public.listing_collection_runs for select
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));

grant select on public.listing_source_links, public.listing_poster_reviews,
  public.listing_contacts, public.listing_contact_verifications,
  public.listing_collection_runs to authenticated;
grant insert, update on public.listing_source_links to authenticated;
grant insert, update on public.listing_poster_reviews to authenticated;
revoke all on public.listing_contacts from anon, authenticated;
grant insert, update on public.listing_contacts to authenticated;
grant all on public.listing_contacts, public.listing_source_links,
  public.listing_contact_verifications, public.listing_collection_runs to service_role;
