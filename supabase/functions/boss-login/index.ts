
Deno.serve((_req: Request) => {
  return new Response(
    JSON.stringify({
      ok: false,
      mensaje: "Autenticacion en preparacion"
    }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
});

