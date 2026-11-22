create table if not exists public.boss_gastos (
 id uuid primary key,
 fecha date not null,
 concepto text not null check (length(trim(concepto)) between 1 and 200),
 partida text not null check (partida in ('Repuestos','Aceites','Mangueras','Filtros','Oficina','Comida','Operacionales')),
 destino text not null check(length(trim(destino)) between 1 and 160),
 monto numeric(14,2) not null check(monto>0),
 registrado_por text not null,
 creado_en timestamptz not null default now()
);
create index if not exists boss_gastos_fecha on public.boss_gastos(fecha);
alter table public.boss_gastos enable row level security;
revoke all on public.boss_gastos from public,anon,authenticated;
grant select,insert on public.boss_gastos to service_role;
