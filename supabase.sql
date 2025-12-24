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
