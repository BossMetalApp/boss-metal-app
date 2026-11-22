create or replace function public.boss_avisar_estado_material() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 insert into boss_avisos(clave,titulo,mensaje)
 values('material-estado:'||new.id||':'||gen_random_uuid(),'Cambio de estado de solicitud',
 concat_ws(' · ',old.estado||' → '||new.estado,new.descripcion,
 coalesce('Unidad '||new.unidad,new.vehiculo,new.equipo_adicional),'Solicitó '||new.solicitado_por));
 return null;
end $$;
revoke all on function public.boss_avisar_estado_material() from public,anon,authenticated;
create or replace trigger boss_material_cambio_estado after update of estado on public.boss_solicitudes_materiales
for each row when (old.estado is distinct from new.estado) execute function public.boss_avisar_estado_material();

do $$ declare prueba uuid:=gen_random_uuid(); destino text:='prueba:'||prueba;
begin
 insert into public.boss_push_dispositivos(endpoint,usuario,auth,p256dh) values(destino,'PruebaDeploy','simulado','simulado');
 insert into public.boss_solicitudes_materiales(id,solicitado_por,categoria,descripcion,cantidad) values(prueba,'PruebaDeploy','Otros','Prueba de avisos',1);
 update public.boss_solicitudes_materiales set estado='Aprobada' where id=prueba;
 update public.boss_solicitudes_materiales set estado='Aprobada' where id=prueba;
 if (select count(*) from public.boss_avisos a join public.boss_push_entregas e on e.aviso=a.id where e.endpoint=destino and a.clave='material:'||prueba)<>1 or
 (select count(*) from public.boss_avisos a join public.boss_push_entregas e on e.aviso=a.id where e.endpoint=destino and a.clave like 'material-estado:'||prueba||':%' and a.mensaje like 'Pendiente → Aprobada%')<>1 then raise exception 'Error en avisos de materiales'; end if;
 raise exception using errcode='BM001', message='Descartar prueba';
exception when sqlstate 'BM001' then null;
end $$;