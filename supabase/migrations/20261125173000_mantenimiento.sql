create table if not exists public.boss_mantenimiento (
  id uuid primary key,
  equipo text not null references public.boss_disponibilidad_equipos(clave),
  falla text not null check (length(btrim(falla)) between 1 and 120),
  etapa text not null check (etapa in ('Reportada','Esperando repuesto','En reparación')),
  abierto_en timestamptz not null default now(),
  cerrado_en timestamptz,
  check (cerrado_en is null or cerrado_en>=abierto_en)
);
create unique index if not exists boss_mantenimiento_abierta on public.boss_mantenimiento(equipo) where cerrado_en is null;
create index if not exists boss_mantenimiento_historial on public.boss_mantenimiento(equipo,cerrado_en desc);

create table if not exists public.boss_mantenimiento_eventos (
  id uuid primary key,
  incidencia uuid not null references public.boss_mantenimiento(id),
  tipo text not null check (tipo in ('Falla reportada','Novedad','Operativo')),
  nota text not null check (length(nota)<=500),
  etapa text check (etapa in ('Reportada','Esperando repuesto','En reparación')),
  solicitud uuid references public.boss_solicitudes_materiales(id),
  actor text not null,
  fecha timestamptz not null default now()
);
create index if not exists boss_mantenimiento_eventos_incidencia on public.boss_mantenimiento_eventos(incidencia,fecha desc);
alter table public.boss_mantenimiento enable row level security;
alter table public.boss_mantenimiento_eventos enable row level security;
revoke all on public.boss_mantenimiento,public.boss_mantenimiento_eventos from public,anon,authenticated,service_role;

create or replace function public.boss_mantenimiento_cierre_disponibilidad()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare incidencia_id uuid;
begin
  update public.boss_mantenimiento
     set cerrado_en=greatest(clock_timestamp(),abierto_en)
   where equipo=new.clave and cerrado_en is null
   returning id into incidencia_id;
  if found then
    insert into public.boss_mantenimiento_eventos(id,incidencia,tipo,nota,actor,fecha)
      values(gen_random_uuid(),incidencia_id,'Operativo','Estado actualizado desde Disponibilidad de equipos.',new.actualizado_por,clock_timestamp());
  end if;
  return new;
end $$;
revoke all on function public.boss_mantenimiento_cierre_disponibilidad() from public,anon,authenticated;
create or replace trigger boss_mantenimiento_al_marcar_operativo
after update of estado on public.boss_disponibilidad_equipos
for each row when (new.estado='Operativo' and new.estado is distinct from old.estado)
execute function public.boss_mantenimiento_cierre_disponibilidad();

create or replace function public.boss_mantenimiento_rpc(p_actor text,p jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  accion text:=p->>'accion';
  clave_equipo text:=nullif(p->>'equipo','');
  nombre_equipo text:=btrim(coalesce(p->>'nombre',''));
  motivo text:=btrim(coalesce(p->>'falla',''));
  nota_evento text:=btrim(coalesce(p->>'nota',''));
  etapa_nueva text:=nullif(p->>'etapa','');
  buscar text:=btrim(coalesce(p->>'buscar',''));
  id_evento uuid:=(p->>'id')::uuid;
  id_incidencia uuid:=(p->>'incidencia')::uuid;
  id_solicitud uuid:=(p->>'solicitud')::uuid;
  pagina integer:=coalesce((p->>'offset')::integer,0);
  evento text;
  marca timestamptz;
  filas jsonb;
begin
  if not exists (select 1 from public.boss_usuarios u where u.usuario=p_actor and u.activo
    and (u.rol='supervisor' or u.usuario in ('Admin','Admin2'))) then
    raise exception 'Acceso restringido.' using errcode='42501';
  end if;
  if clave_equipo is not null and clave_equipo !~ '^(acarreo:[A-Za-z0-9-]{1,12}|equipo:(d8r|hl770|jumbo))$' then
    raise exception 'Selecciona un equipo válido.' using errcode='22023';
  end if;
  if accion='mantenimiento_listar' then
    if pagina<0 then raise exception 'Página inválida.' using errcode='22023'; end if;
    with ultimas as (
      select i.*
      from public.boss_mantenimiento i
      where i.cerrado_en is not null and (clave_equipo is null or i.equipo=clave_equipo)
      order by i.cerrado_en desc,i.id
      offset pagina limit 21
    ), lista as (
      select i.* from public.boss_mantenimiento i
      where pagina=0 and i.cerrado_en is null and (clave_equipo is null or i.equipo=clave_equipo)
      union all
      select * from ultimas
    )
    select coalesce(jsonb_agg(to_jsonb(i)||jsonb_build_object('nombre',d.nombre,'eventos',e.filas)
       order by i.cerrado_en desc nulls first,i.abierto_en desc,i.id),'[]'::jsonb) into filas
    from lista i join public.boss_disponibilidad_equipos d on d.clave=i.equipo
    cross join lateral (
      select coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object('repuesto',s.descripcion,'estado_solicitud',s.estado)
             order by m.fecha desc,m.id),'[]'::jsonb) as filas
      from public.boss_mantenimiento_eventos m left join public.boss_solicitudes_materiales s on s.id=m.solicitud
      where m.incidencia=i.id
    ) e;
    return jsonb_build_object('incidencias',filas,'equipos',
      coalesce((select jsonb_agg(jsonb_build_object('clave',d.clave,'nombre',d.nombre) order by d.clave)
       from public.boss_disponibilidad_equipos d),'[]'::jsonb));
  end if;

  if clave_equipo is null then raise exception 'Selecciona un equipo válido.' using errcode='22023'; end if;
  if accion='mantenimiento_solicitudes' then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.creado_en desc,s.id),'[]'::jsonb) into filas
    from (
      select q.id,q.descripcion,q.estado,q.creado_en
      from public.boss_solicitudes_materiales q
      where (('acarreo:'||q.unidad)=clave_equipo or q.equipo_adicional=case clave_equipo
        when 'equipo:d8r' then 'Bulldozer D8R' when 'equipo:hl770' then 'Payloader HL770' when 'equipo:jumbo' then 'Jumbo' end)
        and (buscar='' or strpos(lower(q.descripcion),lower(buscar))>0)
      order by q.creado_en desc,q.id limit 30
    ) s;
    return filas;
  end if;

  if accion not in ('mantenimiento_reportar','mantenimiento_novedad','mantenimiento_cerrar')
     or id_evento is null or length(nota_evento)>500 then
    raise exception 'Revisa los datos de la incidencia.' using errcode='22023';
  end if;
  if accion='mantenimiento_reportar' then
    if length(nombre_equipo) not between 1 and 100 or length(motivo) not between 1 and 120 then
      raise exception 'Indica el equipo y la falla.' using errcode='22023';
    end if;
    insert into public.boss_disponibilidad_equipos(clave,nombre,estado,actualizado_por)
      values(clave_equipo,nombre_equipo,'Fuera de servicio',p_actor) on conflict on constraint boss_disponibilidad_equipos_pkey do nothing;
    id_incidencia:=id_evento;
    evento:='Falla reportada';
    etapa_nueva:='Reportada';
  elsif accion='mantenimiento_novedad' then
    evento:='Novedad';
    if etapa_nueva not in ('Reportada','Esperando repuesto','En reparación') or
       (nota_evento='' and id_solicitud is null and etapa_nueva is null) then
      raise exception 'Indica una novedad, un estado o una solicitud.' using errcode='22023';
    end if;
  else
    evento:='Operativo';
    etapa_nueva:=null;
  end if;
  -- Mantiene el mismo orden de bloqueo que la edición desde Disponibilidad.
  perform 1 from public.boss_disponibilidad_equipos d where d.clave=clave_equipo for update;
  if not found then raise exception 'Equipo inválido.' using errcode='22023'; end if;
  if exists (select 1 from public.boss_mantenimiento_eventos e where e.id=id_evento
    and e.incidencia=id_incidencia and e.tipo=evento and e.actor=p_actor) then
    return '{}'::jsonb;
  end if;
  if id_solicitud is not null and (accion<>'mantenimiento_novedad' or not exists(
    select 1 from public.boss_solicitudes_materiales q where q.id=id_solicitud
    and (('acarreo:'||q.unidad)=clave_equipo or q.equipo_adicional=case clave_equipo
      when 'equipo:d8r' then 'Bulldozer D8R' when 'equipo:hl770' then 'Payloader HL770' when 'equipo:jumbo' then 'Jumbo' end))) then
    raise exception 'La solicitud debe corresponder a este equipo.' using errcode='22023';
  end if;
  marca:=clock_timestamp();
  if accion='mantenimiento_reportar' then
    if exists(select 1 from public.boss_mantenimiento i where i.equipo=clave_equipo and i.cerrado_en is null) then
      raise exception 'El equipo ya tiene una incidencia abierta. Agrega una novedad.' using errcode='22023';
    end if;
    insert into public.boss_mantenimiento(id,equipo,falla,etapa,abierto_en)
      values(id_incidencia,clave_equipo,motivo,etapa_nueva,marca);
    update public.boss_disponibilidad_equipos d set estado='Fuera de servicio',actualizado_por=p_actor,actualizado_en=marca
      where d.clave=clave_equipo and d.estado<>'Fuera de servicio';
  else
    if not exists(select 1 from public.boss_mantenimiento i where i.id=id_incidencia and i.equipo=clave_equipo and i.cerrado_en is null) then
      raise exception 'La incidencia ya no está abierta. Actualiza la bitácora.' using errcode='22023';
    end if;
    if accion='mantenimiento_cerrar' then
      update public.boss_mantenimiento i set cerrado_en=greatest(marca,i.abierto_en) where i.id=id_incidencia;
      update public.boss_disponibilidad_equipos d set estado='Operativo',actualizado_por=p_actor,actualizado_en=marca
        where d.clave=clave_equipo and d.estado<>'Operativo';
    elsif etapa_nueva is not null then
      update public.boss_mantenimiento i set etapa=etapa_nueva where i.id=id_incidencia;
    end if;
  end if;
  insert into public.boss_mantenimiento_eventos(id,incidencia,tipo,nota,etapa,solicitud,actor,fecha)
    values(id_evento,id_incidencia,evento,nota_evento,etapa_nueva,id_solicitud,p_actor,marca);
  return '{}'::jsonb;
end $$;
revoke all on function public.boss_mantenimiento_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.boss_mantenimiento_rpc(text,jsonb) to service_role;

do $test$
declare
  equipo text:='acarreo:MNT-'||substr(gen_random_uuid()::text,1,6);
  incidente uuid:=gen_random_uuid();
  solicitud_id uuid:=gen_random_uuid();
  datos jsonb;
  resultado jsonb;
begin
  datos:=jsonb_build_object('equipo',equipo,'nombre','Prueba bitácora','falla','Fuga','nota','Pérdida de presión',
    'accion','mantenimiento_reportar','id',incidente);
  perform public.boss_mantenimiento_rpc('Admin',datos);
  perform public.boss_mantenimiento_rpc('Admin',datos);
  if (select estado from public.boss_disponibilidad_equipos where clave=equipo) is distinct from 'Fuera de servicio' then
    raise exception 'La falla no actualizó Disponibilidad';
  end if;
  insert into public.boss_solicitudes_materiales(id,solicitado_por,categoria,descripcion,cantidad,unidad)
    values(solicitud_id,'Prueba','Mangueras','Repuesto de prueba',1,split_part(equipo,':',2));
  perform public.boss_mantenimiento_rpc('Admin',datos||jsonb_build_object('accion','mantenimiento_novedad',
    'incidencia',incidente,'id',gen_random_uuid(),'etapa','Esperando repuesto','solicitud',solicitud_id));
  update public.boss_disponibilidad_equipos set estado='Operativo',actualizado_por='Admin' where clave=equipo;
  resultado:=public.boss_mantenimiento_rpc('Admin',jsonb_build_object('accion','mantenimiento_listar','equipo',equipo));
  if resultado#>>'{incidencias,0,cerrado_en}' is null
     or jsonb_array_length(resultado#>'{incidencias,0,eventos}')<>3
     or not exists (select 1 from jsonb_array_elements(resultado#>'{incidencias,0,eventos}') e where e->>'repuesto'='Repuesto de prueba')
    then raise exception 'El historial no conservó la reparación o el repuesto'; end if;
  incidente:=gen_random_uuid();
  perform public.boss_mantenimiento_rpc('Admin',datos||jsonb_build_object('id',incidente));
  perform public.boss_mantenimiento_rpc('Admin',datos||jsonb_build_object('accion','mantenimiento_cerrar','incidencia',incidente,'id',gen_random_uuid()));
  if (select estado from public.boss_disponibilidad_equipos where clave=equipo) is distinct from 'Operativo'
     or (select cerrado_en from public.boss_mantenimiento where id=incidente) is null then
    raise exception 'El cierre no quedó sincronizado';
  end if;
  raise exception using errcode='ZX002',message='Revertir datos de prueba de mantenimiento';
exception when sqlstate 'ZX002' then null;
end $test$;
