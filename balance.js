(() => {
  const el = id => document.getElementById('balance-' + id);
  const currency = new Intl.NumberFormat('es-VE', {style:'currency', currency:'USD'});
  const number = new Intl.NumberFormat('es-VE', {maximumFractionDigits:2});
  const cents = value => Math.round(Number(value) * 100);
  const money = value => currency.format(value / 100);
  const dateLabel = date => date.split('-').reverse().join('/');
  const todayCaracas = () => new Intl.DateTimeFormat('sv-SE', {timeZone:'America/Caracas'}).format(new Date());
  const normalize = value => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const text = (tag, value) => Object.assign(document.createElement(tag), {textContent:value});
  const form = el('form');
  let sequence = 0, attempt = null, saving = false;

  function buildRows(data, payroll, day) {
    const rows = new Map();
    const general = {nombre:'Gastos generales', gastos:[], monto:0};
    function add(key, nombre, extra = {}) {
      const row = {nombre, gastos:[], monto:0, ...extra};
      rows.set(key, row);
      return row;
    }
    const units = new Map([...DEFAULT_E, ...E].map(unit => [String(unit.id), unit.name]));
    for (const [id, name] of units) add('acarreo:' + id, 'Unidad ' + id + ' · ' + name, {acarreo:true});
    for (const item of data.acarreo) {
      const key = 'acarreo:' + item.unidad;
      const row = rows.get(key) ?? add(key, 'Unidad ' + item.unidad + ' · ' + item.equipo, {acarreo:true});
      row.toneladas = Number(item.toneladas);
      row.viajes = Number(item.viajes);
      row.monto = cents(item.monto);
    }
    const equipment = new Map();
    for (const item of availabilityExtra) {
      const row = add(item.clave, item.nombre, {equipo:item.clave, trabajos:[]});
      equipment.set(normalize(item.nombre), row);
    }
    for (const item of data.trabajos) {
      const row = rows.get(item.equipo);
      row.trabajos.push(item);
      row.monto += cents(item.monto);
    }
    function assigned(destination) {
      const name = window.bossGastos.normalizarDestino(destination ?? '').trim();
      const normalized = normalize(name);
      if (!normalized || normalized === 'general') return general;
      const unit = /^unidad\s+([a-z0-9-]+)(?:\s*[·•-]|$)/i.exec(name);
      const key = unit ? 'acarreo:' + unit[1] : 'destino:' + normalized;
      return equipment.get(normalized) ?? rows.get(key) ?? add(key, name, {acarreo:!!unit});
    }
    for (const expense of data.gastos) assigned(expense.destino).gastos.push(expense);
    let incomplete = false;
    for (const report of payroll) {
      for (const line of window.filasNominaParaGastos(report, day)) {
        if (line.pending) incomplete = true;
        if (line.fixed) {
          if (line.pay) general.gastos.push({
            fecha:day ?? report.desde, concepto:line.w.nombre, monto:line.pay, partida:'Nómina fija',
          });
          continue;
        }
        for (const shift of line.rows) {
          if (!Number(shift.monto)) continue;
          const row = equipment.get(normalize(shift.equipo ?? '')) ?? general;
          row.gastos.push({fecha:shift.fecha, concepto:line.w.nombre + ' · ' + shift.turno, monto:shift.monto, partida:'Nómina'});
        }
      }
    }
    rows.set('general', general);
    for (const row of rows.values()) {
      row.gastos.sort((a,b) => a.fecha.localeCompare(b.fecha));
      row.costo = row.gastos.reduce((sum, expense) => sum + cents(expense.monto), 0);
    }
    return {rows, incomplete};
  }

  function startEntry(row) {
    if (saving) return;
    attempt = null;
    form.reset();
    form.elements.equipo.value = row.equipo;
    form.elements.fecha.value = el('fecha').value;
    el('equipo').textContent = row.nombre;
    el('form-estado').textContent = '';
    form.hidden = false;
    form.elements.monto.focus();
  }

  function detail(row, rate) {
    const root = document.createElement('div');
    root.className = 'balance-detalle';
    if (row.acarreo) root.append(text('p', number.format(row.viajes ?? 0) + ' viajes · ' +
      number.format(row.toneladas ?? 0) + ' t · ' + money(cents(rate)) + ' por tonelada'));
    if (row.equipo) {
      const register = text('button', 'Registrar producción');
      register.type = 'button';
      register.onclick = () => startEntry(row);
      root.append(register);
      if (row.trabajos.length) {
        root.append(text('h4','Trabajos registrados'));
        const list = document.createElement('ul');
        for (const job of row.trabajos) list.append(text('li', [dateLabel(job.fecha), job.concepto, money(cents(job.monto))].filter(Boolean).join(' · ')));
        root.append(list);
      }
    }
    root.append(text('h4', 'Gastos'));
    if (row.gastos.length) {
      const list = document.createElement('ul');
      for (const expense of row.gastos) list.append(text('li', [dateLabel(expense.fecha), expense.partida, expense.concepto, money(cents(expense.monto))].filter(Boolean).join(' · ')));
      root.append(list);
    } else {
      root.append(text('p', 'Sin gastos en este período.'));
    }
    return root;
  }

  function render(rows, rate) {
    const table = el('filas');
    const opened = new Set([...table.querySelectorAll('button[aria-expanded="true"]')].map(button => button.dataset.key));
    table.replaceChildren();
    let production = 0, expenses = 0;
    for (const [key, row] of rows) {
      production += row.monto;
      expenses += row.costo;
      const summary = table.insertRow();
      const unit = summary.insertCell();
      const button = text('button', row.nombre);
      button.type = 'button';
      button.className = 'balance-unidad';
      button.dataset.key = key;
      unit.append(button);
      const value = summary.insertCell();
      value.append(text('strong', money(row.monto)));
      if (row.acarreo) value.append(text('small', number.format(row.toneladas ?? 0) + ' t'));
      summary.insertCell().textContent = money(row.costo);
      const balance = summary.insertCell();
      balance.textContent = money(row.monto - row.costo);
      if (row.monto < row.costo) balance.className = 'balance-negativo';
      const expanded = table.insertRow();
      const cell = expanded.insertCell();
      cell.colSpan = 4;
      cell.append(detail(row, rate));
      expanded.hidden = !opened.has(key);
      button.setAttribute('aria-expanded', String(!expanded.hidden));
      button.onclick = () => {
        expanded.hidden = !expanded.hidden;
        button.setAttribute('aria-expanded', String(!expanded.hidden));
      };
    }
    const totals = el('totales');
    totals.replaceChildren(...[production, expenses, production - expenses].map(value => text('td', money(value))));
    totals.prepend(text('th', 'Total de la operación'));
  }

  async function load(openEquipment) {
    const session = bossSession;
    if (session?.usuario !== 'Admin') return false;
    const seq = ++sequence;
    const status = el('estado');
    const date = el('fecha'), mode = el('modo').value;
    if (!date.value) date.value = todayCaracas();
    const [desde, hasta] = window.bossGastos.periodo(date.value, mode);
    const payrollDates = mode === 'Mensual' ? [desde, desde.slice(0,8) + '16'] : [desde];
    el('periodo').textContent = desde === hasta ? dateLabel(desde) : dateLabel(desde) + ' al ' + dateLabel(hasta);
    el('cuadro').hidden = true;
    status.textContent = 'Consultando producción y gastos…';
    try {
      const [{produccion}, ...payroll] = await Promise.all([
        requestProduction(session, {accion:'balance_produccion', desde, hasta}),
        ...payrollDates.map(fecha => requestProduction(session, {accion:'nomina_resumen', fecha})),
      ]);
      if (session !== bossSession || seq !== sequence) return false;
      const report = buildRows(produccion, payroll, mode === 'Día' ? desde : null);
      render(report.rows, produccion.tarifa);
      if (openEquipment) {
        const button = [...el('filas').querySelectorAll('button.balance-unidad')].find(node => node.dataset.key === openEquipment);
        if (button?.getAttribute('aria-expanded') === 'false') button.click();
      }
      el('cuadro').hidden = false;
      status.textContent = report.incomplete ? 'Hay montos de nómina pendientes de definir.' : '';
      return true;
    } catch (error) {
      if (seq === sequence && session === bossSession) status.textContent = error.message;
      return false;
    }
  }

  el('fecha').onchange = el('modo').onchange = () => load();
  el('cancelar').onclick = () => {
    if (saving) return;
    form.hidden = true;
    form.reset();
    attempt = null;
  };
  form.onsubmit = async event => {
    event.preventDefault();
    const session = bossSession;
    if (session?.usuario !== 'Admin' || saving) return;
    const {equipo, fecha, monto, concepto} = form.elements;
    const amount = monto.value.trim();
    const value = /^\d+(?:[.,]\d{1,2})?$/.test(amount) ? Number(amount.replace(',','.')) : NaN;
    const status = el('form-estado');
    if (!(value > 0 && value < 1e12)) {
      status.textContent = 'Escribe el monto sin separador de miles y con hasta dos decimales.';
      monto.focus();
      return;
    }
    const body = {equipo:equipo.value, fecha:fecha.value, monto:value, concepto:concepto.value.trim()};
    const key = JSON.stringify(body);
    if (attempt?.key !== key) attempt = {key, id:crypto.randomUUID()};
    saving = true;
    const controls = [...form.elements];
    controls.forEach(control => control.disabled = true);
    status.textContent = 'Guardando…';
    try {
      await requestProduction(session, {accion:'balance_registrar_trabajo', id:attempt.id, ...body});
      if (session !== bossSession) return;
      attempt = null;
      form.hidden = true;
      form.reset();
      el('fecha').value = body.fecha;
      if (await load(body.equipo)) {
        const notice = el('estado');
        notice.textContent = ['Producción registrada.', notice.textContent].filter(Boolean).join(' ');
      }
    } catch (error) {
      if (session === bossSession) status.textContent = error.message;
    } finally {
      saving = false;
      controls.forEach(control => control.disabled = false);
    }
  };

  window.abrirBalanceProduccion = () => load();
  window.resetBalanceProduccion = () => {
    sequence++;
    attempt = null;
    form.reset();
    form.hidden = true;
    el('form-estado').textContent = '';
    el('fecha').value = '';
    el('modo').value = 'Quincena';
    el('tab').hidden = true;
    el('filas').replaceChildren();
    el('totales').replaceChildren();
    el('periodo').textContent = '';
    el('estado').textContent = '';
    el('cuadro').hidden = true;
    const section = document.getElementById('balance-produccion');
    if (!section.classList.contains('show')) return;
    section.classList.remove('show');
    document.querySelector('[data-tab="tablero"]').classList.add('active');
    el('tab').classList.remove('active');
    document.getElementById('tablero').classList.add('show');
  };
})();
