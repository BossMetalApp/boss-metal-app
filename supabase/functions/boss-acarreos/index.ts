import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const fields = "id,registrado_por,fecha,turno,unidad,viajes,capacidad_m3,densidad,equipo,observaciones,creado_en,actualizado_en,responsable,actualizado_por";

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
    Number.isInteger(row.viajes) && row.viajes >= 0 && row.viajes <= 1000 &&
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
    if (["gastos_guardar","gastos_listar","gastos_identificar","gastos_reponer","gastos_corregir_reposicion","gastos_saldo"].includes(body?.accion)) {
      if (!admin) return reply({ok:false,mensaje:"Solo Administración puede acceder a gastos."},403);
      etapa = "gastos";
      if (body.accion === "gastos_identificar") {
        if (!validId(body.id) || !["Admin","Admin2"].includes(body.pagador)) return reply({ok:false,mensaje:"Revisa el pagador."},400);
        const {data,error}=await db.from("boss_gastos").update({pagador:body.pagador}).eq("id",body.id).is("pagador",null).select("id");
        if(error)throw error;
        if(!data?.length)return reply({ok:false,mensaje:"El gasto ya fue identificado. Actualiza para consultarlo."},409);
        return reply({ok:true});
      }
      if (body.accion === "gastos_reponer") {
        if(account.usuario!=="Admin")return reply({ok:false,mensaje:"Solo Admin registra reposiciones."},403);
        if (!validId(body.id)||!validDate(body.fecha)||typeof body.monto!=="number"||!(body.monto>0 && body.monto<1e12)||typeof body.referencia!=="string"||body.referencia.length>160)
          return reply({ok:false,mensaje:"Revisa la fecha, el monto y la referencia."},400);
        const {error}=await db.rpc("boss_reponer",{p_id:body.id,p_fecha:body.fecha,p_monto:body.monto,p_referencia:body.referencia.trim(),p_actor:account.usuario});
        if(error?.code==="22023")return reply({ok:false,mensaje:error.message},400);
        if(error)throw error;
        return reply({ok:true});
      }
      if (body.accion === "gastos_corregir_reposicion") {
        if (account.usuario !== "Admin") return reply({ok:false,mensaje:"Solo Admin corrige reposiciones."},403);
        const {id,monto,referencia,montoAnterior,referenciaAnterior}=body;
        const importeValido=(n: unknown): n is number =>
          typeof n==="number" && n>0 && n<1e12 && Number(n.toFixed(2))===n;
        if (!validId(id) || !importeValido(monto) || !importeValido(montoAnterior) ||
          typeof referencia!=="string" || referencia.length>160 ||
          typeof referenciaAnterior!=="string" || referenciaAnterior.length>160)
          return reply({ok:false,mensaje:"Revisa el monto y la referencia."},400);
        const {error}=await db.rpc("boss_corregir_reposicion",{
          p_id:id,p_monto:monto,p_referencia:referencia.trim(),
          p_monto_anterior:montoAnterior,p_referencia_anterior:referenciaAnterior,p_actor:account.usuario,
        });
        if (error?.code==="22023") return reply({ok:false,mensaje:error.message},400);
        if (error?.code==="40001") return reply({ok:false,mensaje:error.message},409);
        if (error) throw error;
        return reply({ok:true});
      }
      if (body.accion === "gastos_guardar") {
        const {id,fecha,concepto,partida,destino,monto} = body;
        if (typeof id !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ||
          !validDate(fecha) || !["Repuestos","Aceites","Mangueras","Filtros","Oficina","Comida","Operacionales"].includes(partida) ||
          typeof concepto !== "string" || !concepto.trim() || concepto.length>200 ||
          typeof destino !== "string" || !destino.trim() || destino.length>160 ||
          typeof monto !== "number" || !(monto>0 && monto<1e12) || Number(monto.toFixed(2))!==monto)
          return reply({ok:false,mensaje:"Revisa los datos del gasto."},400);
        const pagador=body.pagador??null;
        if(pagador!==null && !["Admin","Admin2"].includes(pagador))return reply({ok:false,mensaje:"Revisa el pagador."},400);
        const row={id,fecha,pagador,concepto:concepto.trim(),partida,destino:destino.trim(),monto,registrado_por:account.usuario};
        const {error}=await db.from("boss_gastos").insert(row);
        if(error?.code==="23505"){
          const {data,error:readError}=await db.from("boss_gastos").select("*").eq("id",id).single();
          if(readError) throw readError;
          if(Object.entries(row).some(([k,v])=>data[k]!==v))return reply({ok:false,mensaje:"Este gasto ya se guardó con otros datos."},409);
        }else if(error)throw error;
        return reply({ok:true});
      }
      const {desde,hasta,offset=0}=body;
      if(!validDate(desde)||!validDate(hasta)||hasta<desde||hasta.slice(0,7)!==desde.slice(0,7)||!Number.isSafeInteger(offset)||offset<0)
        return reply({ok:false,mensaje:"Revisa el período."},400);
      if(body.accion==="gastos_saldo"){
        const {data,error}=await db.rpc("boss_saldo_reposiciones",{p_desde:desde,p_hasta:hasta});
        if(error)throw error;
        return reply({ok:true,saldo:data});
      }
      const {data,error}=await db.from("boss_gastos").select("id,fecha,concepto,monto,partida,destino,pagador").gte("fecha",desde).lte("fecha",hasta)
        .order("creado_en").order("id").range(offset,offset+499);
      if(error)throw error;
      return reply({ok:true,gastos:data});
    }
    if (["balance_produccion","balance_registrar_trabajo"].includes(body?.accion)) {
      if (account.usuario !== "Admin") return reply({ok:false,mensaje:"Solo Admin puede consultar Producción y balance."},403);
      etapa = "balance_produccion";
      if (body.accion === "balance_registrar_trabajo") {
        const {id,equipo,fecha,monto,concepto}=body;
        if (!validId(id) || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ||
            !["equipo:d8r","equipo:hl770","equipo:jumbo"].includes(equipo) || !validDate(fecha) ||
            typeof monto!=="number" || !(monto>0 && monto<1e12) || Number(monto.toFixed(2))!==monto ||
            typeof concepto!=="string" || concepto.length>200)
          return reply({ok:false,mensaje:"Revisa el equipo, la fecha, el monto y el concepto."},400);
        const row={id,equipo,fecha,monto,concepto:concepto.trim()};
        const {error}=await db.from("boss_produccion_equipos").insert(row);
        if (error?.code==="23505") {
          const {data,error:readError}=await db.from("boss_produccion_equipos").select("id,equipo,fecha,monto,concepto").eq("id",id).single();
          if (readError) throw readError;
          if (Object.entries(row).some(([key,value])=>data[key]!==value))
            return reply({ok:false,mensaje:"Este trabajo ya se guardó con otros datos."},409);
        } else if (error) throw error;
        return reply({ok:true});
      }
      const {desde,hasta}=body;
      if (!validDate(desde) || !validDate(hasta) || desde>hasta || desde.slice(0,7)!==hasta.slice(0,7))
        return reply({ok:false,mensaje:"Revisa el período de producción."},400);
      const {data,error}=await db.rpc("boss_balance_produccion",{p_desde:desde,p_hasta:hasta});
      if (error) throw error;
      return reply({ok:true,produccion:data});
    }

    if (typeof body?.accion === "string" && body.accion.startsWith("nomina_")) {
      etapa = "nomina";
      if (!validDate(body.fecha)) return reply({ok:false,mensaje:"Revisa la fecha"},400);
      const {data,error} = await db.rpc("boss_nomina",{p_actor:account.usuario,p:body});
      if (error) {
        if (error.code === "42501") return reply({ok:false,mensaje:"Solo Administración puede consultar los montos y configurar personal"},403);
        if (error.code === "23505") return reply({ok:false,mensaje:"El registro ya existe. Actualiza para consultarlo."},409);
        if (error.code === "22023") return reply({ok:false,mensaje:error.message},400);
        if (error.code.startsWith("22") || error.code.startsWith("23")) return reply({ok:false,mensaje:"Revisa los datos ingresados"},400);
        throw error;
      }
      return reply({ok:true,...data});
    }
    if (body?.accion === "avisos") {
      let query = db.from("boss_avisos").select("id,titulo,mensaje,creado_en").order("id",{ascending:false}).limit(30);
      if (Number.isSafeInteger(body.antes) && body.antes > 0) query = query.lt("id",body.antes);
      const {data,error} = await query;
      if (error) throw error;
      return reply({ok:true,avisos:data});
    }
    if (body?.accion === "push_clave") {
      let {data,error} = await db.from("boss_push_config").select("publica").eq("id",true).single();
      if (error) throw error;
      if (!data?.publica) {
        const pair = await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
        const jwk = await crypto.subtle.exportKey("jwk",pair.privateKey);
        const raw = new Uint8Array(await crypto.subtle.exportKey("raw",pair.publicKey));
        const publica = btoa(String.fromCharCode(...raw)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
        const update = await db.from("boss_push_config").update({publica,privada:jwk.d}).eq("id",true).is("publica",null);
        if (update.error) throw update.error;
        ({data,error} = await db.from("boss_push_config").select("publica").eq("id",true).single());
        if (error) throw error;
      }
      return reply({ok:true,clave:data!.publica});
    }
    if (body?.accion === "push_activar") {
      const sub = body.suscripcion;
      let endpoint: URL;
      try { endpoint = new URL(sub?.endpoint); } catch { return reply({ok:false,mensaje:"Suscripción inválida"},400); }
      if (endpoint.protocol!=="https:" || endpoint.port || endpoint.username || endpoint.password ||
          !/^(?:[a-z0-9-]+\.)*push\.apple\.com$|^fcm\.googleapis\.com$|^updates\.push\.services\.mozilla\.com$|^(?:[a-z0-9-]+\.)+notify\.windows\.com$/.test(endpoint.hostname) ||
          !/^[A-Za-z0-9_-]{22}$/.test(sub.keys?.auth||"") || !/^[A-Za-z0-9_-]{87}$/.test(sub.keys?.p256dh||"")) {
        return reply({ok:false,mensaje:"Servicio de notificaciones incompatible"},400);
      }
      const {error} = await db.from("boss_push_dispositivos").upsert({endpoint:endpoint.href,usuario:account.usuario,
        auth:sub.keys.auth,p256dh:sub.keys.p256dh},{onConflict:"endpoint"});
      if (error) throw error;
      return reply({ok:true});
    }

    if (body?.accion === "disponibilidad_listar" || body?.accion === "disponibilidad_guardar") {
      etapa = "disponibilidad";
      const table = "boss_disponibilidad_equipos";
      const columns = "clave,nombre,estado,actualizado_por,actualizado_en";
      if (body.accion === "disponibilidad_listar") {
        const { data, error } = await db.from(table).select(columns).order("clave");
        if (error) throw error;
        return reply({ ok: true, equipos: data });
      }

      const clave = body.clave;
      const nombre = typeof body.nombre === "string" ? body.nombre.trim() : "";
      if (typeof clave !== "string" || !/^(acarreo:[A-Za-z0-9-]{1,12}|equipo:(d8r|hl770|jumbo))$/.test(clave) ||
          !nombre || nombre.length > 100 || !["Operativo", "Fuera de servicio"].includes(body.estado)) {
        return reply({ ok: false, mensaje: "Revisa el equipo y su estado" }, 400);
      }

      const { data, error } = await db.from(table).upsert({
        clave, nombre, estado: body.estado,
        actualizado_por: account.usuario,
        actualizado_en: new Date().toISOString(),
      }, { onConflict: "clave" }).select(columns).single();
      if (error) throw error;
      return reply({ ok: true, equipo: data });
    }

    if (["materiales_listar", "materiales_crear", "materiales_estado"].includes(body?.accion)) {
      etapa = "materiales";
      const table = "boss_solicitudes_materiales";
      const columns = "id,solicitado_por,categoria,descripcion,cantidad,unidad,equipo_adicional,vehiculo,estado,creado_en,actualizado_en";

      if (body.accion === "materiales_listar") {
        const offset = body.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) {
          return reply({ ok: false, mensaje: "Página inválida" }, 400);
        }
        const query = db.from(table).select(columns);
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
      const equipoAdicional = body.equipo_adicional ?? null;
      const vehiculo = typeof body.vehiculo === "string" ? body.vehiculo.trim() : null;
      if ((equipoAdicional !== null &&
          (!["Bulldozer D8R", "Payloader HL770", "Jumbo", "Vehículo"].includes(equipoAdicional) || unidad !== null)) ||
          (equipoAdicional === "Vehículo" ? !vehiculo || vehiculo.length > 100 : body.vehiculo != null)) {
        return reply({ ok: false, mensaje: "Selecciona un equipo válido o indica cuál es el vehículo" }, 400);
      }
      const cantidad = body.cantidad;
      if (!["Aceites", "Mangueras", "EPP", "Filtros", "Repuestos", "Otros"].includes(body.categoria) ||
          !descripcion || descripcion.length > 300 ||
          typeof cantidad !== "number" || !Number.isFinite(cantidad) || cantidad < 0.01 ||
          cantidad > 100000 || Number(cantidad.toFixed(2)) !== cantidad ||
          (unidad !== null && (typeof unidad !== "string" || !/^[A-Za-z0-9-]{1,12}$/.test(unidad)))) {
        return reply({ ok: false, mensaje: "Revisa la categoría, el material, la cantidad y la unidad" }, 400);
      }
      const { error } = await db.from(table).upsert({
        id: body.id, solicitado_por: account.usuario, categoria: body.categoria,
        descripcion, cantidad, unidad, equipo_adicional: equipoAdicional, vehiculo,
      }, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;
      const { data, error: readError } = await db.from(table).select("id")
        .eq("id", body.id).eq("solicitado_por", account.usuario).eq("categoria", body.categoria)
        .eq("descripcion", descripcion).eq("cantidad", cantidad)
        .filter("unidad", unidad === null ? "is" : "eq", unidad)
        .filter("equipo_adicional", equipoAdicional === null ? "is" : "eq", equipoAdicional)
        .filter("vehiculo", vehiculo === null ? "is" : "eq", vehiculo).maybeSingle();
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

    if (body?.accion === "graficas_produccion") {
      etapa = "graficas";
      const { desde, hasta } = body;
      if (!validDate(desde) || !validDate(hasta) || desde > hasta ||
          Date.parse(hasta) - Date.parse(desde) > 731 * 86400000) {
        return reply({ ok: false, mensaje: "Revisa el rango de fechas de la gráfica" }, 400);
      }
      const { data, error } = await db.rpc("boss_graficas_produccion", {p_desde: desde, p_hasta: hasta});
      if (error) throw error;
      return reply({ ok: true, series: data });
    }

    if (body?.accion === "semaforo_carga") {
      etapa = "semaforo";
      if (!validDate(body.fecha) || !["Diurno", "Nocturno"].includes(body.turno)) {
        return reply({ ok: false, mensaje: "Revisa la fecha y el turno" }, 400);
      }
      const { data, error } = await db.from("boss_acarreos").select("unidad,viajes")
        .eq("fecha", body.fecha).eq("turno", body.turno).order("unidad");
      if (error) throw error;
      return reply({ ok: true, registros: data });
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
      etapa = "registro";
      const rows = body.registros;
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100 ||
          !rows.every((row) => validProduction(row) && validId(row.id) &&
            typeof row.unidad === "string" && /^[A-Za-z0-9-]{1,12}$/.test(row.unidad) &&
            Number.isFinite(row.capacidad_m3) && row.capacidad_m3 > 0 && row.capacidad_m3 <= 1000 &&
            Number.isFinite(row.densidad) && row.densidad > 0 && row.densidad <= 100 &&
            typeof row.equipo === "string" && row.equipo.trim().length > 0 && row.equipo.length <= 150 &&
            (row.responsable === undefined || (admin && typeof row.responsable === "string" &&
              row.responsable.trim().length > 0 && row.responsable.trim().length <= 150)))) {
        return reply({ ok: false, mensaje: "Revisa los datos de producción" }, 400);
      }
      const registros = rows.map((row) => ({
        ...production(row),
        id: row.id,
        registrado_por: account.usuario,
        responsable: admin ? row.responsable?.trim() ?? null : null,
        unidad: row.unidad,
        capacidad_m3: row.capacidad_m3,
        densidad: row.densidad,
        equipo: row.equipo,
      }));
      const claves = new Set(registros.map(row => JSON.stringify([row.fecha, row.turno, row.unidad])));
      if (claves.size !== registros.length) {
        return reply({ ok: false, mensaje: "El envío contiene más de un total para la misma unidad, fecha y turno." }, 400);
      }

      const { error } = await db.from("boss_acarreos").insert(registros);
      if (error?.code === "23505") {
        const { data: previos, error: lookupError } = await db.from("boss_acarreos").select(fields)
          .in("id", registros.map(row => row.id)).eq("registrado_por", account.usuario);
        if (lookupError) throw lookupError;
        const byId = new Map(previos.map(row => [row.id, row]));
        if (registros.every(row => {
          const previo = byId.get(row.id);
          return previo && previo.fecha === row.fecha && previo.turno === row.turno &&
            previo.unidad === row.unidad && previo.viajes === row.viajes &&
            Number(previo.capacidad_m3) === row.capacidad_m3 && Number(previo.densidad) === row.densidad &&
            previo.equipo === row.equipo && previo.observaciones === row.observaciones &&
            previo.responsable === row.responsable;
        })) return reply({ ok: true }, 200);

        const found = [];
        for (const row of registros) {
          const { data: existente, error: duplicateError } = await db.from("boss_acarreos")
            .select("viajes,registrado_por").eq("fecha", row.fecha).eq("turno", row.turno).eq("unidad", row.unidad).maybeSingle();
          if (duplicateError) throw duplicateError;
          if (existente) found.push("Unidad " + row.unidad + " · " + row.fecha + " · " + row.turno +
            ": " + existente.viajes + " viajes, registrados por " + existente.registrado_por);
        }
        return reply({
          ok: false,
          mensaje: found.length ? "No se guardó el envío. Ya hay registro para: " + found.join("; ") +
            ". Si cambió el total, pide al autor o a Admin que corrija el registro existente. Retira del formulario las unidades ya registradas para guardar las demás." :
            "El envío ya existe. Revisa el historial antes de volver a intentarlo.",
        }, 409);
      }
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
        actualizado_por: account.usuario,
      }).eq("id", row.id).eq("actualizado_en", row.actualizado_en);
      if (!admin) query = query.eq("registrado_por", account.usuario);
      const { data, error } = await query.select(fields).maybeSingle();
      if (error?.code === "23505") {
        return reply({ ok: false, mensaje: "Ya existe un total para esa unidad, fecha y turno." }, 409);
      }
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
