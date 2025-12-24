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


-- ===========================
-- v11.0 – Concurrency locks & photos
-- ===========================

create table if not exists palette_locks (
  palette_id uuid primary key references palettes(id) on delete cascade,
  lock_token uuid not null,
  locked_by uuid references auth.users(id),
  locked_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists palette_locks_expires_idx on palette_locks(expires_at);

create or replace function acquire_palette_lock(p_palette_id uuid, p_ttl_seconds int default 600)
returns table(lock_token uuid, locked_by uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lock palette_locks%rowtype;
  v_token uuid;
  v_expires timestamptz;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  -- purge expired lock
  delete from palette_locks where palette_id = p_palette_id and expires_at < now();

  select * into v_lock from palette_locks where palette_id = p_palette_id;
  v_expires := now() + make_interval(secs => p_ttl_seconds);

  if found then
    if v_lock.locked_by is distinct from auth.uid() then
      -- locked by someone else
      raise exception 'PALETTE_LOCKED' using errcode = 'P0001';
    end if;
    update palette_locks
      set expires_at = v_expires,
          locked_at = now()
      where palette_id = p_palette_id;

    return query
      select v_lock.lock_token, v_lock.locked_by, v_expires;
  else
    v_token := gen_random_uuid();
    insert into palette_locks(palette_id, lock_token, locked_by, expires_at)
      values (p_palette_id, v_token, auth.uid(), v_expires);

    return query
      select v_token, auth.uid(), v_expires;
  end if;
end;
$$;

create or replace function release_palette_lock(p_palette_id uuid, p_lock_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  delete from palette_locks
   where palette_id = p_palette_id
     and lock_token = p_lock_token
     and locked_by = auth.uid();
  return found;
end;
$$;

create table if not exists palette_photos (
  id uuid primary key default gen_random_uuid(),
  palette_id uuid not null references palettes(id) on delete cascade,
  path text not null,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists palette_photos_palette_idx on palette_photos(palette_id, created_at desc);

-- RLS
alter table palette_locks enable row level security;
alter table palette_photos enable row level security;

-- Locks: read-only for authenticated (writes via security definer functions)
drop policy if exists "locks_select" on palette_locks;
create policy "locks_select" on palette_locks for select
  to authenticated
  using (true);

-- Photos: only if user holds a non-expired lock on that palette
drop policy if exists "photos_select" on palette_photos;
create policy "photos_select" on palette_photos for select
  to authenticated
  using (true);

drop policy if exists "photos_insert_with_lock" on palette_photos;
create policy "photos_insert_with_lock" on palette_photos for insert
  to authenticated
  with check (
    exists (
      select 1 from palette_locks l
       where l.palette_id = palette_photos.palette_id
         and l.locked_by = auth.uid()
         and l.expires_at > now()
    )
  );

-- Enforce lock for palette edits
-- Palettes update only if lock held
drop policy if exists "palettes_update_with_lock" on palettes;
create policy "palettes_update_with_lock" on palettes for update
  to authenticated
  using (
    exists (
      select 1 from palette_locks l
       where l.palette_id = palettes.id
         and l.locked_by = auth.uid()
         and l.expires_at > now()
    )
  )
  with check (
    exists (
      select 1 from palette_locks l
       where l.palette_id = palettes.id
         and l.locked_by = auth.uid()
         and l.expires_at > now()
    )
  );

-- Pallet_items write only if lock held
drop policy if exists "pallet_items_write_with_lock" on pallet_items;
create policy "pallet_items_write_with_lock" on pallet_items for all
  to authenticated
  using (
    exists (
      select 1 from palette_locks l
       where l.palette_id = pallet_items.palette_id
         and l.locked_by = auth.uid()
         and l.expires_at > now()
    )
  )
  with check (
    exists (
      select 1 from palette_locks l
       where l.palette_id = pallet_items.palette_id
         and l.locked_by = auth.uid()
         and l.expires_at > now()
    )
  );




-- v11 – Storage policies for private bucket "palette-photos"
-- IMPORTANT: create the bucket in Supabase Storage with id: palette-photos (PRIVATE).
-- The following policies apply to storage.objects table.
-- They allow authenticated users to upload photos ONLY when holding a valid palette lock,
-- and to read (select) objects referenced in palette_photos.

-- Enable RLS on storage.objects (usually already enabled)
alter table if exists storage.objects enable row level security;

-- Upload (insert) allowed if user holds lock for the referenced palette folder (palette_{palette_number}/...)
create policy if not exists "palette_photos_insert_if_locked"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'palette-photos'
  and exists (
    select 1
    from palette_locks pl
    where pl.user_id = auth.uid()
      and pl.expires_at > now()
      and (storage.objects.name like ('palette_' || pl.palette_number || '/%'))
  )
);

-- Read (select) allowed if the object is referenced by a palette_photo row
create policy if not exists "palette_photos_select_if_referenced"
on storage.objects for select
to authenticated
using (
  bucket_id = 'palette-photos'
  and exists (
    select 1
    from palette_photos pp
    where pp.object_path = storage.objects.name
  )
);

