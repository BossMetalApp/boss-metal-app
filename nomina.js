(() => {
  const el = key => document.getElementById('nom-'+key);
  const money = value => new Intl.NumberFormat('es-VE',{style:'currency',currency:'USD'}).format(value);
  const text = (tag,value) => { const node=document.createElement(tag);node.textContent=value;return node; };
  const detail = r => [r.fecha,r.turno,r.estado,r.equipo,r.condicion,r.estado==='Trabajó' && r.equipo ? (r.medio?'Medio turno':'Turno completo') : '',r.nota,r.actualizado_por].filter(Boolean).join(' · ');
  let selected=null, report=null, equipment=[], version=0, saving=false;
  function closeEditor() { selected=null;el('form').hidden=true;el('form').reset(); }
  window.resetNomina=()=>{
    version++;closeEditor();report=null;equipment=[];saving=false;
    el('admin').hidden=true;
    for(const id of ['lista','resumen','supervisor','maquinas','estado','vigencia']) el(id).replaceChildren();
    el('alta').reset();el('fijo').reset();el('fecha').value='';
  };
  function fields(){
    const operator=selected?.cargo==='Operador' && el('asistencia').value==='Trabajó';
    const failure=operator && el('condicion').value==='Falla durante el turno';
    el('operador').hidden=!operator;el('decision-grupo').hidden=!failure;
    el('equipo').required=el('condicion').required=operator;
    el('decision').required=el('nota').required=failure;
  }
  function edit(w){
    closeEditor();selected=w;
    const r=w.registro;
    el('nombre').textContent=w.nombre+' · '+w.cargo;
    el('asistencia').value=r?.estado||'';el('equipo').value=r?.equipo||'';
    el('condicion').value=r?.condicion||'';el('decision').value=r?.condicion==='Falla durante el turno'?(r.medio?'Medio':'Completo'):'';
    el('nota').value=r?.nota||'';fields();el('form').hidden=false;el('asistencia').focus();
  }
  function renderPeople(people){
    const list=el('lista');list.replaceChildren();
    if(!people.length) list.textContent='Sin personal por turno registrado para esta fecha.';
    for(const w of people){
      const button=text('button',w.nombre);button.type='button';
      button.append(text('span',w.cargo+' · '+(w.registro?.estado||'Sin registrar')+(w.registro?' · '+w.registro.autor:'')));
      button.disabled=!!w.registro && !isBossAdmin(bossSession) && w.registro.autor!==bossSession.usuario;
      button.onclick=()=>edit(w);list.append(button);
    }
  }
  function summaryRows(data){
    const byPerson=new Map();
    for(const row of data.registros){
      if(!byPerson.has(row.persona)) byPerson.set(row.persona,[]);
      byPerson.get(row.persona).push(row);
    }
    return data.personal.map(w=>{
      const rows=byPerson.get(w.id)||[], worked=rows.filter(r=>r.estado==='Trabajó');
      const fixed=w.cargo==='Supervisor';
      return {w,rows,day:worked.filter(r=>r.turno==='Diurno').length,night:worked.filter(r=>r.turno==='Nocturno').length,
        absent:rows.filter(r=>r.estado==='Faltó').length,permits:rows.filter(r=>r.estado==='Permiso').length,
        pay:fixed?w.sueldo:rows.reduce((sum,r)=>sum+(Number(r.monto)||0),0),
        pending:fixed && w.sueldo==null?'Sueldo pendiente de configurar':rows.some(r=>r.monto==null)?'Permiso pendiente de valoración':''};
    });
  }
  function renderReport(data){
    report=data;const root=el('resumen');root.replaceChildren();
    const rows=summaryRows(data), total=rows.reduce((sum,r)=>sum+Math.round(Number(r.pay)*100),0)/100;
    root.append(text('p',data.desde+' al '+data.hasta),text('strong','Total calculado · '+money(total)));
    if(rows.some(r=>r.pending))root.append(text('p','Hay montos pendientes de definir.'));
    const select=el('supervisor');select.replaceChildren(new Option('Seleccionar',''));
    for(const r of rows){
      const block=document.createElement('details');
      block.append(text('summary',r.w.nombre+' · '+(r.pay==null?r.pending:money(r.pay))));
      block.append(text('p',r.w.cargo+(r.w.cargo==='Supervisor'?' · Sueldo fijo':' · Diurnos '+r.day+' · Nocturnos '+r.night+' · Faltas '+r.absent+' · Permisos '+r.permits)));
      if(r.pending && r.pay!=null)block.append(text('p',r.pending));
      for(const entry of r.rows)block.append(text('p',detail(entry)+' · '+(entry.monto==null?'Pendiente':money(entry.monto))));
      root.append(block);
      if(r.w.cargo==='Supervisor')select.add(new Option(r.w.nombre,r.w.id));
    }
    el('vigencia').textContent='Vigente desde la quincena del '+data.desde+'.';
  }
  async function load(message=''){
    const session=bossSession;if(!session)return;
    const seq=++version, admin=isBossAdmin(session),fecha=el('fecha').value;
    closeEditor();report=null;el('resumen').replaceChildren();el('lista').replaceChildren();
    el('admin').hidden=true;el('estado').textContent='Consultando nómina…';
    try{
      const [day,summary,machines]=await Promise.all([
        requestProduction(session,{accion:'nomina_dia',fecha,turno:el('turno').value}),
        admin?requestProduction(session,{accion:'nomina_resumen',fecha}):null,
        requestProduction(session,{accion:'disponibilidad_listar'}).catch(()=>({equipos:[]}))
      ]);
      if(seq!==version||session!==bossSession)return;
      equipment=machines.equipos;
      const names=new Set([...availabilityExtra.map(x=>x.nombre),...equipment.map(x=>x.nombre)]);
      el('maquinas').replaceChildren(...[...names].map(name=>new Option(name,name)));
      renderPeople(day.personal);
      if(admin){renderReport(summary);el('admin').hidden=false;}
      el('estado').textContent=message;
    }catch(err){if(seq===version && session===bossSession)el('estado').textContent=err.message;}
  }
  async function save(event,body){
    event.preventDefault();if(saving)return;
    const session=bossSession,form=event.target;
    saving=true;const btn=form.querySelector('button');btn.disabled=true;
    el('estado').textContent='Guardando…';
    try{
      await requestProduction(session,body);
      if(session===bossSession){form.reset();await load('Registro guardado.');}
    }catch(err){if(session===bossSession){el('estado').textContent=err.message;el('estado').scrollIntoView({block:'center'});}}
    finally{btn.disabled=false;saving=false;}
  }
  el('form').onsubmit=e=>save(e,{accion:'nomina_guardar',fecha:el('fecha').value,turno:el('turno').value,persona:selected.id,
    revision:selected.registro?.revision||0,estado:el('asistencia').value,equipo:el('equipo').value,
    condicion:el('condicion').value,decision:el('decision').value,nota:el('nota').value});
  el('alta').onsubmit=e=>save(e,{accion:'nomina_alta',fecha:el('ingreso').value,nombre:el('persona').value.trim(),cargo:el('cargo').value});
  el('fijo').onsubmit=e=>save(e,{accion:'nomina_sueldo',fecha:el('fecha').value,persona:el('supervisor').value,monto:el('monto').value});
  el('equipo').onchange=()=>{
    const known=equipment.find(x=>x.nombre===el('equipo').value);
    el('condicion').value=known?.estado==='Operativo'?'Operativa':known?.estado==='Fuera de servicio'?'Fuera de servicio':'';
    fields();
  };
  el('asistencia').onchange=el('condicion').onchange=fields;
  el('fecha').onchange=el('turno').onchange=el('actualizar').onclick=()=>load();
  el('cancelar').onclick=closeEditor;
  el('excel').onclick=()=>{
    if(!report || !isBossAdmin(bossSession))return;
    const summary=[['Desde','Hasta','Trabajador','Cargo','Diurnos','Nocturnos','Faltas','Permisos','USD calculados','Pendiente']];
    const entries=[['Fecha','Turno','Trabajador','Cargo','Asistencia','Máquina','Condición','Turno reconocido','USD','Observación','Registró','Última edición']];
    let cents=0;
    for(const r of summaryRows(report)){
      cents+=Math.round(Number(r.pay)*100);
      summary.push([report.desde,report.hasta,r.w.nombre,r.w.cargo,r.day,r.night,r.absent,r.permits,r.pay??'',r.pending]);
      for(const a of r.rows)entries.push([a.fecha,a.turno,r.w.nombre,r.w.cargo,a.estado,a.equipo||'',a.condicion||'',a.equipo?(a.medio?'Medio':'Completo'):'',a.monto??'',a.nota,a.autor,a.actualizado_por]);
    }
    summary.push(['','','Total calculado','','','','','',cents/100,'']);
    download(xlsx([{name:'Resumen quincenal',rows:summary},{name:'Asistencia',rows:entries}]),'BossMetal_Nomina_'+report.desde+'_'+report.hasta+'.xlsx');
  };
  window.abrirNomina=()=>{
    if(!el('fecha').value){const current=operationalShift();el('fecha').value=el('ingreso').value=current.date;el('turno').value=current.shift;}
    load();
  };
})();
