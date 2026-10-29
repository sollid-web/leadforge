-- Built-in scraper adapters are preconfigured per organization so managers do not
-- have to register and approve the same source records manually. This does not
-- authorize collection: a manager must still record the exact scope, evidence
-- reference, expiry, and explicit confirmation in owner_discovery_policies.

create or replace function public.ensure_builtin_owner_scraper_sources(target_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Repair the two legacy slugs generated from the exact display names. Preserve
  -- existing records/listings; only migrate when no canonical row already exists.
  update public.listing_sources s
  set source_key = 'forsalebyowner', approved = true, active = true
  where s.organization_id = target_organization_id
    and s.source_key = 'forsalebyowner-com'
    and s.name = 'ForSaleByOwner.com'
    and s.source_type in ('approved_feed', 'partner_feed')
    and s.source_url ~* '^https://(www[.])?forsalebyowner[.]com/?$'
    and not exists (
      select 1 from public.listing_sources canonical
      where canonical.organization_id = s.organization_id
        and canonical.source_key = 'forsalebyowner'
    );

  update public.listing_sources s
  set source_key = 'byowner', approved = true, active = true
  where s.organization_id = target_organization_id
    and s.source_key = 'byowner-com'
    and s.name = 'ByOwner.com'
    and s.source_type in ('approved_feed', 'partner_feed')
    and s.source_url ~* '^https://(www[.])?byowner[.]com/?$'
    and not exists (
      select 1 from public.listing_sources canonical
      where canonical.organization_id = s.organization_id
        and canonical.source_key = 'byowner'
    );

  insert into public.listing_sources (
    organization_id, name, source_key, source_type, source_url,
    approved, active, opt_out_instructions
  ) values
    (target_organization_id, 'Craigslist', 'craigslist', 'approved_feed', 'https://www.craigslist.org', true, true,
      'Built-in adapter. Collect only within a separately authorized source/city policy; stop on access restrictions.'),
    (target_organization_id, 'ForSaleByOwner.com', 'forsalebyowner', 'approved_feed', 'https://www.forsalebyowner.com', true, true,
      'Built-in adapter. Collect only within a separately authorized source/city policy; stop on access restrictions.'),
    (target_organization_id, 'ByOwner.com', 'byowner', 'approved_feed', 'https://www.byowner.com', true, true,
      'Built-in adapter. Collect only within a separately authorized source/city policy; stop on access restrictions.')
  on conflict (organization_id, source_key) do nothing;
end;
$$;

revoke all on function public.ensure_builtin_owner_scraper_sources(uuid) from public, anon, authenticated;

drop trigger if exists seed_builtin_owner_scraper_sources_after_org_insert on public.organizations;

create or replace function public.seed_builtin_owner_scraper_sources_after_org_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.ensure_builtin_owner_scraper_sources(new.id);
  return new;
end;
$$;

revoke all on function public.seed_builtin_owner_scraper_sources_after_org_insert() from public, anon, authenticated;

create trigger seed_builtin_owner_scraper_sources_after_org_insert
  after insert on public.organizations
  for each row execute function public.seed_builtin_owner_scraper_sources_after_org_insert();

do $$
declare
  org record;
begin
  for org in select id from public.organizations loop
    perform public.ensure_builtin_owner_scraper_sources(org.id);
  end loop;
end;
$$;

comment on function public.ensure_builtin_owner_scraper_sources(uuid) is
  'Seeds supported owner-scraper adapter records only; scheduled collection still requires explicit per-source/city authorization evidence and expiry.';
