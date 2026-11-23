(() => {
const by=id=>document.getElementById('gasto-'+id);
const fmt=n=>new Intl.NumberFormat('es-VE',{style:'currency',currency:'USD'}).format(n);
let entries=[],version=0,pending=null,saving=false;
let balance=null, paymentAttempt=null;
const form=by('form');
function normalizarDestino(destino){
  const nombre=destino?.trim().replace(/\s+/g,' ').toLowerCase();
  return nombre==='van trasporte'||nombre==='van transporte'?'Van transporte':destino;
}
function bounds(date,mode){
  if(mode==='Día')return [date,date];
  const [year,month,day]=date.split('-').map(Number);
  const prefix=date.slice(0,8),last=new Date(year,month,0).getDate();
  if(mode==='Mensual')return [prefix+'01',prefix+last];
  return day<=15?[prefix+'01',prefix+'15']:[prefix+'16',prefix+last];
}
function draw(){const date=by('date').value;if(!date)return;const [start,end]=bounds(date,document.querySelector('input[name="gasto-periodo"]:checked').value),rows=entries.filter(r=>r[0]>=start&&r[0]<=end),sum=rs=>rs.reduce((s,r)=>s+Math.round(r[2]*100),0)/100,display=d=>d.split('-').reverse().join('/');by('period').textContent=start===end?display(start):display(start)+' al '+display(end);by('total').textContent=fmt(sum(rows));const root=by('groups');root.replaceChildren();
function section(name){const s=document.createElement('div');s.className='card';const h=document.createElement('h2');h.textContent=name;s.append(h);root.append(s);return s}
function group(parent,label,items){const d=document.createElement('details'),h=document.createElement('summary'),b=document.createElement('b');h.append(label);b.textContent=fmt(sum(items));h.append(b);d.append(h);parent.append(d);return d}
function detail(parent,items){for(const [day,concept,value,,unit,payer] of items){const line=document.createElement('small');line.textContent=[display(day),concept,unit,payer,fmt(value)].filter(Boolean).join(' · ');parent.append(line)}if(!items.length)parent.append('Sin gastos en este período.')}
const cat=section('Resumen por partida');for(const name of ['Nómina','Repuestos','Consumibles','Oficina','Comida','Operacionales']){const cons=['Aceites','Mangueras','Filtros'],items=rows.filter(r=>name==='Consumibles'?cons.includes(r[3]):r[3]===name),g=group(cat,name,items);if(name==='Consumibles'){for(const c of cons){const part=items.filter(r=>r[3]===c);detail(group(g,c,part),part)}}else detail(g,items)}
const eq=section('Por unidad o equipo'),assigned=rows.filter(r=>r[4] && r[4]!=='General');for(const u of new Set(assigned.map(r=>r[4]))){const items=assigned.filter(r=>r[4]===u);detail(group(eq,u,items),items)}if(!assigned.length)eq.append('Sin gastos asignados.');const general=rows.filter(r=>r[4]==='General');detail(group(section('Gastos generales'),'General',general),general)}
function clearBalance(){
  balance=null;by('saldo').textContent='';by('mov').replaceChildren();by('reponer').hidden=true;
}
function outstanding(){return (Math.round(balance.pagado*100)-Math.round(balance.repuesto*100))/100;}
function movements(){
  const expenses=entries.filter(r=>r[5]==='Admin2').map(r=>({fecha:r[0],tipo:'Pagado por Admin2',detalle:r[1],monto:r[2]}));
  const payments=balance.movimientos.map(r=>({id:r.id,fecha:r.fecha,tipo:'Reposición',detalle:r.referencia,monto:r.monto,esReposicion:true}));
  return expenses.concat(payments).sort((a,b)=>a.fecha.localeCompare(b.fecha));
}
function montoCorreccion(value){
  const texto=value.trim();
  return /^\d+(?:[.,]\d{1,2})?$/.test(texto)?Number(texto.replace(',','.')):NaN;
}
function editarReposicion(movimiento){
  const panel=document.createElement('details');
  const toggle=document.createElement('summary');
  toggle.textContent='Corregir reposición';
  const editor=document.createElement('form');
  editor.className='gasto-editar-reposicion';
  const etiquetaMonto=document.createElement('label'), monto=document.createElement('input');
  etiquetaMonto.textContent='Monto correcto en USD';
  monto.type='text';
  monto.inputMode='decimal';
  monto.required=true;
  monto.value=String(movimiento.monto);
  etiquetaMonto.append(monto);
  const etiquetaReferencia=document.createElement('label'), referencia=document.createElement('input');
  etiquetaReferencia.textContent='Referencia (opcional)';
  referencia.maxLength=160;
  referencia.value=movimiento.detalle;
  etiquetaReferencia.append(referencia);
  const guardar=document.createElement('button');
  guardar.type='submit';
  guardar.textContent='Guardar corrección';
  const estado=document.createElement('small');
  estado.setAttribute('role','status');
  editor.append(etiquetaMonto,etiquetaReferencia,guardar,estado);
  panel.append(toggle,editor);
  editor.onsubmit=async event=>{
    event.preventDefault();
    const session=bossSession;
    if(guardar.disabled||session?.usuario!=='Admin')return;
    const importe=montoCorreccion(monto.value);
    if(!(importe>0 && importe<1e12)){
      estado.textContent='Escribe el monto sin separador de miles. Usa coma o punto para hasta dos decimales.';
      monto.focus();
      return;
    }
    estado.textContent='';
    guardar.disabled=monto.disabled=referencia.disabled=true;
    try{
      await requestProduction(session,{
        accion:'gastos_corregir_reposicion',id:movimiento.id,monto:importe,referencia:referencia.value.trim(),
        montoAnterior:Number(movimiento.monto),referenciaAnterior:movimiento.detalle,
      });
      if(session!==bossSession)return;
      if(await load())by('status').textContent='Reposición corregida. '+by('status').textContent;
    }catch(error){
      if(session===bossSession)estado.textContent=error.message;
    }finally{
      guardar.disabled=monto.disabled=referencia.disabled=false;
    }
  };
  return panel;
}
function drawBalance(){
  const saldo=outstanding(), box=by('mov');
  const pendiente=document.createElement('strong');
  pendiente.className='gasto-saldo-pendiente';
  if(saldo>0)pendiente.classList.add('gasto-saldo-por-reponer');
  pendiente.textContent='Pendiente por reponer a Admin 2 · '+fmt(saldo);
  const totales=document.createElement('span');
  totales.textContent='Pagado por Admin2 · '+fmt(balance.pagado)+' | Repuesto · '+fmt(balance.repuesto)+(balance.pendientes?' · '+balance.pendientes+' gastos por identificar en total':'');
  by('saldo').replaceChildren(pendiente,totales);
  by('reponer').hidden=bossSession.usuario!=='Admin' || saldo<=0;
  const f=by('pago').elements;
  if(!f.dia.value)f.dia.value=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Caracas'}).format(new Date());
  f.monto.max=saldo;
  const moves=movements();
  if(!moves.length)box.textContent='Sin movimientos en este período.';
  for(const m of moves){
    const line=document.createElement(m.esReposicion?'div':'p');
    line.textContent=[m.fecha,m.tipo,m.detalle,fmt(m.monto)].filter(Boolean).join(' · ');
    if(m.esReposicion){
      line.className='gasto-mov-reposicion';
      if(bossSession.usuario==='Admin'&&m.id)line.append(editarReposicion(m));
    }
    box.append(line);
  }
  for(const r of entries.filter(row=>row[5]==='Por identificar')){
    const line=document.createElement('p'), select=document.createElement('select'), btn=document.createElement('button');
    line.textContent=[r[0],r[1],r[4],fmt(r[2])].join(' · ');
    select.add(new Option('Selecciona quién pagó',''));for(const actor of ['Admin','Admin2'])select.add(new Option(actor,actor));
    btn.type='button';btn.textContent='Guardar pagador';btn.onclick=async()=>{
      if(!select.value)return;
      const session=bossSession;btn.disabled=true;
      try{await requestProduction(session,{accion:'gastos_identificar',id:r[6],pagador:select.value});if(session===bossSession)await load();}
      catch(e){if(session===bossSession)by('status').textContent=e.message;}finally{btn.disabled=false;}
    };
    line.append(select,btn);box.append(line);
  }
}
by('pago').onsubmit=async event=>{
  event.preventDefault();
  const session=bossSession,f=event.target,btn=f.querySelector('button');
  if(btn.disabled||session?.usuario!=='Admin')return;
  const body={fecha:f.elements.dia.value,monto:Number(f.elements.monto.value),referencia:f.elements.ref.value.trim()};
  const key=JSON.stringify(body);
  if(paymentAttempt?.key!==key)paymentAttempt={key,id:crypto.randomUUID()};
  btn.disabled=true;
  try{
    await requestProduction(session,{accion:'gastos_reponer',id:paymentAttempt.id,...body});
    if(session!==bossSession)return;
    paymentAttempt=null;f.reset();by('reponer').open=false;
    if(await load())by('status').textContent='Reposición guardada. '+by('status').textContent;
  }catch(e){if(session===bossSession)by('status').textContent=e.message;}finally{btn.disabled=false;}
};
function exportExpenses(){
  const date=by('date');
  if(!date.reportValidity())return;
  const mode=document.querySelector('input[name="gasto-periodo"]:checked').value;
  const [start,end]=bounds(date.value,mode);
  const rows=entries.filter(([day])=>day>=start&&day<=end).sort((a,b)=>a[0].localeCompare(b[0]));
  const consumables=['Aceites','Mangueras','Filtros'];
  const category=item=>consumables.includes(item[3])?'Consumibles':item[3];
  const amount=items=>items.reduce((sum,item)=>sum+Math.round(item[2]*100),0)/100;
  const summary=[['Partida','Monto (USD)','Desde','Hasta']];
  for(const name of ['Nómina','Repuestos','Consumibles','Oficina','Comida','Operacionales'])
    summary.push([name,amount(rows.filter(row=>category(row)===name)),start,end]);
  summary.push(['Total del período',amount(rows),start,end]);
  const detail=[['Fecha','Partida','Tipo de consumible','Concepto','Unidad o destino','Monto (USD)','Pagador']];
  for(const row of rows)detail.push([row[0],category(row),consumables.includes(row[3])?row[3]:'',row[1],row[4]||'Nómina',row[2],row[5]||'']);
  const destinations=[['Unidad o destino','Monto (USD)']];
  for(const name of new Set(rows.map(r=>r[4]||'Nómina'))){
    const items=rows.filter(row=>(row[4]||'Nómina')===name);
    if(items.length)destinations.push([name,amount(items)]);
  }
  const ledger=[['Concepto acumulado','USD'],['Pagado por Admin2',balance.pagado],['Repuesto por Admin',balance.repuesto],['Pendiente',outstanding()],[],['Fecha','Movimiento del período','Referencia o concepto','Monto (USD)']];
  for(const m of movements())ledger.push([m.fecha,m.tipo,m.detalle,m.monto]);
  const blob=xlsx([{name:'Resumen',rows:summary},{name:'Detalle',rows:detail},{name:'Por destino',rows:destinations},{name:'Reposiciones',rows:ledger}]);
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download='BossMetal_Gastos_'+start+'_'+end+'.xlsx';
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
by('exportar').onclick=exportExpenses;
window.resetGastos=()=>{
  clearBalance();by('pago').reset();by('reponer').open=false;paymentAttempt=null;
  version++;entries=[];pending=null;form.reset();form.hidden=true;
  by('groups').replaceChildren();by('total').textContent='';by('period').textContent='';
  by('status').textContent='';by('date').value='';$('gastos-tab').hidden=true;
};
async function load(){
  const session=bossSession,seq=++version;
  if(!isBossAdmin(session))return false;
  if(!by('date').value)by('date').value=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Caracas'}).format(new Date());
  const date=by('date').value,mode=document.querySelector('input[name="gasto-periodo"]:checked').value;
  const [desde,hasta]=bounds(date,mode);
  clearBalance();by('exportar').disabled=true;by('status').textContent='Consultando gastos y nómina…';
  by('groups').replaceChildren();by('period').textContent='';by('total').textContent='…';
  const selector=by('destinos'), previous=selector.value;
  const destinos=new Set(['General',...E.map(e=>'Unidad '+e.id+' · '+e.name),...availabilityExtra.map(e=>normalizarDestino(e.nombre))]);
  selector.replaceChildren(...Array.from(destinos,n=>new Option(n,n)),new Option('Otro vehículo o equipo…','__otro'));
  if(previous && (destinos.has(previous)||previous==='__otro'))selector.value=previous;
  mostrarOtro();
  try{
    const dates=[desde];
    if(desde.slice(-2)<='15' && hasta.slice(-2)>'15')dates.push(desde.slice(0,8)+'16');
    const reports=await Promise.all(dates.map(fecha=>requestProduction(session,{accion:'nomina_resumen',fecha})));
    const {saldo}=await requestProduction(session,{accion:'gastos_saldo',desde,hasta});
    const rows=[];let offset=0;
    for(;;){
      const {gastos}=await requestProduction(session,{accion:'gastos_listar',desde,hasta,offset});
      for(const g of gastos)rows.push([g.fecha,g.concepto,Number(g.monto),g.partida,normalizarDestino(g.destino),g.pagador||'Por identificar',g.id]);
      if(gastos.length<500)break;
      offset+=gastos.length;
    }
    let incomplete=false;
    for(const report of reports){
      const day=mode==='Día'?date:null;
      for(const row of window.filasNominaParaGastos(report,day)){
        if(row.pending)incomplete=true;
        if(row.pay)rows.push([day||report.desde,row.w.nombre+(day?'':' · '+report.desde+' al '+report.hasta),row.pay,'Nómina','']);
      }
    }
    if(seq!==version || session!==bossSession)return false;
    entries=rows;balance=saldo;draw();drawBalance();by('status').textContent=incomplete?'Nómina con montos pendientes de definir.':'';
    by('exportar').disabled=false;return true;
  }catch(error){if(seq===version)by('status').textContent=error.message;return false;}
}
window.abrirGastos=load;
by('date').onchange=by('mode').onchange=load;
function mostrarOtro(){
  const otro=form.elements.unit.value==='__otro';
  by('otro-label').hidden=!otro;
  form.elements.otro.required=otro;
}
form.elements.unit.onchange=mostrarOtro;
by('add').onclick=()=>{if(form.hidden){form.elements.pagador.value=bossSession.usuario;form.elements.day.value=by('date').value;form.elements.unit.value='General';mostrarOtro();}form.hidden=false;form.scrollIntoView();};
by('cancel').onclick=()=>{if(!saving){form.reset();form.hidden=true;pending=null;}};
form.onsubmit=async event=>{
  event.preventDefault();if(saving || !isBossAdmin(bossSession))return;
  const session=bossSession,f=form.elements;
  const data={pagador:f.pagador.value,fecha:f.day.value,concepto:f.concept.value.trim(),monto:Number(f.amount.value),partida:f.cat.value,destino:normalizarDestino((f.unit.value==='__otro'?f.otro.value:f.unit.value).trim())};
  const key=JSON.stringify(data);
  if(!pending || key!==pending.key)pending={key,id:crypto.randomUUID()};
  saving=true;const controls=[...form.elements];controls.forEach(c=>c.disabled=true);
  try{
    await requestProduction(session,{accion:'gastos_guardar',id:pending.id,...data});
    if(bossSession!==session)return;
    pending=null;form.reset();form.hidden=true;by('date').value=data.fecha;
    if(await load())by('status').textContent='Gasto guardado. '+by('status').textContent;
  }catch(error){if(bossSession===session)by('status').textContent=error.message;}
  finally{saving=false;controls.forEach(c=>c.disabled=false);}
};
})();
