(() => {
const by=id=>document.getElementById('gasto-'+id);
const fmt=n=>new Intl.NumberFormat('es-VE',{style:'currency',currency:'USD'}).format(n);
let entries=[],version=0,pending=null,saving=false;
const form=by('form');
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
function detail(parent,items){for(const [day,concept,value,,unit] of items){const line=document.createElement('small');line.textContent=[display(day),concept,unit,fmt(value)].filter(Boolean).join(' · ');parent.append(line)}if(!items.length)parent.append('Sin gastos en este período.')}
const cat=section('Resumen por partida');for(const name of ['Nómina','Repuestos','Consumibles','Oficina','Comida','Operacionales']){const cons=['Aceites','Mangueras','Filtros'],items=rows.filter(r=>name==='Consumibles'?cons.includes(r[3]):r[3]===name),g=group(cat,name,items);if(name==='Consumibles'){for(const c of cons){const part=items.filter(r=>r[3]===c);detail(group(g,c,part),part)}}else detail(g,items)}
const eq=section('Por unidad o equipo'),assigned=rows.filter(r=>r[4] && r[4]!=='General');for(const u of new Set(assigned.map(r=>r[4]))){const items=assigned.filter(r=>r[4]===u);detail(group(eq,u,items),items)}if(!assigned.length)eq.append('Sin gastos asignados.');const general=rows.filter(r=>r[4]==='General');detail(group(section('Gastos generales'),'General',general),general)}
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
  const detail=[['Fecha','Partida','Tipo de consumible','Concepto','Unidad o destino','Monto (USD)']];
  for(const row of rows)detail.push([row[0],category(row),consumables.includes(row[3])?row[3]:'',row[1],row[4]||'Nómina',row[2]]);
  const destinations=[['Unidad o destino','Monto (USD)']];
  for(const name of new Set(rows.map(r=>r[4]||'Nómina'))){
    const items=rows.filter(row=>(row[4]||'Nómina')===name);
    if(items.length)destinations.push([name,amount(items)]);
  }
  const blob=xlsx([{name:'Resumen',rows:summary},{name:'Detalle',rows:detail},{name:'Por destino',rows:destinations}]);
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download='BossMetal_Gastos_'+start+'_'+end+'.xlsx';
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
by('exportar').onclick=exportExpenses;
window.resetGastos=()=>{
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
  by('exportar').disabled=true;by('status').textContent='Consultando gastos y nómina…';
  by('groups').replaceChildren();by('period').textContent='';by('total').textContent='…';
  const selector=by('destinos'), previous=selector.value;
  const destinos=new Set(['General',...E.map(e=>'Unidad '+e.id+' · '+e.name),...availabilityExtra.map(e=>e.nombre)]);
  selector.replaceChildren(...Array.from(destinos,n=>new Option(n,n)),new Option('Otro vehículo o equipo…','__otro'));
  if(previous && (destinos.has(previous)||previous==='__otro'))selector.value=previous;
  mostrarOtro();
  try{
    const dates=[desde];
    if(desde.slice(-2)<='15' && hasta.slice(-2)>'15')dates.push(desde.slice(0,8)+'16');
    const reports=await Promise.all(dates.map(fecha=>requestProduction(session,{accion:'nomina_resumen',fecha})));
    const rows=[];let offset=0;
    for(;;){
      const {gastos}=await requestProduction(session,{accion:'gastos_listar',desde,hasta,offset});
      for(const g of gastos)rows.push([g.fecha,g.concepto,Number(g.monto),g.partida,g.destino]);
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
    entries=rows;draw();by('status').textContent=incomplete?'Nómina con montos pendientes de definir.':'';
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
by('add').onclick=()=>{if(form.hidden){form.elements.day.value=by('date').value;form.elements.unit.value='General';mostrarOtro();}form.hidden=false;form.scrollIntoView();};
by('cancel').onclick=()=>{if(!saving){form.reset();form.hidden=true;pending=null;}};
form.onsubmit=async event=>{
  event.preventDefault();if(saving || !isBossAdmin(bossSession))return;
  const session=bossSession,f=form.elements;
  const data={fecha:f.day.value,concepto:f.concept.value.trim(),monto:Number(f.amount.value),partida:f.cat.value,destino:(f.unit.value==='__otro'?f.otro.value:f.unit.value).trim()};
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
