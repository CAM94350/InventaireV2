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
