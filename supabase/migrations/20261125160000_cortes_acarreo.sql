create table if not exists public.boss_cortes_acarreo (
  id uuid primary key,
  desde date not null,
  hasta date not null check (hasta>=desde),
  toneladas_registradas numeric(14,2) not null check (toneladas_registradas>=0),
  toneladas_aprobadas numeric(14,2) not null check (toneladas_aprobadas>0),
  tarifa numeric(10,2) not null check (tarifa>0),
  importe numeric(16,2) generated always as (round(toneladas_aprobadas*tarifa,2)) stored check (importe>0),
  observacion text not null check (length(observacion)<=300),
  creado_en timestamptz not null default now(),
  check (toneladas_aprobadas=toneladas_registradas or observacion<>'')
);

create table if not exists public.boss_abonos_acarreo (
  id uuid primary key,
  corte uuid not null references public.boss_cortes_acarreo(id),
  fecha date not null,
  monto numeric(16,2) not null check (monto>0),
  referencia text not null check (length(referencia)<=160),
  creado_en timestamptz not null default now()
);
create index if not exists boss_abonos_acarreo_corte on public.boss_abonos_acarreo(corte);
alter table public.boss_cortes_acarreo enable row level security;
alter table public.boss_abonos_acarreo enable row level security;
revoke all on public.boss_cortes_acarreo,public.boss_abonos_acarreo from public,anon,authenticated,service_role;

create or replace function public.boss_cortes_acarreo_rpc(p jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  accion text:=p->>'accion';
  id_solicitado uuid:=(p->>'id')::uuid;
  inicio date:=(p->>'desde')::date;
  fin date:=(p->>'hasta')::date;
  dia date:=(p->>'fecha')::date;
  corte_id uuid:=(p->>'corte')::uuid;
  registradas numeric;
  vista numeric:=(p->>'registradas')::numeric;
  aprobadas numeric:=(p->>'aprobadas')::numeric;
  precio numeric:=(p->>'tarifa')::numeric;
  importe_abono numeric:=(p->>'monto')::numeric;
  nota text:=btrim(coalesce(p->>'observacion',''));
  ref text:=btrim(coalesce(p->>'referencia',''));
  corte public.boss_cortes_acarreo%rowtype;
  abono public.boss_abonos_acarreo%rowtype;
  total_abonos numeric;
begin
  if accion='cortes_listar' then
    return coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('abonos',a.detalle,'abonado',a.total,'pendiente',c.importe-a.total)
                                      order by c.hasta desc,c.desde desc)
      from public.boss_cortes_acarreo c
      cross join lateral (
        select coalesce(jsonb_agg(jsonb_build_object('fecha',b.fecha,'monto',b.monto,'referencia',b.referencia)
                          order by b.fecha desc,b.creado_en desc,b.id),'[]'::jsonb) as detalle,
               coalesce(sum(b.monto),0) as total
        from public.boss_abonos_acarreo b where b.corte=c.id
      ) a),'[]'::jsonb);
  elsif accion in ('cortes_consultar','cortes_cerrar') then
    if inicio is null or fin is null or inicio>fin then
      raise exception 'Revisa las fechas del corte.' using errcode='22023';
    end if;
    if accion='cortes_cerrar' then
      if id_solicitado is null or vista is null or aprobadas is null or precio is null
         or aprobadas<=0 or aprobadas>=1e12 or precio<=0 or precio>=1e8 or round(aprobadas*precio,2) not between 0.01 and 99999999999.99
         or aprobadas<>round(aprobadas,2) or precio<>round(precio,2) or length(nota)>300 then
        raise exception 'Revisa las toneladas aprobadas, la tarifa y la observación.' using errcode='22023';
      end if;
      -- Serializa cierres para que dos períodos no puedan incluir los mismos viajes.
      perform pg_advisory_xact_lock(73101,1);
      select * into corte from public.boss_cortes_acarreo c where c.id=id_solicitado;
      if found then
        if (corte.desde,corte.hasta,corte.toneladas_registradas,corte.toneladas_aprobadas,corte.tarifa,corte.observacion)
           is distinct from (inicio,fin,vista,aprobadas,precio,nota) then
          raise exception 'Este corte ya se guardó con otros datos.' using errcode='22023';
        end if;
        return '{}'::jsonb;
      end if;
      if exists(select 1 from public.boss_cortes_acarreo c where c.desde<=fin and c.hasta>=inicio) then
        raise exception 'El período coincide con otro corte. Ajusta las fechas.' using errcode='22023';
      end if;
    end if;
    registradas:=round((public.boss_resumen_operacion(inicio,fin)->>'toneladas')::numeric,2);
    if accion='cortes_consultar' then
      return jsonb_build_object('toneladas',registradas,'tarifa',1.50);
    end if;
    if vista<>registradas then
      raise exception 'Cambió la producción del período. Consulta las toneladas nuevamente.' using errcode='22023';
    end if;
    if aprobadas<>registradas and nota='' then
      raise exception 'Explica el ajuste de las toneladas aprobadas en la observación.' using errcode='22023';
    end if;
    insert into public.boss_cortes_acarreo(id,desde,hasta,toneladas_registradas,toneladas_aprobadas,tarifa,observacion)
      values(id_solicitado,inicio,fin,registradas,aprobadas,precio,nota);
  elsif accion='cortes_abonar' then
    if id_solicitado is null or dia is null or importe_abono is null or importe_abono<=0 or importe_abono>=1e12
       or importe_abono<>round(importe_abono,2) or length(ref)>160 then
      raise exception 'Revisa la fecha, el monto y la referencia del abono.' using errcode='22023';
    end if;
    select * into corte from public.boss_cortes_acarreo c where c.id=corte_id for update;
    if not found then raise exception 'Selecciona un corte válido.' using errcode='22023'; end if;
    select * into abono from public.boss_abonos_acarreo b where b.id=id_solicitado;
    if found then
      if (abono.corte,abono.fecha,abono.monto,abono.referencia) is distinct from (corte_id,dia,importe_abono,ref) then
        raise exception 'Este abono ya se guardó con otros datos.' using errcode='22023';
      end if;
      return '{}'::jsonb;
    end if;
    select coalesce(sum(b.monto),0) into total_abonos from public.boss_abonos_acarreo b where b.corte=corte_id;
    if importe_abono>corte.importe-total_abonos then
      raise exception 'El abono supera el saldo pendiente del corte.' using errcode='22023';
    end if;
    insert into public.boss_abonos_acarreo(id,corte,fecha,monto,referencia) values(id_solicitado,corte_id,dia,importe_abono,ref);
  else
    raise exception 'Acción de cortes desconocida.' using errcode='22023';
  end if;
  return '{}'::jsonb;
end $$;
revoke all on function public.boss_cortes_acarreo_rpc(jsonb) from public,anon,authenticated;
grant execute on function public.boss_cortes_acarreo_rpc(jsonb) to service_role;

do $test$
declare
  corte_id uuid:=gen_random_uuid();
  orden jsonb;
  abono jsonb;
  resumen jsonb;
begin
  insert into public.boss_acarreos(id,registrado_por,fecha,turno,unidad,viajes,capacidad_m3,densidad,equipo)
  values(gen_random_uuid()::text,'Prueba','1898-11-01','Diurno','43',2,20,0.83,'Prueba');
  resumen:=public.boss_cortes_acarreo_rpc('{"accion":"cortes_consultar","desde":"1898-11-01","hasta":"1898-11-15"}');
  if (resumen->>'toneladas')::numeric is distinct from 33.20 then raise exception 'Toneladas incorrectas'; end if;
  orden:=jsonb_build_object('accion','cortes_cerrar','id',corte_id,'desde','1898-11-01','hasta','1898-11-15',
                            'registradas',33.20,'aprobadas',32,'tarifa',1.50,'observacion','Ajuste de prueba');
  perform public.boss_cortes_acarreo_rpc(orden);
  perform public.boss_cortes_acarreo_rpc(orden);
  begin
    perform public.boss_cortes_acarreo_rpc(orden||jsonb_build_object('id',gen_random_uuid(),'desde','1898-11-15','hasta','1898-11-25'));
    raise exception 'Se permitió solapar un corte';
  exception when invalid_parameter_value then null;
  end;
  abono:=jsonb_build_object('accion','cortes_abonar','corte',corte_id,'id',gen_random_uuid(),'fecha','1898-11-20','monto',20);
  perform public.boss_cortes_acarreo_rpc(abono);
  perform public.boss_cortes_acarreo_rpc(abono);
  select value into strict resumen from jsonb_array_elements(public.boss_cortes_acarreo_rpc('{"accion":"cortes_listar"}'))
    where value->>'id'=corte_id::text;
  if (resumen->>'importe')::numeric<>48 or (resumen->>'abonado')::numeric<>20 or (resumen->>'pendiente')::numeric<>28 then
    raise exception 'Saldo inicial incorrecto';
  end if;
  abono:=abono||jsonb_build_object('id',gen_random_uuid());
  begin
    perform public.boss_cortes_acarreo_rpc(abono||'{"monto":29}');
    raise exception 'Se permitió abonar por encima del saldo';
  exception when invalid_parameter_value then null;
  end;
  perform public.boss_cortes_acarreo_rpc(abono||'{"monto":28}');
  if not exists(select 1 from jsonb_array_elements(public.boss_cortes_acarreo_rpc('{"accion":"cortes_listar"}'))
    where value->>'id'=corte_id::text and (value->>'pendiente')::numeric=0 and jsonb_array_length(value->'abonos')=2) then
    raise exception 'Corte liquidado incorrectamente';
  end if;
  raise exception using errcode='ZX002',message='Revertir datos de prueba de cortes';
exception when sqlstate 'ZX002' then null;
end $test$;
