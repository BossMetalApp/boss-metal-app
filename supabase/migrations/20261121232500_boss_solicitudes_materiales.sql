create table if not exists public.boss_solicitudes_materiales (
  id uuid primary key,
  solicitado_por text not null,
  categoria text not null check (categoria in ('Aceites', 'Mangueras', 'EPP')),
  descripcion text not null check (char_length(btrim(descripcion)) between 1 and 300),
  cantidad numeric(10,2) not null check (cantidad > 0 and cantidad <= 100000),
  unidad text check (unidad ~ '^[A-Za-z0-9-]{1,12}$'),
  estado text not null default 'Pendiente' check (estado in ('Pendiente', 'Aprobada', 'Entregada', 'Rechazada')),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create index if not exists boss_solicitudes_fecha
  on public.boss_solicitudes_materiales (creado_en desc, id);
create index if not exists boss_solicitudes_usuario_fecha
  on public.boss_solicitudes_materiales (solicitado_por, creado_en desc, id);

alter table public.boss_solicitudes_materiales enable row level security;
revoke all on public.boss_solicitudes_materiales from anon, authenticated;
grant select, insert, update on public.boss_solicitudes_materiales to service_role;
