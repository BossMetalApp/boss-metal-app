(() => {
  const el = key => document.getElementById('nom-'+key);
  const money = value => new Intl.NumberFormat('es-VE',{style:'currency',currency:'USD'}).format(value);
  const text = (tag,value) => { const node=document.createElement(tag);node.textContent=value;return node; };
  const attendance = r => r?.estado === 'Trabajó' && r.condicion === 'Stand by' ? 'Stand by' : r?.estado;
  const detail = r => [r.fecha,r.turno,attendance(r),normalizarEtiquetaUnidad(r.equipo),r.condicion === attendance(r) ? null : r.condicion,r.estado==='Trabajó' && r.equipo ? (r.medio?'Medio turno':'Turno completo') : '',r.nota,r.actualizado_por].filter(Boolean).join(' · ');
  let selected=null, report=null, equipment=[], version=0, saving=false;
  function closeEditor() { selected=null;el('form').hidden=true;el('form').reset(); }
  window.resetNomina=()=>{
    version++;reportVersion++;payrollPeriod=null;el('periodo').value='quincena';el('dia-grupo').hidden=true;closeEditor();report=null;equipment=[];saving=false;
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
    el('nombre').textContent=nombrePuesto(w.nombre)+' · '+w.cargo+(w.cargo==='Vigilante'?' · Registra ambos turnos de la guardia de 24 h.':'');
    const options=el('asistencia');
    options.querySelector('option[value="Stand by"]')?.remove();
    if(w.cargo==='Operador') options.add(new Option('Stand by','Stand by'));
    options.value=attendance(r)||'';el('equipo').value=normalizarEtiquetaUnidad(r?.equipo)||assigned?.nombre||'';
    el('condicion').value=r?.condicion||'';el('decision').value=r?.condicion==='Falla durante el turno'?(r.medio?'Medio':'Completo'):'';
    if(fixed && !r?.condicion) el('equipo').onchange();
    el('nota').value=r?.nota||'';fields();el('form').hidden=false;el('asistencia').focus();
  }
  function renderPeople(people){
    const list=el('lista');list.replaceChildren();
    if(!people.length) list.textContent='Sin personal por turno registrado para esta fecha.';
    const lastPositions = new Map(['Mecánico','Ayudante de mecánico 1','Ayudante de mecánico 2','Chequeador','Vigilante 1','Vigilante 2'].map((name,index)=>[name,index]));
    const ordered = [...people].sort((a,b)=>(lastPositions.get(a.nombre) ?? -1)-(lastPositions.get(b.nombre) ?? -1));
    if(people.length)list.append(text('p',people.filter(w=>w.registro).length+' de '+people.length+' puestos registrados'));
    const labels={Chofer:'Choferes',Operador:'Operadores',Vigilante:'Vigilancia'};
    for(const group of ['Choferes','Operadores','Mecánicos','Vigilancia']){
      const members=ordered.filter(w=>(labels[w.cargo]||'Mecánicos')===group);
      if(!members.length)continue;
      const block=document.createElement('details');
      block.append(text('summary',group+' · '+members.filter(w=>w.registro).length+' de '+members.length));
      list.append(block);
      for(const w of members){
      const button=text('button',nombrePuesto(w.nombre));button.type='button';
      button.append(text('span',w.cargo+' · '+(attendance(w.registro)||'Sin registrar')+(w.registro?' · '+w.registro.autor:'')));
      button.disabled=!!w.registro && !isBossAdmin(bossSession) && w.registro.autor!==bossSession.usuario;
      button.onclick=()=>edit(w);block.append(button);
      }
    }
  }
  let payrollPeriod=null, reportVersion=0;
  function todayCaracas(){
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
    const part=name=>parts.find(p=>p.type===name).value;
    return [part('year'),part('month'),part('day')].join('-');
  }
  async function refreshSummary(){
    const seq=++reportVersion, session=bossSession, day=selectedDay();
    report=null;
    if(!session || !isBossAdmin(session) || !payrollPeriod)return;
    if(el('periodo').value==='dia' && !day){el('resumen').textContent='Selecciona la fecha del resumen.';return;}
    if(!day || (day>=payrollPeriod.desde && day<=payrollPeriod.hasta)){renderReport(payrollPeriod);return;}
    el('resumen').textContent='Consultando la fecha…';
    try {
      const data=await requestProduction(session,{accion:'nomina_resumen',fecha:day});
      if(seq===reportVersion && session===bossSession)renderReport(data);
    }catch(e){if(seq===reportVersion && session===bossSession)el('resumen').textContent=e.message;}
  }
  function selectedDay(){return el('periodo').value==='dia'?el('fecha-resumen').value:null;}
  function dayNumber(date){return Date.parse(date+'T00:00:00Z')/86400000;}
  function summaryRows(data,date=selectedDay()){
    const byPerson=new Map();
    for(const row of data.registros){
      if(!byPerson.has(row.persona)) byPerson.set(row.persona,[]);
      byPerson.get(row.persona).push(row);
    }
    return data.personal.map(w=>{
      const all=byPerson.get(w.id)||[];
      const rows=date?all.filter(r=>r.fecha===date):all, worked=rows.filter(r=>r.estado==='Trabajó');
      const fixed=w.cargo==='Supervisor' || w.cargo==='Costo fijo' || (w.cargo==='Vigilante' && w.sueldo!=null);
      let base=w.sueldo, deduction=w.descuento_guardias||0;
      if(date && fixed && base!=null){
        const start=w.desde && w.desde>data.desde?w.desde:data.desde;
        const days=dayNumber(data.hasta)-dayNumber(start)+1;
        const offset=dayNumber(date)-dayNumber(start);
        const cents=Math.round(base*100);
        base=offset<0?0:(Math.round(cents*(offset+1)/days)-Math.round(cents*offset/days))/100;
        const missed=new Map();
        if(deduction)for(const r of all){
          if(r.estado!=='Faltó')continue;
          if(!missed.has(r.fecha))missed.set(r.fecha,new Set());
          missed.get(r.fecha).add(r.turno);
        }
        const dates=[...missed].filter(([,shifts])=>shifts.size===2).map(([d])=>d).sort();
        const index=dates.indexOf(date);
        const perGuard=dates.length?deduction/dates.length:0;
        deduction=index<0?0:Math.min(perGuard,Math.max(0,w.sueldo-index*perGuard));
      }
      return {w,rows,fixed,base,deduction,day:worked.filter(r=>r.turno==='Diurno').length,night:worked.filter(r=>r.turno==='Nocturno').length,
        absent:rows.filter(r=>r.estado==='Faltó').length,permits:rows.filter(r=>r.estado==='Permiso').length,
        pay:fixed && w.sueldo!=null?(date?base-deduction:Math.max(0,base-deduction)):fixed?null:rows.reduce((sum,r)=>sum+(Number(r.monto)||0),0),
        pending:fixed && w.sueldo==null?'Sueldo pendiente de configurar':rows.some(r=>r.monto==null)?'Permiso pendiente de valoración':''};
    });
  }
  window.filasNominaParaGastos=(data,dia)=>summaryRows(data,dia);
  function renderReport(data){
    report=data;const root=el('resumen');root.replaceChildren();
    const rows=summaryRows(data), total=rows.reduce((sum,r)=>sum+Math.round(Number(r.pay)*100),0)/100;
    const banner=document.createElement('div');
    banner.className='nom-total';
    const fecha=v=>v.split('-').reverse().join('/');
    banner.append(text('span',selectedDay()?fecha(selectedDay()):fecha(data.desde)+' al '+fecha(data.hasta)),text('small','Total calculado'),text('strong',money(total)));
    root.append(banner);
    if(rows.some(r=>r.pending))root.append(text('p','Hay montos pendientes de definir.'));

    const groups=new Map(['Choferes','Operadores','Mecánicos','Vigilancia','Supervisores','Costos fijos'].map(name=>[name,[]]));
    const groupNames={Chofer:'Choferes',Operador:'Operadores',Vigilante:'Vigilancia',Supervisor:'Supervisores','Costo fijo':'Costos fijos'};
    for(const row of rows)groups.get(groupNames[row.w.cargo]||'Mecánicos').push(row);
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
      block.append(heading(nombrePuesto(r.w.nombre),r.pay==null?r.pending:money(r.pay)));
      block.append(text('p',r.w.cargo+(r.fixed?(selectedDay()?' · Fijo prorrateado':' · Fijo quincenal'):' · Diurnos '+r.day+' · Nocturnos '+r.night+' · Faltas '+r.absent+' · Permisos '+r.permits)));
      if(r.w.cargo==='Vigilante' && r.fixed)block.append(text('p','Base '+money(r.base)+' · Descuento por guardias '+money(r.deduction)));
      if(r.pending && r.pay!=null)block.append(text('p',r.pending));
      for(const entry of r.rows)block.append(text('p',detail(entry)+' · '+(r.fixed?'Incluido en el fijo quincenal':entry.monto==null?'Pendiente':money(entry.monto))));
      group.append(block);

    }
    }

  }
  async function load(message=''){
    const session=bossSession;if(!session)return;
    const seq=++version, admin=isBossAdmin(session),fecha=el('fecha').value;
    reportVersion++;payrollPeriod=null;closeEditor();report=null;el('resumen').replaceChildren();el('lista').replaceChildren();
    el('admin').hidden=true;el('estado').textContent='Consultando nómina…';
    try{
      const [day,summary,machines]=await Promise.all([
        requestProduction(session,{accion:'nomina_dia',fecha,turno:el('turno').value}),
        admin?requestProduction(session,{accion:'nomina_resumen',fecha}):null,
        requestProduction(session,{accion:'disponibilidad_listar'}).catch(()=>({equipos:[]}))
      ]);
      if(seq!==version||session!==bossSession)return;
      equipment=machines.equipos.map(item=>item.clave?.startsWith('acarreo:')
        ? {...item,nombre:etiquetaUnidad(item.clave.slice(8),item.nombre)}
        : item);
      const names=new Set([...availabilityExtra.map(x=>x.nombre),...equipment.map(x=>x.nombre)]);
      el('maquinas').replaceChildren(...[...names].map(name=>new Option(name,name)));
      renderPeople(day.personal);
      if(admin){
        payrollPeriod=summary;
        el('supervisor').replaceChildren(new Option('Seleccionar',''),...summary.personal.filter(w=>w.cargo==='Supervisor').map(w=>new Option(w.nombre,w.id)));
        el('vigencia').textContent='Vigente desde la quincena del '+summary.desde+'.';
        el('admin').hidden=false;refreshSummary();
      }
      el('estado').textContent=message;
      return true;
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
  el('periodo').onchange=()=>{
    const daily=el('periodo').value==='dia';
    el('dia-grupo').hidden=!daily;
    if(daily)el('fecha-resumen').value=todayCaracas();
    refreshSummary();
  };
  el('fecha-resumen').onchange=refreshSummary;
  el('excel').onclick=()=>{
    if(!report || !isBossAdmin(bossSession))return;
    const summary=[['Desde','Hasta','Trabajador','Cargo','Diurnos','Nocturnos','Faltas','Permisos','USD calculados','Pendiente','Descuento guardias USD']];
    const entries=[['Fecha','Turno','Trabajador','Cargo','Asistencia','Máquina','Condición','Turno reconocido','USD','Observación','Registró','Última edición']];
    let cents=0;
    for(const r of summaryRows(report)){
      cents+=Math.round(Number(r.pay)*100);
      summary.push([selectedDay()||report.desde,selectedDay()||report.hasta,nombrePuesto(r.w.nombre),r.w.cargo,r.day,r.night,r.absent,r.permits,r.pay??'',r.pending,r.deduction]);
      for(const a of r.rows)entries.push([a.fecha,a.turno,nombrePuesto(r.w.nombre),r.w.cargo,attendance(a),normalizarEtiquetaUnidad(a.equipo)||'',a.condicion||'',a.equipo?(a.medio?'Medio':'Completo'):'',a.monto??'',a.nota,a.autor,a.actualizado_por]);
    }
    summary.push(['','','Total calculado','','','','','',cents/100,'']);
    download(xlsx([{name:selectedDay()?'Resumen diario':'Resumen quincenal',rows:summary},{name:'Asistencia',rows:entries}]),'BossMetal_Nomina_'+(selectedDay()||report.desde+'_'+report.hasta)+'.xlsx');
  };
  window.actualizarNomina=()=>selected || saving ? Promise.resolve(false) : load();
  window.abrirNomina=()=>{
    if(!el('fecha').value){const current=operationalShift();el('fecha').value=el('ingreso').value=current.date;el('turno').value=current.shift;}
    load();
  };
})();
