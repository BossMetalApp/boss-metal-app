
Deno.serve(() => {
  return Response.json(
    {
      ok: false,
      mensaje: "Inicio de sesión en configuración"
    },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
});
