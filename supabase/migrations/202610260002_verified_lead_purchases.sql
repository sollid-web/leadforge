create table public.lead_purchases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  interest_request_id uuid not null unique references public.interest_requests(id) on delete cascade,
  purchase_type text not null check (purchase_type in ('sample', 'paid')),
  status text not null check (status in ('sample', 'payment_required', 'checkout_pending', 'paid')),
  amount_cents integer not null default 0 check (amount_cents >= 0),
  currency text not null default 'usd' check (currency = lower(currency)),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  check (
    (purchase_type = 'sample' and status = 'sample' and amount_cents = 0)
    or (purchase_type = 'paid' and status <> 'sample' and amount_cents > 0)
  )
);

create unique index lead_purchases_one_sample_per_org
  on public.lead_purchases (organization_id)
  where purchase_type = 'sample';
create index lead_purchases_agent_status_idx
  on public.lead_purchases (agent_id, status, created_at desc);

create unique index audit_logs_unique_paid_lead_session
  on public.audit_logs (entity_id, (metadata->>'stripe_session_id'))
  where action = 'lead_purchase.paid';

alter table public.lead_purchases enable row level security;

create policy lead_purchases_agent_or_manager_read
  on public.lead_purchases
  for select
  using (
    public.has_org_role(organization_id, array['owner','admin','manager']::public.member_role[])
    or exists (
      select 1 from public.agents a
      where a.id = agent_id and a.user_id = auth.uid()
    )
  );

grant select on public.lead_purchases to authenticated;
grant all on public.lead_purchases to service_role;

create or replace function public.prepare_owner_lead_access(target_interest uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  request_row public.interest_requests%rowtype;
  listing_row public.listings%rowtype;
  owner_status text;
  sample_exists boolean;
  purchase_status text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select ir.* into request_row
  from public.interest_requests ir
  where ir.id = target_interest
  for update;

  if not found then
    raise exception 'Interest request not found';
  end if;
  if not public.has_org_role(request_row.organization_id, array['owner','admin','manager']::public.member_role[]) then
    raise exception 'Manager permission required';
  end if;

  select l.* into listing_row
  from public.matches m
  join public.listings l on l.id = m.listing_id
  where m.id = request_row.match_id;

  if not found or not listing_row.owner_led_claim then
    return 'not_required';
  end if;

  select o.verification_status into owner_status
  from public.owners o
  where o.listing_id = listing_row.id
    and o.organization_id = request_row.organization_id;

  if owner_status is distinct from 'verified' then
    return 'verification_required';
  end if;

  select lp.status into purchase_status
  from public.lead_purchases lp
  where lp.interest_request_id = request_row.id;
  if found then
    return purchase_status;
  end if;

  perform 1 from public.organizations
  where id = request_row.organization_id
  for update;

  select exists (
    select 1 from public.lead_purchases lp
    where lp.organization_id = request_row.organization_id
      and lp.purchase_type = 'sample'
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

revoke all on function public.prepare_owner_lead_access(uuid) from public, anon;
grant execute on function public.prepare_owner_lead_access(uuid) to authenticated;
grant execute on function public.prepare_owner_lead_access(uuid) to service_role;

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
      and (
        not l.owner_led_claim
        or (
          exists (
            select 1 from public.owners o
            where o.listing_id = l.id
              and o.organization_id = l.organization_id
              and o.verification_status = 'verified'
          )
          and exists (
            select 1 from public.lead_purchases lp
            where lp.interest_request_id = ir.id
              and lp.agent_id = a.id
              and lp.organization_id = l.organization_id
              and lp.status in ('sample', 'paid')
          )
        )
      )
  );
$$;

revoke all on function public.agent_can_reveal_listing(uuid) from public, anon;
grant execute on function public.agent_can_reveal_listing(uuid) to authenticated, service_role;
