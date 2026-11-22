alter table public.boss_solicitudes_materiales
  add column if not exists equipo_adicional text,
  add column if not exists vehiculo text;

alter table public.boss_solicitudes_materiales
  drop constraint if exists boss_solicitudes_destino_check,
  add constraint boss_solicitudes_destino_check check (
    (equipo_adicional is null and vehiculo is null)
    or (
      unidad is null and equipo_adicional is not null
      and equipo_adicional in ('Bulldozer D8R', 'Payloader HL770', 'Jumbo', 'Vehículo')
      and (
        (equipo_adicional = 'Vehículo' and vehiculo is not null and char_length(btrim(vehiculo)) between 1 and 100)
        or (equipo_adicional <> 'Vehículo' and vehiculo is null)
      )
    )
  );
