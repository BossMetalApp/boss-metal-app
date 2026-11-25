(() => {
  const el = id => document.getElementById('mant-' + id);
  const text = (tag, value) => Object.assign(document.createElement(tag), {textContent:value});
  const button = (label, action) => Object.assign(text('button',label), {type:'button',onclick:action});
  const time = new Intl.DateTimeFormat('es-VE',{
    dateStyle:'medium',timeStyle:'short',timeZone:'America/Caracas',
  });
  const stamp = value => time.format(new Date(value));
  const dateLabel = value => value.split('-').reverse().join('/');
  const today = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Caracas'}).format(new Date());
  const meterUnit = key => key.startsWith('equipo:') ? 'h' : 'km';
  const form = el('form'), fields = form.elements;
  const filter = el('filtro');
  const pageSize = 20;
  const vehicles = [
    ['vehiculo:x1','X1'],
    ['vehiculo:van-transporte','Van Transporte'],
    ['vehiculo:orinoco','Orinoco'],
    ['vehiculo:mitsubishi-l200','Mitsubishi L200'],
  ];
  let selected, mode, request = 0, lookup = 0, timer, attempt, saving = false, offset = null;
  let equipment = new Map();

  function catalog(reported) {
    return new Map([
      ...[...DEFAULT_E,...E].map(item => ['acarreo:'+item.id,item.name]),
      ...availabilityExtra.map(item => [item.clave,item.nombre]),
      ...reported.map(item => [item.clave,item.nombre]),
      ...vehicles,
    ]);
  }

  function equipmentName(key, name) {
    return key.startsWith('acarreo:') ? etiquetaUnidad(key.slice(8),name) : name;
  }

  function equipmentOptions(includeGroup=false) {
    const options = [];
    const group = document.createElement('optgroup');
    group.label = 'Vehículos';
    if (includeGroup) group.append(new Option('Todos los vehículos','vehiculos'));
    for (const [key,name] of equipment) {
      const option = new Option(equipmentName(key,name),key);
      if (key.startsWith('vehiculo:')) group.append(option);
      else options.push(option);
    }
    return [...options,group];
  }

  function fillEquipment() {
    const current = filter.value;
    filter.replaceChildren(new Option('Todos los equipos',''),...equipmentOptions(true));
    filter.value = current==='vehiculos' || equipment.has(current) ? current : '';
  }

  function elapsed(start, end) {
    const minutes = Math.max(0, Math.floor((end-new Date(start))/60000));
    const days = Math.floor(minutes/1440), hours = Math.floor(minutes/60)%24, rest = minutes%60;
    if (minutes===0) return 'Menos de 1 min';
    return [days?days+' d':'',hours?hours+' h':'',rest?rest+' min':''].filter(Boolean).join(' ');
  }

  function eventLine(item) {
    const line = document.createElement('div');
    line.className = 'mant-evento';
    line.append(text('strong',stamp(item.fecha)),text('span',item.actor));
    const detail = [item.tipo, item.tipo==='Novedad' ? item.etapa : null, item.nota].filter(Boolean).join(' · ');
    line.append(text('p',detail));
    if (item.repuesto) {
      line.append(text('p',['Solicitud vinculada',item.repuesto,item.estado_solicitud].filter(Boolean).join(' · ')));
    }
    return line;
  }

  function timeline(incident, compact) {
    const content = document.createElement('div');
    const recent = compact ? incident.eventos.slice(0,2) : incident.eventos;
    for (const event of recent) content.append(eventLine(event));
    if (compact && incident.eventos.length>2) {
      const older = document.createElement('details');
      older.className = 'mant-mas-eventos';
      older.append(text('summary','Ver novedades anteriores'),...incident.eventos.slice(2).map(eventLine));
      content.append(older);
    }
    return content;
  }

  function serviceDetails(incident, node) {
    if (!incident.preventivo) return;
    const parts = ['Preventivo',dateLabel(incident.fecha_servicio)];
    if (incident.lectura!==null) parts.push(incident.lectura+' '+meterUnit(incident.equipo));
    if (incident.proxima_revision) parts.push('Próxima revisión '+dateLabel(incident.proxima_revision));
    node.append(text('p',parts.join(' · ')));
  }

  function drawOpen(incidents) {
    const box = el('abiertas');
    box.replaceChildren();
    if (!incidents.length) box.append(text('p','Sin incidencias abiertas.'));
    for (const incident of incidents) {
      const card = document.createElement('article');
      card.className = 'card mant-incidencia';
      const heading = document.createElement('div');
      heading.className = 'mant-fila';
      const unavailable = text('span',incident.preventivo?'En mantenimiento':'Fuera de servicio');
      unavailable.className = 'mant-badge '+(incident.preventivo?'mant-etapa':'mant-fuera');
      heading.append(text('h3',equipmentName(incident.equipo,incident.nombre)),unavailable);
      const stage = text('span',incident.pendiente_detalle?'Pendiente de completar':incident.etapa);
      stage.className = 'mant-badge mant-etapa';
      const update = incident.pendiente_detalle
        ? button('Completar incidencia',() => showForm('reportar',incident))
        : button('Agregar novedad',() => showForm('novedad',incident));
      update.className = 'secondary';
      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.append(update,button('Marcar operativo',() => showForm('cerrar',incident)));
      card.append(heading,text('h4',incident.falla),text('p','Desde el '+stamp(incident.abierto_en)));
      if (incident.preventivo) serviceDetails(incident,card);
      if (!incident.preventivo || incident.etapa!=='Reportada') card.append(stage);
      card.append(timeline(incident,true),actions);
      box.append(card);
    }
  }

  function drawHistory(incidents, append) {
    const box = el('historial-lista');
    if (!append) box.replaceChildren();
    if (!append && !incidents.length) box.append(text('p','Sin reparaciones registradas para esta selección.'));
    for (const incident of incidents) {
      const card = document.createElement('details');
      card.className = 'mant-reparacion';
      const heading = document.createElement('summary');
      const label = document.createElement('span');
      label.append(text('strong',equipmentName(incident.equipo,incident.nombre)),
        text('small',(incident.preventivo?'Preventivo · ':'')+incident.falla));
      heading.append(label,text('small',incident.preventivo?dateLabel(incident.fecha_servicio):stamp(incident.cerrado_en)));
      card.append(heading);
      serviceDetails(incident,card);
      if (!incident.preventivo || incident.cerrado_en!==incident.abierto_en) {
        const kind = incident.preventivo?'En mantenimiento':'Fuera de servicio';
        card.append(text('p','Desde '+stamp(incident.abierto_en)+' · '+kind+' '+elapsed(incident.abierto_en,new Date(incident.cerrado_en))));
      }
      card.append(timeline(incident,false));
      box.append(card);
    }
  }

  async function load(message='', next=false) {
    const session = bossSession;
    if (!session || (next && offset===null)) return false;
    const token = ++request, page = next ? offset : 0;
    el('mas').disabled = true;
    el('estado').textContent = 'Consultando mantenimiento…';
    try {
      const {resultado} = await requestProduction(session,{accion:'mantenimiento_listar',equipo:filter.value,offset:page});
      if (token!==request || session!==bossSession) return false;
      equipment = catalog(resultado.equipos);
      fillEquipment();
      const closed = resultado.incidencias.filter(incident => incident.cerrado_en);
      if (!next) drawOpen(resultado.incidencias.filter(incident => !incident.cerrado_en));
      drawHistory(closed.slice(0,pageSize),next);
      offset = closed.length>pageSize ? page+pageSize : null;
      el('mas').hidden = offset===null;
      el('estado').textContent = message;
      return true;
    } catch (error) {
      if (token===request && session===bossSession) el('estado').textContent = error.message;
      return false;
    } finally {
      if (token===request && session===bossSession) el('mas').disabled = false;
    }
  }

  function closeForm() {
    lookup++;
    clearTimeout(timer);
    selected = mode = attempt = null;
    form.reset();
    form.hidden = true;
    el('form-estado').textContent = '';
    el('solicitudes-estado').textContent = '';
  }

  async function loadRequests() {
    const session = bossSession;
    if (!session || !selected || mode!=='novedad') return;
    const token = ++lookup;
    const previous = fields.solicitud.value;
    el('solicitudes-estado').textContent = 'Consultando solicitudes…';
    try {
      const {resultado} = await requestProduction(session,{
        accion:'mantenimiento_solicitudes',equipo:selected.equipo,buscar:fields.buscar.value.trim(),
      });
      if (token!==lookup || session!==bossSession) return;
      fields.solicitud.replaceChildren(new Option('Sin vincular',''),...resultado.map(item =>
        new Option(item.descripcion+' · '+item.estado,item.id)));
      if (resultado.some(item=>item.id===previous)) fields.solicitud.value = previous;
      el('solicitudes-estado').textContent = resultado.length ? '' : 'No se encontraron solicitudes de este equipo.';
    } catch (error) {
      if (token===lookup && session===bossSession) el('solicitudes-estado').textContent = error.message;
    }
  }

  function showForm(action, incident=null) {
    if (saving) return;
    closeForm();
    mode = action;
    selected = incident;
    const reporting = mode==='reportar', updating = mode==='novedad', preventive = mode==='preventivo';
    const creating = reporting || preventive;
    fields.equipo.replaceChildren(new Option('Seleccionar',''),...equipmentOptions());
    fields.equipo.value = incident?.equipo ?? (equipment.has(filter.value) ? filter.value : '');
    fields.equipo.required = creating && !incident;
    fields.falla.required = creating;
    fields.fecha_servicio.required = preventive;
    el('equipo-campo').hidden = !!incident;
    el('falla-rotulo').textContent = preventive?'Trabajo realizado':'Falla';
    el('falla-campos').hidden = !creating;
    el('preventivo-campos').hidden = !preventive;
    el('novedad-campos').hidden = !updating;
    if (preventive) {
      fields.fecha_servicio.value = fields.fecha_servicio.max = today();
      updateMeter();
    }
    fields.solicitud.replaceChildren(new Option('Sin vincular',''));
    const title = preventive ? 'Registrar mantenimiento preventivo'
      : reporting ? (incident?'Completar incidencia':'Reportar falla')
      : updating ? 'Agregar novedad' : 'Marcar operativo';
    el('form-titulo').textContent = title;
    el('form-equipo').textContent = incident ? equipmentName(incident.equipo,incident.nombre) : '';
    el('guardar').textContent = mode==='cerrar' ? 'Marcar operativo' : 'Guardar';
    form.hidden = false;
    if (updating) loadRequests();
    (creating ? (incident?fields.falla:fields.equipo) : fields.nota).focus();
  }

  function updateMeter() {
    const key = fields.equipo.value;
    el('medidor-rotulo').textContent = key && meterUnit(key)==='h'?'Horómetro (h)':'Kilometraje (km)';
  }
  fields.equipo.onchange = updateMeter;

  form.onsubmit = async event => {
    event.preventDefault();
    const session = bossSession;
    if (!session || !mode || saving) return;
    const action = mode;
    const body = {accion:'mantenimiento_'+action,equipo:selected?.equipo ?? fields.equipo.value,nota:fields.nota.value.trim()};
    if (action==='reportar' || action==='preventivo') {
      Object.assign(body,{nombre:equipment.get(body.equipo),falla:fields.falla.value.trim()});
    } else body.incidencia = selected.id;
    if (action==='preventivo') {
      Object.assign(body,{fecha_servicio:fields.fecha_servicio.value,lectura:fields.lectura.value || null,
        proxima_revision:fields.proxima_revision.value || null,detener:fields.detener.checked});
    }
    if (action==='novedad') Object.assign(body,{etapa:fields.etapa.value,solicitud:fields.solicitud.value || null});
    if (action==='novedad' && !body.nota && !body.etapa && !body.solicitud) {
      el('form-estado').textContent = 'Indica una novedad, un estado o una solicitud.';
      return;
    }
    const key = JSON.stringify(body);
    if (attempt?.key!==key) attempt = {key,id:crypto.randomUUID()};
    saving = true;
    const controls = [...fields];
    controls.forEach(control => {control.disabled = true;});
    el('form-estado').textContent = 'Guardando…';
    try {
      await requestProduction(session,{...body,id:attempt.id});
      if (session!==bossSession) return;
      closeForm();
      const messages={cerrar:'Registro cerrado. Equipo operativo.',reportar:'Falla registrada.',
        preventivo:'Mantenimiento preventivo registrado.',novedad:'Novedad guardada.'};
      await load(messages[action]);
    } catch (error) {
      if (session===bossSession) el('form-estado').textContent = error.message;
    } finally {
      saving = false;
      controls.forEach(control => {control.disabled = false;});
    }
  };

  fields.buscar.oninput = () => {
    lookup++;
    clearTimeout(timer);
    timer = setTimeout(loadRequests,250);
  };
  filter.onchange = () => {
    if (!saving) closeForm();
    offset = null;
    el('mas').hidden = true;
    el('abiertas').replaceChildren();
    el('historial-lista').replaceChildren();
    return load();
  };
  el('reportar').onclick = () => showForm('reportar');
  el('preventivo').onclick = () => showForm('preventivo');
  el('cancelar').onclick = () => {if (!saving) closeForm();};
  el('mas').onclick = () => load('',true);
  window.abrirMantenimiento = () => {
    if (equipment.size===0) {
      equipment = catalog([]);
      fillEquipment();
    }
    filter.value = '';
    return load();
  };
  window.actualizarMantenimiento = () => load();
  window.resetMantenimiento = () => {
    request++;
    closeForm();
    offset = null;
    equipment.clear();
    for (const id of ['abiertas','historial-lista','estado']) el(id).replaceChildren();
    filter.value = '';
    el('historial').open = false;
    el('mas').hidden = true;
  };
})();
