alter table public.listings add constraint listings_id_organization_unique unique (id, organization_id);

alter table public.listing_collection_runs
  add column worker_configuration jsonb not null default '{}'::jsonb,
  add column worker_progress jsonb not null default '{}'::jsonb,
  add column worker_artifact_name text,
  add column worker_heartbeat_at timestamptz,
  add column authorization_reference text;

create table public.agent_directory (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  linked_user_id uuid,
  name text not null check (length(trim(name)) between 2 and 160),
  agency text,
  country_code char(2) not null check (country_code ~ '^[A-Z]{2}$'),
  city text not null check (length(trim(city)) between 1 and 120),
  service_areas text[] not null default '{}',
  preferred_property_types text[] not null default '{}',
  preferred_listing_types text[] not null default '{}',
  preferred_currency char(3),
  min_lead_volume integer check (min_lead_volume is null or min_lead_volume >= 1),
  max_lead_volume integer check (max_lead_volume is null or max_lead_volume >= 1),
  min_budget numeric check (min_budget is null or min_budget >= 0),
  max_budget numeric check (max_budget is null or max_budget >= 0),
  preferred_channel text not null default 'manual' check (preferred_channel in ('email','phone','whatsapp','manual')),
  contact_ciphertext text,
  contact_iv text,
  contact_auth_tag text,
  contact_key_version text,
  source_name text not null default 'Manual entry',
  source_url text,
  status text not null default 'discovered' check (status in ('discovered','reviewed','contacted','interested','customer','inactive','opted_out')),
  opted_out_at timestamptz,
  notes text,
  follow_up_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (linked_user_id) references auth.users(id) on delete set null,
  check ((contact_ciphertext is null and contact_iv is null and contact_auth_tag is null and contact_key_version is null)
      or (contact_ciphertext is not null and contact_iv is not null and contact_auth_tag is not null and contact_key_version is not null)),
  check (min_lead_volume is null or max_lead_volume is null or min_lead_volume <= max_lead_volume),
  check (min_budget is null or max_budget is null or min_budget <= max_budget),
  check ((status = 'opted_out' and opted_out_at is not null) or status <> 'opted_out')
);
create unique index agent_directory_linked_user_idx on public.agent_directory(organization_id, linked_user_id) where linked_user_id is not null;
create index agent_directory_market_idx on public.agent_directory(organization_id, country_code, lower(city), status);

create table public.agent_directory_interactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_directory_id uuid not null,
  interaction_type text not null check (interaction_type in ('note','offer_sent','response','sample_request','negotiation','follow_up','status_change','opt_out')),
  channel text check (channel in ('email','phone','whatsapp','manual')),
  summary text not null check (length(trim(summary)) between 1 and 4000),
  occurred_at timestamptz not null default now(),
  follow_up_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (agent_directory_id, organization_id) references public.agent_directory(id, organization_id) on delete cascade
);
create index agent_directory_interactions_idx on public.agent_directory_interactions(organization_id, agent_directory_id, occurred_at desc);

create table public.lead_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 160),
  city text not null,
  country_code char(2) not null check (country_code ~ '^[A-Z]{2}$'),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  exclusive boolean not null default true,
  status text not null default 'draft' check (status in ('draft','ready_for_review','approved','archived')),
  minimum_freshness_days integer not null default 14 check (minimum_freshness_days between 1 and 90),
  summary jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);

create table public.lead_batch_items (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  batch_id uuid not null,
  listing_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (batch_id, listing_id),
  foreign key (batch_id, organization_id) references public.lead_batches(id, organization_id) on delete cascade,
  foreign key (listing_id, organization_id) references public.listings(id, organization_id) on delete cascade
);
create index lead_batch_items_listing_idx on public.lead_batch_items(organization_id, listing_id);

create table public.lead_batch_agent_matches (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  batch_id uuid not null,
  agent_directory_id uuid not null,
  score integer not null check (score between 0 and 100),
  factors jsonb not null default '[]'::jsonb,
  matched_at timestamptz not null default now(),
  primary key (batch_id, agent_directory_id),
  foreign key (batch_id, organization_id) references public.lead_batches(id, organization_id) on delete cascade,
  foreign key (agent_directory_id, organization_id) references public.agent_directory(id, organization_id) on delete cascade
);

create table public.lead_offers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  batch_id uuid not null,
  agent_directory_id uuid not null,
  status text not null default 'draft' check (status in ('draft','ready_for_review','approved','sent','responded','interested','accepted','paid','delivered','declined','expired','cancelled','refunded')),
  pricing_mode text not null default 'batch' check (pricing_mode in ('batch','per_lead')),
  unit_price_minor_units bigint not null check (unit_price_minor_units > 0),
  price_minor_units bigint not null check (price_minor_units > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  channel text not null check (channel in ('email','phone','whatsapp','manual')),
  template_key text not null default 'initial_offer' check (template_key in ('initial_offer','follow_up','sample_request','negotiation','purchase_confirmation','delivery_notification')),
  message text not null default '',
  shared_disclosure_confirmed boolean not null default false,
  offer_sent_at timestamptz,
  responded_at timestamptz,
  response_summary text,
  accepted_at timestamptz,
  payment_reference text,
  payment_evidence_note text,
  payment_verified_by uuid references auth.users(id),
  paid_at timestamptz,
  delivered_at timestamptz,
  refunded_at timestamptz,
  refund_note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (batch_id, agent_directory_id),
  foreign key (batch_id, organization_id) references public.lead_batches(id, organization_id) on delete cascade,
  foreign key (agent_directory_id, organization_id) references public.agent_directory(id, organization_id) on delete cascade,
  check ((status in ('paid','delivered','refunded') and paid_at is not null and payment_reference is not null and payment_evidence_note is not null and payment_verified_by is not null)
      or status not in ('paid','delivered','refunded')),
  check ((status in ('delivered','refunded') and delivered_at is not null) or status not in ('delivered','refunded'))
);
create index lead_offers_org_status_idx on public.lead_offers(organization_id, status, created_at desc);
create index lead_offers_agent_idx on public.lead_offers(organization_id, agent_directory_id, created_at desc);

create table public.lead_offer_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  offer_id uuid not null,
  previous_status text,
  next_status text not null,
  event_type text not null,
  summary text,
  actor_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (offer_id, organization_id) references public.lead_offers(id, organization_id) on delete cascade
);
create index lead_offer_events_idx on public.lead_offer_events(organization_id, offer_id, created_at desc);

create table public.lead_listing_sales (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  listing_id uuid not null,
  offer_id uuid not null,
  agent_directory_id uuid not null,
  distribution_mode text not null check (distribution_mode in ('exclusive','shared')),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (listing_id, organization_id) references public.listings(id, organization_id) on delete cascade,
  foreign key (offer_id, organization_id) references public.lead_offers(id, organization_id) on delete cascade,
  foreign key (agent_directory_id, organization_id) references public.agent_directory(id, organization_id) on delete cascade
);
create unique index lead_listing_sales_offer_listing_idx on public.lead_listing_sales(offer_id, listing_id);
create unique index lead_listing_sales_active_buyer_idx on public.lead_listing_sales(listing_id, agent_directory_id) where revoked_at is null;
create unique index lead_listing_sales_exclusive_idx on public.lead_listing_sales(listing_id) where distribution_mode = 'exclusive' and revoked_at is null;

alter table public.agent_directory enable row level security;
alter table public.agent_directory_interactions enable row level security;
alter table public.lead_batches enable row level security;
alter table public.lead_batch_items enable row level security;
alter table public.lead_batch_agent_matches enable row level security;
alter table public.lead_offers enable row level security;
alter table public.lead_offer_events enable row level security;
alter table public.lead_listing_sales enable row level security;

create policy agent_directory_manager_all on public.agent_directory for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy agent_directory_interactions_manager_all on public.agent_directory_interactions for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy lead_batches_manager_all on public.lead_batches for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy lead_batch_items_manager_all on public.lead_batch_items for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy lead_batch_agent_matches_manager_read on public.lead_batch_agent_matches for select using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy lead_offers_manager_all on public.lead_offers for all using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy lead_offer_events_manager_read on public.lead_offer_events for select using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));
create policy lead_listing_sales_manager_read on public.lead_listing_sales for select using (public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[]));

grant select on public.agent_directory, public.agent_directory_interactions, public.lead_batches, public.lead_batch_items, public.lead_batch_agent_matches, public.lead_offers, public.lead_offer_events, public.lead_listing_sales to authenticated;
revoke insert, update, delete on public.agent_directory, public.agent_directory_interactions, public.lead_batches, public.lead_batch_items, public.lead_batch_agent_matches, public.lead_offers, public.lead_offer_events, public.lead_listing_sales from authenticated;
grant all on public.agent_directory, public.agent_directory_interactions, public.lead_batches, public.lead_batch_items, public.lead_batch_agent_matches, public.lead_offers, public.lead_offer_events, public.lead_listing_sales to service_role;

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
  from public.lead_batch_items bi join public.listings l on l.id = bi.listing_id and l.organization_id = bi.organization_id
    join public.listing_sources ls on ls.id = l.source_id and ls.organization_id = l.organization_id and ls.approved = true and ls.active = true
  where bi.batch_id = batch_row.id and bi.organization_id = batch_row.organization_id
    and l.country_code = batch_row.country_code and lower(trim(l.city)) = lower(trim(batch_row.city))
    and l.currency = batch_row.currency and l.owner_led_claim = true
    and l.status not in ('closed','suppressed') and l.suppressed_at is null
    and l.source_url ~ '^https://[^/?#]+([/?#].*)?$'
    and coalesce(l.last_seen_at, l.created_at) >= now() - make_interval(days => batch_row.minimum_freshness_days)
    and not exists (select 1 from public.lead_listing_sales s where s.listing_id = l.id and s.revoked_at is null);
  select count(*) into total_count from public.lead_batch_items bi where bi.batch_id = batch_row.id and bi.organization_id = batch_row.organization_id;
  if qualifying_count < 20 or qualifying_count <> total_count then raise exception 'At least 20 currently qualifying listings are required; every batch record must still pass qualification'; end if;
  update public.lead_batches set status = 'approved', approved_by = auth.uid(), approved_at = now(), updated_at = now() where id = batch_row.id;
end $$;

create or replace function public.advance_lead_offer(target_offer uuid, next_state text, event_summary text default null, sent_message text default null, sent_channel text default null, shared_disclosure boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare
  offer_row public.lead_offers%rowtype;
  batch_row public.lead_batches%rowtype;
  agent_row public.agent_directory%rowtype;
  allowed boolean := false;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into offer_row from public.lead_offers where id = target_offer for update;
  if not found or not public.has_org_role(offer_row.organization_id, array['owner','admin','manager']::public.member_role[]) then raise exception 'Manager permission required'; end if;
  if next_state in ('paid','delivered') then raise exception 'Use verified payment reconciliation and explicit delivery functions'; end if;
  select * into batch_row from public.lead_batches where id = offer_row.batch_id for update;
  select * into agent_row from public.agent_directory where id = offer_row.agent_directory_id for update;
  allowed :=
    (offer_row.status = 'draft' and next_state in ('ready_for_review','cancelled')) or
    (offer_row.status = 'ready_for_review' and next_state in ('approved','declined','expired','cancelled')) or
    (offer_row.status = 'approved' and next_state in ('sent','declined','expired','cancelled')) or
    (offer_row.status = 'sent' and next_state in ('responded','declined','expired','cancelled')) or
    (offer_row.status = 'responded' and next_state in ('interested','declined','cancelled')) or
    (offer_row.status = 'interested' and next_state in ('accepted','declined','expired','cancelled')) or
    (offer_row.status = 'accepted' and next_state = 'cancelled') or
    (offer_row.status in ('paid','delivered') and next_state = 'refunded');
  if not allowed then raise exception 'Invalid offer state transition: % -> %', offer_row.status, next_state; end if;
  if next_state = 'approved' and batch_row.status <> 'approved' then raise exception 'Batch approval is required'; end if;
  if next_state = 'sent' then
    if agent_row.status = 'opted_out' or agent_row.opted_out_at is not null then raise exception 'Agent has opted out'; end if;
    if coalesce(trim(sent_message), '') = '' or sent_channel not in ('email','phone','whatsapp','manual') then raise exception 'A reviewed message and channel are required'; end if;
    if not batch_row.exclusive and not shared_disclosure then raise exception 'Shared batch disclosure is required'; end if;
  end if;
  if next_state = 'responded' and length(trim(coalesce(event_summary, ''))) < 2 then raise exception 'A response summary is required'; end if;
  if next_state = 'refunded' and length(trim(coalesce(event_summary, ''))) < 8 then raise exception 'A refund reason is required'; end if;
  update public.lead_offers set
    status = next_state,
    message = case when next_state = 'sent' then sent_message else message end,
    channel = case when next_state = 'sent' then sent_channel else channel end,
    shared_disclosure_confirmed = case when next_state = 'sent' then shared_disclosure else shared_disclosure_confirmed end,
    offer_sent_at = case when next_state = 'sent' then now() else offer_sent_at end,
    responded_at = case when next_state = 'responded' then now() else responded_at end,
    accepted_at = case when next_state = 'accepted' then now() else accepted_at end,
    response_summary = case when next_state in ('responded','declined') and event_summary is not null then trim(event_summary) else response_summary end,
    delivered_at = case when next_state = 'delivered' then now() else delivered_at end,
    refunded_at = case when next_state = 'refunded' then now() else refunded_at end,
    refund_note = case when next_state = 'refunded' then event_summary else refund_note end,
    updated_at = now()
  where id = offer_row.id;
  if next_state = 'refunded' then update public.lead_listing_sales set revoked_at = now() where offer_id = offer_row.id and revoked_at is null; end if;
  insert into public.lead_offer_events(organization_id, offer_id, previous_status, next_status, event_type, summary, actor_id)
  values (offer_row.organization_id, offer_row.id, offer_row.status, next_state, 'status_change', event_summary, auth.uid());
end $$;

create or replace function public.reconcile_lead_offer_payment(target_offer uuid, payment_ref text, evidence_note text, verified_amount_minor_units bigint, verified_currency text)
returns void language plpgsql security definer set search_path = public as $$
declare
  offer_row public.lead_offers%rowtype;
  batch_row public.lead_batches%rowtype;
  item record;
  has_conflicting_sale boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into offer_row from public.lead_offers where id = target_offer for update;
  if not found or not public.has_org_role(offer_row.organization_id, array['owner','admin','manager']::public.member_role[]) then raise exception 'Manager permission required'; end if;
  if offer_row.status <> 'accepted' then raise exception 'Only an accepted offer may be reconciled as paid'; end if;
  if length(trim(coalesce(payment_ref,''))) < 4 or length(trim(coalesce(evidence_note,''))) < 8 then raise exception 'Payment reference and verification evidence note are required'; end if;
  if verified_amount_minor_units <> offer_row.price_minor_units or upper(verified_currency) <> offer_row.currency then raise exception 'Reconciled amount and currency must match the accepted offer'; end if;
  select * into batch_row from public.lead_batches where id = offer_row.batch_id for update;
  if batch_row.status <> 'approved' then raise exception 'Batch must remain approved'; end if;
  if not batch_row.exclusive and not offer_row.shared_disclosure_confirmed then raise exception 'Shared distribution disclosure must be recorded before payment'; end if;
  for item in select l.id from public.lead_batch_items bi join public.listings l on l.id = bi.listing_id and l.organization_id = bi.organization_id where bi.batch_id = batch_row.id order by l.id for update of l loop
    select exists(select 1 from public.lead_listing_sales s where s.listing_id = item.id and s.revoked_at is null) into has_conflicting_sale;
    if batch_row.exclusive and has_conflicting_sale then raise exception 'Exclusive batch includes a lead already sold or reserved'; end if;
    if not batch_row.exclusive and exists(select 1 from public.lead_listing_sales s where s.listing_id = item.id and s.distribution_mode = 'exclusive' and s.revoked_at is null) then raise exception 'Shared sale conflicts with an exclusive sale'; end if;
    insert into public.lead_listing_sales(organization_id, listing_id, offer_id, agent_directory_id, distribution_mode)
    values (offer_row.organization_id, item.id, offer_row.id, offer_row.agent_directory_id, case when batch_row.exclusive then 'exclusive' else 'shared' end);
  end loop;
  update public.lead_offers set status = 'paid', payment_reference = trim(payment_ref), payment_evidence_note = trim(evidence_note), payment_verified_by = auth.uid(), paid_at = now(), updated_at = now() where id = offer_row.id;
  insert into public.lead_offer_events(organization_id, offer_id, previous_status, next_status, event_type, summary, actor_id)
  values (offer_row.organization_id, offer_row.id, 'accepted', 'paid', 'manual_payment_reconciled', 'Manual payment marked reconciled by an authorized manager; no provider confirmation was received.', auth.uid());
end $$;

create or replace function public.deliver_lead_offer(target_offer uuid)
returns void language plpgsql security definer set search_path = public as $$
declare offer_row public.lead_offers%rowtype; buyer_linked boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into offer_row from public.lead_offers where id = target_offer for update;
  if not found or not public.has_org_role(offer_row.organization_id, array['owner','admin','manager']::public.member_role[]) then raise exception 'Manager permission required'; end if;
  if offer_row.status <> 'paid' then raise exception 'Only reconciled paid offers can be delivered'; end if;
  select linked_user_id is not null into buyer_linked from public.agent_directory where id = offer_row.agent_directory_id and organization_id = offer_row.organization_id;
  if not coalesce(buyer_linked, false) then raise exception 'Link an authenticated buyer account before confirming delivery'; end if;
  update public.lead_offers set status = 'delivered', delivered_at = now(), updated_at = now() where id = offer_row.id;
  insert into public.lead_offer_events(organization_id, offer_id, previous_status, next_status, event_type, summary, actor_id)
  values (offer_row.organization_id, offer_row.id, 'paid', 'delivered', 'delivery_confirmed', 'Manager recorded in-app batch availability for the linked buyer.', auth.uid());
end $$;

revoke all on function public.approve_lead_batch(uuid) from public, anon;
grant execute on function public.approve_lead_batch(uuid) to authenticated, service_role;
revoke all on function public.advance_lead_offer(uuid, text, text, text, text, boolean) from public, anon;
grant execute on function public.advance_lead_offer(uuid, text, text, text, text, boolean) to authenticated, service_role;
revoke all on function public.reconcile_lead_offer_payment(uuid, text, text, bigint, text) from public, anon;
grant execute on function public.reconcile_lead_offer_payment(uuid, text, text, bigint, text) to authenticated, service_role;
revoke all on function public.deliver_lead_offer(uuid) from public, anon;
grant execute on function public.deliver_lead_offer(uuid) to authenticated, service_role;
