(() => {
  const el = key => document.getElementById('nom-'+key);
  const money = value => new Intl.NumberFormat('es-VE',{style:'currency',currency:'USD'}).format(value);
  const text = (tag,value) => { const node=document.createElement(tag);node.textContent=value;return node; };
  const attendance = r => r?.estado === 'Trabajó' && r.condicion === 'Stand by' ? 'Stand by' : r?.estado;
  const detail = r => [r.fecha,r.turno,attendance(r),r.equipo,r.condicion === attendance(r) ? null : r.condicion,r.estado==='Trabajó' && r.equipo ? (r.medio?'Medio turno':'Turno completo') : '',r.nota,r.actualizado_por].filter(Boolean).join(' · ');
  let selected=null, report=null, equipment=[], version=0, saving=false;
  function closeEditor() { selected=null;el('form').hidden=true;el('form').reset(); }
  window.resetNomina=()=>{
    version++;closeEditor();report=null;equipment=[];saving=false;
    el('admin').hidden=true;
    for(const id of ['lista','resumen','supervisor','maquinas','estado','vigencia']) el(id).replaceChildren();
    el('alta').reset();el('fijo').reset();el('fecha').value='';
  };
  function fields(){
    const standby=el('asistencia').value==='Stand by';
    const operator=selected?.cargo==='Operador' && (standby || el('asistencia').value==='Trabajó');
    if(standby) el('condicion').value='Stand by';
    el('condicion').disabled=standby;
    const failure=operator && el('condicion').value==='Falla durante el turno';
    el('operador').hidden=!operator;el('decision-grupo').hidden=!failure;
    el('equipo').required=el('condicion').required=operator;
    el('decision').required=el('nota').required=failure;
  }
  function edit(w){
    closeEditor();selected=w;
    const r=w.registro;
    const assigned=availabilityExtra.find(item=>w.cargo==='Operador' && w.nombre==='Operador '+item.nombre);
    const fixed=!!assigned && (!r?.equipo || r.equipo===assigned.nombre);
    el('equipo').hidden=fixed;
    document.querySelector('label[for="nom-equipo"]').hidden=fixed;
    el('nombre').textContent=w.nombre+' · '+w.cargo+(w.cargo==='Vigilante'?' · Registra ambos turnos de la guardia de 24 h.':'');
    const options=el('asistencia');
    options.querySelector('option[value="Stand by"]')?.remove();
    if(w.cargo==='Operador') options.add(new Option('Stand by','Stand by'));
    options.value=attendance(r)||'';el('equipo').value=r?.equipo||assigned?.nombre||'';
    el('condicion').value=r?.condicion||'';el('decision').value=r?.condicion==='Falla durante el turno'?(r.medio?'Medio':'Completo'):'';
    if(fixed && !r?.condicion) el('equipo').onchange();
    el('nota').value=r?.nota||'';fields();el('form').hidden=false;el('asistencia').focus();
  }
  function renderPeople(people){
    const list=el('lista');list.replaceChildren();
    if(!people.length) list.textContent='Sin personal por turno registrado para esta fecha.';
    const lastPositions = new Map(['Mecánico','Ayudante de mecánico 1','Ayudante de mecánico 2','Chequeador','Vigilante 1','Vigilante 2'].map((name,index)=>[name,index]));
    const ordered = [...people].sort((a,b)=>(lastPositions.get(a.nombre) ?? -1)-(lastPositions.get(b.nombre) ?? -1));
    for(const w of ordered){
      const button=text('button',w.nombre);button.type='button';
      button.append(text('span',w.cargo+' · '+(attendance(w.registro)||'Sin registrar')+(w.registro?' · '+w.registro.autor:'')));
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
      const fixed=w.cargo==='Supervisor' || w.cargo==='Costo fijo' || (w.cargo==='Vigilante' && w.sueldo!=null);
      return {w,rows,fixed,day:worked.filter(r=>r.turno==='Diurno').length,night:worked.filter(r=>r.turno==='Nocturno').length,
        absent:rows.filter(r=>r.estado==='Faltó').length,permits:rows.filter(r=>r.estado==='Permiso').length,
        pay:fixed && w.sueldo!=null?Math.max(0,w.sueldo-(w.descuento_guardias||0)):fixed?null:rows.reduce((sum,r)=>sum+(Number(r.monto)||0),0),
        pending:fixed && w.sueldo==null?'Sueldo pendiente de configurar':rows.some(r=>r.monto==null)?'Permiso pendiente de valoración':''};
    });
  }
  function renderReport(data){
    report=data;const root=el('resumen');root.replaceChildren();
    const rows=summaryRows(data), total=rows.reduce((sum,r)=>sum+Math.round(Number(r.pay)*100),0)/100;
    const banner=document.createElement('div');
    banner.className='nom-total';
    const fecha=v=>v.split('-').reverse().join('/');
    banner.append(text('span',fecha(data.desde)+' al '+fecha(data.hasta)),text('small','Total calculado'),text('strong',money(total)));
    root.append(banner);
    if(rows.some(r=>r.pending))root.append(text('p','Hay montos pendientes de definir.'));
    const select=el('supervisor');select.replaceChildren(new Option('Seleccionar',''));
    const groups=new Map(['Choferes','Operadores','Personal de apoyo','Vigilancia','Supervisores','Costos fijos'].map(name=>[name,[]]));
    const groupNames={Chofer:'Choferes',Operador:'Operadores',Vigilante:'Vigilancia',Supervisor:'Supervisores','Costo fijo':'Costos fijos'};
    for(const row of rows)groups.get(groupNames[row.w.cargo]||'Personal de apoyo').push(row);
    function heading(label,amount){
      const summary=document.createElement('summary');
      summary.append(text('span',label),text('b',amount));return summary;
    }
    for(const [name,members] of groups){
      if(!members.length)continue;
      const group=document.createElement('details');group.className='nom-grupo';
      const subtotal=members.reduce((sum,row)=>sum+Math.round(Number(row.pay)*100),0)/100;
      group.append(heading(name,members.every(row=>row.pay==null)?'Pendiente':money(subtotal)));
      root.append(group);
      for(const r of members){
      const block=document.createElement('details');
      block.append(heading(r.w.nombre,r.pay==null?r.pending:money(r.pay)));
      block.append(text('p',r.w.cargo+(r.fixed?' · Fijo quincenal':' · Diurnos '+r.day+' · Nocturnos '+r.night+' · Faltas '+r.absent+' · Permisos '+r.permits)));
      if(r.w.cargo==='Vigilante' && r.fixed)block.append(text('p','Base '+money(r.w.sueldo)+' · Descuento por guardias '+money(r.w.descuento_guardias||0)));
      if(r.pending && r.pay!=null)block.append(text('p',r.pending));
      for(const entry of r.rows)block.append(text('p',detail(entry)+' · '+(r.fixed?'Incluido en el fijo quincenal':entry.monto==null?'Pendiente':money(entry.monto))));
      group.append(block);
      if(r.w.cargo==='Supervisor')select.add(new Option(r.w.nombre,r.w.id));
    }
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
    revision:selected.registro?.revision||0,estado:el('asistencia').value==='Stand by'?'Trabajó':el('asistencia').value,equipo:el('equipo').value,
    condicion:el('condicion').value,decision:el('decision').value,nota:el('nota').value});
  el('alta').onsubmit=e=>save(e,{accion:'nomina_alta',fecha:el('ingreso').value,nombre:el('persona').value.trim(),cargo:el('cargo').value});
  el('fijo').onsubmit=e=>save(e,{accion:'nomina_sueldo',fecha:el('fecha').value,persona:el('supervisor').value,monto:el('monto').value});
  el('equipo').onchange=()=>{
    const known=equipment.find(x=>x.nombre===el('equipo').value);
    el('condicion').value=known?.estado==='Operativo'?'Operativa':known?.estado==='Fuera de servicio'?'Fuera de servicio':'';
    fields();
  };
  el('asistencia').onchange=()=>{
    if(el('asistencia').value==='Trabajó' && el('condicion').value==='Stand by') el('condicion').value='';
    fields();
  };
  el('condicion').onchange=()=>{
    if(el('condicion').value==='Stand by') el('asistencia').value='Stand by';
    fields();
  };
  el('fecha').onchange=el('turno').onchange=el('actualizar').onclick=()=>load();
  el('cancelar').onclick=closeEditor;
  el('excel').onclick=()=>{
    if(!report || !isBossAdmin(bossSession))return;
    const summary=[['Desde','Hasta','Trabajador','Cargo','Diurnos','Nocturnos','Faltas','Permisos','USD calculados','Pendiente','Descuento guardias USD']];
    const entries=[['Fecha','Turno','Trabajador','Cargo','Asistencia','Máquina','Condición','Turno reconocido','USD','Observación','Registró','Última edición']];
    let cents=0;
    for(const r of summaryRows(report)){
      cents+=Math.round(Number(r.pay)*100);
      summary.push([report.desde,report.hasta,r.w.nombre,r.w.cargo,r.day,r.night,r.absent,r.permits,r.pay??'',r.pending,r.w.descuento_guardias||0]);
      for(const a of r.rows)entries.push([a.fecha,a.turno,r.w.nombre,r.w.cargo,attendance(a),a.equipo||'',a.condicion||'',a.equipo?(a.medio?'Medio':'Completo'):'',a.monto??'',a.nota,a.autor,a.actualizado_por]);
    }
    summary.push(['','','Total calculado','','','','','',cents/100,'']);
    download(xlsx([{name:'Resumen quincenal',rows:summary},{name:'Asistencia',rows:entries}]),'BossMetal_Nomina_'+report.desde+'_'+report.hasta+'.xlsx');
  };
  window.abrirNomina=()=>{
    if(!el('fecha').value){const current=operationalShift();el('fecha').value=el('ingreso').value=current.date;el('turno').value=current.shift;}
    load();
  };
})();
