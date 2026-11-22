import {createClient} from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

Deno.serve(async req => {
  const token = req.headers.get("Authorization")?.match(/^Bearer ([0-9a-f-]{36})$/)?.[1];
  if (req.method !== "POST" || !token) return new Response(null,{status:401});
  const db = createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const {data:config,error} = await db.from("boss_push_config").select("publica,privada").eq("secreto",token).maybeSingle();
  if (error || !config) return new Response(null,{status:error?503:401});
  const {data:jobs,error:queueError} = await db.rpc("boss_tomar_entregas");
  if (queueError) return new Response(null,{status:503});
  await Promise.all(jobs.map(async (job:any) => {
    const delivery = () => db.from("boss_push_entregas").delete().eq("aviso",job.aviso).eq("endpoint",job.endpoint);
    try {
      const details = webpush.generateRequestDetails({endpoint:job.endpoint,keys:{auth:job.auth,p256dh:job.p256dh}},
        JSON.stringify({id:job.aviso,title:job.titulo,body:job.mensaje}), {TTL:86400,
          vapidDetails:{subject:"https://bossmetalapp.github.io/boss-metal-app/",publicKey:config.publica,privateKey:config.privada}});
      const response = await fetch(details.endpoint,{method:"POST",headers:details.headers,body:details.body,redirect:"error",signal:AbortSignal.timeout(10000)});
      if ([404,410].includes(response.status)) await db.from("boss_push_dispositivos").delete().eq("endpoint",job.endpoint).eq("auth",job.auth);
      else if (response.ok) await delivery();
    } finally {
      if (job.intentos>=20) await delivery();
    }
  }).map((p:Promise<void>)=>p.catch(()=>{})));
  return new Response(null,{status:204});
});
