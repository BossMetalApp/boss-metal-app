create or replace function public.boss_graficas_produccion(p_desde date, p_hasta date)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  select coalesce(jsonb_agg(jsonb_build_array(
    fecha, turno, unidad, equipo, viajes, viajes * capacidad_m3 * densidad
  ) order by fecha, turno, unidad), '[]'::jsonb)
  from public.boss_acarreos
  where fecha between p_desde and p_hasta;
$$;

revoke all on function public.boss_graficas_produccion(date, date) from public, anon, authenticated;
grant execute on function public.boss_graficas_produccion(date, date) to service_role;
