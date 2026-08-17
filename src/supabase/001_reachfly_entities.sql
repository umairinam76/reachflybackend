-- ReachFly production persistence schema.
-- Run once in the Supabase SQL Editor before deploying the backend.

create table if not exists public.reachfly_entities (
  collection_key text not null,
  entity_id text not null,
  position integer not null default 0,
  workspace_id text,
  campaign_id text,
  lead_id text,
  user_id text,
  status text,
  kind text,
  next_action_at timestamptz,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection_key, entity_id)
);

create table if not exists public.reachfly_singletons (
  state_key text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Query/index coverage for the hot ReachFly domains and operational inspection.
create index if not exists reachfly_entities_collection_position_idx
  on public.reachfly_entities (collection_key, position);

create index if not exists reachfly_entities_workspace_collection_idx
  on public.reachfly_entities (workspace_id, collection_key);

create index if not exists reachfly_entities_assignment_queue_idx
  on public.reachfly_entities (workspace_id, user_id, status, next_action_at)
  where collection_key = 'salesAssignments';

create index if not exists reachfly_entities_lead_campaign_idx
  on public.reachfly_entities (campaign_id, lead_id)
  where collection_key = 'campaignLeads';

create index if not exists reachfly_entities_calls_lead_idx
  on public.reachfly_entities (workspace_id, lead_id, updated_at desc)
  where collection_key = 'calls';

create index if not exists reachfly_entities_audit_lead_idx
  on public.reachfly_entities (workspace_id, lead_id, kind, updated_at desc)
  where collection_key in ('leadAuditReports', 'auditReports');

create index if not exists reachfly_entities_team_messages_idx
  on public.reachfly_entities (workspace_id, updated_at desc)
  where collection_key = 'teamMessages';

-- These tables are never exposed directly to the browser. RLS remains enabled
-- as a second guardrail. The backend uses a Supabase secret/service-role key.
alter table public.reachfly_entities enable row level security;
alter table public.reachfly_singletons enable row level security;

revoke all on table public.reachfly_entities from anon, authenticated;
revoke all on table public.reachfly_singletons from anon, authenticated;
grant select, insert, update, delete on table public.reachfly_entities to service_role;
grant select, insert, update, delete on table public.reachfly_singletons to service_role;

create or replace function public.reachfly_apply_changes(
  p_upserts jsonb default '[]'::jsonb,
  p_deletes jsonb default '[]'::jsonb,
  p_singleton_upserts jsonb default '[]'::jsonb,
  p_singleton_deletes jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_upserted integer := 0;
  v_deleted integer := 0;
  v_singleton_upserted integer := 0;
  v_singleton_deleted integer := 0;
begin
  if jsonb_typeof(coalesce(p_upserts, '[]'::jsonb)) <> 'array' then
    raise exception 'p_upserts must be a JSON array';
  end if;

  if jsonb_array_length(coalesce(p_upserts, '[]'::jsonb)) > 0 then
    insert into public.reachfly_entities (
      collection_key,
      entity_id,
      position,
      workspace_id,
      campaign_id,
      lead_id,
      user_id,
      status,
      kind,
      next_action_at,
      data,
      updated_at
    )
    select
      x.collection_key,
      x.entity_id,
      coalesce(x.position, 0),
      nullif(x.workspace_id, ''),
      nullif(x.campaign_id, ''),
      nullif(x.lead_id, ''),
      nullif(x.user_id, ''),
      nullif(x.status, ''),
      nullif(x.kind, ''),
      x.next_action_at,
      coalesce(x.data, '{}'::jsonb),
      coalesce(x.updated_at, now())
    from jsonb_to_recordset(p_upserts) as x(
      collection_key text,
      entity_id text,
      position integer,
      workspace_id text,
      campaign_id text,
      lead_id text,
      user_id text,
      status text,
      kind text,
      next_action_at timestamptz,
      data jsonb,
      updated_at timestamptz
    )
    on conflict (collection_key, entity_id)
    do update set
      position = excluded.position,
      workspace_id = excluded.workspace_id,
      campaign_id = excluded.campaign_id,
      lead_id = excluded.lead_id,
      user_id = excluded.user_id,
      status = excluded.status,
      kind = excluded.kind,
      next_action_at = excluded.next_action_at,
      data = excluded.data,
      updated_at = excluded.updated_at;

    get diagnostics v_upserted = row_count;
  end if;

  if jsonb_array_length(coalesce(p_deletes, '[]'::jsonb)) > 0 then
    delete from public.reachfly_entities e
    using jsonb_to_recordset(p_deletes) as d(
      collection_key text,
      entity_id text
    )
    where e.collection_key = d.collection_key
      and e.entity_id = d.entity_id;

    get diagnostics v_deleted = row_count;
  end if;

  if jsonb_array_length(coalesce(p_singleton_upserts, '[]'::jsonb)) > 0 then
    insert into public.reachfly_singletons (
      state_key,
      data,
      updated_at
    )
    select
      x.state_key,
      coalesce(x.data, '{}'::jsonb),
      coalesce(x.updated_at, now())
    from jsonb_to_recordset(p_singleton_upserts) as x(
      state_key text,
      data jsonb,
      updated_at timestamptz
    )
    on conflict (state_key)
    do update set
      data = excluded.data,
      updated_at = excluded.updated_at;

    get diagnostics v_singleton_upserted = row_count;
  end if;

  if jsonb_array_length(coalesce(p_singleton_deletes, '[]'::jsonb)) > 0 then
    delete from public.reachfly_singletons s
    where s.state_key in (
      select jsonb_array_elements_text(p_singleton_deletes)
    );

    get diagnostics v_singleton_deleted = row_count;
  end if;

  return jsonb_build_object(
    'ok', true,
    'upserted', v_upserted,
    'deleted', v_deleted,
    'singletonUpserted', v_singleton_upserted,
    'singletonDeleted', v_singleton_deleted,
    'changed', v_upserted + v_deleted + v_singleton_upserted + v_singleton_deleted
  );
end;
$$;

create or replace function public.reachfly_replace_all_state(
  p_entities jsonb default '[]'::jsonb,
  p_singletons jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entities integer := 0;
  v_singletons integer := 0;
begin
  if jsonb_typeof(coalesce(p_entities, '[]'::jsonb)) <> 'array' then
    raise exception 'p_entities must be a JSON array';
  end if;

  if jsonb_typeof(coalesce(p_singletons, '[]'::jsonb)) <> 'array' then
    raise exception 'p_singletons must be a JSON array';
  end if;

  delete from public.reachfly_entities;
  delete from public.reachfly_singletons;

  if jsonb_array_length(coalesce(p_entities, '[]'::jsonb)) > 0 then
    insert into public.reachfly_entities (
      collection_key,
      entity_id,
      position,
      workspace_id,
      campaign_id,
      lead_id,
      user_id,
      status,
      kind,
      next_action_at,
      data,
      updated_at
    )
    select
      x.collection_key,
      x.entity_id,
      coalesce(x.position, 0),
      nullif(x.workspace_id, ''),
      nullif(x.campaign_id, ''),
      nullif(x.lead_id, ''),
      nullif(x.user_id, ''),
      nullif(x.status, ''),
      nullif(x.kind, ''),
      x.next_action_at,
      coalesce(x.data, '{}'::jsonb),
      coalesce(x.updated_at, now())
    from jsonb_to_recordset(p_entities) as x(
      collection_key text,
      entity_id text,
      position integer,
      workspace_id text,
      campaign_id text,
      lead_id text,
      user_id text,
      status text,
      kind text,
      next_action_at timestamptz,
      data jsonb,
      updated_at timestamptz
    );

    get diagnostics v_entities = row_count;
  end if;

  if jsonb_array_length(coalesce(p_singletons, '[]'::jsonb)) > 0 then
    insert into public.reachfly_singletons (
      state_key,
      data,
      updated_at
    )
    select
      x.state_key,
      coalesce(x.data, '{}'::jsonb),
      coalesce(x.updated_at, now())
    from jsonb_to_recordset(p_singletons) as x(
      state_key text,
      data jsonb,
      updated_at timestamptz
    );

    get diagnostics v_singletons = row_count;
  end if;

  return jsonb_build_object(
    'ok', true,
    'entities', v_entities,
    'singletons', v_singletons
  );
end;
$$;

revoke all on function public.reachfly_apply_changes(jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.reachfly_replace_all_state(jsonb, jsonb)
  from public, anon, authenticated;

grant execute on function public.reachfly_apply_changes(jsonb, jsonb, jsonb, jsonb)
  to service_role;
grant execute on function public.reachfly_replace_all_state(jsonb, jsonb)
  to service_role;
