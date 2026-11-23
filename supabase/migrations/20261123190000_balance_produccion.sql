create table if not exists public.boss_produccion_equipos (
  id uuid primary key,
  equipo text not null check (equipo in ('equipo:d8r','equipo:hl770','equipo:jumbo')),
  fecha date not null,
  monto numeric(14,2) not null check (monto > 0),
  concepto text not null check (length(concepto) <= 200)
);
create index if not exists boss_produccion_equipos_fecha on public.boss_produccion_equipos(fecha);
alter table public.boss_produccion_equipos enable row level security;
revoke all on public.boss_produccion_equipos from public, anon, authenticated;
grant select, insert on public.boss_produccion_equipos to service_role;

create or replace function public.boss_balance_produccion(p_desde date,p_hasta date)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object(
    'tarifa',1.50,
    'acarreo',coalesce((
      select jsonb_agg(unidad || jsonb_build_object('monto',round((unidad->>'toneladas')::numeric * 1.50,2))
                       order by unidad->>'unidad')
      from jsonb_array_elements(public.boss_resumen_operacion(p_desde,p_hasta)->'equipos') unidad
    ),'[]'::jsonb),
    'trabajos',coalesce((
      select jsonb_agg(to_jsonb(t) order by t.fecha,t.id)
      from public.boss_produccion_equipos t where t.fecha between p_desde and p_hasta
    ),'[]'::jsonb),
    'gastos',coalesce((
      select jsonb_agg(to_jsonb(g) order by g.fecha,g.id)
      from (
        select id,fecha,concepto,partida,destino,monto
        from public.boss_gastos where fecha between p_desde and p_hasta
      ) g
    ),'[]'::jsonb)
  );
$$;
revoke all on function public.boss_balance_produccion(date,date) from public, anon, authenticated;
grant execute on function public.boss_balance_produccion(date,date) to service_role;

-- Los datos de verificación se revierten antes de publicar la función.
do $test$
declare
  trabajo uuid:=gen_random_uuid();
  prueba jsonb;
begin
  insert into public.boss_produccion_equipos values(trabajo,'equipo:hl770','1899-11-15',725.50,'Prueba de publicación');
  prueba:=public.boss_balance_produccion('1899-11-01','1899-11-15');
  if not exists (select 1 from jsonb_array_elements(prueba->'trabajos') t
    where t->>'id'=trabajo::text and (t->>'monto')::numeric=725.50)
    or exists (select 1 from jsonb_array_elements(public.boss_balance_produccion('1899-11-16','1899-11-30')->'trabajos') t
    where t->>'id'=trabajo::text)
    then raise exception 'El saldo de producción no respeta el período';
  end if;
  raise exception using errcode='ZX002',message='Retirar el trabajo de prueba';
exception when sqlstate 'ZX002' then null;
end $test$;
