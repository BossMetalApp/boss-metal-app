create table public.boss_acarreos (
  id text primary key check (char_length(id) between 1 and 100),
  registrado_por text not null,
  fecha date not null,
  turno text not null check (turno in ('Diurno', 'Nocturno')),
  unidad text not null check (char_length(unidad) between 1 and 12),
  viajes integer not null check (viajes between 1 and 1000),
  capacidad_m3 numeric not null check (capacidad_m3 > 0 and capacidad_m3 <= 1000),
  densidad numeric not null check (densidad > 0 and densidad <= 100),
  equipo text not null check (char_length(equipo) between 1 and 150),
  observaciones text not null default '' check (char_length(observaciones) <= 2000),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create index boss_acarreos_usuario_fecha on public.boss_acarreos (registrado_por, fecha desc, id);
create index boss_acarreos_fecha on public.boss_acarreos (fecha desc, id);

alter table public.boss_acarreos enable row level security;
revoke all on public.boss_acarreos from anon, authenticated;
grant select, insert, update on public.boss_acarreos to service_role;
