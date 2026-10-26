alter table public.listings
  add column image_urls text[] not null default '{}';

alter table public.listing_collection_runs
  add column search_filters jsonb not null default '{}'::jsonb,
  add column known_poster_count integer not null default 0 check (known_poster_count >= 0),
  add column unknown_poster_count integer not null default 0 check (unknown_poster_count >= 0);

create table public.provider_request_limits (
  provider text primary key,
  last_requested_at timestamptz,
  window_started_at timestamptz not null default now(),
  requests_in_window integer not null default 0 check (requests_in_window >= 0),
  updated_at timestamptz not null default now()
);

alter table public.provider_request_limits enable row level security;
revoke all on public.provider_request_limits from anon, authenticated;
grant all on public.provider_request_limits to service_role;

create or replace function public.claim_untera_api_request()
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  rate_state public.provider_request_limits%rowtype;
  retry_seconds integer;
begin
  insert into public.provider_request_limits (provider)
  values ('untera')
  on conflict (provider) do nothing;

  select * into rate_state
  from public.provider_request_limits
  where provider = 'untera'
  for update;

  if rate_state.window_started_at <= v_now - interval '24 hours' then
    rate_state.window_started_at := v_now;
    rate_state.requests_in_window := 0;
  end if;

  if rate_state.last_requested_at is not null
     and rate_state.last_requested_at > v_now - interval '4 seconds' then
    retry_seconds := greatest(1, ceil(extract(epoch from (rate_state.last_requested_at + interval '4 seconds' - v_now))::numeric)::integer);
    return query select false, retry_seconds;
    return;
  end if;

  if rate_state.requests_in_window >= 900 then
    retry_seconds := greatest(1, ceil(extract(epoch from (rate_state.window_started_at + interval '24 hours' - v_now))::numeric)::integer);
    return query select false, retry_seconds;
    return;
  end if;

  update public.provider_request_limits
  set last_requested_at = v_now,
      window_started_at = rate_state.window_started_at,
      requests_in_window = rate_state.requests_in_window + 1,
      updated_at = v_now
  where provider = 'untera';

  return query select true, 0;
end;
$$;

revoke all on function public.claim_untera_api_request() from public, anon, authenticated;
grant execute on function public.claim_untera_api_request() to service_role;

create or replace function public.record_untera_listing_save(
  target_run uuid,
  target_organization uuid,
  was_duplicate boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.listing_collection_runs
  set imported_count = imported_count + case when was_duplicate then 0 else 1 end,
      duplicate_count = duplicate_count + case when was_duplicate then 1 else 0 end
  where id = target_run
    and organization_id = target_organization
    and provider = 'untera'
    and status in ('completed', 'degraded');

  if not found then
    raise exception 'Untera collection run not found or not complete';
  end if;
end;
$$;

revoke all on function public.record_untera_listing_save(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.record_untera_listing_save(uuid, uuid, boolean) to service_role;
