alter table public.boss_acarreos add column if not exists responsable text;

create or replace function public.boss_importar_acarreos(p_usuario text, p_registros jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  insertados integer;
  verificados integer;
begin
  if p_usuario is null or p_usuario not in ('Admin', 'Admin2')
     or jsonb_typeof(p_registros) is distinct from 'array'
     or jsonb_array_length(p_registros) not between 1 and 100 then
    raise exception 'Lote inválido' using errcode = '22023';
  end if;

  insert into public.boss_acarreos
    (id, registrado_por, fecha, turno, unidad, viajes, capacidad_m3, densidad, equipo, observaciones, creado_en, responsable)
  select r.id, p_usuario, r.fecha, r.turno, r.unidad, r.viajes, r.capacidad_m3, r.densidad,
    r.equipo, r.observaciones, r.creado_en, r.responsable
  from jsonb_populate_recordset(null::public.boss_acarreos, p_registros) r
  on conflict (id) do nothing;
  get diagnostics insertados = row_count;

  select count(*) into verificados
  from jsonb_populate_recordset(null::public.boss_acarreos, p_registros) r
  join public.boss_acarreos a on a.id = r.id
  where a.registrado_por in ('Admin', 'Admin2')
    and (a.fecha, a.turno, a.unidad, a.viajes, a.capacidad_m3, a.densidad, a.equipo, a.observaciones, a.creado_en, a.responsable)
    is not distinct from
    (r.fecha, r.turno, r.unidad, r.viajes, r.capacidad_m3, r.densidad, r.equipo, r.observaciones, r.creado_en, r.responsable);

  if verificados <> jsonb_array_length(p_registros) then
    raise exception 'Un registro existente difiere del respaldo' using errcode = '23505';
  end if;
  return jsonb_build_object('insertados', insertados, 'verificados', verificados);
end;
$$;

revoke all on function public.boss_importar_acarreos(text, jsonb) from public, anon, authenticated;
grant execute on function public.boss_importar_acarreos(text, jsonb) to service_role;
