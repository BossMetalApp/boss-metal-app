create or replace function public.boss_crear_supervisor(p_usuario text, p_pin text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, extensions, public
as $$
begin
  if p_usuario is null or p_usuario !~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{2,39}$'
     or lower(p_usuario) in ('admin', 'admin2')
     or p_pin is null or p_pin !~ '^[0-9]{4}$' then
    raise exception 'Usuario o PIN inválido' using errcode = '22023';
  end if;

  insert into public.boss_usuarios (usuario, pin_hash, rol, activo, intentos_fallidos)
  values (p_usuario, crypt(p_pin, gen_salt('bf', 10)), 'supervisor', true, 0);
end;
$$;

revoke all on function public.boss_crear_supervisor(text, text) from public, anon, authenticated;
grant execute on function public.boss_crear_supervisor(text, text) to service_role;
