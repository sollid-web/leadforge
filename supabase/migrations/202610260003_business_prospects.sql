create table public.business_prospects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  osm_type text not null check (osm_type in ('node', 'way', 'relation')),
  osm_id bigint not null,
  name text not null,
  business_type text not null,
  phone text,
  email text,
  website text,
  address text,
  latitude double precision,
  longitude double precision,
  osm_url text not null,
  search_area text not null,
  status text not null default 'new' check (status in ('new', 'reviewed', 'contacted', 'qualified', 'archived')),
  notes text,
  discovered_by uuid references auth.users(id),
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, osm_type, osm_id)
);

create index business_prospects_org_status_idx
  on public.business_prospects (organization_id, status, discovered_at desc);

alter table public.business_prospects enable row level security;

create policy business_prospects_manager_access
  on public.business_prospects
  for all
  using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));

grant select, insert, update, delete on public.business_prospects to authenticated;
grant all on public.business_prospects to service_role;

create table public.business_prospect_search_control (
  singleton boolean primary key default true check (singleton),
  last_search_at timestamptz,
  last_organization_id uuid references public.organizations(id) on delete set null,
  last_organization_search_at timestamptz
);

insert into public.business_prospect_search_control (singleton) values (true);
alter table public.business_prospect_search_control enable row level security;
grant all on public.business_prospect_search_control to service_role;

create or replace function public.reserve_business_prospect_search(target_organization uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  control_row public.business_prospect_search_control%rowtype;
  now_at timestamptz := clock_timestamp();
begin
  if auth.uid() is null or not public.has_org_role(
    target_organization,
    array['owner','admin','manager']::public.member_role[]
  ) then
    raise exception 'Manager permission required';
  end if;

  select * into control_row
  from public.business_prospect_search_control
  where singleton = true
  for update;

  if control_row.last_search_at is not null
    and now_at - control_row.last_search_at < interval '1100 milliseconds' then
    return 'global_cooldown';
  end if;
  if control_row.last_organization_id = target_organization
    and control_row.last_organization_search_at is not null
    and now_at - control_row.last_organization_search_at < interval '30 seconds' then
    return 'organization_cooldown';
  end if;

  update public.business_prospect_search_control
  set last_search_at = now_at,
      last_organization_id = target_organization,
      last_organization_search_at = now_at
  where singleton = true;
  return 'reserved';
end;
$$;

revoke all on function public.reserve_business_prospect_search(uuid) from public, anon;
grant execute on function public.reserve_business_prospect_search(uuid) to authenticated;
grant execute on function public.reserve_business_prospect_search(uuid) to service_role;
