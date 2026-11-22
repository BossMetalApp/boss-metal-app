create extension if not exists pg_cron;
create extension if not exists pg_net;
create table if not exists public.boss_avisos (
  id bigint generated always as identity primary key, clave text unique not null,
  titulo text not null, mensaje text not null, creado_en timestamptz not null default now()
);
create table if not exists public.boss_turnos_por_revisar (
  fecha date, turno text, primary key(fecha,turno)
);
create table if not exists public.boss_push_config (
  id boolean primary key default true check(id), secreto uuid not null default gen_random_uuid(),
  publica text, privada text
);
insert into public.boss_push_config(id) values(true) on conflict do nothing;
create table if not exists public.boss_push_dispositivos (
  endpoint text primary key, usuario text not null, auth text not null, p256dh text not null
);
create table if not exists public.boss_push_entregas (
  aviso bigint references public.boss_avisos on delete cascade,
  endpoint text references public.boss_push_dispositivos on delete cascade,
  proximo timestamptz not null default now(), intentos integer not null default 0,
  primary key(aviso,endpoint)
);
do $$ declare tabla text; begin
  foreach tabla in array array['boss_avisos','boss_turnos_por_revisar','boss_push_config','boss_push_dispositivos','boss_push_entregas'] loop
    execute format('alter table public.%I enable row level security',tabla);
    execute format('revoke all on public.%I from public, anon, authenticated',tabla);
    execute format('grant select,insert,update,delete on public.%I to service_role',tabla);
  end loop;
end $$;
create or replace function public.boss_anotar_evento() returns trigger language plpgsql set search_path = pg_catalog,public as $$
begin
  if tg_table_name='boss_acarreos' then
    insert into boss_turnos_por_revisar values(new.fecha,new.turno) on conflict(fecha,turno) do update set turno=excluded.turno;
  elsif tg_table_name='boss_solicitudes_materiales' then
    insert into boss_avisos(clave,titulo,mensaje) values('material:'||new.id,'Nueva solicitud de material',
      concat_ws(' · ',new.solicitado_por,new.categoria,new.cantidad||' × '||new.descripcion,
        coalesce('Unidad '||new.unidad,new.vehiculo,new.equipo_adicional))) on conflict do nothing;
  elsif tg_op='INSERT' or old.estado is distinct from new.estado then
    insert into boss_avisos(clave,titulo,mensaje) values(gen_random_uuid()::text,'Disponibilidad de equipo',
      new.nombre||' · '||case when tg_op='INSERT' then 'Sin reportar' else old.estado end||' → '||new.estado);
  end if;
  return null;
end $$;
create or replace trigger boss_aviso_acarreo after insert or update on public.boss_acarreos for each row execute function public.boss_anotar_evento();
create or replace trigger boss_aviso_material after insert on public.boss_solicitudes_materiales for each row execute function public.boss_anotar_evento();
create or replace trigger boss_aviso_equipo after insert or update on public.boss_disponibilidad_equipos for each row execute function public.boss_anotar_evento();

create or replace function public.boss_encolar_push() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  insert into boss_push_entregas(aviso,endpoint) select new.id,endpoint from boss_push_dispositivos;
  return null;
end $$;
create or replace trigger boss_aviso_entregas after insert on public.boss_avisos for each row execute function public.boss_encolar_push();

create or replace function public.boss_revisar_turnos() returns void language plpgsql set search_path=pg_catalog,public as $$
declare turno_pendiente record;
begin
  for turno_pendiente in delete from boss_turnos_por_revisar returning fecha,turno loop
    insert into boss_avisos(clave,titulo,mensaje)
    select 'turno:'||fecha||':'||turno,'Carga del turno completa',
      to_char(fecha,'DD/MM/YYYY')||' · '||turno||' · '||sum(viajes)||' viajes · '||
      replace(round(sum(viajes*capacidad_m3*densidad),2)::text,'.',',')||' toneladas'
    from boss_acarreos where fecha=turno_pendiente.fecha and turno=turno_pendiente.turno group by fecha,turno
    having count(distinct unidad) filter(where unidad in ('43','44','45','46'))=4
    on conflict do nothing;
  end loop;
end $$;
create or replace function public.boss_tomar_entregas() returns table(aviso bigint,endpoint text,auth text,p256dh text,titulo text,mensaje text,intentos integer)
language sql set search_path=pg_catalog,public as $$
  with pendientes as (
    select e.aviso,e.endpoint from boss_push_entregas e where e.proximo<=now()
    order by e.proximo limit 40 for update skip locked
  ), tomadas as (
    update boss_push_entregas e set proximo=now()+interval '3 minutes',intentos=e.intentos+1
    from pendientes p where (e.aviso,e.endpoint)=(p.aviso,p.endpoint) returning e.*
  )
  select e.aviso,d.endpoint,d.auth,d.p256dh,a.titulo,a.mensaje,e.intentos
  from tomadas e join boss_push_dispositivos d using(endpoint) join boss_avisos a on a.id=e.aviso
  join boss_usuarios u on u.usuario=d.usuario where u.activo and (u.usuario in ('Admin','Admin2') or u.rol='supervisor')
$$;
revoke all on function public.boss_anotar_evento(),public.boss_encolar_push(),public.boss_revisar_turnos(),public.boss_tomar_entregas() from public, anon, authenticated;
grant execute on function public.boss_revisar_turnos(),public.boss_tomar_entregas() to service_role;
select cron.schedule('boss-avisos','* * * * *',$job$
  select public.boss_revisar_turnos();
  select net.http_post(url:='https://syixumzybwcqumaszzqa.supabase.co/functions/v1/boss-push',
    headers:=jsonb_build_object('Authorization','Bearer '||secreto),body:='{}'::jsonb)
  from public.boss_push_config where exists(select 1 from public.boss_push_entregas where proximo<=now());
$job$);
