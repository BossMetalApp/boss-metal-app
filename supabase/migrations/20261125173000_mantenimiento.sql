alter table public.boss_disponibilidad_equipos
  drop constraint if exists boss_disponibilidad_equipos_clave_check,
  add constraint boss_disponibilidad_equipos_clave_check check (clave ~ '^(acarreo:[A-Za-z0-9-]{1,12}|equipo:(d8r|hl770|jumbo)|vehiculo:(x1|van-transporte|orinoco|mitsubishi-l200))$');

create table if not exists public.boss_mantenimiento (
  id uuid primary key,
  equipo text not null references public.boss_disponibilidad_equipos(clave),
  falla text not null check (length(btrim(falla)) between 1 and 120),
  etapa text not null check (etapa in ('Reportada','Esperando repuesto','En reparación')),
  abierto_en timestamptz not null default now(),
  cerrado_en timestamptz,
  check (cerrado_en is null or cerrado_en>=abierto_en)
);
alter table public.boss_disponibilidad_equipos
  drop constraint if exists boss_disponibilidad_equipos_estado_check,
  add constraint boss_disponibilidad_equipos_estado_check check (estado in ('Operativo','Fuera de servicio','En mantenimiento'));

alter table public.boss_mantenimiento
  add column if not exists pendiente_detalle boolean not null default false,
  add column if not exists preventivo boolean not null default false,
  add column if not exists fecha_servicio date,
  add column if not exists lectura numeric(12,2),
  add column if not exists proxima_revision date;

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
alter table public.boss_mantenimiento_eventos
  drop constraint if exists boss_mantenimiento_eventos_tipo_check,
  add constraint boss_mantenimiento_eventos_tipo_check check (tipo in ('Falla reportada','Novedad','Operativo','Preventivo'));

create index if not exists boss_mantenimiento_eventos_incidencia on public.boss_mantenimiento_eventos(incidencia,fecha desc);
alter table public.boss_mantenimiento enable row level security;
alter table public.boss_mantenimiento_eventos enable row level security;
revoke all on public.boss_mantenimiento,public.boss_mantenimiento_eventos from public,anon,authenticated,service_role;

with pendientes as (
  insert into public.boss_mantenimiento(id,equipo,falla,etapa,abierto_en,pendiente_detalle)
  select gen_random_uuid(),d.clave,'Falla pendiente de describir','Reportada',d.actualizado_en,true
  from public.boss_disponibilidad_equipos d where d.estado='Fuera de servicio'
  on conflict (equipo) where cerrado_en is null do nothing
  returning id,equipo,abierto_en
)
insert into public.boss_mantenimiento_eventos(id,incidencia,tipo,nota,actor,fecha)
select gen_random_uuid(),p.id,'Novedad','Fuera de servicio según Disponibilidad de equipos.',d.actualizado_por,p.abierto_en
from pendientes p join public.boss_disponibilidad_equipos d on d.clave=p.equipo;

create or replace function public.boss_mantenimiento_abrir_disponibilidad()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare nuevo_id uuid;
begin
  if exists (select 1 from public.boss_mantenimiento where equipo=new.clave and cerrado_en is null and preventivo) then
    raise exception 'Finaliza el mantenimiento preventivo antes de reportar una falla.' using errcode='22023';
  end if;
  insert into public.boss_mantenimiento(id,equipo,falla,etapa,abierto_en,pendiente_detalle)
    values(gen_random_uuid(),new.clave,'Falla pendiente de describir','Reportada',new.actualizado_en,true)
    on conflict (equipo) where cerrado_en is null do nothing returning id into nuevo_id;
  if found then
    insert into public.boss_mantenimiento_eventos(id,incidencia,tipo,nota,actor,fecha)
      values(gen_random_uuid(),nuevo_id,'Novedad','Fuera de servicio según Disponibilidad de equipos.',new.actualizado_por,new.actualizado_en);
  end if;
  return new;
end $$;
revoke all on function public.boss_mantenimiento_abrir_disponibilidad() from public,anon,authenticated;
create or replace trigger boss_mantenimiento_al_quedar_fuera
after insert or update of estado on public.boss_disponibilidad_equipos
for each row when (new.estado='Fuera de servicio')
execute function public.boss_mantenimiento_abrir_disponibilidad();

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

create or replace function public.boss_mantenimiento_destino(p_unidad text,p_equipo text,p_vehiculo text)
returns text language sql immutable set search_path=pg_catalog as $$
  select case
    when p_unidad is not null then 'acarreo:'||p_unidad
    when p_equipo='Bulldozer D8R' then 'equipo:d8r'
    when p_equipo='Payloader HL770' then 'equipo:hl770'
    when p_equipo='Jumbo' then 'equipo:jumbo'
    when p_equipo='Vehículo' then case regexp_replace(lower(coalesce(p_vehiculo,'')),'[^a-z0-9]','','g')
      when 'x1' then 'vehiculo:x1'
      when 'vantransporte' then 'vehiculo:van-transporte'
      when 'vantrasporte' then 'vehiculo:van-transporte'
      when 'orinoco' then 'vehiculo:orinoco'
      when 'mitsubishil200' then 'vehiculo:mitsubishi-l200'
      when 'l200' then 'vehiculo:mitsubishi-l200'
    end
  end;
$$;
revoke all on function public.boss_mantenimiento_destino(text,text,text) from public,anon,authenticated;

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
  servicio date:=(p->>'fecha_servicio')::date;
  revision date:=(p->>'proxima_revision')::date;
  medidor numeric:=(p->>'lectura')::numeric;
  detener boolean:=coalesce((p->>'detener')::boolean,false);
  actual public.boss_mantenimiento%rowtype;
  evento text;
  marca timestamptz;
  filas jsonb;
begin
  if not exists (select 1 from public.boss_usuarios u where u.usuario=p_actor and u.activo
    and (u.rol='supervisor' or u.usuario in ('Admin','Admin2'))) then
    raise exception 'Acceso restringido.' using errcode='42501';
  end if;
  if clave_equipo is not null and clave_equipo !~ '^(acarreo:[A-Za-z0-9-]{1,12}|equipo:(d8r|hl770|jumbo)|vehiculo:(x1|van-transporte|orinoco|mitsubishi-l200))$'
     and not (accion='mantenimiento_listar' and clave_equipo='vehiculos') then
    raise exception 'Selecciona un equipo válido.' using errcode='22023';
  end if;
  if accion='mantenimiento_listar' then
    if pagina<0 then raise exception 'Página inválida.' using errcode='22023'; end if;
    with ultimas as (
      select i.*
      from public.boss_mantenimiento i
      where i.cerrado_en is not null and (clave_equipo is null or i.equipo=clave_equipo or (clave_equipo='vehiculos' and i.equipo like 'vehiculo:%'))
      order by i.cerrado_en desc,i.id
      offset pagina limit 21
    ), lista as (
      select i.* from public.boss_mantenimiento i
      where pagina=0 and i.cerrado_en is null and (clave_equipo is null or i.equipo=clave_equipo or (clave_equipo='vehiculos' and i.equipo like 'vehiculo:%'))
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
      where public.boss_mantenimiento_destino(q.unidad,q.equipo_adicional,q.vehiculo)=clave_equipo
        and (buscar='' or strpos(lower(q.descripcion),lower(buscar))>0)
      order by q.creado_en desc,q.id limit 30
    ) s;
    return filas;
  end if;

  if accion not in ('mantenimiento_reportar','mantenimiento_preventivo','mantenimiento_novedad','mantenimiento_cerrar')
     or id_evento is null or length(nota_evento)>500 then
    raise exception 'Revisa los datos de la incidencia.' using errcode='22023';
  end if;
  if accion in ('mantenimiento_reportar','mantenimiento_preventivo') then
    if length(nombre_equipo) not between 1 and 100 or length(motivo) not between 1 and 120 then
      raise exception 'Indica el equipo y la falla.' using errcode='22023';
    end if;
    if accion='mantenimiento_preventivo' and (servicio is null or servicio>(now() at time zone 'America/Caracas')::date
      or revision<servicio or medidor<0 or medidor>=1e10 or medidor<>round(medidor,2)) then
      raise exception 'Revisa la fecha del mantenimiento, la próxima revisión y la lectura.' using errcode='22023';
    end if;
    insert into public.boss_disponibilidad_equipos(clave,nombre,estado,actualizado_por)
      values(clave_equipo,nombre_equipo,case when accion='mantenimiento_reportar' then 'Fuera de servicio' else 'Operativo' end,p_actor)
      on conflict on constraint boss_disponibilidad_equipos_pkey do nothing;
    id_incidencia:=id_evento;
    evento:=case when accion='mantenimiento_reportar' then 'Falla reportada' else 'Preventivo' end;
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
  if exists (select 1 from public.boss_mantenimiento_eventos e join public.boss_mantenimiento m on m.id=e.incidencia
    where e.id=id_evento and m.equipo=clave_equipo and e.tipo=evento and e.actor=p_actor
      and (accion='mantenimiento_reportar' or e.incidencia=id_incidencia)) then
    return '{}'::jsonb;
  end if;
  if id_solicitud is not null and (accion<>'mantenimiento_novedad' or not exists(
    select 1 from public.boss_solicitudes_materiales q where q.id=id_solicitud
    and public.boss_mantenimiento_destino(q.unidad,q.equipo_adicional,q.vehiculo)=clave_equipo)) then
    raise exception 'La solicitud debe corresponder a este equipo.' using errcode='22023';
  end if;
  marca:=clock_timestamp();
  if accion='mantenimiento_reportar' then
    select * into actual from public.boss_mantenimiento i where i.equipo=clave_equipo and i.cerrado_en is null;
    if found then
      if not actual.pendiente_detalle then
        raise exception 'El equipo ya tiene un registro abierto. Agrega una novedad.' using errcode='22023';
      end if;
      id_incidencia:=actual.id;
      update public.boss_mantenimiento set falla=motivo,pendiente_detalle=false where id=id_incidencia;
    else
      insert into public.boss_mantenimiento(id,equipo,falla,etapa,abierto_en)
        values(id_incidencia,clave_equipo,motivo,etapa_nueva,marca);
      update public.boss_disponibilidad_equipos d set estado='Fuera de servicio',actualizado_por=p_actor,actualizado_en=marca
        where d.clave=clave_equipo and d.estado<>'Fuera de servicio';
    end if;
  elsif accion='mantenimiento_preventivo' then
    if detener and exists(select 1 from public.boss_mantenimiento i where i.equipo=clave_equipo and i.cerrado_en is null) then
      raise exception 'Ya hay un registro abierto para este equipo. Ciérralo antes de iniciar otro mantenimiento.' using errcode='22023';
    end if;
    insert into public.boss_mantenimiento(id,equipo,falla,etapa,abierto_en,cerrado_en,preventivo,fecha_servicio,lectura,proxima_revision)
      values(id_incidencia,clave_equipo,motivo,etapa_nueva,marca,case when not detener then marca end,true,servicio,medidor,revision);
    if detener then
      update public.boss_disponibilidad_equipos d set estado='En mantenimiento',actualizado_por=p_actor,actualizado_en=marca where d.clave=clave_equipo;
    end if;
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
  prueba_vehiculo uuid:=gen_random_uuid();
  datos jsonb;
  resultado jsonb;
begin
  datos:=jsonb_build_object('equipo',equipo,'nombre','Prueba bitácora','falla','Fuga','nota','Pérdida de presión',
    'accion','mantenimiento_reportar','id',incidente);
  insert into public.boss_disponibilidad_equipos(clave,nombre,estado,actualizado_por)
    values(equipo,'Prueba bitácora','Operativo','Admin');
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
  insert into public.boss_disponibilidad_equipos(clave,nombre,estado,actualizado_por)
    values('vehiculo:van-transporte','Van Transporte','Operativo','Prueba')
    on conflict on constraint boss_disponibilidad_equipos_pkey do nothing;
  insert into public.boss_mantenimiento(id,equipo,falla,etapa,abierto_en,cerrado_en)
    values(prueba_vehiculo,'vehiculo:van-transporte','Prueba de vehículo','Reportada',now(),now());
  select public.boss_mantenimiento_rpc('Admin','{"accion":"mantenimiento_listar","equipo":"vehiculos"}') into resultado;
  if not exists (select 1 from jsonb_array_elements(resultado->'incidencias') i where i->>'id'=prueba_vehiculo::text)
     or exists (select 1 from jsonb_array_elements(resultado->'incidencias') i where i->>'equipo' not like 'vehiculo:%')
    then raise exception 'El filtro Vehículos no devuelve el historial de los vehículos'; end if;
  if public.boss_mantenimiento_destino(null,'Vehículo','Van trasporte') is distinct from 'vehiculo:van-transporte'
     or public.boss_mantenimiento_destino(null,'Vehículo','Mitsubishi L-200') is distinct from 'vehiculo:mitsubishi-l200'
    then raise exception 'No se reconocieron los alias de solicitudes de vehículos'; end if;
  update public.boss_disponibilidad_equipos set estado='Fuera de servicio' where clave=equipo;
  select id into strict incidente from public.boss_mantenimiento where boss_mantenimiento.equipo=datos->>'equipo'
    and cerrado_en is null and pendiente_detalle;
  datos:=datos||jsonb_build_object('id',gen_random_uuid(),'falla','Falla completada');
  perform public.boss_mantenimiento_rpc('Admin',datos);
  perform public.boss_mantenimiento_rpc('Admin',datos);
  if not exists(select 1 from public.boss_mantenimiento where id=incidente and falla='Falla completada' and not pendiente_detalle)
    then raise exception 'Disponibilidad y la falla completada no quedaron enlazadas'; end if;
  datos:=datos||jsonb_build_object('accion','mantenimiento_preventivo','id',gen_random_uuid(),'fecha_servicio',(now() at time zone 'America/Caracas')::date,'falla','Cambio de aceite');
  perform public.boss_mantenimiento_rpc('Admin',datos);
  if (select estado from public.boss_disponibilidad_equipos where clave=equipo) is distinct from 'Fuera de servicio'
    then raise exception 'Registrar un preventivo modificó una falla abierta'; end if;
  update public.boss_disponibilidad_equipos set estado='Operativo' where clave=equipo;
  perform public.boss_mantenimiento_rpc('Admin',datos||jsonb_build_object('id',gen_random_uuid(),'detener',true));
  if (select estado from public.boss_disponibilidad_equipos where clave=equipo) is distinct from 'En mantenimiento'
    then raise exception 'El preventivo no actualizó la disponibilidad'; end if;
  update public.boss_disponibilidad_equipos set estado='Operativo' where clave=equipo;
  if exists(select 1 from public.boss_mantenimiento where boss_mantenimiento.equipo=datos->>'equipo' and cerrado_en is null)
    then raise exception 'Disponibilidad no cerró el preventivo'; end if;
  raise exception using errcode='ZX002',message='Revertir datos de prueba de mantenimiento';
exception when sqlstate 'ZX002' then null;
end $test$;
