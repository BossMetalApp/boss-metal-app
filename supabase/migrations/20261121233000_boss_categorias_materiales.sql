alter table public.boss_solicitudes_materiales
  drop constraint if exists boss_solicitudes_materiales_categoria_check,
  add constraint boss_solicitudes_materiales_categoria_check
    check (categoria in ('Aceites', 'Mangueras', 'EPP', 'Filtros', 'Repuestos', 'Otros'));
