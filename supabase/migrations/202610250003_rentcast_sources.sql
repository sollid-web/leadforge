alter table public.listing_sources
  add column configuration jsonb not null default '{}'::jsonb;

alter table public.source_health
  add column last_sync_attempt_at timestamptz;

create or replace function public.claim_rentcast_source_sync(
  target_source uuid,
  target_organization uuid,
  attempted_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed boolean;
begin
  insert into public.source_health (organization_id, source_id, status, last_sync_attempt_at)
  values (target_organization, target_source, 'unknown', null)
  on conflict (source_id) do nothing;

  update public.source_health
  set last_sync_attempt_at = attempted_at
  where source_id = target_source
    and organization_id = target_organization
    and (
      last_sync_attempt_at is null
      or last_sync_attempt_at <= attempted_at - interval '24 hours'
    )
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

revoke all on function public.claim_rentcast_source_sync(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_rentcast_source_sync(uuid, uuid, timestamptz) to service_role;
