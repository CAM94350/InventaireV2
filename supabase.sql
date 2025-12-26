-- v11.2 patch: fix ambiguous expires_at in acquire_palette_lock
-- Supabase SQL — items(designation unique), palettes, pallet_items(designation, qty)
create extension if not exists pgcrypto;

create table if not exists palettes (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  description text,
  location text,
  created_at timestamptz default now()
);

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  designation text not null
);
create unique index if not exists uniq_items_designation on items (designation);

create table if not exists pallet_items (
  id uuid primary key default gen_random_uuid(),
  palette_id uuid not null references palettes(id) on delete cascade,
  designation text not null,
  qty numeric not null default 0,
  updated_at timestamptz default now()
);

create index if not exists idx_pallet_items_palette on pallet_items(palette_id);
create index if not exists idx_palettes_code on palettes(code);

alter table palettes enable row level security;
alter table items enable row level security;
alter table pallet_items enable row level security;

create policy if not exists "palettes read if authenticated"
  on palettes for select using (auth.uid() is not null);
create policy if not exists "palettes write if authenticated"
  on palettes for all using (auth.uid() is not null) with check (auth.uid() is not null);

create policy if not exists "items read if authenticated"
  on items for select using (auth.uid() is not null);
create policy if not exists "items write if authenticated"
  on items for all using (auth.uid() is not null) with check (auth.uid() is not null);

create policy if not exists "pallet_items read if authenticated"
  on pallet_items for select using (auth.uid() is not null);
create policy if not exists "pallet_items write if authenticated"
  on pallet_items for all using (auth.uid() is not null) with check (auth.uid() is not null);


-- v11.3: support lock per session (works even with same login)
alter table if exists public.palette_locks add column if not exists session_id uuid;
create index if not exists palette_locks_session_idx on public.palette_locks(session_id);

create or replace function public.acquire_palette_lock_v2(
  p_palette_id uuid,
  p_session_id uuid,
  p_ttl_seconds int default 600
)
returns table(lock_token uuid, locked_by uuid, expires_at timestamptz, locked_session_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lock public.palette_locks%rowtype;
  v_token uuid;
  v_expires timestamptz;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if p_session_id is null then
    raise exception 'SESSION_REQUIRED';
  end if;

  delete from public.palette_locks
   where palette_id = p_palette_id
     and public.palette_locks.expires_at <= now();

  select * into v_lock
  from public.palette_locks
  where palette_id = p_palette_id;

  v_expires := now() + make_interval(secs => p_ttl_seconds);

  if found then
    if v_lock.locked_by is distinct from auth.uid()
       or v_lock.session_id is distinct from p_session_id then
      raise exception 'PALETTE_LOCKED' using errcode = 'P0001';
    end if;

    update public.palette_locks
       set expires_at = v_expires,
           locked_at  = now()
     where palette_id = p_palette_id;

    return query
    select v_lock.lock_token, v_lock.locked_by, v_expires, v_lock.session_id;
  else
    v_token := gen_random_uuid();

    insert into public.palette_locks(
      palette_id, lock_token, locked_by, session_id, expires_at, locked_at
    )
    values (
      p_palette_id, v_token, auth.uid(), p_session_id, v_expires, now()
    );

    return query
    select v_token, auth.uid(), v_expires, p_session_id;
  end if;
end;
$$;

create or replace function public.release_palette_lock_v2(
  p_palette_id uuid,
  p_lock_token uuid,
  p_session_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if p_session_id is null then
    raise exception 'SESSION_REQUIRED';
  end if;

  delete from public.palette_locks
   where palette_id = p_palette_id
     and lock_token = p_lock_token
     and locked_by = auth.uid()
     and session_id = p_session_id;

  return found;
end;
$$;

grant execute on function public.acquire_palette_lock_v2(uuid, uuid, integer) to authenticated;
grant execute on function public.release_palette_lock_v2(uuid, uuid, uuid) to authenticated;


-- v12.5 – Audit (parcours utilisateur + actions DB + Storage)

-- Tables manquantes si vous rejouez le SQL sur un projet neuf
create table if not exists public.palette_photos (
  id uuid primary key default gen_random_uuid(),
  palette_id uuid not null references public.palettes(id) on delete cascade,
  path text not null,
  created_by uuid,
  created_at timestamptz default now()
);
create index if not exists idx_palette_photos_palette on public.palette_photos(palette_id);

create table if not exists public.palette_locks (
  palette_id uuid primary key references public.palettes(id) on delete cascade,
  lock_token uuid not null,
  locked_by uuid not null,
  locked_at timestamptz default now(),
  expires_at timestamptz not null,
  session_id uuid
);

-- Colonnes si schéma évolué
alter table if exists public.pallet_items add column if not exists checked boolean default false;

-- RLS de base (à ajuster selon vos règles métier)
alter table if exists public.palette_photos enable row level security;
alter table if exists public.palette_locks enable row level security;

create policy if not exists "palette_photos read if authenticated"
  on public.palette_photos for select using (auth.uid() is not null);
create policy if not exists "palette_photos write if authenticated"
  on public.palette_photos for all using (auth.uid() is not null) with check (auth.uid() is not null);

create policy if not exists "palette_locks read if authenticated"
  on public.palette_locks for select using (auth.uid() is not null);
create policy if not exists "palette_locks write if authenticated"
  on public.palette_locks for all using (auth.uid() is not null) with check (auth.uid() is not null);


-- Audit schema
create schema if not exists audit;

create table if not exists audit.audit_events (
  id           bigserial primary key,
  created_at   timestamptz not null default now(),
  actor_uid    uuid null,
  session_id   uuid null,
  action       text not null,
  entity_type  text null,
  entity_id    text null,
  palette_id   uuid null,
  palette_code text null,
  success      boolean not null default true,
  details      jsonb not null default '{}'::jsonb
);

create index if not exists idx_audit_events_created_at on audit.audit_events(created_at desc);
create index if not exists idx_audit_events_actor on audit.audit_events(actor_uid, created_at desc);
create index if not exists idx_audit_events_session on audit.audit_events(session_id, created_at desc);
create index if not exists idx_audit_events_palette on audit.audit_events(palette_id, created_at desc);
create index if not exists idx_audit_events_palette_code on audit.audit_events(palette_code, created_at desc);

alter table audit.audit_events enable row level security;
create policy if not exists "audit no direct access" on audit.audit_events
for all using (false) with check (false);

create or replace function audit._insert_event(
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_palette_id uuid,
  p_palette_code text,
  p_session_id uuid,
  p_details jsonb
)
returns void
language plpgsql
security definer
set search_path = public, audit
as $$
begin
  insert into audit.audit_events(
    actor_uid, session_id, action, entity_type, entity_id, palette_id, palette_code, details
  )
  values (
    auth.uid(), p_session_id, p_action, p_entity_type, p_entity_id, p_palette_id, p_palette_code, coalesce(p_details,'{}'::jsonb)
  );
end;
$$;

-- RPC pour le front
create or replace function audit.log_event(
  p_action text,
  p_entity_type text default null,
  p_entity_id text default null,
  p_palette_id uuid default null,
  p_palette_code text default null,
  p_session_id uuid default null,
  p_success boolean default true,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, audit
as $$
begin
  insert into audit.audit_events(
    actor_uid, session_id, action, entity_type, entity_id, palette_id, palette_code, success, details
  )
  values (
    auth.uid(), p_session_id, p_action, p_entity_type, p_entity_id, p_palette_id, p_palette_code, coalesce(p_success,true), coalesce(p_details,'{}'::jsonb)
  );
end;
$$;

grant execute on function audit.log_event(text,text,text,uuid,text,uuid,boolean,jsonb) to authenticated;


-- Triggers DB : palettes
create or replace function audit.trg_palettes()
returns trigger
language plpgsql
security definer
set search_path = public, audit
as $$
declare
  v_action text;
  v_palette_id uuid;
  v_code text;
begin
  v_palette_id := coalesce(new.id, old.id);
  v_code := coalesce(new.code, old.code);

  if tg_op='INSERT' then v_action := 'palettes.insert';
  elseif tg_op='UPDATE' then v_action := 'palettes.update';
  else v_action := 'palettes.delete';
  end if;

  perform audit._insert_event(
    v_action,
    'palettes',
    v_palette_id::text,
    v_palette_id,
    v_code,
    null,
    jsonb_build_object(
      'code', v_code,
      'description_old', old.description,
      'description_new', new.description,
      'location_old', old.location,
      'location_new', new.location
    )
  );

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_audit_palettes on public.palettes;
create trigger trg_audit_palettes
after insert or update or delete on public.palettes
for each row execute function audit.trg_palettes();


-- Triggers DB : pallet_items
create or replace function audit.trg_pallet_items()
returns trigger
language plpgsql
security definer
set search_path = public, audit
as $$
declare
  v_action text;
  v_palette_id uuid;
  v_code text;
  v_entity_id uuid;
begin
  v_palette_id := coalesce(new.palette_id, old.palette_id);
  v_entity_id := coalesce(new.id, old.id);

  select code into v_code from public.palettes where id = v_palette_id;

  if tg_op='INSERT' then v_action := 'pallet_items.insert';
  elseif tg_op='UPDATE' then v_action := 'pallet_items.update';
  else v_action := 'pallet_items.delete';
  end if;

  perform audit._insert_event(
    v_action,
    'pallet_items',
    v_entity_id::text,
    v_palette_id,
    v_code,
    null,
    jsonb_build_object(
      'designation_old', old.designation,
      'designation_new', new.designation,
      'qty_old', old.qty,
      'qty_new', new.qty,
      'checked_old', old.checked,
      'checked_new', new.checked
    )
  );

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_audit_pallet_items on public.pallet_items;
create trigger trg_audit_pallet_items
after insert or update or delete on public.pallet_items
for each row execute function audit.trg_pallet_items();


-- Triggers DB : palette_photos
create or replace function audit.trg_palette_photos()
returns trigger
language plpgsql
security definer
set search_path = public, audit
as $$
declare
  v_action text;
  v_palette_id uuid;
  v_code text;
  v_entity_id uuid;
begin
  v_palette_id := coalesce(new.palette_id, old.palette_id);
  v_entity_id := coalesce(new.id, old.id);
  select code into v_code from public.palettes where id = v_palette_id;

  if tg_op='INSERT' then v_action := 'palette_photos.insert';
  elseif tg_op='UPDATE' then v_action := 'palette_photos.update';
  else v_action := 'palette_photos.delete';
  end if;

  perform audit._insert_event(
    v_action,
    'palette_photos',
    v_entity_id::text,
    v_palette_id,
    v_code,
    null,
    jsonb_build_object(
      'path_old', old.path,
      'path_new', new.path,
      'created_by', coalesce(new.created_by, old.created_by)
    )
  );

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_audit_palette_photos on public.palette_photos;
create trigger trg_audit_palette_photos
after insert or update or delete on public.palette_photos
for each row execute function audit.trg_palette_photos();


-- Triggers DB : palette_locks (corrélation par session)
create or replace function audit.trg_palette_locks()
returns trigger
language plpgsql
security definer
set search_path = public, audit
as $$
declare
  v_action text;
  v_palette_id uuid;
  v_code text;
begin
  v_palette_id := coalesce(new.palette_id, old.palette_id);
  select code into v_code from public.palettes where id = v_palette_id;

  if tg_op='INSERT' then v_action := 'palette_locks.insert';
  elseif tg_op='UPDATE' then v_action := 'palette_locks.update';
  else v_action := 'palette_locks.delete';
  end if;

  perform audit._insert_event(
    v_action,
    'palette_locks',
    coalesce(new.lock_token, old.lock_token)::text,
    v_palette_id,
    v_code,
    coalesce(new.session_id, old.session_id),
    jsonb_build_object(
      'locked_by', coalesce(new.locked_by, old.locked_by),
      'locked_at', coalesce(new.locked_at, old.locked_at),
      'expires_at', coalesce(new.expires_at, old.expires_at)
    )
  );

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_audit_palette_locks on public.palette_locks;
create trigger trg_audit_palette_locks
after insert or update or delete on public.palette_locks
for each row execute function audit.trg_palette_locks();


-- Trigger Storage (bucket palette-photos)
create or replace function audit.trg_storage_objects()
returns trigger
language plpgsql
security definer
set search_path = public, audit, storage
as $$
declare
  v_action text;
  v_bucket text;
  v_name text;
  v_entity_id uuid;
begin
  if tg_op='INSERT' then v_action := 'storage.upload';
  elseif tg_op='DELETE' then v_action := 'storage.delete';
  else v_action := 'storage.update';
  end if;

  v_bucket := coalesce(new.bucket_id, old.bucket_id);
  v_name := coalesce(new.name, old.name);
  v_entity_id := coalesce(new.id, old.id);

  if v_bucket <> 'palette-photos' then
    return coalesce(new, old);
  end if;

  perform audit._insert_event(
    v_action,
    'storage.objects',
    v_entity_id::text,
    null,
    null,
    null,
    jsonb_build_object(
      'bucket_id', v_bucket,
      'name', v_name,
      'metadata', coalesce(new.metadata, old.metadata)
    )
  );

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_audit_storage_objects on storage.objects;
create trigger trg_audit_storage_objects
after insert or update or delete on storage.objects
for each row execute function audit.trg_storage_objects();
