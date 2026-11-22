(() => {
  const bell = document.getElementById('boss-campana');
  const panel = document.getElementById('boss-avisos-panel');
  const list = document.getElementById('boss-avisos-lista');
  const more = document.getElementById('boss-avisos-mas');
  const activate = document.getElementById('boss-push-activar');
  const status = document.getElementById('boss-push-estado');
  let cursor, latest = 0, version = 0;
  function seenKey() { return 'boss-aviso-visto-'+bossSession.usuario; }
  async function load(older=false) {
    const session = bossSession;
    if (!session) return;
    const request = ++version;
    try {
      const {avisos} = await requestProduction(session,{accion:'avisos',antes:older?cursor:null});
      if (session !== bossSession || request !== version) return;
      if (!older) {
        latest = avisos[0]?.id || 0;
        bell.textContent = latest > Number(localStorage.getItem(seenKey())) && panel.hidden ? '🔔 Avisos •' : '🔔 Avisos';
        list.replaceChildren();
      }
      for (const item of avisos) {
        const row = document.createElement('li');
        const title = document.createElement('strong');
        title.textContent = item.titulo;
        const date = new Date(item.creado_en).toLocaleString('es-VE',{timeZone:'America/Caracas'});
        row.append(title,document.createElement('br'),item.mensaje,document.createElement('br'),date);
        list.append(row);
      }
      if (!older && !avisos.length) list.textContent = 'Aún no hay avisos.';
      if (!panel.hidden) localStorage.setItem(seenKey(),String(latest));
      cursor = avisos.at(-1)?.id;
      more.hidden = avisos.length < 30;
    } catch (e) {
      if (session === bossSession && !panel.hidden) status.textContent = e.message;
    }
  }
  bell.onclick = () => {
    panel.hidden = !panel.hidden;
    bell.setAttribute('aria-expanded',String(!panel.hidden));
    if (!panel.hidden) load();
  };
  more.onclick = () => load(true);
  activate.onclick = async () => {
    const session = bossSession;
    if (!session) return;
    activate.disabled = true;
    try {
      if (!('PushManager' in window) || !('Notification' in window) || !('serviceWorker' in navigator))
        throw Error('En iPhone, agrega la app a la pantalla de inicio y ábrela desde su ícono.');
      if (await Notification.requestPermission() !== 'granted') throw Error('Para recibir avisos, permite las notificaciones en los ajustes de este dispositivo.');
      const registration = await navigator.serviceWorker.ready;
      let sub = await registration.pushManager.getSubscription();
      if (!sub) {
        const {clave} = await requestProduction(session,{accion:'push_clave'});
        const bytes = Uint8Array.from(atob(clave.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
        sub = await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
      }
      await requestProduction(session,{accion:'push_activar',suscripcion:sub.toJSON()});
      if (session === bossSession) status.textContent = 'Avisos activados en este teléfono.';
    } catch (e) { if (session === bossSession) status.textContent = e.message; }
    finally { activate.disabled = false; }
  };
  window.resetBossAvisos = () => {
    version++; panel.hidden=true; list.replaceChildren(); status.textContent='';
    bell.textContent='🔔 Avisos'; bell.setAttribute('aria-expanded','false'); latest=0;
  };
  window.startBossAvisos = () => {
    if (location.hash === '#avisos') { panel.hidden=false; bell.setAttribute('aria-expanded','true'); }
    load();
  };
  navigator.serviceWorker?.addEventListener('message',e=>{
    if (e.data==='abrir-avisos' && bossSession) { panel.hidden=false; bell.setAttribute('aria-expanded','true'); load(); bell.scrollIntoView(); }
  });
  setInterval(()=>{if (!document.hidden && panel.hidden) load();},45000);
})();
