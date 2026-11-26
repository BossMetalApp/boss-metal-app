-- Solo estados técnicos del servicio, sin publicar credenciales ni datos de la operación.
select jsonb_build_object(
  'tarea_activa',exists(select 1 from cron.job where jobname='boss-avisos' and active),
  'respuestas_recientes',coalesce((
    select jsonb_object_agg(result,quantity)
    from (
      select case when timed_out then 'tiempo_agotado'
                  when status_code is null then 'sin_respuesta'
                  else status_code::text end as result,count(*) as quantity
      from net._http_response where created>now()-interval '60 minutes'
      group by 1
    ) r
  ),'{}'::jsonb)
) as diagnostico_entrega;

select cron.schedule('boss-avisos','* * * * *',$job$
  select public.boss_revisar_turnos();
  select net.http_post(
    url:='https://syixumzybwcqumaszzqa.supabase.co/functions/v1/boss-push',
    headers:=jsonb_build_object('Authorization','Bearer '||secreto),
    body:='{}'::jsonb,
    timeout_milliseconds:=25000
  ) from public.boss_push_config
  where publica is not null and privada is not null
    and exists(select 1 from public.boss_push_entregas where proximo<=now());
$job$);

create or replace function public.boss_avisar_estado_material()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  insert into public.boss_avisos(clave,titulo,mensaje)
  values('material-estado:'||new.id||':'||gen_random_uuid(),
    case when old.estado is distinct from new.estado then 'Cambio de estado de solicitud' else 'Solicitud de material actualizada' end,
    concat_ws(' · ',case when old.estado is distinct from new.estado then old.estado||' → '||new.estado end,
      new.categoria,new.cantidad||' × '||new.descripcion,
      coalesce('Unidad '||new.unidad,new.vehiculo,new.equipo_adicional),'Solicitó '||new.solicitado_por));
  return null;
end $$;
revoke all on function public.boss_avisar_estado_material() from public,anon,authenticated;
create or replace trigger boss_material_cambio_estado after update on public.boss_solicitudes_materiales
for each row when (
  (old.estado,old.categoria,old.descripcion,old.cantidad,old.unidad,old.equipo_adicional,old.vehiculo)
  is distinct from (new.estado,new.categoria,new.descripcion,new.cantidad,new.unidad,new.equipo_adicional,new.vehiculo)
) execute function public.boss_avisar_estado_material();

do $test$
declare
  prueba uuid:=gen_random_uuid();
  destino text:='prueba:'||prueba;
  estados text[]:=array['Aprobada','Entregada','Rechazada'];
  siguiente text;
begin
  insert into public.boss_push_dispositivos(endpoint,usuario,auth,p256dh)
    values(destino,'Admin','simulado','simulado');
  insert into public.boss_solicitudes_materiales(id,solicitado_por,categoria,descripcion,cantidad)
    values(prueba,'Prueba','Repuestos','Prueba temporal',1);
  foreach siguiente in array estados loop
    update public.boss_solicitudes_materiales set estado=siguiente where id=prueba;
  end loop;
  update public.boss_solicitudes_materiales set descripcion='Prueba actualizada' where id=prueba;
  update public.boss_solicitudes_materiales set estado='Rechazada',actualizado_en=clock_timestamp() where id=prueba;
  if (select count(*) from public.boss_avisos a join public.boss_push_entregas e on e.aviso=a.id
    where e.endpoint=destino and (a.clave='material:'||prueba or a.clave like 'material-estado:'||prueba||':%'))<>5
    then raise exception 'La solicitud y sus cambios no encolaron exactamente cinco avisos'; end if;
  raise exception using errcode='ZX002',message='Revertir verificación de avisos';
exception when sqlstate 'ZX002' then null;
end $test$;
