import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const fields = "id,registrado_por,fecha,turno,unidad,viajes,capacidad_m3,densidad,equipo,observaciones,creado_en,actualizado_en";

function reply(body: object, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

function validId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9.-]{1,100}$/.test(id);
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && !value.startsWith("0000");
}

function validProduction(row: any) {
  return row && validDate(row.fecha) &&
    ["Diurno", "Nocturno"].includes(row.turno) &&
    Number.isInteger(row.viajes) && row.viajes >= 1 && row.viajes <= 1000 &&
    typeof row.observaciones === "string" && row.observaciones.length <= 2000;
}

function production(row: any) {
  return {
    fecha: row.fecha,
    turno: row.turno,
    viajes: row.viajes,
    observaciones: row.observaciones,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply({ ok: false, mensaje: "Método no permitido" }, 405);

  let etapa = "sesion";
  try {
    const token = req.headers.get("Authorization")?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
    if (!token) return reply({ ok: false, mensaje: "Inicia sesión nuevamente" }, 401);

    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return reply({ ok: false, mensaje: "Servicio no disponible" }, 503);
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const { data: session, error: sessionError } = await db.from("boss_sesiones")
      .select("usuario_id").eq("token_hash", hash).gt("expira_en", new Date().toISOString()).maybeSingle();
    if (sessionError) throw sessionError;
    if (!session) return reply({ ok: false, mensaje: "La sesión expiró o no es válida" }, 401);

    etapa = "cuenta";
    const { data: account, error: accountError } = await db.from("boss_usuarios")
      .select("usuario,rol,activo").eq("id", session.usuario_id).maybeSingle();
    if (accountError) throw accountError;
    const admin = !!account && ["Admin", "Admin2"].includes(account.usuario);
    if (!account?.activo || (!admin && account.rol !== "supervisor")) {
      return reply({ ok: false, mensaje: "Acceso no autorizado" }, 403);
    }

    const body = await req.json().catch(() => null);
    if (["materiales_listar", "materiales_crear", "materiales_estado"].includes(body?.accion)) {
      etapa = "materiales";
      const table = "boss_solicitudes_materiales";
      const columns = "id,solicitado_por,categoria,descripcion,cantidad,unidad,estado,creado_en,actualizado_en";

      if (body.accion === "materiales_listar") {
        const offset = body.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) {
          return reply({ ok: false, mensaje: "Página inválida" }, 400);
        }
        let query = db.from(table).select(columns);
        if (!admin) query = query.eq("solicitado_por", account.usuario);
        const { data, error } = await query.order("creado_en", { ascending: false }).order("id").range(offset, offset + 49);
        if (error) throw error;
        return reply({ ok: true, solicitudes: data, siguiente: data.length === 50 ? offset + 50 : null });
      }

      if (typeof body.id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.id)) {
        return reply({ ok: false, mensaje: "Solicitud inválida" }, 400);
      }

      if (body.accion === "materiales_estado") {
        if (!admin) return reply({ ok: false, mensaje: "Solo administradores" }, 403);
        if (!["Pendiente", "Aprobada", "Entregada", "Rechazada"].includes(body.estado) ||
            typeof body.actualizado_en !== "string" || !Number.isFinite(Date.parse(body.actualizado_en))) {
          return reply({ ok: false, mensaje: "Estado inválido" }, 400);
        }
        const { data, error } = await db.from(table)
          .update({ estado: body.estado, actualizado_en: new Date().toISOString() })
          .eq("id", body.id).eq("actualizado_en", body.actualizado_en)
          .select("id").maybeSingle();
        if (error) throw error;
        if (!data) return reply({ ok: false, mensaje: "La solicitud cambió. Actualiza la lista antes de editarla." }, 409);
        return reply({ ok: true });
      }

      if (admin) return reply({ ok: false, mensaje: "Usa una cuenta de supervisor para solicitar materiales" }, 403);
      const descripcion = typeof body.descripcion === "string" ? body.descripcion.trim() : "";
      const unidad = body.unidad ?? null;
      const cantidad = body.cantidad;
      if (!["Aceites", "Mangueras", "EPP"].includes(body.categoria) ||
          !descripcion || descripcion.length > 300 ||
          typeof cantidad !== "number" || !Number.isFinite(cantidad) || cantidad < 0.01 ||
          cantidad > 100000 || Number(cantidad.toFixed(2)) !== cantidad ||
          (unidad !== null && (typeof unidad !== "string" || !/^[A-Za-z0-9-]{1,12}$/.test(unidad)))) {
        return reply({ ok: false, mensaje: "Revisa la categoría, el material, la cantidad y la unidad" }, 400);
      }
      const { error } = await db.from(table).upsert({
        id: body.id, solicitado_por: account.usuario, categoria: body.categoria,
        descripcion, cantidad, unidad,
      }, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;
      const { data, error: readError } = await db.from(table).select("id")
        .eq("id", body.id).eq("solicitado_por", account.usuario).eq("categoria", body.categoria)
        .eq("descripcion", descripcion).eq("cantidad", cantidad)
        .filter("unidad", unidad === null ? "is" : "eq", unidad).maybeSingle();
      if (readError) throw readError;
      if (!data) return reply({ ok: false, mensaje: "No se pudo confirmar esta solicitud" }, 409);
      return reply({ ok: true }, 201);
    }

    if (body?.accion === "listar_supervisores" || body?.accion === "crear_supervisor" || body?.accion === "estado_supervisor") {
      if (!admin) return reply({ ok: false, mensaje: "Solo administradores" }, 403);
      if (body.accion === "listar_supervisores") {
        etapa = "lista";
        const { data, error } = await db.from("boss_usuarios").select("usuario,activo")
          .eq("rol", "supervisor").order("usuario");
        if (error) throw error;
        return reply({ ok: true, supervisores: data });
      }

      const user = body.usuario;
      if (typeof user !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{2,39}$/.test(user) ||
          ["admin", "admin2"].includes(user.toLowerCase())) {
        return reply({ ok: false, mensaje: "Nombre de usuario inválido" }, 400);
      }

      if (body.accion === "crear_supervisor") {
        if (typeof body.pin !== "string" || !/^[0-9]{4}$/.test(body.pin)) {
          return reply({ ok: false, mensaje: "El PIN debe tener cuatro dígitos" }, 400);
        }
        etapa = "alta";
        const { error } = await db.rpc("boss_crear_supervisor", { p_usuario: user, p_pin: body.pin });
        if (error?.code === "23505") return reply({ ok: false, mensaje: "Ese usuario ya existe" }, 409);
        if (error) throw error;
        return reply({ ok: true }, 201);
      }

      if (typeof body.activo !== "boolean") return reply({ ok: false, mensaje: "Estado inválido" }, 400);
      const { data, error } = await db.from("boss_usuarios").update({ activo: body.activo })
        .eq("usuario", user).eq("rol", "supervisor").select("usuario").maybeSingle();
      if (error) throw error;
      if (!data) return reply({ ok: false, mensaje: "Supervisor no encontrado" }, 404);
      return reply({ ok: true });
    }

    if (body?.accion === "resumen_operacion") {
      etapa = "resumen";
      const { desde, hasta } = body;
      if ((desde != null && !validDate(desde)) || (hasta != null && !validDate(hasta)) ||
          (desde && hasta && desde > hasta)) {
        return reply({ ok: false, mensaje: "Revisa el intervalo de fechas" }, 400);
      }
      const { data, error } = await db.rpc("boss_resumen_operacion", {
        p_desde: desde ?? null,
        p_hasta: hasta ?? null,
      });
      if (error) throw error;
      return reply({ ok: true, resumen: data });
    }

    if (body?.accion === "listar") {
      const offset = body.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 ||
          (body.desde !== undefined && !validDate(body.desde)) ||
          (body.hasta !== undefined && !validDate(body.hasta))) {
        return reply({ ok: false, mensaje: "Filtros inválidos" }, 400);
      }
      let query = db.from("boss_acarreos").select(fields);
      if (!admin) query = query.eq("registrado_por", account.usuario);
      if (body.desde) query = query.gte("fecha", body.desde);
      if (body.hasta) query = query.lte("fecha", body.hasta);
      const { data, error } = await query.order("fecha", { ascending: false }).order("id").range(offset, offset + 100);
      if (error) throw error;
      return reply({ ok: true, registros: data.slice(0, 100), siguiente: data.length > 100 ? offset + 100 : null });
    }

    if (body?.accion === "registrar") {
      const rows = body.registros;
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100 ||
          !rows.every((row) => validProduction(row) && validId(row.id) &&
            typeof row.unidad === "string" && /^[A-Za-z0-9-]{1,12}$/.test(row.unidad) &&
            Number.isFinite(row.capacidad_m3) && row.capacidad_m3 > 0 && row.capacidad_m3 <= 1000 &&
            Number.isFinite(row.densidad) && row.densidad > 0 && row.densidad <= 100 &&
            typeof row.equipo === "string" && row.equipo.trim().length > 0 && row.equipo.length <= 150)) {
        return reply({ ok: false, mensaje: "Revisa los datos de producción" }, 400);
      }
      const { error } = await db.from("boss_acarreos").insert(rows.map((row) => ({
        ...production(row),
        id: row.id,
        registrado_por: account.usuario,
        unidad: row.unidad,
        capacidad_m3: row.capacidad_m3,
        densidad: row.densidad,
        equipo: row.equipo,
      })));
      if (error?.code === "23505") return reply({ ok: false, mensaje: "Uno de los registros ya existe. Consulta el historial antes de repetir el envío." }, 409);
      if (error) throw error;
      return reply({ ok: true }, 201);
    }

    if (body?.accion === "corregir") {
      const row = body.registro;
      if (!validProduction(row) || !validId(row.id) ||
          typeof row.actualizado_en !== "string" || !Number.isFinite(Date.parse(row.actualizado_en))) {
        return reply({ ok: false, mensaje: "Revisa los datos de la corrección" }, 400);
      }
      let query = db.from("boss_acarreos").update({
        ...production(row),
        actualizado_en: new Date().toISOString(),
      }).eq("id", row.id).eq("actualizado_en", row.actualizado_en);
      if (!admin) query = query.eq("registrado_por", account.usuario);
      const { data, error } = await query.select(fields).maybeSingle();
      if (error) throw error;
      if (!data) return reply({ ok: false, mensaje: "Registro no disponible o actualizado. Recarga el historial." }, 409);
      return reply({ ok: true, registro: data });
    }

    return reply({ ok: false, mensaje: "Acción inválida" }, 400);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    const reference = etapa + "-" + (/^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(code) ? code : "interno");
    console.error("boss-acarreos", reference);
    return reply({ ok: false, mensaje: "No se pudo procesar el registro (" + reference + ")" }, 500);
  }
});
