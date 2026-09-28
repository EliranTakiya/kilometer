create table if not exists public.vehicle_mileage (
  id integer primary key check (id between 1 and 24),
  plate_number text not null default '',
  km bigint check (km is null or km >= 0),
  km_updated_at timestamptz
);

alter table public.vehicle_mileage
  add column if not exists plate_number text not null default '',
  add column if not exists km_updated_at timestamptz;

create or replace function public.set_vehicle_mileage_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.km is not null then
      new.km_updated_at = now();
    end if;
  elsif new.km is distinct from old.km then
    new.km_updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists vehicle_mileage_updated_at on public.vehicle_mileage;
create trigger vehicle_mileage_updated_at
  before insert or update of km on public.vehicle_mileage
  for each row execute function public.set_vehicle_mileage_updated_at();

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