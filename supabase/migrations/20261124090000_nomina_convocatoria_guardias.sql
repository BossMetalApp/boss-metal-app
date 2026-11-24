alter table public.boss_nomina_asistencia
  drop constraint if exists boss_nomina_asistencia_estado_check,
  add constraint boss_nomina_asistencia_estado_check check (estado in ('Trabajó','Faltó','Permiso','No convocado'));

create or replace function public.boss_nomina(p_actor text,p jsonb) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare
 admin boolean; accion text:=p->>'accion'; f date:=(p->>'fecha')::date;
 inicio date; fin date; persona_id uuid:=(p->>'persona')::uuid; cargo_persona text;
 estado_turno text:=p->>'estado'; condicion_turno text; maquina text; medio_turno boolean:=false;
 nota_turno text:=trim(coalesce(p->>'nota','')); pago numeric; esperado integer:=coalesce((p->>'revision')::integer,0);
 ficha boss_nomina_personal%rowtype; personal jsonb; registros jsonb; importe numeric;
 guardia_inicio constant date := date '2026-11-16';
 vigilante_asignado text; turno_guardia text; revision_guardia integer;
begin
 select usuario in ('Admin','Admin2') into admin from boss_usuarios where usuario=p_actor and activo and (rol='supervisor' or usuario in ('Admin','Admin2'));
 if admin is null or (accion in ('nomina_alta','nomina_sueldo','nomina_resumen') and not admin) then
 raise exception 'Acceso restringido' using errcode='42501'; end if;
 if f is null then raise exception 'Selecciona la fecha operativa' using errcode='22023'; end if;
 if f>=guardia_inicio then
   vigilante_asignado:=case when (f-guardia_inicio)%2=0 then 'Vigilante 1' else 'Vigilante 2' end;
 end if;
 inicio:=date_trunc('month',f)::date + case when extract(day from f)>15 then 15 else 0 end;
 fin:=case when extract(day from f)<=15 then inicio+14 else (date_trunc('month',f)+interval '1 month - 1 day')::date end;

 if accion='nomina_alta' then
 insert into boss_nomina_personal(nombre,cargo,desde) values(trim(p->>'nombre'),p->>'cargo',f);
 elsif accion='nomina_sueldo' then
 select cargo into cargo_persona from boss_nomina_personal where id=persona_id;
 importe:=(p->>'monto')::numeric;
 if cargo_persona is distinct from 'Supervisor' or importe is null or importe<=0 or importe>99999999 or importe<>round(importe,2) then
 raise exception 'Revisa el supervisor y el sueldo quincenal' using errcode='22023'; end if;
 insert into boss_nomina_sueldos values(persona_id,inicio,importe) on conflict(persona,desde) do update set monto=excluded.monto;
 elsif accion='nomina_dia' then
 select coalesce(jsonb_agg(jsonb_build_object(
   'id',w.id,'nombre',w.nombre,'cargo',w.cargo,'registro',
   case when a.persona is null then null else to_jsonb(a)-'monto' end,
   'guardia',case when vigilante_asignado is not null and w.cargo='Vigilante' and w.nombre in ('Vigilante 1','Vigilante 2') then
     jsonb_build_object('asignada',w.nombre=vigilante_asignado,'turnos',coalesce(g.turnos,'{}'::jsonb))
   end
 ) order by w.nombre),'[]') into personal
 from boss_nomina_personal w
 left join boss_nomina_asistencia a on a.persona=w.id and a.fecha=f and a.turno=p->>'turno'
 left join lateral (
   select jsonb_object_agg(b.turno,to_jsonb(b)-'monto') as turnos
   from boss_nomina_asistencia b where b.persona=w.id and b.fecha=f
 ) g on vigilante_asignado is not null and w.cargo='Vigilante' and w.nombre in ('Vigilante 1','Vigilante 2')
 where w.cargo<>'Supervisor' and w.desde<=f;
 return jsonb_build_object('personal',personal);
 elsif accion='nomina_guardia' then
 if vigilante_asignado is null or not exists (
   select 1 from boss_nomina_personal where id=persona_id and desde<=f and cargo='Vigilante' and nombre=vigilante_asignado
 ) then raise exception 'Selecciona al vigilante asignado para esa fecha' using errcode='22023'; end if;

 -- Ambos turnos se guardan juntos con la validación habitual de revisión y autor.
 foreach turno_guardia in array array['Diurno','Nocturno'] loop
   revision_guardia:=(p->'revisiones'->>turno_guardia)::integer;
   if revision_guardia is null or revision_guardia<0 then
     raise exception 'Actualiza las asistencias antes de guardar la guardia' using errcode='22023';
   end if;
   perform public.boss_nomina(p_actor,p||jsonb_build_object(
     'accion','nomina_guardar','turno',turno_guardia,'revision',revision_guardia,
     'nota',case when p->>'conservar_notas'='true' then coalesce((
       select b.nota from boss_nomina_asistencia b where b.persona=persona_id and b.fecha=f and b.turno=turno_guardia
     ),'') else nota_turno end
   ));
 end loop;
 elsif accion='nomina_guardar' then
 select * into ficha from boss_nomina_personal where id=persona_id and desde<=f and cargo<>'Supervisor';
 if not found then raise exception 'Trabajador inválido para esta fecha' using errcode='22023'; end if;
 if estado_turno='Trabajó' then
 pago:=case ficha.cargo when 'Chofer' then 35 when 'Operador' then 40 when 'Mecánico' then 35 when 'Ayudante de mecánico' then 30 when 'Chequeador' then 20 when 'Vigilante' then 18 end;
 if ficha.cargo='Operador' then
 maquina:=trim(p->>'equipo'); condicion_turno:=p->>'condicion';
 if coalesce(length(maquina),0) not between 1 and 120 or coalesce(condicion_turno,'') not in ('Operativa','Fuera de servicio','Stand by','Falla durante el turno') then
 raise exception 'Indica la máquina y su condición durante el turno' using errcode='22023'; end if;
 medio_turno:=condicion_turno in ('Fuera de servicio','Stand by');
 if condicion_turno='Falla durante el turno' then
 if coalesce(p->>'decision','') not in ('Completo','Medio') or nota_turno='' then raise exception 'Indica turno completo o medio y el motivo' using errcode='22023'; end if;
 medio_turno:=p->>'decision'='Medio'; end if;
 if medio_turno then pago:=20; end if;
 end if;
 elsif estado_turno in ('Faltó','No convocado') then pago:=0;
 elsif estado_turno='Permiso' then pago:=null;
 else raise exception 'Selecciona una asistencia' using errcode='22023'; end if;
 if ficha.cargo='Vigilante' and exists(select 1 from boss_nomina_sueldos where persona=persona_id and desde<=inicio) then pago:=0; end if;
 if esperado=0 then
 insert into boss_nomina_asistencia(persona,fecha,turno,estado,equipo,condicion,medio,nota,monto,autor,actualizado_por)
 values(persona_id,f,p->>'turno',estado_turno,maquina,condicion_turno,medio_turno,nota_turno,pago,p_actor,p_actor);
 else
 update boss_nomina_asistencia set estado=estado_turno,equipo=maquina,condicion=condicion_turno,medio=medio_turno,nota=nota_turno,monto=pago,actualizado_por=p_actor,revision=revision+1
 where persona=persona_id and fecha=f and turno=p->>'turno' and revision=esperado and (admin or autor=p_actor);
 if not found then raise exception 'Registro modificado o de otro supervisor. Actualiza la lista.' using errcode='22023'; end if;
 end if;
 elsif accion='nomina_resumen' then
 select coalesce(jsonb_agg(to_jsonb(w)||jsonb_build_object('descuento_guardias',case when w.cargo='Vigilante' and inicio>=date '2026-11-16' then (select count(*)*36 from (select a.fecha from boss_nomina_asistencia a where a.persona=w.id and a.fecha between inicio and fin and a.estado='Faltó' group by a.fecha having count(distinct a.turno)=2) faltas) else 0 end,'sueldo',(
 select s.monto from boss_nomina_sueldos s where s.persona=w.id and s.desde<=inicio order by s.desde desc limit 1
 )) order by w.nombre),'[]') into personal from boss_nomina_personal w where w.desde<=fin;
 if inicio>=date '2026-11-16' then
 personal:=personal||(select jsonb_agg(jsonb_build_object('id',nombre,'nombre',nombre,'cargo','Costo fijo','sueldo',monto))
 from (values ('Mantenimiento',180),('Nómina Administrativa',2825),('Nómina Villa',500)) conceptos(nombre,monto));
 end if;
 select coalesce(jsonb_agg((to_jsonb(a)||case when exists(select 1 from boss_nomina_personal w join boss_nomina_sueldos s on s.persona=w.id where w.id=a.persona and w.cargo='Vigilante' and s.desde<=inicio) then '{"monto":0}'::jsonb else '{}'::jsonb end) order by a.fecha,a.turno,a.persona),'[]') into registros from boss_nomina_asistencia a where a.fecha between inicio and fin;
 return jsonb_build_object('desde',inicio,'hasta',fin,'personal',personal,'registros',registros);
 else raise exception 'Acción desconocida' using errcode='22023'; end if;
 return '{}'::jsonb;
end $$;
revoke all on function public.boss_nomina(text,jsonb) from public,anon,authenticated;
grant execute on function public.boss_nomina(text,jsonb) to service_role;

create or replace function public.boss_notificar_nomina() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
  if not exists(select 1 from boss_nomina_puestos_turno where persona=new.persona) then return null; end if;
  perform pg_advisory_xact_lock(new.fecha-date '2000-01-01',case new.turno when 'Diurno' then 71001 else 71002 end);
  insert into boss_avisos(clave,titulo,mensaje)
  select 'nomina:'||new.fecha||':'||new.turno,'Nómina del turno completa',
    to_char(new.fecha,'DD/MM/YYYY')||' · '||new.turno||' · 7 de 7 puestos · Trabajaron: '||
    count(*) filter(where a.estado='Trabajó' and a.condicion is distinct from 'Stand by')||
    ' · Stand by: '||count(*) filter(where a.estado='Trabajó' and a.condicion='Stand by')||
    ' · Faltas: '||count(*) filter(where a.estado='Faltó')||
    ' · Permisos: '||count(*) filter(where a.estado='Permiso')||
    ' · No convocados: '||count(*) filter(where a.estado='No convocado')
  from boss_nomina_asistencia a join boss_nomina_puestos_turno p using(persona)
  where a.fecha=new.fecha and a.turno=new.turno
  having count(*)=7
  on conflict(clave) do nothing;
  return null;
end $$;
revoke all on function public.boss_notificar_nomina() from public,anon,authenticated;

do $$
declare
  dia date := date '2299-11-20';
  guardia uuid;
  mecanico uuid;
  fila jsonb;
  solicitud jsonb;
  deduccion numeric;
begin
  select value into strict fila
  from jsonb_array_elements(public.boss_nomina('Admin','{"accion":"nomina_dia","fecha":"2026-11-16","turno":"Nocturno"}')->'personal')
  where value->>'nombre'='Vigilante 1' and value->>'cargo'='Vigilante';
  if fila#>>'{guardia,asignada}' is distinct from 'true' then raise exception 'Rotación incorrecta el 16/11'; end if;
  select value into strict fila
  from jsonb_array_elements(public.boss_nomina('Admin','{"accion":"nomina_dia","fecha":"2026-11-17","turno":"Diurno"}')->'personal')
  where value->>'nombre'='Vigilante 2' and value->>'cargo'='Vigilante';
  if fila#>>'{guardia,asignada}' is distinct from 'true' then raise exception 'Rotación incorrecta el 17/11'; end if;

  select value into strict fila
  from jsonb_array_elements(public.boss_nomina('Admin',jsonb_build_object('accion','nomina_dia','fecha',dia,'turno','Diurno'))->'personal')
  where value#>>'{guardia,asignada}'='true';
  guardia:=(fila->>'id')::uuid;
  solicitud:=jsonb_build_object('accion','nomina_guardia','persona',guardia,'fecha',dia,'estado','No convocado','revisiones','{"Diurno":0,"Nocturno":0}'::jsonb);
  perform public.boss_nomina('Admin',solicitud);
  if (select count(*) from public.boss_nomina_asistencia where persona=guardia and fecha=dia and estado='No convocado' and monto=0)<>2 then
    raise exception 'La guardia no conservó los dos turnos a cero';
  end if;
  begin
    perform public.boss_nomina('Admin',solicitud||'{"estado":"Faltó","revisiones":{"Diurno":1,"Nocturno":9}}');
    raise exception 'Se aceptó una revisión incorrecta';
  exception when invalid_parameter_value then null;
  end;
  if exists(select 1 from public.boss_nomina_asistencia where persona=guardia and fecha=dia and revision<>1) then
    raise exception 'Se guardó solo la mitad de la guardia';
  end if;
  select (value->>'descuento_guardias')::numeric into strict deduccion
  from jsonb_array_elements(public.boss_nomina('Admin',jsonb_build_object('accion','nomina_resumen','fecha',dia))->'personal')
  where value->>'id'=guardia::text;
  if deduccion<>0 then raise exception 'No convocado generó un descuento'; end if;

  insert into public.boss_nomina_personal(nombre,cargo,desde) values('Prueba guardias '||gen_random_uuid(),'Mecánico',dia) returning id into mecanico;
  perform public.boss_nomina('Admin',jsonb_build_object('accion','nomina_guardar','persona',mecanico,'fecha',dia,'turno','Nocturno','estado','Trabajó'));
  if (select monto from public.boss_nomina_asistencia where persona=mecanico) is distinct from 35 then
    raise exception 'No se aplicó la tarifa nocturna del mecánico';
  end if;
  raise exception using errcode='BM001',message='Revertir pruebas de convocatoria y guardias';
exception when sqlstate 'BM001' then null;
end $$;
