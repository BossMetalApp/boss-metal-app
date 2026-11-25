(() => {
  const el = id => document.getElementById('cortes-' + id);
  const text = (tag, value) => Object.assign(document.createElement(tag), {textContent:value});
  const number = new Intl.NumberFormat('es-VE', {minimumFractionDigits:2, maximumFractionDigits:2});
  const money = amount => 'USD ' + number.format(Number(amount));
  const date = day => day.split('-').reverse().join('/');
  const period = (start, end) => start === end ? date(end) : date(start) + ' al ' + date(end);
  const shortPeriod = (start,end) => {
    if (start===end || start.slice(0,7)!==end.slice(0,7)) return period(start,end);
    const endLabel = new Date(end+'T00:00:00Z').toLocaleDateString('es-VE',{day:'2-digit',month:'short',timeZone:'UTC'});
    return start.slice(-2)+'–'+endLabel+' '+end.slice(0,4);
  };
  const decimal = value => /^\d+(?:[.,]\d{1,2})?$/.test(value.trim()) ? Number(value.trim().replace(',','.')) : NaN;
  const creation = el('nuevo'), payment = el('abono');
  let listVersion = 0, quoteVersion = 0, quote = null, open = null, busy = false;
  let cutAttempt, paymentAttempt;

  function status(message) {
    el('estado').textContent = message;
  }

  function invalidateQuote() {
    quoteVersion++;
    quote = null;
    el('cierre').hidden = true;
    el('consulta').textContent = '';
    el('consultar').disabled = false;
  }

  function recalcular() {
    const {aprobadas, tarifa, observacion} = creation.elements;
    const tons = decimal(aprobadas.value), rate = decimal(tarifa.value);
    const scaled = Math.round(tons * 100) * Math.round(rate * 100);
    const amount = Number.isSafeInteger(scaled) && tons > 0 && rate > 0 ? money(Math.round(scaled / 100) / 100) : '—';
    el('importe').textContent = 'Importe del corte · ' + amount;
    observacion.required = !!quote && Number.isFinite(tons) && tons !== quote.toneladas;
  }

  function beginPayment(cut) {
    if (busy) return;
    paymentAttempt = null;
    payment.reset();
    payment.elements.corte.value = cut.id;
    payment.elements.fecha.value = new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Caracas'}).format(new Date());
    el('abono-periodo').textContent = period(cut.desde,cut.hasta) + ' · Pendiente ' + money(cut.pendiente);
    payment.hidden = false;
    payment.elements.monto.focus();
  }

  function cutDetail(cut) {
    const root = document.createElement('div');
    root.className = 'balance-detalle';
    const info = document.createElement('dl');
    for (const [label, value] of [
      ['Toneladas registradas', number.format(cut.toneladas_registradas)+' Ton'],
      ['Toneladas aprobadas', number.format(cut.toneladas_aprobadas)+' Ton'],
      ['Tarifa', money(cut.tarifa)+' por Ton'],
    ]) info.append(text('dt',label),text('dd',value));
    root.append(info);
    if (cut.observacion) root.append(text('p',cut.observacion));
    root.append(text('h4','Abonos del corte'));
    if (!cut.abonos.length) root.append(text('p','Aún no hay abonos.'));
    for (const abono of cut.abonos) {
      root.append(text('p',[date(abono.fecha),abono.referencia,money(abono.monto)].filter(Boolean).join(' · ')));
    }
    if (Number(cut.pendiente)>0) {
      const button = text('button','+ Registrar abono');
      button.type = 'button';
      button.onclick = () => beginPayment(cut);
      root.append(button);
    }
    return root;
  }

  function render(cuts) {
    const rows = el('filas');
    rows.replaceChildren();
    el('tabla').hidden = cuts.length===0;
    for (const cut of cuts) {
      const row = rows.insertRow();
      row.className = 'balance-resumen';
      const summary = row.insertCell();
      const button = text('button',shortPeriod(cut.desde,cut.hasta));
      button.setAttribute('aria-label',period(cut.desde,cut.hasta));
      button.className = 'balance-unidad';
      button.type = 'button';
      summary.append(button);
      const paid = Number(cut.pendiente)===0;
      const label = text('small',paid?'Pagado':Number(cut.abonado)>0?'Abono parcial':'Por cobrar');
      label.className = paid?'cortes-pagado':'cortes-pendiente';
      summary.append(label);
      for (const amount of [cut.importe,cut.abonado,cut.pendiente]) {
        row.insertCell().append(text('strong',number.format(amount)));
      }
      row.lastElementChild.className = label.className;

      const expanded = rows.insertRow();
      expanded.className = 'balance-ampliado';
      expanded.id = 'corte-' + cut.id;
      const cell = expanded.insertCell();
      cell.colSpan = 4;
      cell.append(cutDetail(cut));
      button.setAttribute('aria-controls',expanded.id);
      const refresh = () => {
        expanded.hidden = open!==cut.id;
        button.setAttribute('aria-expanded',String(!expanded.hidden));
      };
      refresh();
      button.onclick = () => {
        const previous = open && document.getElementById('corte-'+open);
        if (previous && previous!==expanded) {
          previous.hidden = true;
          previous.previousElementSibling.querySelector('button').setAttribute('aria-expanded','false');
        }
        open = open===cut.id ? null : cut.id;
        refresh();
      };
    }
  }

  async function load(message = '') {
    const session = bossSession;
    if (session?.usuario!=='Admin') return;
    const token = ++listVersion;
    status('Consultando cortes de acarreo…');
    try {
      const {resultado} = await requestProduction(session,{accion:'cortes_listar'});
      if (token!==listVersion || session!==bossSession) return;
      render(resultado);
      status([message,resultado.length?'':'Aún no hay cortes de acarreo.'].filter(Boolean).join(' '));
    } catch (error) {
      if (token===listVersion && session===bossSession) status(error.message);
    }
  }

  async function save(form, body, attempt, message, afterSave) {
    const session = bossSession;
    if (session?.usuario!=='Admin' || busy) return;
    const key = JSON.stringify(body);
    const id = attempt?.key===key ? attempt.id : crypto.randomUUID();
    if (form===creation) cutAttempt = {key,id};
    else paymentAttempt = {key,id};
    busy = true;
    const controls = [...form.elements].filter(control => !control.disabled);
    controls.forEach(control => {control.disabled = true;});
    el(form===creation?'consulta':'abono-estado').textContent = 'Guardando…';
    try {
      await requestProduction(session,{...body,id});
      if (session!==bossSession) return;
      afterSave(id);
      form.hidden = true;
      form.reset();
      await load(message);
    } catch (error) {
      if (session===bossSession) el(form===creation?'consulta':'abono-estado').textContent = error.message;
    } finally {
      busy = false;
      controls.forEach(control => {control.disabled = false;});
    }
  }

  el('agregar').onclick = () => {
    if (busy || !creation.hidden) return;
    cutAttempt = null;
    creation.reset();
    invalidateQuote();
    const baseDate = document.getElementById('balance-fecha').value;
    if (baseDate) {
      const [desde,hasta] = window.bossGastos.periodo(baseDate,document.getElementById('balance-modo').value);
      creation.elements.desde.value = desde;
      creation.elements.hasta.value = hasta;
    }
    creation.hidden = false;
    creation.elements.desde.focus();
  };
  creation.elements.desde.oninput = creation.elements.hasta.oninput = invalidateQuote;
  creation.elements.aprobadas.oninput = creation.elements.tarifa.oninput = recalcular;
  el('consultar').onclick = async () => {
    const session = bossSession;
    if (session?.usuario!=='Admin' || busy) return;
    const {desde,hasta,aprobadas,tarifa} = creation.elements;
    if (!desde.reportValidity() || !hasta.reportValidity()) return;
    if (desde.value>hasta.value) {
      el('consulta').textContent = 'La fecha final debe ser igual o posterior a la inicial.';
      return;
    }
    const previous = quote;
    invalidateQuote();
    const token = quoteVersion;
    const query = {desde:desde.value,hasta:hasta.value};
    el('consultar').disabled = true;
    el('consulta').textContent = 'Consultando toneladas…';
    try {
      const {resultado} = await requestProduction(session,{accion:'cortes_consultar',...query});
      if (token!==quoteVersion || session!==bossSession) return;
      if (previous?.desde!==query.desde || previous?.hasta!==query.hasta) {
        aprobadas.value = resultado.toneladas;
        tarifa.value = Number(resultado.tarifa).toFixed(2).replace('.',',');
      } else if (decimal(aprobadas.value)===previous.toneladas) {
        aprobadas.value = resultado.toneladas;
      }
      quote = {...query,toneladas:Number(resultado.toneladas)};
      el('registradas').textContent = number.format(quote.toneladas)+' Ton';
      el('cierre').hidden = false;
      el('consulta').textContent = '';
      recalcular();
    } catch (error) {
      if (token===quoteVersion && session===bossSession) el('consulta').textContent = error.message;
    } finally {
      if (token===quoteVersion && session===bossSession) el('consultar').disabled = false;
    }
  };
  creation.onsubmit = event => {
    event.preventDefault();
    if (!quote || busy) return;
    const {aprobadas,tarifa,observacion} = creation.elements;
    if (!(decimal(aprobadas.value)>0 && decimal(tarifa.value)>0)) {
      el('consulta').textContent = 'Ingresa toneladas y tarifa mayores a cero, con hasta dos decimales.';
      return;
    }
    return save(creation,{accion:'cortes_cerrar',desde:quote.desde,hasta:quote.hasta,registradas:quote.toneladas,
      aprobadas:decimal(aprobadas.value),tarifa:decimal(tarifa.value),observacion:observacion.value.trim()},
    cutAttempt,'Corte cerrado.',id => {open = id;cutAttempt = null;invalidateQuote();});
  };
  payment.onsubmit = event => {
    event.preventDefault();
    if (busy) return;
    const {corte,fecha,monto,referencia} = payment.elements;
    if (!(decimal(monto.value)>0)) {
      el('abono-estado').textContent = 'Ingresa un monto positivo con hasta dos decimales.';
      return;
    }
    return save(payment,{accion:'cortes_abonar',corte:corte.value,fecha:fecha.value,monto:decimal(monto.value),referencia:referencia.value.trim()},
      paymentAttempt,'Abono registrado.',() => {open = corte.value;paymentAttempt = null;el('abono-estado').textContent = '';});
  };
  el('cancelar-corte').onclick = () => {
    if (busy) return;
    creation.hidden = true;
    invalidateQuote();
  };
  el('cancelar-abono').onclick = () => {
    if (busy) return;
    payment.hidden = true;
    el('abono-estado').textContent = '';
  };
  window.cargarCortesAcarreo = () => load();
  window.resetCortesAcarreo = () => {
    listVersion++;
    cutAttempt = paymentAttempt = open = null;
    for (const form of [creation,payment]) {
      form.reset();
      form.hidden = true;
    }
    invalidateQuote();
    el('abono-estado').textContent = '';
    el('filas').replaceChildren();
    el('tabla').hidden = true;
    status('');
  };
})();
