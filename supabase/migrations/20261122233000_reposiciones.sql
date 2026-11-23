alter table public.boss_gastos add column if not exists pagador text check (pagador in ('Admin','Admin2'));
grant update(pagador) on public.boss_gastos to service_role;
create table if not exists public.boss_reposiciones (
 id uuid primary key, fecha date not null, monto numeric(14,2) not null check(monto>0),
 referencia text not null check(length(referencia)<=160), registrado_por text not null check(registrado_por='Admin'),
 creado_en timestamptz not null default now()
);
alter table public.boss_reposiciones enable row level security;
revoke all on public.boss_reposiciones from public,anon,authenticated;
grant select,insert on public.boss_reposiciones to service_role;

create or replace function public.boss_saldo_reposiciones(p_desde date,p_hasta date) returns jsonb
language sql stable set search_path=public as $$
 select jsonb_build_object(
 'pagado',coalesce((select sum(monto) from boss_gastos where pagador='Admin2'),0),
 'repuesto',coalesce((select sum(monto) from boss_reposiciones),0),
 'pendientes', (select count(*) from boss_gastos where pagador is null),
 'movimientos',coalesce((select jsonb_agg(to_jsonb(r) order by r.fecha,r.creado_en,r.id)
 from (select id,fecha,monto,referencia,creado_en from boss_reposiciones where fecha between p_desde and p_hasta) r),'[]'::jsonb))
$$;
create or replace function public.boss_reponer(p_id uuid,p_fecha date,p_monto numeric,p_referencia text,p_actor text) returns void
language plpgsql set search_path=public as $$
declare anterior boss_reposiciones%rowtype; disponible numeric;
begin
 if p_actor is distinct from 'Admin' then raise insufficient_privilege; end if;
 if p_monto<=0 or p_monto<>round(p_monto,2) then raise exception 'Monto inválido' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(24819,2);
 select * into anterior from boss_reposiciones where id=p_id;
 if found then
   if (anterior.fecha,anterior.monto,anterior.referencia) is distinct from (p_fecha,p_monto,p_referencia) then
     raise exception 'Ya existe una reposición con este identificador.' using errcode='22023'; end if;
   return;
 end if;
 select coalesce((select sum(monto) from boss_gastos where pagador='Admin2'),0)
       -coalesce((select sum(monto) from boss_reposiciones),0) into disponible;
 if p_monto>disponible then raise exception 'El monto supera el saldo pendiente de Admin2.' using errcode='22023'; end if;
 insert into boss_reposiciones values(p_id,p_fecha,p_monto,p_referencia,p_actor,now());
end $$;
revoke all on function public.boss_reponer(uuid,date,numeric,text,text),public.boss_saldo_reposiciones(date,date) from public,anon,authenticated;
grant execute on function public.boss_reponer(uuid,date,numeric,text,text),public.boss_saldo_reposiciones(date,date) to service_role;
grant update(monto,referencia) on public.boss_reposiciones to service_role;

create or replace function public.boss_corregir_reposicion(
 p_id uuid,p_monto numeric,p_referencia text,p_monto_anterior numeric,p_referencia_anterior text,p_actor text
) returns void language plpgsql set search_path=public as $$
declare anterior boss_reposiciones%rowtype; disponible numeric;
begin
 if p_actor is distinct from 'Admin' then raise insufficient_privilege; end if;
 if p_monto is null or p_monto<=0 or p_monto>=1e12 or p_monto<>round(p_monto,2)
   or p_referencia is null or length(p_referencia)>160 then
   raise exception 'Revisa el monto y la referencia.' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(24819,2);
 select * into anterior from boss_reposiciones where id=p_id for update;
 if not found then raise exception 'La reposición ya no está disponible.' using errcode='40001'; end if;
 if (anterior.monto,anterior.referencia) is not distinct from (p_monto,p_referencia) then return; end if;
 if (anterior.monto,anterior.referencia) is distinct from (p_monto_anterior,p_referencia_anterior) then
   raise exception 'La reposición cambió. Actualiza Gastos y vuelve a intentarlo.' using errcode='40001';
 end if;
 if p_monto>anterior.monto then
   select coalesce((select sum(monto) from boss_gastos where pagador='Admin2'),0)
         -coalesce((select sum(monto) from boss_reposiciones where id<>p_id),0) into disponible;
   if p_monto>disponible then raise exception 'El nuevo monto supera el saldo disponible para esta reposición.' using errcode='22023'; end if;
 end if;
 update boss_reposiciones set monto=p_monto,referencia=p_referencia where id=p_id;
end $$;
revoke all on function public.boss_corregir_reposicion(uuid,numeric,text,numeric,text,text) from public,anon,authenticated;
grant execute on function public.boss_corregir_reposicion(uuid,numeric,text,numeric,text,text) to service_role;
notify pgrst,'reload schema';

-- Ejercicio transaccional: los registros de prueba se revierten dentro del bloque.
do $test$
declare gasto uuid:=gen_random_uuid(); pago uuid:=gen_random_uuid(); antes jsonb; despues jsonb; hoy date:=current_date;
begin
 begin
  antes:=public.boss_saldo_reposiciones(hoy,hoy);
  insert into public.boss_gastos(id,fecha,concepto,partida,destino,monto,registrado_por,pagador)
    values(gasto,hoy,'Verificación transaccional','Filtros','General',120,'Admin','Admin2');
  perform public.boss_reponer(pago,hoy,80,'Prueba','Admin');
  perform public.boss_reponer(pago,hoy,80,'Prueba','Admin');
  despues:=public.boss_saldo_reposiciones(hoy,hoy);
  if (despues->>'pagado')::numeric-(antes->>'pagado')::numeric<>120 or
     (despues->>'repuesto')::numeric-(antes->>'repuesto')::numeric<>80 then raise exception 'Saldo incorrecto'; end if;
  perform public.boss_corregir_reposicion(pago,100,'Prueba corregida',80,'Prueba','Admin');
  perform public.boss_corregir_reposicion(pago,100,'Prueba corregida',80,'Prueba','Admin');
  despues:=public.boss_saldo_reposiciones(hoy,hoy);
  if (despues->>'repuesto')::numeric-(antes->>'repuesto')::numeric<>100
     or jsonb_array_length(despues->'movimientos')<>jsonb_array_length(antes->'movimientos')+1
     or not exists (select 1 from boss_reposiciones where id=pago and fecha=hoy and monto=100 and referencia='Prueba corregida')
     then raise exception 'Corrección de reposición incorrecta'; end if;
  begin
    perform public.boss_corregir_reposicion(pago,90,'Prueba',80,'Prueba','Admin');
    raise exception 'Corrección con monto anterior desactualizado aceptada';
  exception when serialization_failure then null; end;
  begin
    perform public.boss_corregir_reposicion(pago,90,'Prueba',100,'Prueba corregida','Admin2');
    raise exception 'Corrección permitida para Admin2';
  exception when insufficient_privilege then null; end;
  raise exception using errcode='ZX001',message='Revertir datos de prueba';
 exception when sqlstate 'ZX001' then null;
 end;
end $test$;
