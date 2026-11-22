create table if not exists public.boss_nomina_puestos_turno (
  puesto text primary key, persona uuid not null unique references public.boss_nomina_personal(id)
);
alter table public.boss_nomina_puestos_turno enable row level security;
revoke all on public.boss_nomina_puestos_turno from public, anon, authenticated;
grant select on public.boss_nomina_puestos_turno to service_role;

insert into public.boss_nomina_puestos_turno(puesto,persona)
select v.nombre,p.id from (values
 ('Chofer Unidad 43','Chofer'),('Chofer Unidad 44','Chofer'),('Chofer Unidad 45','Chofer'),('Chofer Unidad 46','Chofer'),
 ('Operador Bulldozer D8R','Operador'),('Operador Payloader HL770','Operador'),('Operador Jumbo','Operador')
) v(nombre,cargo) join public.boss_nomina_personal p on p.nombre=v.nombre and p.cargo=v.cargo
on conflict(puesto) do nothing;

do $$ begin
  if (select count(*) from public.boss_nomina_puestos_turno) <> 7 then raise exception 'Faltan puestos previstos de nómina'; end if;
end $$;

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
    ' · Permisos: '||count(*) filter(where a.estado='Permiso')
  from boss_nomina_asistencia a join boss_nomina_puestos_turno p using(persona)
  where a.fecha=new.fecha and a.turno=new.turno
  having count(*)=7
  on conflict(clave) do nothing;
  return null;
end $$;
revoke all on function public.boss_notificar_nomina() from public,anon,authenticated;
create or replace trigger boss_aviso_nomina after insert on public.boss_nomina_asistencia
for each row execute function public.boss_notificar_nomina();

do $$
declare ids uuid[]; i integer; turno_prueba text; fecha_prueba date := date '1888-11-22';
begin
  select array_agg(persona order by puesto) into ids from public.boss_nomina_puestos_turno;
  foreach turno_prueba in array array['Diurno','Nocturno'] loop
    for i in 1..7 loop
      insert into public.boss_nomina_asistencia(persona,fecha,turno,estado,condicion,medio,nota,autor,actualizado_por)
      values(ids[i],fecha_prueba,turno_prueba,case i when 1 then 'Faltó' when 2 then 'Permiso' else 'Trabajó' end,
        case when i=7 then 'Stand by' end,i=7,'','PruebaDeploy','PruebaDeploy');
      if i<7 and exists(select 1 from public.boss_avisos where clave='nomina:'||fecha_prueba||':'||turno_prueba) then raise exception 'Aviso prematuro'; end if;
    end loop;
    update public.boss_nomina_asistencia set nota='Corrección' where persona=ids[7] and fecha=fecha_prueba and turno=turno_prueba;
    if (select count(*) from public.boss_avisos where clave='nomina:'||fecha_prueba||':'||turno_prueba and mensaje like '%Trabajaron: 4 · Stand by: 1 · Faltas: 1 · Permisos: 1')<>1 then raise exception 'Aviso de nómina incorrecto'; end if;
  end loop;
  raise exception using errcode='BM001', message='Descartar prueba';
exception when sqlstate 'BM001' then null;
end $$;
