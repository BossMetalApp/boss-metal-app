alter table public.boss_acarreos
  drop constraint if exists boss_acarreos_viajes_check,
  add constraint boss_acarreos_viajes_check check (viajes between 0 and 1000);

create or replace function public.boss_resumen_operacion(p_desde date, p_hasta date)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  with datos as (
    select fecha, turno, unidad, equipo, viajes, viajes * capacidad_m3 * densidad as toneladas
    from public.boss_acarreos
    where (p_desde is null or fecha >= p_desde)
      and (p_hasta is null or fecha <= p_hasta)
  ), equipos as (
    select unidad, max(equipo) as equipo, sum(viajes) as viajes, sum(toneladas) as toneladas
    from datos group by unidad
  ), turnos as (
    select turno, sum(viajes) as viajes, sum(toneladas) as toneladas
    from datos group by turno
  )
  select jsonb_build_object(
    'viajes', coalesce(sum(viajes), 0),
    'toneladas', coalesce(sum(toneladas), 0),
    'dias', count(distinct fecha) filter (where viajes > 0),
    'equipos', coalesce((select jsonb_agg(to_jsonb(equipos) order by unidad) from equipos), '[]'::jsonb),
    'turnos', coalesce((select jsonb_agg(to_jsonb(turnos) order by turno) from turnos), '[]'::jsonb)
  ) from datos;
$$;

revoke all on function public.boss_resumen_operacion(date, date) from public, anon, authenticated;
grant execute on function public.boss_resumen_operacion(date, date) to service_role;
