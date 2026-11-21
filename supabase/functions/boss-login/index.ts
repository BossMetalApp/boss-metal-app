import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function pinHash(
  usuario: string,
  pin: string,
  pepper: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${usuario}:${pin}`),
  );

  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(a: string, b: string) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;

  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }

  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== "POST") {
    return reply({ ok: false, mensaje: "Método no permitido" }, 405);
  }

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const pepper = Deno.env.get("BOSS_PIN_PEPPER");

    if (!url || !key || !pepper) {
      return reply({
        ok: false,
        mensaje: "Configuración del servidor incompleta",
      }, 503);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return reply({ ok: false, mensaje: "Solicitud inválida" }, 400);
    }

    const usuario = body?.usuario;
    const pin = body?.pin;

    if (
      typeof usuario !== "string" ||
      typeof pin !== "string" ||
      !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,39}$/.test(usuario) ||
      !/^\d{4}$/.test(pin)
    ) {
      return reply({ ok: false, mensaje: "Credenciales inválidas" }, 401);
    }

    const db = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: cuenta, error } = await db
      .from("boss_usuarios")
      .select("id, usuario, rol, activo, pin_hash, intentos_fallidos, bloqueado_hasta")
      .eq("usuario", usuario)
      .maybeSingle();

    if (error) {
      return reply({ ok: false, mensaje: "Error de autenticación" }, 500);
    }

    if (
      !cuenta || !cuenta.activo || !cuenta.pin_hash ||
      (!["Admin", "Admin2"].includes(cuenta.usuario) && cuenta.rol !== "supervisor")
    ) {
      return reply({ ok: false, mensaje: "Credenciales inválidas" }, 401);
    }

    const ahora = new Date();

    if (
      cuenta.bloqueado_hasta &&
      new Date(cuenta.bloqueado_hasta) > ahora
    ) {
      return reply({
        ok: false,
        mensaje: "Acceso bloqueado temporalmente",
      }, 429);
    }

    const { data: valido, error: errorPin } = await db.rpc(
  "boss_verificar_pin",
  { p_usuario: usuario, p_pin: pin }
);

if (errorPin) {
  return reply({ ok: false, mensaje: "Error de autenticación" }, 500);
}

    if (!valido) {
  return reply(
    {
      ok: false,
      mensaje: "Credenciales inválidas o acceso bloqueado temporalmente"
    },
    401
  );
}

    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(tokenBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const token_hash = await sha256(token);
    const expira_en = new Date(
      Date.now() + 8 * 60 * 60 * 1000,
    ).toISOString();

    const { error: sessionError } = await db
      .from("boss_sesiones")
      .insert({
        usuario_id: cuenta.id,
        token_hash,
        expira_en,
      });

    if (sessionError) {
      return reply({ ok: false, mensaje: "No se pudo crear la sesión" }, 500);
    }

    await db
      .from("boss_usuarios")
      .update({
        intentos_fallidos: 0,
        bloqueado_hasta: null,
      })
      .eq("id", cuenta.id);

    return reply({
      ok: true,
      usuario: cuenta.usuario,
      rol: cuenta.rol,
      token,
      expira_en,
    });
  } catch {
    return reply({ ok: false, mensaje: "Error interno del servidor" }, 500);
  }
});
