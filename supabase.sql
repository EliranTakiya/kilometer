create table if not exists public.vehicle_mileage (
  id integer primary key check (id between 1 and 24),
  km bigint check (km is null or km >= 0)
);

alter table public.vehicle_mileage enable row level security;

grant select, insert, update on public.vehicle_mileage to anon;

drop policy if exists "Public can read vehicle mileage" on public.vehicle_mileage;
create policy "Public can read vehicle mileage"
  on public.vehicle_mileage for select to anon
  using (true);

drop policy if exists "Public can insert vehicle mileage" on public.vehicle_mileage;
create policy "Public can insert vehicle mileage"
  on public.vehicle_mileage for insert to anon
  with check (true);

drop policy if exists "Public can update vehicle mileage" on public.vehicle_mileage;
create policy "Public can update vehicle mileage"
  on public.vehicle_mileage for update to anon
  using (true)
  with check (true);