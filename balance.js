(() => {
  const el = id => document.getElementById('balance-' + id);
  const currency = new Intl.NumberFormat('es-VE', {style:'currency', currency:'USD'});
  const number = new Intl.NumberFormat('es-VE', {maximumFractionDigits:2});
  const tableAmount = new Intl.NumberFormat('es-VE', {minimumFractionDigits:2, maximumFractionDigits:2});
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
    const general = {nombre:'Gastos generales', gastos:[], monto:0, general:true};
    function add(key, nombre, extra = {}) {
      const row = {nombre, gastos:[], monto:0, ...extra};
      rows.set(key, row);
      return row;
    }
    const units = new Map([...DEFAULT_E, ...E].map(unit => [String(unit.id), unit.name]));
    for (const [id, name] of units) add('acarreo:' + id, etiquetaUnidad(id,name), {acarreo:true});
    for (const item of data.acarreo) {
      const key = 'acarreo:' + item.unidad;
      const row = rows.get(key) ?? add(key, etiquetaUnidad(item.unidad,item.equipo), {acarreo:true});
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
    function assigned(name, normalized) {
      if (!normalized || normalized === 'general') return general;
      const unit = idUnidadEnEtiqueta(name);
      const key = unit ? 'acarreo:' + unit : 'destino:' + normalized;
      return equipment.get(normalized) ?? rows.get(key) ?? add(key, name, {acarreo:!!unit});
    }
    for (const expense of data.gastos) {
      const name = window.bossGastos.normalizarDestino(expense.destino ?? '').trim();
      const normalized = normalize(name);
      const vehicle = window.bossGastos.vehiculo(name);
      if (vehicle) general.gastos.push({...expense, vehiculo:vehicle});
      else assigned(name, normalized).gastos.push(expense);
    }
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
        const puesto = normalize(line.w.nombre);
        const unidadChofer = line.w.cargo === 'Chofer' ? /^chofer unidad ([a-z0-9-]+)$/.exec(puesto)?.[1] : undefined;
        const equipoHabitual = line.w.cargo === 'Operador' && puesto.startsWith('operador ') ? puesto.slice(9) : '';
        for (const shift of line.rows) {
          if (!Number(shift.monto)) continue;
          const nombreEquipo = normalize(shift.equipo ?? '') || equipoHabitual;
          const id = unidadChofer ?? idUnidadEnEtiqueta(shift.equipo);
          const unidad = id ? rows.get('acarreo:' + id) : undefined;
          const asignado = shift.equipo ? undefined : rows.get(line.w.asignacion);
          const destino = unidad ?? equipment.get(nombreEquipo) ?? rows.get('destino:' + nombreEquipo) ?? asignado ?? general;
          destino.gastos.push({fecha:shift.fecha, concepto:nombrePuesto(line.w.nombre) + ' · ' + shift.turno, monto:shift.monto, partida:'Nómina'});
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
    const payroll = [], other = [];
    for (const expense of row.gastos) {
      const group = ['Nómina', 'Nómina fija'].includes(expense.partida) ? payroll : other;
      group.push(expense);
    }
    for (const [label, expenses] of [[row.general ? 'Nómina' : 'Nómina directa', payroll], ['Otros gastos', other]]) {
      if (!expenses.length) continue;
      const subtotal = expenses.reduce((sum, expense) => sum + cents(expense.monto), 0);
      const group = document.createElement('details');
      group.className = 'balance-gastos';
      const summary = document.createElement('summary');
      summary.append(text('strong', label), text('strong', money(subtotal)));
      group.append(summary);
      const movements = expenses.map(expense => [
        expense.fecha, expense.concepto, Number(expense.monto),
        [expense.vehiculo, expense.partida].filter(Boolean).join(' · '),
      ]);
      window.bossGastos.renderExpenseDays(group, movements, true);
      root.append(group);
    }
    if (!row.gastos.length) root.append(text('p', 'Sin gastos en este período.'));
    return root;
  }

  function metric(amount) {
    const cell = document.createElement('td');
    cell.append(text('strong', '$ ' + tableAmount.format(amount / 100)));
    return cell;
  }

  function balanceMetric(amount) {
    const cell = metric(amount);
    if (amount < 0) cell.className = 'balance-negativo';
    if (amount > 0) cell.className = 'balance-positivo';
    return cell;
  }

  function render(rows, rate) {
    const table = el('filas');
    const opened = new Set([...table.querySelectorAll('button[aria-expanded="true"]')].map(button => button.dataset.key));
    table.replaceChildren();
    let production = 0, expenses = 0, equipmentStarted = false;
    for (const [key, row] of rows) {
      production += row.monto;
      expenses += row.costo;
      const summary = table.insertRow();
      summary.className = key === 'general' ? 'balance-resumen balance-general' : 'balance-resumen';
      if (row.equipo && !equipmentStarted) {
        summary.classList.add('balance-equipos-inicio');
        equipmentStarted = true;
      }
      summary.setAttribute('role', 'row');
      const unit = summary.insertCell();
      unit.setAttribute('role', 'cell');
      const button = text('button', row.nombre);
      button.setAttribute('aria-label', row.nombre);
      button.type = 'button';
      button.className = 'balance-unidad';
      button.dataset.key = key;
      unit.append(button);
      const value = metric(row.monto);
      if (row.acarreo) value.append(text('small', number.format(row.toneladas ?? 0) + ' t'));
      summary.append(value, metric(row.costo), balanceMetric(row.monto - row.costo));
      const expanded = table.insertRow();
      expanded.className = 'balance-ampliado';
      expanded.setAttribute('role', 'row');
      const cell = expanded.insertCell();
      cell.colSpan = 4;
      cell.setAttribute('role', 'cell');
      cell.append(detail(row, rate));
      expanded.hidden = !opened.has(key);
      button.setAttribute('aria-expanded', String(!expanded.hidden));
      button.onclick = () => {
        expanded.hidden = !expanded.hidden;
        button.setAttribute('aria-expanded', String(!expanded.hidden));
      };
    }
    const totals = el('totales');
    const heading = text('th', 'Total de la operación');
    heading.scope = 'row';
    heading.setAttribute('role', 'rowheader');
    totals.replaceChildren(heading, metric(production), metric(expenses), balanceMetric(production - expenses));
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

  window.abrirBalanceProduccion = () => {
    el('modo').value = 'Mensual';
    return window.actualizarBalanceProduccion();
  };
  window.actualizarBalanceProduccion = () => Promise.all([load(),window.cargarCortesAcarreo()]);
  window.resetBalanceProduccion = () => {
    window.resetCortesAcarreo();
    sequence++;
    attempt = null;
    form.reset();
    form.hidden = true;
    el('form-estado').textContent = '';
    el('fecha').value = '';
    el('modo').value = 'Mensual';
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
