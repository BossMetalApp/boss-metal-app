insert into public.boss_nomina_sueldos(persona,desde,monto)
select id,date '2026-11-16',250 from public.boss_nomina_personal where cargo='Vigilante' and nombre in ('Vigilante 1','Vigilante 2')
on conflict(persona,desde) do nothing;
create or replace function public.boss_nomina(p_actor text,p jsonb) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare
 admin boolean; accion text:=p->>'accion'; f date:=(p->>'fecha')::date;
 inicio date; fin date; persona_id uuid:=(p->>'persona')::uuid; cargo_persona text;
 estado_turno text:=p->>'estado'; condicion_turno text; maquina text; medio_turno boolean:=false;
 nota_turno text:=trim(coalesce(p->>'nota','')); pago numeric; esperado integer:=coalesce((p->>'revision')::integer,0);
 ficha boss_nomina_personal%rowtype; personal jsonb; registros jsonb; importe numeric;
begin
 select usuario in ('Admin','Admin2') into admin from boss_usuarios where usuario=p_actor and activo and (rol='supervisor' or usuario in ('Admin','Admin2'));
 if admin is null or (accion in ('nomina_alta','nomina_sueldo','nomina_resumen') and not admin) then
 raise exception 'Acceso restringido' using errcode='42501'; end if;
 if f is null then raise exception 'Selecciona la fecha operativa' using errcode='22023'; end if;
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
 select coalesce(jsonb_agg(jsonb_build_object('id',w.id,'nombre',w.nombre,'cargo',w.cargo,'registro',
 case when a.persona is null then null else to_jsonb(a)-'monto' end) order by w.nombre),'[]') into personal
 from boss_nomina_personal w left join boss_nomina_asistencia a on a.persona=w.id and a.fecha=f and a.turno=p->>'turno'
 where w.cargo<>'Supervisor' and w.desde<=f;
 return jsonb_build_object('personal',personal);
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
 elsif estado_turno='Faltó' then pago:=0;
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
 select coalesce(jsonb_agg(to_jsonb(w)||jsonb_build_object('sueldo',(
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

do $$ declare total numeric; n integer; begin
select sum((p->>'sueldo')::numeric),count(*) into total,n from jsonb_array_elements(public.boss_nomina('Admin','{"accion":"nomina_resumen","fecha":"2026-11-16"}')->'personal') p
where p->>'cargo'='Costo fijo' or p->>'nombre' in ('Vigilante 1','Vigilante 2');
if total is distinct from 4005 or n<>5 then raise exception 'Importes fijos incorrectos'; end if;
end $$;