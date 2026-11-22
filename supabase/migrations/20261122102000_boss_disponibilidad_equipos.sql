create table if not exists public.boss_disponibilidad_equipos (
  clave text primary key check (clave ~ '^(acarreo:[A-Za-z0-9-]{1,12}|equipo:(d8r|hl770|jumbo))$'),
  nombre text not null check (char_length(btrim(nombre)) between 1 and 100),
  estado text not null check (estado in ('Operativo', 'Fuera de servicio')),
  actualizado_por text not null,
  actualizado_en timestamptz not null default now()
);

alter table public.boss_disponibilidad_equipos enable row level security;
revoke all on public.boss_disponibilidad_equipos from anon, authenticated;
grant select, insert, update on public.boss_disponibilidad_equipos to service_role;
