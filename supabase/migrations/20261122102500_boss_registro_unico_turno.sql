do $$
declare
  repetidos integer;
begin
  select count(*) into repetidos from (
    select fecha, turno, unidad from public.boss_acarreos
    group by fecha, turno, unidad having count(*) > 1
  ) coincidencias;
  if repetidos > 0 then
    raise exception 'Hay % combinaciones históricas repetidas. Reconciliar los totales antes de activar la regla.', repetidos;
  end if;
end;
$$;

create unique index if not exists boss_acarreos_fecha_turno_unidad_unico
  on public.boss_acarreos (fecha, turno, unidad);

alter table public.boss_acarreos add column if not exists actualizado_por text;

create table if not exists public.boss_acarreos_correcciones (
  id bigint generated always as identity primary key,
  acarreo_id text not null,
  corregido_por text not null,
  corregido_en timestamptz not null,
  antes jsonb not null,
  despues jsonb not null
);
alter table public.boss_acarreos_correcciones enable row level security;
revoke all on public.boss_acarreos_correcciones from anon, authenticated;
grant insert, select on public.boss_acarreos_correcciones to service_role;

create or replace function public.boss_auditar_correccion_acarreo()
returns trigger language plpgsql security invoker set search_path = pg_catalog
as $$
begin
  if (old.fecha, old.turno, old.viajes, old.observaciones)
       is distinct from (new.fecha, new.turno, new.viajes, new.observaciones) then
    insert into public.boss_acarreos_correcciones (acarreo_id, corregido_por, corregido_en, antes, despues)
    values (old.id, coalesce(new.actualizado_por, new.registrado_por), new.actualizado_en,
      jsonb_build_object('fecha', old.fecha, 'turno', old.turno, 'viajes', old.viajes, 'observaciones', old.observaciones),
      jsonb_build_object('fecha', new.fecha, 'turno', new.turno, 'viajes', new.viajes, 'observaciones', new.observaciones));
  end if;
  return new;
end;
$$;

drop trigger if exists boss_auditar_correccion on public.boss_acarreos;
create trigger boss_auditar_correccion after update on public.boss_acarreos
  for each row execute function public.boss_auditar_correccion_acarreo();
