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

    const { data: account, error: accountError } = await db.from("boss_usuarios")
      .select("usuario,rol,activo").eq("id", session.usuario_id).maybeSingle();
    if (accountError) throw accountError;
    const admin = !!account && ["Admin", "Admin2"].includes(account.usuario);
    if (!account?.activo || (!admin && account.rol !== "supervisor")) {
      return reply({ ok: false, mensaje: "Acceso no autorizado" }, 403);
    }

    const body = await req.json().catch(() => null);
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
  } catch {
    return reply({ ok: false, mensaje: "No se pudo procesar el registro" }, 500);
  }
});
