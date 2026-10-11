-- Miras: схема Supabase. Вставить целиком в Dashboard → SQL Editor → Run.
-- Скрипт можно запускать повторно.

-- ============ 1. Данные магазина: одна строка (id = 1) с JSON ============
create table if not exists public.store (
  id         int primary key check (id = 1),
  data       jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 1000000),
  rev        int not null default 0,          -- версия: защита от перезаписи правок с другого устройства
  updated_at timestamptz not null default now()
);

insert into public.store (id, data) values (1, '{
  "categories": [
    { "id": "shirts", "name": "Shirts" },
    { "id": "pants", "name": "Pants" },
    { "id": "shoes", "name": "Shoes" },
    { "id": "accessories", "name": "Accessories" }
  ],
  "collections": [
    { "id": "season", "title": "Seasonal", "subtitle": "Picks for the weather right now", "productIds": [] },
    { "id": "top", "title": "Top Picks", "subtitle": "Our most recommended pieces", "productIds": [] },
    { "id": "new", "title": "New Arrivals", "subtitle": "Recently added to the edit", "productIds": [] }
  ],
  "products": []
}'::jsonb) on conflict (id) do nothing;

create or replace function public.touch_store() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists store_touch on public.store;
create trigger store_touch before update on public.store for each row execute function public.touch_store();

-- ============ 2. Права (RLS): читать может любой, менять — только вошедший админ ============
alter table public.store enable row level security;

drop policy if exists "store: public read" on public.store;
create policy "store: public read" on public.store for select to anon, authenticated using (true);

drop policy if exists "store: admin update" on public.store;
create policy "store: admin update" on public.store for update to authenticated using (true) with check (true);
-- Политик на insert/delete нет: добавить вторую строку или удалить магазин нельзя никому.

grant select on public.store to anon, authenticated;
grant update on public.store to authenticated;

-- ============ 3. Фото: публичный бакет «products» ============
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('products', 'products', true, 2097152, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "products: admin read"   on storage.objects;
drop policy if exists "products: admin upload" on storage.objects;
drop policy if exists "products: admin delete" on storage.objects;
create policy "products: admin read"   on storage.objects for select to authenticated using (bucket_id = 'products');
create policy "products: admin upload" on storage.objects for insert to authenticated with check (bucket_id = 'products');
create policy "products: admin delete" on storage.objects for delete to authenticated using (bucket_id = 'products');
-- Публичные ссылки на фото работают без политик (бакет public).
