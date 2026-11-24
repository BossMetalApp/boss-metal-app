(() => {
  const el = key => document.getElementById('nom-'+key);
  const money = value => new Intl.NumberFormat('es-VE',{style:'currency',currency:'USD'}).format(value);
  const text = (tag,value) => { const node=document.createElement(tag);node.textContent=value;return node; };
  const attendance = r => r?.estado === 'Trabajó' && r.condicion === 'Stand by' ? 'Stand by' : r?.estado;
  let selected=null, editorButton=null, visiblePeriod=null, report=null, equipment=[], version=0, saving=false;
  const shift = () => el('turno').querySelector(':checked').value;
  const guardShifts=['Diurno','Nocturno'];
  const daytimeRoles=new Set(['Mecánico','Ayudante de mecánico','Chequeador']);
  const offSchedule=w=>shift()==='Nocturno' && daytimeRoles.has(w.cargo);
  const guardRecords=w=>guardShifts.map(turno=>w.guardia?.turnos[turno]);
  function guardStatus(w){
    const [day,night]=guardRecords(w);
    if(!day && !night)return 'Por registrar';
    return day && night && day.estado===night.estado ? day.estado : 'Revisar turnos';
  }
  const counted=w=>w.guardia ? w.guardia.asignada : !offSchedule(w) || !!w.registro;
  const registered=w=>w.guardia
    ? !['Por registrar','Revisar turnos'].includes(guardStatus(w))
    : !!w.registro;
  function closeEditor(focus=false) {
    const form=el('form'), button=editorButton;
    selected=null;editorButton=null;
    form.hidden=true;form.reset();
    el('editor-inicio').append(form);
    if(button){
      button.setAttribute('aria-expanded','false');
      if(focus)button.focus();
    }
  }
  window.resetNomina=()=>{
    version++;reportVersion++;payrollPeriod=null;el('periodo').value='quincena';el('dia-grupo').hidden=true;closeEditor();report=null;equipment=[];saving=false;
    visiblePeriod=null;el('admin').hidden=true;el('avance').hidden=true;
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
    el('nota-rotulo').textContent=failure?'Observación (obligatoria)':'Observación (opcional)';
  }
  function edit(w,row,button){
    if(saving)return;
    if(editorButton===button){closeEditor(true);return;}
    closeEditor();selected=w;editorButton=button;
    const daily=!!w.guardia;
    const resting=daily && !w.guardia.asignada;
    const [day,night]=guardRecords(w);
    const r=daily ? day || night : w.registro;
    const differentNotes=!!(day && night && day.nota!==night.nota);
    const assigned=availabilityExtra.find(item=>w.cargo==='Operador' && w.nombre==='Operador '+item.nombre);
    const fixed=!!assigned && (!r?.equipo || r.equipo===assigned.nombre);
    el('equipo').hidden=fixed;
    document.querySelector('label[for="nom-equipo"]').hidden=fixed;
    el('nombre').textContent=(daily?'Guardia de 24 h de ':'Asistencia de ')+nombrePuesto(w.nombre);
    const help=el('ayuda');
    help.hidden=w.cargo!=='Vigilante';
    help.textContent=daily
      ? 'De 7:00 a. m. a 7:00 a. m. del día siguiente. La asistencia se aplica a ambos turnos.'
      : 'Editando únicamente el turno '+shift().toLowerCase()+'.';
    if(resting)help.textContent='Es el día de descanso según la rotación. Al guardar, se aplica «De descanso» a ambos turnos de esta fecha.';
    if(daily && differentNotes)help.textContent+=' Deja la observación vacía para conservar las notas de cada turno.';
    const options=el('asistencia');
    options.querySelector('option[value="Stand by"]')?.remove();
    options.querySelector('option[value="De descanso"]')?.remove();
    if(w.cargo==='Operador') options.add(new Option('Stand by','Stand by'));
    if(w.cargo==='Vigilante') options.add(new Option('De descanso','De descanso'));
    for(const option of options.options)option.disabled=resting && !!option.value && option.value!=='De descanso';
    if(resting){
      options.value='De descanso';
    }else if(daily){
      options.value=guardStatus(w)==='Revisar turnos'?'':attendance(r)||'';
    }else{
      options.value=attendance(r)||(offSchedule(w)?'No convocado':'');
    }
    el('equipo').value=normalizarEtiquetaUnidad(r?.equipo)||assigned?.nombre||'';
    el('condicion').value=r?.condicion||'';el('decision').value=r?.condicion==='Falla durante el turno'?(r.medio?'Medio':'Completo'):'';
    if(fixed && !r?.condicion) el('equipo').onchange();
    el('nota').value=daily && differentNotes?'':r?.nota||'';
    fields();
    row.append(el('form'));el('form').hidden=false;
    button.setAttribute('aria-expanded','true');el('asistencia').focus();
  }
  function renderPeople(people,opened){
    const list=el('lista');list.replaceChildren();
    const expected=people.filter(counted);
    const completed=expected.filter(registered).length;
    el('avance').hidden=!expected.length;
    el('avance-texto').textContent=completed+' de '+expected.length+' registrados';
    el('avance-barra').max=expected.length||1;
    el('avance-barra').value=completed;
    if(!people.length){list.textContent='Sin personal por turno registrado para esta fecha.';return;}
    const lastPositions = new Map(['Mecánico','Ayudante de mecánico 1','Ayudante de mecánico 2','Chequeador','Vigilante 1','Vigilante 2'].map((name,index)=>[name,index]));
    const ordered = [...people].sort((a,b)=>(lastPositions.get(a.nombre) ?? -1)-(lastPositions.get(b.nombre) ?? -1));
    const labels={Chofer:'Choferes',Operador:'Operadores',Vigilante:'Vigilancia'};
    const groups=['Choferes','Operadores','Mecánicos','Vigilancia']
      .map(name=>({name,members:ordered.filter(w=>(labels[w.cargo]||'Mecánicos')===name)}))
      .filter(group=>group.members.length)
      .map(group=>{
        const scheduled=group.members.filter(counted);
        return {...group,scheduled,pending:scheduled.filter(w=>!registered(w)).length};
      });
    const initial=(groups.find(group=>group.pending)??groups[0]).name;
    for(const {name,members,scheduled,pending} of groups){
      const block=document.createElement('details');
      block.className='nom-grupo-turno';block.dataset.grupo=name;
      block.open=opened?opened.has(name):name===initial;
      const heading=document.createElement('summary');
      const title=text('strong',name);
      if(members.some(w=>w.guardia)){
        const guard=text('small','Guardia de 24 h · Relevo a las 7:00 a. m.');guard.className='nom-guardia';title.append(guard);
      }
      const review=scheduled.some(w=>w.guardia && guardStatus(w)==='Revisar turnos');
      const progress=!scheduled.length?'Sin convocatoria':!pending?'Completo':review?'Por revisar':pending+' por registrar';
      heading.append(title,text('span',progress));
      const roster=document.createElement('div');roster.className='nom-puestos';
      block.append(heading,roster);list.append(block);
      for(const w of members){
        const row=document.createElement('div');row.className='nom-puesto';
        const button=document.createElement('button');button.type='button';button.className='nom-puesto-boton';
        const label=text('span',nombrePuesto(w.nombre).replace(/^Chofer · /,''));
        label.className='nom-puesto-nombre';
        const daily=w.guardia?.asignada;
        const records=(w.guardia?guardRecords(w):[w.registro]).filter(Boolean);
        const previous=w.guardia && guardShifts.flatMap(turno=>{
          const record=w.guardia.turnos[turno];
          return record?[turno+': '+attendance(record)]:[];
        });
        let detail='';
        const state=w.guardia ? daily?guardStatus(w):'De descanso' : attendance(w.registro)||(offSchedule(w)?'No convocado':'Por registrar');
        if(previous?.length && (state==='Revisar turnos' || (!daily && records.some(r=>r.estado!=='De descanso'))))detail=previous.join(' · ');
        else if(records.length && records.every(r=>r.autor===records[0].autor))detail='Registró: '+records[0].autor;
        if(detail){
          const metadata=text('small',detail);metadata.className='nom-puesto-meta';label.append(metadata);
        }
        const badge=text('span',state);badge.className='nom-asistencia-etiqueta';badge.dataset.estado=state;
        button.append(label,badge);
        button.setAttribute('aria-controls','nom-form');button.setAttribute('aria-expanded','false');
        button.disabled=!isBossAdmin(bossSession) && records.some(r=>r.autor!==bossSession.usuario);
        button.onclick=()=>edit(w,row,button);
        row.append(button);roster.append(row);
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
  const payrollDay = new Intl.DateTimeFormat('es-VE',{day:'numeric',month:'short',timeZone:'UTC'});
  function renderPayrollDays(row){
    const dates=new Map();
    for(const entry of row.rows){
      if(!dates.has(entry.fecha))dates.set(entry.fecha,[]);
      dates.get(entry.fecha).push(entry);
    }
    const list=document.createElement('div');
    list.className='nom-dias';
    const sorted=[...dates.keys()].sort((a,b)=>b.localeCompare(a));
    for(const day of sorted.slice(0,3))appendDay(list,day);
    const older=sorted.slice(3);
    if(older.length){
      const previous=document.createElement('details');
      previous.className='nom-dias-anteriores';
      previous.append(text('summary','Ver '+older.length+(older.length===1?' día anterior':' días anteriores')));
      for(const day of older)appendDay(previous,day);
      list.append(previous);
    }
    return list;

    function appendDay(parent,day){
      const records=dates.get(day);
      const totals=[
        ['Trabajó','turno trabajado','turnos trabajados'],
        ['Faltó','falta','faltas'],
        ['Permiso','permiso','permisos'],
        ['No convocado','no convocado','no convocados'],
        ['De descanso','turno de descanso','turnos de descanso'],
        ['Stand by','en stand by','en stand by'],
      ];
      const counts=totals.map(([status,singular,plural])=>{
        const n=records.filter(entry=>attendance(entry)===status).length;
        return n?n+' '+(n===1?singular:plural):'';
      }).filter(Boolean);
      const pending=records.some(entry=>entry.monto==null);
      const cents=records.reduce((sum,entry)=>sum+Math.round(Number(entry.monto)*100),0);
      const amount=row.fixed?'':records.every(entry=>entry.monto==null)?'Pendiente':money(cents/100);
      const block=document.createElement('details');
      block.className='nom-dia';
      const summary=document.createElement('summary');
      const label=document.createElement('span');
      label.append(text('strong',payrollDay.format(new Date(day+'T00:00:00Z'))));
      if(counts.length)label.append(text('small',counts.join(' · ')));
      const subtotal=text('b',amount);
      if(!row.fixed && pending && amount!=='Pendiente')subtotal.append(text('small','Monto parcial'));
      summary.append(label,subtotal);
      const shifts=document.createElement('div');
      shifts.className='nom-turnos-dia';
      for(const entry of records){
        const line=document.createElement('div');
        line.className='nom-turno-dia';
        const estado=attendance(entry);
        const value=row.fixed && !['No convocado','De descanso'].includes(estado)?'Incluido en el fijo quincenal':entry.monto==null?'Pendiente':money(entry.monto);
        line.append(text('span',entry.turno+' · '+estado),text('b',value));
        const notes=[
          normalizarEtiquetaUnidad(entry.equipo),
          entry.condicion===estado?null:entry.condicion,
          entry.estado==='Trabajó' && entry.equipo ? (entry.medio?'Medio turno':'Turno completo'):null,
          entry.nota?'Observación · '+entry.nota:null,
          entry.actualizado_por?'Última edición · '+entry.actualizado_por:entry.autor?'Registró · '+entry.autor:null,
        ].filter(Boolean);
        for(const note of notes)line.append(text('small',note));
        shifts.append(line);
      }
      block.append(summary,shifts);parent.append(block);
    }
  }
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
      if(r.rows.length)block.append(renderPayrollDays(r));
      group.append(block);

    }
    }

  }
  async function load(message=''){
    const session=bossSession;if(!session)return;
    const seq=++version, admin=isBossAdmin(session),fecha=el('fecha').value,turno=shift();
    const period=fecha+'|'+turno, groups=el('lista').querySelectorAll('.nom-grupo-turno');
    const opened=visiblePeriod===period && groups.length
      ? new Set([...groups].filter(group=>group.open).map(group=>group.dataset.grupo)) : null;
    reportVersion++;payrollPeriod=null;closeEditor();report=null;el('resumen').replaceChildren();el('lista').replaceChildren();
    el('avance').hidden=true;
    el('admin').hidden=true;el('estado').textContent='Consultando nómina…';
    try{
      const [day,summary,machines]=await Promise.all([
        requestProduction(session,{accion:'nomina_dia',fecha,turno}),
        admin?requestProduction(session,{accion:'nomina_resumen',fecha}):null,
        requestProduction(session,{accion:'disponibilidad_listar'}).catch(()=>({equipos:[]}))
      ]);
      if(seq!==version||session!==bossSession)return;
      equipment=machines.equipos.map(item=>item.clave?.startsWith('acarreo:')
        ? {...item,nombre:etiquetaUnidad(item.clave.slice(8),item.nombre)}
        : item);
      const names=new Set([...availabilityExtra.map(x=>x.nombre),...equipment.map(x=>x.nombre)]);
      el('maquinas').replaceChildren(...[...names].map(name=>new Option(name,name)));
      visiblePeriod=period;renderPeople(day.personal,opened);
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
  el('form').onsubmit=e=>{
    const body={fecha:el('fecha').value,persona:selected.id,
      estado:el('asistencia').value==='Stand by'?'Trabajó':el('asistencia').value,nota:el('nota').value};
    if(selected.guardia){
      const revisiones=Object.fromEntries(guardShifts.map(turno=>[turno,selected.guardia.turnos[turno]?.revision||0]));
      const [day,night]=guardRecords(selected);
      const conservar_notas=!!(day && night && day.nota!==night.nota && !body.nota.trim());
      return save(e,{...body,accion:'nomina_guardia',revisiones,conservar_notas});
    }
    return save(e,{...body,accion:'nomina_guardar',turno:shift(),revision:selected.registro?.revision||0,
      equipo:el('equipo').value,condicion:el('condicion').value,decision:el('decision').value});
  };
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
  el('cancelar').onclick=()=>{if(!saving)closeEditor(true);};
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
    if(!el('fecha').value){
      const current=operationalShift();
      el('fecha').value=el('ingreso').value=current.date;
      for(const radio of el('turno').querySelectorAll('input[type="radio"]')){
        radio.checked=radio.value===current.shift;
      }
    }
    return load();
  };
})();
