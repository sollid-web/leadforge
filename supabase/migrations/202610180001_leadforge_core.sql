create extension if not exists pgcrypto;

create type public.member_role as enum ('owner','admin','manager','agent');
create type public.lead_stage as enum ('new','review','qualified','nurture','suppressed');
create type public.follow_up_status as enum ('draft','pending_approval','approved','sending','sent','failed','rejected','cancelled');

create table public.organizations (
  id uuid primary key default gen_random_uuid(), name text not null, market text not null default 'Nigeria', currency text not null default 'NGN', created_at timestamptz not null default now()
);
create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null default 'agent',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create table public.leads (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  first_name text not null, last_name text, email text, normalized_email text, phone text, normalized_phone text,
  location text, property_type text, budget numeric, currency text not null default 'NGN', source text not null,
  external_record_id text, stage public.lead_stage not null default 'new', score integer not null default 0 check (score between 0 and 100),
  score_rule_version text, score_explanation text, consent_status text not null default 'unknown', suppressed_at timestamptz,
  discovered_at timestamptz, assigned_to uuid references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id, normalized_email), unique (organization_id, source, external_record_id)
);
create table public.lead_score_details (
  id uuid primary key default gen_random_uuid(), lead_id uuid not null references public.leads(id) on delete cascade, organization_id uuid not null references public.organizations(id) on delete cascade,
  rule_version text not null, factor_id text not null, contribution integer not null, evidence text, scored_at timestamptz not null default now()
);
create table public.follow_ups (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade, lead_id uuid not null references public.leads(id) on delete cascade,
  channel text not null default 'email', recipient text not null, subject text not null, body text not null, content_hash text not null,
  status public.follow_up_status not null default 'draft', approved_by uuid references auth.users(id), approved_at timestamptz, provider_message_id text, idempotency_key text not null unique, attempt_count integer not null default 0, error_classification text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade, actor_id uuid references auth.users(id), action text not null, entity_type text not null, entity_id uuid, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index leads_org_stage_idx on public.leads(organization_id, stage);
create index leads_org_score_idx on public.leads(organization_id, score desc);
create index followups_org_status_idx on public.follow_ups(organization_id, status);

create or replace function public.is_org_member(target_org uuid) returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from public.organization_members where organization_id = target_org and user_id = auth.uid()); $$;
create or replace function public.has_org_role(target_org uuid, allowed public.member_role[]) returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from public.organization_members where organization_id = target_org and user_id = auth.uid() and role = any(allowed)); $$;

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.leads enable row level security;
alter table public.lead_score_details enable row level security;
alter table public.follow_ups enable row level security;
alter table public.audit_logs enable row level security;
create policy org_member_select on public.organizations for select using (public.is_org_member(id));
create policy members_same_org on public.organization_members for select using (public.is_org_member(organization_id));
create policy leads_tenant_access on public.leads for all using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy scores_tenant_access on public.lead_score_details for all using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy followups_tenant_access on public.follow_ups for all using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy audits_tenant_access on public.audit_logs for select using (public.is_org_member(organization_id));
