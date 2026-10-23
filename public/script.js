// Base de datos del Tablero Logistico CEC (vacia - clasificada por meses)
const _nowInit = new Date();
const RAW_DATA = {
  "today": `${_nowInit.getFullYear()}-${String(_nowInit.getMonth() + 1).padStart(2, "0")}-${String(_nowInit.getDate()).padStart(2, "0")}`,
  "activos": [],
  "semanas": [],
  "semana_actual_idx": -1,
  "archive": {}
};

(function () {
  "use strict";
  const DATA = RAW_DATA;
  const TODAY = DATA.today;

  function fmtDate(iso) {
    if (!iso) return "—";
    const parts = iso.split("-");
    if (parts.length !== 3) return iso;
    const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
    return `${parseInt(parts[2], 10)} ${meses[parseInt(parts[1], 10) - 1]}`;
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ---- Firebase Realtime Database State & Helpers ----
  let fbApp = null;
  let fbDb = null;
  let fbRef = null;
  var currentPartCourse = null;
  var partModal = null;

  function encodeFirebaseKey(key) {
    return encodeURIComponent(key).replace(/\./g, '%2E');
  }

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function storageSet(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* ignore */ }
    if (fbDb) {
      try {
        const safeKey = encodeFirebaseKey(key);
        fbDb.ref('tablero_estado/' + safeKey).set({
          key: key,
          valor: val,
          updated_at: Date.now()
        }).catch(err => {
          console.error("Error sincronizando con Firebase Realtime:", err);
        });
      } catch (err) {
        console.error("Error al escribir en Firebase:", err);
      }
    }
  }


  function estadoPill(estado) {
    const e = (estado || "").toLowerCase();
    if (e.includes("curso")) return `<span class="pill blue">En curso</span>`;
    if (e.includes("preparaci")) return `<span class="pill grey">En preparación</span>`;
    if (e.includes("pronto")) return `<span class="pill amber">Pronto a comenzar</span>`;
    if (e.includes("finaliz")) return `<span class="pill green">Finalizado</span>`;
    if (e.includes("reprogram")) return `<span class="pill red">Reprogramado</span>`;
    return `<span class="pill grey">${estado || "—"}</span>`;
  }

  function tabStatusLabel(s) {
    return { vencido: "Vencida", hoy: "Vence hoy", proximo: "Próxima", futuro: "Futura", completo: "Tabulada", no_aplica: "No aplica", sin_fecha: "Sin fecha" }[s] || s;
  }
  function salStatusLabel(s) {
    return { pendiente: "Pendiente", por_confirmar: "Por confirmar", completo: "Confirmado", no_aplica: "No aplica", proximo: "Próxima", futuro: "—" }[s] || s;
  }

  function semaforo(p) {
    if (!p) return "green";
    const tabs = Array.isArray(p.tabulaciones) ? p.tabulaciones : (p.tabulaciones ? Object.values(p.tabulaciones) : []);
    const sals = Array.isArray(p.salones) ? p.salones : (p.salones ? Object.values(p.salones) : []);
    const vencidoTab = tabs.some(t => t && t.estado === "vencido");
    const pendienteSal = sals.some(s => s && s.estado === "pendiente");
    if (vencidoTab || pendienteSal || /reprogramado/i.test(p.estado || "")) return "red";
    const prontoTab = tabs.some(t => t && (t.estado === "hoy" || t.estado === "proximo"));
    const porConfirmarSal = sals.some(s => s && s.estado === "por_confirmar");
    const prontoSal = sals.some(s => s && s.estado === "proximo");
    if (prontoTab || porConfirmarSal || prontoSal) return "amber";
    return "green";
  }

  let activos = (DATA.activos || []).slice();

  // ---- KPIs ----
  function renderKPIs() {
    const enCurso = activos.filter(p => p.estado_cat === 'en_curso' || /curso/i.test(p.estado || "")).length;
    const enPrep = activos.filter(p => p.estado_cat === 'en_preparacion' || p.estado_cat === 'pronto' || /prepara|pronto/i.test(p.estado || "")).length;
    const tabVencidas = activos.reduce((n, p) => {
      const tabs = Array.isArray(p.tabulaciones) ? p.tabulaciones : (p.tabulaciones ? Object.values(p.tabulaciones) : []);
      return n + tabs.filter(t => t && t.estado === "vencido").length;
    }, 0);
    const salPend = activos.reduce((n, p) => {
      const sals = Array.isArray(p.salones) ? p.salones : (p.salones ? Object.values(p.salones) : []);
      return n + sals.filter(s => s && (s.estado === "pendiente" || s.estado === "por_confirmar")).length;
    }, 0);
    const rojos = activos.filter(p => semaforo(p) === "red").length;

    const horarioRevisar = activos.filter(p => p.analisis_horario && p.analisis_horario.confianza === 'revisar').length;

    const kpis = [
      { n: activos.length, l: "Programas activos", cls: "" },
      { n: enCurso, l: "En curso ahora", cls: "blue" },
      { n: tabVencidas, l: "Tabulaciones vencidas", cls: "red" },
      { n: salPend, l: "Salones por resolver", cls: "amber" },
      { n: horarioRevisar, l: "Horarios a verificar", cls: "amber" },
      { n: rojos, l: "Programas en alerta roja", cls: "red" },
    ];
    document.getElementById('kpi-row').innerHTML = kpis.map(k => `
      <div class="kpi ${k.cls}"><div class="n">${k.n}</div><div class="l">${k.l}</div></div>
    `).join("");
    document.getElementById('asof-date').textContent = fmtDate(TODAY) + " · " + TODAY.split("-")[0];
  }

  // ---- Tabs ----
  function renderTabsHeader() {
    const tabsDef = [
      { id: "current", label: "Programas activos", count: activos.length },
      { id: "archive", label: "Histórico por pestaña", count: null },
    ];
    document.getElementById('tabs').innerHTML = tabsDef.map((t, i) => `
      <button class="tab-btn ${i === 0 ? 'active' : ''}" data-tab="${t.id}">${t.label}${t.count !== null ? `<span class="count">${t.count}</span>` : ''}</button>
    `).join("");
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        ['current', 'archive'].forEach(id => {
          document.getElementById('view-' + id).style.display = (id === btn.dataset.tab) ? '' : 'none';
        });
      });
    });
  }

  // ---- Coordinadora filter chips ----
  let activeCoord = null;
  let searchTerm = "";
  function renderChips() {
    const coords = Array.from(new Set(activos.map(p => p.coordinadora).filter(Boolean))).sort();
    document.getElementById('coord-chips').innerHTML =
      `<button class="chip ${activeCoord === null ? 'active' : ''}" data-c="">Todas</button>` +
      coords.map(c => `<button class="chip ${activeCoord === c ? 'active' : ''}" data-c="${c}">${c}</button>`).join("");
    document.querySelectorAll('.chip').forEach(ch => {
      ch.addEventListener('click', () => {
        activeCoord = ch.dataset.c || null;
        renderChips(); renderTable();
      });
    });
  }
  document.getElementById('search-box').addEventListener('input', (e) => {
    searchTerm = e.target.value.trim().toLowerCase();
    renderTable();
  });

  // ---- Month classification & order definition (01_Enero to 12_Diciembre) ----
  const MESES_INFO = [
    { key: "01_Enero", name: "Enero", num: 1 },
    { key: "02_Febrero", name: "Febrero", num: 2 },
    { key: "03_Marzo", name: "Marzo", num: 3 },
    { key: "04_Abril", name: "Abril", num: 4 },
    { key: "05_Mayo", name: "Mayo", num: 5 },
    { key: "06_Junio", name: "Junio", num: 6 },
    { key: "07_Julio", name: "Julio", num: 7 },
    { key: "08_Agosto", name: "Agosto", num: 8 },
    { key: "09_Septiembre", name: "Septiembre", num: 9 },
    { key: "10_Octubre", name: "Octubre", num: 10 },
    { key: "11_Noviembre", name: "Noviembre", num: 11 },
    { key: "12_Diciembre", name: "Diciembre", num: 12 }
  ];

  function getMesKey(mesName) {
    if (!mesName) return "01_Enero";
    const clean = mesName.replace(/^\d+_/, '').toLowerCase().trim();
    const found = MESES_INFO.find(m => m.name.toLowerCase() === clean);
    return found ? found.key : mesName;
  }

  function getMesNombreLimpio(mesKeyOrName) {
    if (!mesKeyOrName) return "Enero";
    return mesKeyOrName.replace(/^\d+_/, '').trim();
  }

  function sanitizeFirebaseNodeKey(name) {
    if (!name) return 'programa_' + Date.now();
    return name.trim().replace(/[.#$\[\]\/]/g, '_');
  }

  const MESES = ["Todos", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  let activeMonth = "Todos";
  function renderMonthChips() {
    const el = document.getElementById('month-chips');
    if (!el) return;
    el.innerHTML = MESES.map(m => {
      const count = (m === "Todos")
        ? activos.length
        : activos.filter(p => getMesNombreLimpio(p.mes || p.origen_mes || "").toLowerCase() === m.toLowerCase()).length;
      return `<button class="week-chip ${activeMonth === m ? 'active' : ''}" data-m="${m}">
        ${m} <span style="opacity:0.8;font-size:11px;font-weight:normal;">(${count})</span>
      </button>`;
    }).join("");
    el.querySelectorAll('.week-chip').forEach(ch => {
      ch.addEventListener('click', () => {
        activeMonth = ch.dataset.m;
        renderMonthChips();
        renderTable();
      });
    });
  }
  renderMonthChips();

  // ---- Definición de Días y Utilidades de Horario ----
  const SEMANA_DIAS = [
    { key: "Lun", nombre: "Lunes", index: 0, jsDay: 1 },
    { key: "Mar", nombre: "Martes", index: 1, jsDay: 2 },
    { key: "Mié", nombre: "Miércoles", index: 2, jsDay: 3 },
    { key: "Jue", nombre: "Jueves", index: 3, jsDay: 4 },
    { key: "Vie", nombre: "Viernes", index: 4, jsDay: 5 },
    { key: "Sáb", nombre: "Sábado", index: 5, jsDay: 6 },
    { key: "Dom", nombre: "Domingo", index: 6, jsDay: 0 }
  ];

  function formatTime12h(timeStr) {
    if (!timeStr) return "";
    const parts = timeStr.split(":");
    if (parts.length < 2) return timeStr;
    let h = parseInt(parts[0], 10);
    const m = parts[1];
    if (isNaN(h)) return timeStr;
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${m} ${ampm}`;
  }

  function formatTime12hShort(timeStr) {
    if (!timeStr) return "";
    const parts = timeStr.split(":");
    if (parts.length < 2) return timeStr;
    let h = parseInt(parts[0], 10);
    const m = parts[1];
    const ampm = h >= 12 ? "pm" : "am";
    h = h % 12;
    if (h === 0) h = 12;
    return m === "00" ? `${h}${ampm}` : `${h}:${m}${ampm}`;
  }

  function calcDurationHours(t1, t2) {
    if (!t1 || !t2) return 0;
    const [h1, m1] = t1.split(":").map(Number);
    const [h2, m2] = t2.split(":").map(Number);
    if (isNaN(h1) || isNaN(h2)) return 0;
    let diffMinutes = (h2 * 60 + (m2 || 0)) - (h1 * 60 + (m1 || 0));
    if (diffMinutes < 0) diffMinutes += 24 * 60;
    return +(diffMinutes / 60).toFixed(1);
  }

  function calculateSessionDates(startDateStr, endDateStr, scheduleDays) {
    if (!startDateStr || !endDateStr || !Array.isArray(scheduleDays) || scheduleDays.length === 0) {
      return [];
    }
    const targetJsDays = new Set(scheduleDays.map(sd => {
      const found = SEMANA_DIAS.find(d => d.index === sd.diaIndex);
      return found ? found.jsDay : null;
    }).filter(d => d !== null));

    const dates = [];
    const current = new Date(startDateStr + "T12:00:00");
    const end = new Date(endDateStr + "T12:00:00");
    let iterations = 0;
    while (current <= end && iterations < 500) {
      iterations++;
      if (targetJsDays.has(current.getDay())) {
        const y = current.getFullYear();
        const m = String(current.getMonth() + 1).padStart(2, '0');
        const d = String(current.getDate()).padStart(2, '0');
        dates.push(`${y}-${m}-${d}`);
      }
      current.setDate(current.getDate() + 1);
    }
    return dates;
  }

  function buildScheduleReadableText(days, modalidad) {
    if (!Array.isArray(days) || days.length === 0) {
      return "";
    }
    const isBlended = (modalidad || "").toLowerCase() === "blended";

    if (!isBlended && days.length > 1) {
      const firstT1 = days[0].horaInicio;
      const firstT2 = days[0].horaFin;
      const allSameTime = days.every(d => d.horaInicio === firstT1 && d.horaFin === firstT2);
      if (allSameTime) {
        const names = days.map(d => d.dia);
        const daysJoined = names.length === 2
          ? `${names[0]} y ${names[1]}`
          : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
        return `${daysJoined} de ${formatTime12h(firstT1)} a ${formatTime12h(firstT2)}`;
      }
    }

    const parts = days.map(d => {
      const modTag = isBlended ? ` (${d.tipo || 'Presencial'})` : '';
      return `${d.dia}${modTag} de ${formatTime12h(d.horaInicio)} a ${formatTime12h(d.horaFin)}`;
    });

    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return `${parts[0]} y ${parts[1]}`;
    return `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`;
  }

  function parseHorarioToConfig(horarioStr, modalidad) {
    if (!horarioStr) return [];
    const str = horarioStr.toLowerCase();
    const isBlended = (modalidad || "").toLowerCase() === "blended";
    const foundDays = [];

    let defaultH1 = "17:00", defaultH2 = "21:00";
    if (/8\s*(am)?\s*(a|-)\s*12/i.test(str)) {
      defaultH1 = "08:00"; defaultH2 = "12:00";
    } else if (/6\s*(pm)?\s*(a|-)\s*9/i.test(str)) {
      defaultH1 = "18:00"; defaultH2 = "21:00";
    } else if (/5\s*(pm)?\s*(a|-)\s*9/i.test(str)) {
      defaultH1 = "17:00"; defaultH2 = "21:00";
    }

    SEMANA_DIAS.forEach(d => {
      const re = new RegExp(d.key.slice(0, 3), 'i');
      if (re.test(str)) {
        let tipo = isBlended ? "Presencial" : (modalidad || "Presencial");
        if (isBlended) {
          const daySliceMatch = str.match(new RegExp(`${d.key.slice(0, 3)}[^,\n\.]*(remoto|virtual|zoom|teams)`, 'i'));
          if (daySliceMatch) tipo = "Remoto";
          else if (/remoto|virtual/i.test(str) && !/presencial/i.test(str)) tipo = "Remoto";
        }
        let h1 = defaultH1, h2 = defaultH2;
        if (d.index === 5 && (/s[aá]b/i.test(str)) && (/8\s*(am)?\s*(a|-)\s*12/i.test(str) || defaultH1 === "17:00")) {
          h1 = "08:00"; h2 = "12:00";
        }

        foundDays.push({
          dia: d.nombre,
          diaIndex: d.index,
          tipo: tipo,
          horaInicio: h1,
          horaFin: h2
        });
      }
    });

    return foundDays;
  }

  // ---- Basic Horario Parser for manual program entry ----
  function parseHorarioBasico(horarioStr) {
    const str = (horarioStr || "").toLowerCase();
    const dias = [];
    const diasNombres = [];
    if (/lun/i.test(str)) { dias.push(0); diasNombres.push("Lunes"); }
    if (/mar/i.test(str)) { dias.push(1); diasNombres.push("Martes"); }
    if (/mi[eé]/i.test(str)) { dias.push(2); diasNombres.push("Miércoles"); }
    if (/jue/i.test(str)) { dias.push(3); diasNombres.push("Jueves"); }
    if (/vie/i.test(str)) { dias.push(4); diasNombres.push("Viernes"); }
    if (/s[aá]b/i.test(str)) { dias.push(5); diasNombres.push("Sábado"); }
    if (/dom/i.test(str)) { dias.push(6); diasNombres.push("Domingo"); }
    return {
      fechas_sesion: [],
      dias_detectados: dias,
      dias_nombres: diasNombres,
      horas: horarioStr ? [horarioStr] : [],
      fuente: "manual",
      confianza: dias.length > 0 ? "ok" : "revisar"
    };
  }

  // ---- Week filter ----
  const semanas = DATA.semanas || [];
  let activeWeekIdx = DATA.semana_actual_idx === undefined ? -1 : DATA.semana_actual_idx; // -1 = todas
  function renderWeekChips() {
    const el = document.getElementById('week-chips');
    const bar = el ? el.closest('.week-bar') : null;
    const legend = document.getElementById('week-legend');
    if (!semanas || semanas.length === 0) {
      if (bar) bar.style.display = 'none';
      if (legend) legend.style.display = 'none';
      return;
    }
    const todayIdx = DATA.semana_actual_idx;
    el.innerHTML = `<button class="week-chip ${activeWeekIdx === -1 ? 'active' : ''}" data-w="-1">Todas</button>` +
      semanas.map((w, i) => `<button class="week-chip ${activeWeekIdx === i ? 'active' : ''} ${i === todayIdx ? 'is-today' : ''}" data-w="${i}">${w.label}</button>`).join("");
    el.querySelectorAll('.week-chip').forEach(ch => {
      ch.addEventListener('click', () => {
        activeWeekIdx = parseInt(ch.dataset.w, 10);
        renderWeekChips(); renderTable();
      });
    });
    if (activeWeekIdx === -1) {
      legend.textContent = "Mostrando todos los programas, sin filtrar por semana.";
    } else {
      const w = semanas[activeWeekIdx];
      legend.textContent = `Mostrando programas con sesión entre el ${w.label} (o vigentes en ese rango).`;
    }
  }
  renderWeekChips();

  function programInWeek(p, week) {
    const an = p.analisis_horario;
    if (an && an.fechas_sesion && an.fechas_sesion.length) {
      return an.fechas_sesion.some(d => d >= week.start && d <= week.end);
    }
    const fi = p.fecha_inicio, ff = p.fecha_fin;
    if (!fi || !/^\d{4}-\d{2}-\d{2}$/.test(fi)) return true;
    const endOk = (ff && /^\d{4}-\d{2}-\d{2}$/.test(ff)) ? ff >= week.start : true;
    return fi <= week.end && endOk;
  }

  // ---- Main table ----
  const ALL_DAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

  function diasHorarioCell(p) {
    const an = (p && p.analisis_horario) || {};
    const dias = Array.isArray(an.dias_detectados) ? an.dias_detectados : [];
    const horas = Array.isArray(an.horas) ? an.horas : [];
    const isBlended = (p.modalidad || "").toLowerCase() === "blended";
    const cfg = (p.horario_config && Array.isArray(p.horario_config.dias)) ? p.horario_config.dias : [];

    const diaConfigMap = {};
    cfg.forEach(c => { diaConfigMap[c.diaIndex] = c; });

    const diasRow = `<div class="dias-row">${ALL_DAYS.map((d, i) => {
      const isHit = dias.includes(i);
      if (!isHit) return `<span class="day-chip">${d}</span>`;
      const itemCfg = diaConfigMap[i];
      if (isBlended && itemCfg) {
        const isPres = itemCfg.tipo === "Presencial";
        const title = `${itemCfg.dia}: ${itemCfg.tipo} (${formatTime12h(itemCfg.horaInicio)} - ${formatTime12h(itemCfg.horaFin)})`;
        return `<span class="day-chip ${isPres ? 'hit-presencial' : 'hit-remoto'}" title="${title}">${isPres ? '🏢 ' : '💻 '}${d}</span>`;
      }
      return `<span class="day-chip hit">${d}</span>`;
    }).join("")}</div>`;

    let horasStr = "";
    if (isBlended && cfg.length > 0) {
      horasStr = `<div class="prog-sub" style="display:flex;gap:4px;flex-wrap:wrap;margin-top:3px;">${cfg.map(c => {
        const isPres = c.tipo === "Presencial";
        return `<span class="${isPres ? 'badge-tag-pres' : 'badge-tag-rem'}">${isPres ? '🏢' : '💻'} ${c.dia.slice(0, 3)} ${formatTime12hShort(c.horaInicio)}-${formatTime12hShort(c.horaFin)}</span>`;
      }).join("")
        }</div>`;
    } else if (horas.length) {
      horasStr = `<div class="prog-sub">${horas[0]}${horas.length > 1 ? ' +' + (horas.length - 1) : ''}</div>`;
    }
    const warn = an.confianza === 'revisar' ? `<div class="warn-badge">⚠ verificar horario</div>` : "";
    return diasRow + horasStr + warn;
  }

  // Helper para auditoría y cálculo de estado de tabulación de asistencia por sesiones
  function calcularEstadoTabulacionCurso(prog) {
    if (!prog) return { matriculadosCount: 0, totalSesiones: 0, tabuladasCount: 0, pendientesVencidas: 0, sesionesHoy: 0, promedioPct: 0, sesionesDetalle: [], participantes: [] };

    const rawPart = prog.participantes;
    let parts = [];
    if (Array.isArray(rawPart)) {
      parts = rawPart.map((p, i) => (p && typeof p === 'object' ? { ...p, _key: p._key || ('part_' + (p.documento || i)) } : p));
    } else if (rawPart && typeof rawPart === 'object') {
      parts = Object.entries(rawPart).map(([key, val]) => {
        if (val && typeof val === 'object') {
          return { ...val, _key: val._key || key };
        }
        return val;
      }).filter(Boolean);
    }

    const rawSes = (prog.analisis_horario && Array.isArray(prog.analisis_horario.fechas_sesion)) ? prog.analisis_horario.fechas_sesion : [];
    const numSes = Math.max(rawSes.length, 8);
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    let tabuladasCount = 0;
    let pendientesVencidas = 0;
    let sesionesHoy = 0;
    const sesionesDetalle = [];

    for (let s = 0; s < numSes; s++) {
      const fStr = rawSes[s] || "";
      let isTab = false;
      if (prog.sesiones_tabuladas && (prog.sesiones_tabuladas['sesion_' + s] || prog.sesiones_tabuladas[s])) {
        isTab = true;
      } else {
        for (let i = 0; i < parts.length; i++) {
          const att = parts[i] && parts[i].asistencias;
          if (att && (att['sesion_' + s] || att[s])) {
            isTab = true;
            break;
          }
        }
      }

      let estado = 'futuro';
      if (isTab) {
        estado = 'completo';
        tabuladasCount++;
      } else if (fStr) {
        if (fStr < todayStr) {
          estado = 'vencido';
          pendientesVencidas++;
        } else if (fStr === todayStr) {
          estado = 'hoy';
          sesionesHoy++;
        } else {
          estado = 'futuro';
        }
      } else {
        estado = 'sin_fecha';
      }

      sesionesDetalle.push({
        index: s,
        fecha: fStr,
        label: `Sesión ${s + 1}${fStr ? ' (' + fmtDate(fStr) + ')' : ''}`,
        estado: estado,
        isTab: isTab
      });
    }

    let sumPct = 0;
    parts.forEach(p => {
      let pCount = 0;
      for (let s = 0; s < numSes; s++) {
        const mark = p.asistencias && (p.asistencias['sesion_' + s] || p.asistencias[s]);
        if (mark === 'P') pCount++;
      }
      const pct = numSes > 0 ? (pCount / numSes) : 0;
      sumPct += pct;
    });
    const promedioPct = parts.length > 0 ? Math.round((sumPct / parts.length) * 100) : 0;

    return {
      matriculadosCount: parts.length,
      totalSesiones: numSes,
      tabuladasCount: tabuladasCount,
      pendientesVencidas: pendientesVencidas,
      sesionesHoy: sesionesHoy,
      promedioPct: promedioPct,
      sesionesDetalle: sesionesDetalle,
      participantes: parts
    };
  }

  let activeTrafficFilter = 'all';

  function renderTable() {
    const week = activeWeekIdx >= 0 ? semanas[activeWeekIdx] : null;
    let rows = activos.filter(p => {
      if (!p) return false;
      const mesProg = getMesNombreLimpio(p.mes || p.origen_mes || "");
      if (activeMonth !== "Todos" && mesProg.toLowerCase() !== activeMonth.toLowerCase()) return false;
      if (activeCoord && p.coordinadora !== activeCoord) return false;
      const progName = (p.programa || p.nombre_del_programa || "").toLowerCase();
      const coordName = (p.coordinadora || "").toLowerCase();
      if (searchTerm && !(progName.includes(searchTerm) || coordName.includes(searchTerm))) return false;
      if (week && !programInWeek(p, week)) return false;
      if (activeTrafficFilter && activeTrafficFilter !== 'all' && semaforo(p) !== activeTrafficFilter) return false;
      return true;
    });

    // Actualizar contadores de filtros rápidos
    const rCount = activos.filter(p => semaforo(p) === 'red').length;
    const aCount = activos.filter(p => semaforo(p) === 'amber').length;
    const gCount = activos.filter(p => semaforo(p) === 'green').length;
    const elR = document.getElementById('qcount-red'); if (elR) elR.textContent = rCount;
    const elA = document.getElementById('qcount-amber'); if (elA) elA.textContent = aCount;
    const elG = document.getElementById('qcount-green'); if (elG) elG.textContent = gCount;

    document.getElementById('table-count').textContent = rows.length + " de " + activos.length;
    const tbody = document.getElementById('main-tbody');
    if (rows.length === 0) {
      const mesTxt = activeMonth === "Todos" ? "en este tablero" : `para el mes de ${activeMonth}`;
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty">Sin programas registrados ${mesTxt}.<br><button type="button" class="btn btn-primary btn-sm" style="margin-top:10px;" id="btn-crear-primer-prog">+ Crear programa ${activeMonth === 'Todos' ? '' : 'en ' + activeMonth}</button></div></td></tr>`;
      const btnCrear = tbody.querySelector('#btn-crear-primer-prog');
      if (btnCrear) {
        btnCrear.addEventListener('click', () => openProgramModal(null));
      }
      return;
    }
    tbody.innerHTML = rows.map((p, idx) => {
      const sem = semaforo(p);
      const semLabel = { red: "Requiere acción", amber: "Seguimiento", green: "Al día" }[sem];
      const pKey = p.id || encodeURIComponent(p.programa || ('prog_' + idx));
      const fechasStr = (p.fecha_inicio || p.fecha_fin)
        ? `${fmtDate(p.fecha_inicio)} – ${fmtDate(p.fecha_fin)}`
        : '—';
      const tabs = Array.isArray(p.tabulaciones) ? p.tabulaciones : (p.tabulaciones ? Object.values(p.tabulaciones) : []);
      const sals = Array.isArray(p.salones) ? p.salones : (p.salones ? Object.values(p.salones) : []);
      const sesiones = (p.analisis_horario && Array.isArray(p.analisis_horario.fechas_sesion)) ? p.analisis_horario.fechas_sesion : [];
      const cfg = (p.horario_config && Array.isArray(p.horario_config.dias)) ? p.horario_config.dias : [];
      const isBlended = (p.modalidad || '').toLowerCase() === 'blended';
      const diaConfigMap = {};
      cfg.forEach(c => { diaConfigMap[c.diaIndex] = c; });

      const calcTab = calcularEstadoTabulacionCurso(p);

      return `
      <tr class="prow" data-idx="${idx}" data-key="${escapeHtml(pKey)}">
        <td>
          <div class="prog-name">${escapeHtml(p.programa || p.nombre_del_programa || 'Sin nombre')}</div>
          <div class="prog-sub" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span>${escapeHtml(p.tipo || '')}${p.modalidad ? ' · ' + escapeHtml(p.modalidad) : ''}</span>
            ${calcTab.pendientesVencidas > 0
              ? `<span class="pill red" style="font-size:10px;padding:1px 6px;" title="Hay ${calcTab.pendientesVencidas} sesiones pasadas sin tabular">⚠️ ${calcTab.pendientesVencidas} sin tabular</span>`
              : (calcTab.matriculadosCount > 0 && calcTab.tabuladasCount > 0
                ? `<span class="pill green" style="font-size:10px;padding:1px 6px;" title="Tabulación al día (${calcTab.tabuladasCount}/${calcTab.totalSesiones} sesiones)">✓ ${calcTab.tabuladasCount}/${calcTab.totalSesiones} tab</span>`
                : '')}
          </div>
        </td>
        <td>${p.coordinadora || "—"}</td>
        <td>${diasHorarioCell(p)}</td>
        <td>${fechasStr}</td>
        <td>${estadoPill(p.estado)}</td>
        <td><span class="pill blue">${getMesNombreLimpio(p.mes || p.origen_mes || 'Sin mes')}</span></td>
        <td><span class="semaforo-cell ${sem}"><span class="dot ${sem}"></span>${semLabel}</span></td>
        <td class="action-cell">
          <div style="display:flex;gap:6px;justify-content:flex-end;align-items:center;">
            <button type="button" class="btn-action btn-manage-part" data-idx="${idx}" title="Añadir participantes y tabular asistencia">
              👥 Alumnos <span class="badge-part-counter">${calcTab.matriculadosCount}</span>
            </button>
            <button type="button" class="btn-action btn-edit-prog" data-idx="${idx}" title="Editar programa">✏️</button>
          </div>
        </td>
      </tr>
      <tr class="detail-row" data-detail-for="${idx}" style="display:none;"><td colspan="8">
        <!-- Bloque destacado: Participantes y Control de Asistencia Oficial -->
        <div class="detail-block" style="border-left:4px solid var(--indigo-600);margin-bottom:12px;background:linear-gradient(180deg, #ffffff 0%, var(--slate-50) 100%);">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
            <div>
              <h4 style="margin:0;font-size:14px;display:flex;align-items:center;gap:6px;">
                👥 Control de Asistencia y Participantes
                <span class="badge-part-counter">${calcTab.matriculadosCount} inscritos</span>
              </h4>
              <div style="font-size:12px;color:var(--slate-600);margin-top:3px;">
                <strong>${calcTab.tabuladasCount} de ${calcTab.totalSesiones}</strong> sesiones tabuladas (${Math.round((calcTab.tabuladasCount / Math.max(calcTab.totalSesiones, 1)) * 100)}%)
                ${calcTab.pendientesVencidas > 0
                  ? `<span class="pill red" style="margin-left:6px;font-size:10px;">⚠️ ${calcTab.pendientesVencidas} sesiones retrasadas sin tabular</span>`
                  : `<span class="pill green" style="margin-left:6px;font-size:10px;">✓ Tabulación al día</span>`}
              </div>
            </div>
            <div style="display:flex;gap:6px;">
              <button type="button" class="btn btn-primary btn-sm btn-quick-open-part" data-idx="${idx}" style="font-size:12px;">
                👥 Gestionar Alumnos y Asistencia ↗
              </button>
            </div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">
            ${calcTab.sesionesDetalle.map(sd => `
              <div style="background:#ffffff;border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:11px;display:inline-flex;align-items:center;gap:6px;">
                <span style="font-weight:600;color:var(--slate-700);">${sd.label}</span>
                ${statusPill('tab', sd.estado)}
              </div>
            `).join('')}
          </div>
        </div>

        <div class="detail-grid">
          <div class="detail-block">
            <h4>Tabulación por periodo (Histórico)</h4>
            <div class="period-list">
              ${tabs.length ? tabs.map(t => `<div class="period-item"><span class="lbl">${(t.label || '').replace(/^Tabulaci[oó]n\s*/i, '')}</span>${statusPill('tab', t.estado)}</div>`).join("") : '<div class="meta-line">Sin tabulaciones registradas.</div>'}
            </div>
          </div>
          <div class="detail-block">
            <h4>Salones por periodo</h4>
            <div class="period-list">
              ${sals.length ? sals.map(s => `<div class="period-item"><span class="lbl">${(s.label || '').replace(/^Salones?\s*/i, '')}</span>${statusPill('sal', s.estado)}</div>`).join("") : '<div class="meta-line">Sin columnas de salón registradas.</div>'}
            </div>
          </div>
        </div>
        <div class="detail-grid" style="margin-top:12px;">
          <div class="detail-block">
            <h4>Horario tal como está en el sistema</h4>
            <div class="raw-horario">${(p.horario || "—").replace(/\n/g, '<br>')}</div>
            ${cfg.length > 0 ? `
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
                ${cfg.map(d => `
                  <span class="sched-stat-pill" style="font-size:11px;padding:3px 9px;">
                    ${d.tipo === 'Presencial' ? '🏢 Presencial' : '💻 Remoto'}: <strong>${d.dia}</strong> (${formatTime12h(d.horaInicio)} - ${formatTime12h(d.horaFin)})
                  </span>
                `).join("")}
              </div>
            ` : ''}
            ${p.analisis_horario && p.analisis_horario.confianza === 'revisar' ? '<div class="warn-badge">⚠ No se pudo interpretar el patrón completo — verificar manualmente</div>' : ''}
          </div>
          <div class="detail-block">
            <h4>Fechas de sesión calculadas ${week ? '(semana ' + week.label + ' resaltada)' : ''}</h4>
            <div class="session-dates">
              ${sesiones.length ?
          sesiones.map(d => {
            const inWeek = week && d >= week.start && d <= week.end;
            const jsDow = new Date(d + "T12:00:00").getDay();
            const dowNames = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
            const diaIdx = (jsDow + 6) % 7;
            const itemCfg = diaConfigMap[diaIdx];
            const badge = (itemCfg && isBlended) ? (itemCfg.tipo === 'Presencial' ? ' 🏢' : ' 💻') : '';
            return `<div class="session-date-item ${inWeek ? 'in-week' : ''}"><span>${dowNames[jsDow]} ${fmtDate(d)}${badge}</span></div>`;
          }).join("")
          : '<div class="meta-line">No se pudieron calcular fechas exactas de sesión a partir del horario. Revisa el texto original.</div>'}
            </div>
          </div>
        </div>
        <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:8px;">
          <div>
            <div class="meta-line"><strong>Contacto:</strong> ${p.nombre_contacto || p.nombre || "—"} ${p.celular && p.celular !== 'No aplica' ? '· ' + p.celular : ''}</div>
            <div class="meta-line"><strong>Links sesiones virtuales:</strong> ${p.link ? `<a href="${p.link.startsWith('http') ? p.link : 'https://' + p.link}" target="_blank" style="color:var(--blue);">${p.link}</a>` : '—'}</div>
            <div class="meta-line"><strong>Encuesta de satisfacción:</strong> ${p.evaluaciones ? p.evaluaciones : 'Sin registrar'}</div>
            <div class="meta-line"><strong>Facturación:</strong> ${p.estado_facturacion || 'Sin registrar'}${p.comentarios_facturacion ? ' · ' + p.comentarios_facturacion : ''}</div>
            <div class="meta-line"><strong>📁 Google Drive:</strong> ${p.drive_folder_url ? `<a href="${p.drive_folder_url}" target="_blank" rel="noopener" style="color:var(--indigo-600);font-weight:600;margin-right:8px;">📂 Carpeta Drive</a>` : '<span style="color:var(--slate-400);">Pendiente de sincronizar</span>'} ${p.asistencia_sheet_url ? `· <a href="${p.asistencia_sheet_url}" target="_blank" rel="noopener" style="color:var(--emerald-600);font-weight:600;margin-left:6px;">📊 Planilla Asistencia</a>` : ''}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <button type="button" class="btn btn-secondary btn-sm btn-quick-asistencia" data-idx="${idx}" title="Descargar plantilla de asistencia en Excel (.xlsx)">📥 Asistencia (.xlsx)</button>
            <button type="button" class="btn btn-secondary btn-sm btn-edit-prog-detail" data-idx="${idx}">✏️ Modificar datos completos</button>
          </div>
        </div>
      </td></tr>`;
    }).join("");
    tbody.querySelectorAll('tr.prow').forEach(tr => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('.btn-edit-prog, .btn-manage-part')) return;
        const idx = tr.dataset.idx;
        const dr = tbody.querySelector(`tr[data-detail-for="${idx}"]`);
        if (dr) dr.style.display = dr.style.display === 'none' ? '' : 'none';
      });
    });
    tbody.querySelectorAll('.btn-manage-part, .btn-quick-open-part').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        if (rows[idx]) openParticipantsModal(rows[idx]);
      });
    });
    tbody.querySelectorAll('.btn-edit-prog, .btn-edit-prog-detail').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        if (rows[idx]) openProgramModal(rows[idx]);
      });
    });
    tbody.querySelectorAll('.btn-quick-asistencia').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        if (rows[idx]) exportarPlanillaAsistenciaXLSX(rows[idx]);
      });
    });
  }

  // Generador y descargador directo de planilla de asistencia oficial en Excel (.xlsx)
  function exportarPlanillaAsistenciaXLSX(prog) {
    if (!prog) return;
    if (!window.XLSX) {
      alert("La librería SheetJS no está lista todavía. Intenta nuevamente en un momento.");
      return;
    }

    const nombre = (prog.programa || prog.nombre_del_programa || prog.nombre || "Curso").trim();
    const nrc = (prog.nrc || "").toString().trim();
    const docente = (prog.coordinadora || prog.nombre_contacto || "Por asignar").trim();
    const horario = (prog.horario || "").trim();
    const salon = (prog.salones_1_val || (prog.salones && prog.salones[0] && prog.salones[0].valor) || "").trim();
    const fi = prog.fecha_inicio || "";
    const ff = prog.fecha_fin || "";
    const sesiones = (prog.analisis_horario && Array.isArray(prog.analisis_horario.fechas_sesion) && prog.analisis_horario.fechas_sesion.length > 0)
      ? prog.analisis_horario.fechas_sesion
      : [];
    const numSesiones = Math.max(sesiones.length, 8);

    const aoa = [
      ["UNIVERSIDAD DEL NORTE — CENTRO DE EDUCACIÓN CONTINUADA (CEC)"],
      ["CONTROL Y REGISTRO OFICIAL DE ASISTENCIA"],
      [],
      ["PROGRAMA:", nombre, "", "", "NRC:", nrc, "", "MODALIDAD:", prog.modalidad || "Presencial"],
      ["DOCENTE / COORD:", docente, "", "", "TELÉFONO:", prog.celular || "", "", "SALÓN:", salon],
      ["FECHAS:", (fi ? (fi + " al " + ff) : ""), "", "", "HORARIO:", horario, "", "", ""],
      []
    ];

    const headers = ["#", "No. Documento", "Nombre Completo del Participante", "Correo Electrónico"];
    for (let s = 0; s < numSesiones; s++) {
      const fStr = sesiones[s] ? sesiones[s] : ("Sesión " + (s + 1));
      headers.push(fStr);
    }
    headers.push("Total Asistencias");
    headers.push("% Asistencia");
    headers.push("Estado Final");
    aoa.push(headers);

    const rawPart = prog.participantes;
    const parts = Array.isArray(rawPart) ? rawPart : (rawPart && typeof rawPart === 'object' ? Object.values(rawPart) : []);
    const numRows = Math.max(parts.length, 30);

    for (let i = 1; i <= numRows; i++) {
      const pItem = parts[i - 1] || null;
      const row = [
        i,
        pItem ? (pItem.documento || "") : "",
        pItem ? (pItem.nombre || "") : "",
        pItem ? (pItem.correo || "") : ""
      ];
      for (let s = 0; s < numSesiones; s++) {
        const mark = pItem && pItem.asistencias ? (pItem.asistencias['sesion_' + s] || pItem.asistencias[s] || "") : "";
        row.push(mark);
      }
      const startLetter = "E";
      const endColIdx = 3 + numSesiones; // 0-indexed column of last session
      const endLetter = XLSX.utils.encode_col(endColIdx);
      const rowNum = 8 + i; // Excel row index (1-based)
      const totalColLetter = XLSX.utils.encode_col(endColIdx + 1);
      const percentColLetter = XLSX.utils.encode_col(endColIdx + 2);

      row.push({ t: 'n', f: 'COUNTIF(' + startLetter + rowNum + ':' + endLetter + rowNum + ',"P")' });
      row.push({ t: 'n', f: totalColLetter + rowNum + '/' + numSesiones, z: '0.0%' });
      row.push({ t: 's', f: 'IF(' + percentColLetter + rowNum + '>=0.8,"APROBADO",IF(' + totalColLetter + rowNum + '>0,"EN CURSO","PENDIENTE"))' });
      aoa.push(row);
    }

    aoa.push([]);
    aoa.push(["Convenciones: P = Presente  |  F = Falta injustificada  |  E = Excusa médica / laboral. Requisito mínimo para certificar: 80% de asistencia."]);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: headers.length - 1 } }
    ];

    const colWidths = [{ wch: 5 }, { wch: 15 }, { wch: 32 }, { wch: 25 }];
    for (let s = 0; s < numSesiones; s++) colWidths.push({ wch: 14 });
    colWidths.push({ wch: 16 });
    colWidths.push({ wch: 14 });
    colWidths.push({ wch: 14 });
    ws['!cols'] = colWidths;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Control Asistencia");
    const safeName = (nombre + (nrc ? ("_NRC_" + nrc) : "")).replace(/[\\/:*?"<>|]/g, '_').substring(0, 60);
    XLSX.writeFile(wb, "Asistencia_" + safeName + ".xlsx");
  }
  function statusPill(kind, estado) {
    const map = kind === 'tab' ?
      { vencido: 'red', hoy: 'amber', proximo: 'amber', futuro: 'grey', completo: 'green', no_aplica: 'grey', sin_fecha: 'grey' } :
      { pendiente: 'red', por_confirmar: 'amber', completo: 'green', no_aplica: 'grey', proximo: 'amber', futuro: 'grey' };
    const cls = map[estado] || 'grey';
    const label = kind === 'tab' ? tabStatusLabel(estado) : salStatusLabel(estado);
    return `<span class="pill ${cls}">${label}</span>`;
  }

  // ---- Reminders panel (tabulación vencida / hoy + salones pendientes, grouped by coordinadora) ----
  function buildReminders() {
    const items = [];
    activos.forEach(p => {
      if (!p) return;
      const calcTab = calcularEstadoTabulacionCurso(p);
      calcTab.sesionesDetalle.forEach(sd => {
        if (sd.estado === 'vencido' || sd.estado === 'hoy') {
          items.push({
            coord: p.coordinadora,
            programa: p.programa || p.nombre_del_programa || 'Sin nombre',
            tipo: 'Tabulación Asistencia',
            periodo: sd.label,
            urgent: sd.estado === 'vencido',
            key: 'rem_' + (p.programa || p.id) + '_tab_ses_' + sd.index
          });
        }
      });
      const sals = Array.isArray(p.salones) ? p.salones : (p.salones ? Object.values(p.salones) : []);
      sals.forEach(s => {
        if (s && s.estado === 'pendiente') {
          items.push({ coord: p.coordinadora, programa: p.programa || p.nombre_del_programa || 'Sin nombre', tipo: 'Salón', periodo: (s.label || '').replace(/^Salones?\s*/i, ''), urgent: true, key: 'rem_' + (p.programa || p.id) + '_sal_' + (s.label || '') });
        }
      });
    });
    document.getElementById('rec-count').textContent = items.length;
    const grouped = {};
    items.forEach(it => { (grouped[it.coord || 'Sin asignar'] = grouped[it.coord || 'Sin asignar'] || []).push(it); });
    const list = document.getElementById('reminders-list');
    if (items.length === 0) {
      list.innerHTML = `<div class="empty"><div class="big">✓</div>Sin recordatorios pendientes por ahora.</div>`;
      return;
    }
    list.innerHTML = Object.keys(grouped).sort().map(coord => `
      <div class="coord-group">
        <div class="coord-head"><span>${coord}</span><span>${grouped[coord].length}</span></div>
        ${grouped[coord].map(it => {
      const done = storageGet(it.key) === '1';
      return `<div class="alert-item ${done ? 'done' : ''}" data-key="${it.key}">
            <input type="checkbox" ${done ? 'checked' : ''}>
            <div>
              <div class="alert-title">${it.tipo} · ${it.periodo}${it.urgent ? ' <span class="pill red" style="margin-left:6px;">Vencida</span>' : ''}</div>
              <div class="alert-sub">${it.programa}</div>
            </div>
          </div>`;
    }).join("")}
      </div>
    `).join("");
    list.querySelectorAll('.alert-item input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const wrap = e.target.closest('.alert-item');
        const key = wrap.dataset.key;
        storageSet(key, e.target.checked ? '1' : '0');
        wrap.classList.toggle('done', e.target.checked);
      });
    });
  }

  // ---- Tabulaciones pendientes table (vencido + hoy + proximo) ----
  function buildTabTable() {
    const rows = [];
    activos.forEach((p, progIdx) => {
      if (!p) return;
      const calc = calcularEstadoTabulacionCurso(p);
      calc.sesionesDetalle.forEach(sd => {
        if (sd.estado === 'vencido' || sd.estado === 'hoy') {
          rows.push({
            periodo: sd.label,
            programa: p.programa || p.nombre_del_programa || 'Sin nombre',
            coord: p.coordinadora,
            estado: sd.estado,
            progIdx: progIdx,
            nrc: p.nrc || ''
          });
        }
      });
      // Si no hubo sesiones calculadas, usar tabulaciones legacy
      if (calc.sesionesDetalle.length === 0) {
        const tabs = Array.isArray(p.tabulaciones) ? p.tabulaciones : (p.tabulaciones ? Object.values(p.tabulaciones) : []);
        tabs.forEach(t => {
          if (t && (t.estado === 'vencido' || t.estado === 'hoy')) {
            rows.push({
              periodo: (t.label || '').replace(/^Tabulaci[oó]n\s*/i, ''),
              programa: p.programa || p.nombre_del_programa || 'Sin nombre',
              coord: p.coordinadora,
              estado: t.estado,
              progIdx: progIdx,
              nrc: p.nrc || ''
            });
          }
        });
      }
    });

    rows.sort((a, b) => (a.estado === 'vencido' ? 0 : 1) - (b.estado === 'vencido' ? 0 : 1));
    document.getElementById('tab-count').textContent = rows.length;
    const tbody = document.getElementById('tab-tbody');
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty">✓ ¡Excelente! Todas las listas de asistencia están tabuladas al día.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td><strong>${r.periodo}</strong></td>
        <td>
          <div style="font-weight:600;color:var(--slate-800);">${r.programa}</div>
          ${r.nrc ? `<div style="font-size:11px;color:var(--slate-500);">NRC: ${r.nrc}</div>` : ''}
        </td>
        <td>${r.coord || '—'}</td>
        <td>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
            ${statusPill('tab', r.estado)}
            <button type="button" class="btn btn-primary btn-sm btn-quick-tab-action" data-idx="${r.progIdx}" style="padding:2px 8px;font-size:11px;">
              Tabular ↗
            </button>
          </div>
        </td>
      </tr>
    `).join("");

    tbody.querySelectorAll('.btn-quick-tab-action').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        if (activos[idx]) openParticipantsModal(activos[idx], 'matriz');
      });
    });
  }

  // ---- Survey (Evaluaciones) panel ----
  function buildSurveyPanel() {
    const relevant = activos.filter(p => p && /curso|finaliz/i.test(p.estado || ""));
    document.getElementById('survey-count').textContent = relevant.length;
    const list = document.getElementById('survey-list');
    if (relevant.length === 0) {
      list.innerHTML = `<div class="empty">Aún no hay programas en curso o finalizados este mes.</div>`;
      return;
    }
    const options = ["Sin enviar", "Enviada", "En proceso", "Cerrada"];
    list.innerHTML = relevant.map(p => {
      const key = 'survey_' + (p.programa || p.id);
      const stored = storageGet(key) || (p.evaluaciones || "Sin enviar");
      return `<div class="alert-item" data-key="${key}">
        <div style="flex:1;">
          <div class="alert-title">${p.programa}</div>
          <div class="alert-sub">${p.coordinadora || ''}</div>
        </div>
        <select class="survey-select">
          ${options.map(o => `<option value="${o}" ${o === stored ? 'selected' : ''}>${o}</option>`).join("")}
        </select>
      </div>`;
    }).join("");
    list.querySelectorAll('.survey-select').forEach(sel => {
      sel.addEventListener('change', (e) => {
        const key = e.target.closest('.alert-item').dataset.key;
        storageSet(key, e.target.value);
      });
    });
  }

  // ---- Barra de Progreso de Carga en Google Drive ----
  let isDriveSyncActive = false;
  let userDismissedSyncCard = false;
  let driveQueuePendingCount = 0;

  function updateDriveSyncProgress(forceShow = false) {
    const card = document.getElementById('drive-sync-progress-card');
    const fill = document.getElementById('sync-progress-fill');
    const countEl = document.getElementById('sync-progress-count');
    const titleEl = document.getElementById('sync-progress-title');
    const detailEl = document.getElementById('sync-progress-detail');
    const spinner = document.getElementById('sync-spinner-icon');
    const checkIcon = document.getElementById('sync-check-icon');
    const quickBadge = document.getElementById('drive-sync-quick-badge');

    const total = activos ? activos.length : 0;
    // Un curso se considera montado en Google Drive si tiene su carpeta y planilla enlazadas
    const synced = activos ? activos.filter(p => p.drive_folder_url && p.asistencia_sheet_url).length : 0;
    const pending = total - synced;
    const pct = total > 0 ? Math.round((synced / total) * 100) : 0;

    // Actualizar badge rápido en la cabecera de la tabla
    if (quickBadge) {
      quickBadge.textContent = `📁 Drive: ${synced}/${total} (${pct}%)`;
      if (total > 0 && synced === total) {
        quickBadge.style.background = '#dcfce7';
        quickBadge.style.color = '#15803d';
        quickBadge.style.border = '1px solid #86efac';
      } else if (synced > 0) {
        quickBadge.style.background = '#e0e7ff';
        quickBadge.style.color = '#4338ca';
        quickBadge.style.border = '1px solid #c7d2fe';
      } else {
        quickBadge.style.background = '#fef3c7';
        quickBadge.style.color = '#b45309';
        quickBadge.style.border = '1px solid #fde68a';
      }
    }

    if (!card || !fill || !countEl) return;

    fill.style.width = `${pct}%`;
    countEl.textContent = `${synced} de ${total} cursos montados (${pct}%)`;

    if (forceShow) {
      userDismissedSyncCard = false;
      card.style.display = 'block';
    }

    // Auto-mostrar si hay sincronización activa o cola con pendientes y no ha sido descartada
    if ((isDriveSyncActive || driveQueuePendingCount > 0) && !userDismissedSyncCard) {
      card.style.display = 'block';
    }

    if (total === 0) {
      if (titleEl) titleEl.textContent = 'Sincronización con Google Drive';
      if (detailEl) detailEl.textContent = 'No hay cursos registrados en el tablero.';
      if (spinner) spinner.style.display = 'none';
      if (checkIcon) checkIcon.style.display = 'none';
      return;
    }

    if (synced === total) {
      if (titleEl) titleEl.textContent = '¡Todos los cursos están montados en Google Drive!';
      if (detailEl) detailEl.textContent = `✓ Los ${total} cursos tienen su carpeta y planilla de asistencia listas en Google Drive.`;
      if (spinner) spinner.style.display = 'none';
      if (checkIcon) checkIcon.style.display = 'inline-block';
      fill.style.background = 'linear-gradient(90deg, #10b981, #059669)';

      if (isDriveSyncActive) {
        isDriveSyncActive = false;
        setTimeout(() => {
          if (!isDriveSyncActive && synced === total && card) {
            card.style.display = 'none';
          }
        }, 7000);
      }
    } else {
      fill.style.background = 'linear-gradient(90deg, #6366f1, #06b6d4, #10b981)';
      if (spinner) spinner.style.display = 'inline-block';
      if (checkIcon) checkIcon.style.display = 'none';

      if (isDriveSyncActive || driveQueuePendingCount > 0) {
        if (titleEl) titleEl.textContent = 'Subiendo y montando cursos en Google Drive...';
        const qInfo = driveQueuePendingCount > 0 ? ` (${driveQueuePendingCount} pendientes en cola)` : '';
        if (detailEl) detailEl.textContent = `Sincronizando en tiempo real: ${synced} listos, faltan ${pending} curso(s)${qInfo}.`;
      } else {
        if (titleEl) titleEl.textContent = 'Estado de Google Drive';
        if (detailEl) detailEl.textContent = `${pending} curso(s) sin montar. Haz clic en "Sincronizar Drive" para crearlos automáticamente.`;
      }
    }
  }

  // Interacciones con la tarjeta de progreso
  const quickDriveBadge = document.getElementById('drive-sync-quick-badge');
  if (quickDriveBadge) {
    quickDriveBadge.addEventListener('click', () => {
      const card = document.getElementById('drive-sync-progress-card');
      if (card) {
        if (card.style.display === 'none') {
          userDismissedSyncCard = false;
          updateDriveSyncProgress(true);
        } else {
          card.style.display = 'none';
          userDismissedSyncCard = true;
        }
      }
    });
  }

  const btnCloseSyncProg = document.getElementById('btn-close-sync-progress');
  if (btnCloseSyncProg) {
    btnCloseSyncProg.addEventListener('click', () => {
      const card = document.getElementById('drive-sync-progress-card');
      if (card) card.style.display = 'none';
      userDismissedSyncCard = true;
    });
  }

  // ---- Central Refresh Function ----
  function refreshAll() {
    renderKPIs();
    renderTabsHeader();
    renderChips();
    renderMonthChips();
    renderTable();
    buildReminders();
    buildTabTable();
    buildSurveyPanel();
    updateDriveSyncProgress();
    if (typeof renderTvDashboard === 'function') {
      renderTvDashboard();
    }
    if (currentPartCourse && partModal && !partModal.hasAttribute('hidden') && typeof refreshParticipantsModalUI === 'function') {
      refreshParticipantsModalUI();
    }
  }
  refreshAll();

  // ---- Archive view ----
  const archiveMonths = Object.keys(DATA.archive);
  document.getElementById('archive-select').innerHTML = archiveMonths.map(m => `<option value="${m}">${m}</option>`).join("");
  if (archiveMonths.includes('Septiembre')) document.getElementById('archive-select').value = 'Septiembre';
  function renderArchive() {
    const month = document.getElementById('archive-select').value || archiveMonths[0];
    const rows = DATA.archive[month] || [];
    document.getElementById('archive-count').textContent = rows.length + " programas";
    const tbody = document.getElementById('archive-tbody');
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty">Sin programas registrados en ${month}.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(p => `
      <tr>
        <td>${p.programa}</td>
        <td>${p.coordinadora || '—'}</td>
        <td>${p.modalidad || '—'}</td>
        <td>${fmtDate(p.fecha_inicio)} – ${fmtDate(p.fecha_fin)}</td>
        <td>${estadoPill(p.estado)}</td>
        <td>${p.estado_facturacion ? p.estado_facturacion : '<span class="pill grey">Sin registrar</span>'}</td>
      </tr>
    `).join("");
  }
  document.getElementById('archive-select').addEventListener('change', renderArchive);
  renderArchive();

  // ---- Firebase Realtime Synchronization & Modal Logic ----

  function applyRealtimeUpdate(key, val, animate) {
    const items = document.querySelectorAll('.alert-item');
    items.forEach(wrap => {
      if (wrap.dataset.key !== key) return;

      // Checkbox (Recordatorios)
      const cb = wrap.querySelector('input[type=checkbox]');
      if (cb) {
        const isDone = (val === '1' || val === true);
        if (cb.checked !== isDone) {
          cb.checked = isDone;
        }
        wrap.classList.toggle('done', isDone);
        if (animate) {
          wrap.classList.remove('realtime-updated');
          void wrap.offsetWidth;
          wrap.classList.add('realtime-updated');
        }
      }

      // Select (Encuestas de satisfacción)
      const sel = wrap.querySelector('.survey-select');
      if (sel) {
        if (sel.value !== val) {
          sel.value = val;
        }
        if (animate) {
          wrap.classList.remove('realtime-updated');
          void wrap.offsetWidth;
          wrap.classList.add('realtime-updated');
        }
      }
    });
  }

  function setFirebaseUIStatus(status, text) {
    const dot = document.getElementById('firebase-dot');
    const label = document.getElementById('firebase-status-label');
    if (!dot || !label) return;
    dot.className = 'status-dot ' + (status || '');
    if (text) {
      label.textContent = text;
    } else if (status === 'connected') {
      label.textContent = 'Firebase: En tiempo real';
    } else if (status === 'connecting') {
      label.textContent = 'Firebase: Conectando...';
    } else if (status === 'error') {
      label.textContent = 'Firebase: Error';
    } else {
      label.textContent = 'Firebase: Desconectado';
    }
  }

  // Estado global para solicitudes de correo de apertura de curso
  var currentEmailRequests = {};
  var emailListenerInitialized = false;
  var isFirstEmailLoad = true;
  var knownEmailRequestIds = new Set();

  // Webhook de Google Apps Script para Google Drive en tiempo real
  var gasWebhookUrl = '';
  try { gasWebhookUrl = localStorage.getItem('cec_gas_webhook_url') || ''; } catch (e) { }

  function sendGasWebhook(payload) {
    if (!payload) return Promise.resolve(null);
    var url = (gasWebhookUrl || (function () {
      try { return localStorage.getItem('cec_gas_webhook_url') || ''; } catch (e) { return ''; }
    })()).trim();

    if (!url) {
      console.warn("Webhook no configurado aún en la web. Operación guardada en cola de Firebase.");
      return Promise.resolve(null);
    }

    return fetch(url, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function () {
      console.log("⚡ Webhook ejecutado en tiempo real en Google Drive:", payload.action);
      return { success: true };
    }).catch(function (err) {
      console.error("Error al enviar Webhook a Google Apps Script:", err);
    });
  }

  function updateWebhookStatusUI(connected, urlVal) {
    var badge = document.getElementById('gas-webhook-status-badge');
    var input = document.getElementById('gas-webhook-url-input');
    if (badge) {
      badge.className = connected ? 'pill green' : 'pill grey';
      badge.textContent = connected ? '✓ Conectado en tiempo real' : 'No configurado';
    }
    if (input && urlVal && !input.value) {
      input.value = urlVal;
    }
  }

  function initFirebase(config) {
    if (!window.firebase) {
      console.warn("SDK de Firebase no está disponible.");
      return;
    }
    if (!config || !config.apiKey || !config.databaseURL) {
      setFirebaseUIStatus('error', 'Falta configuración');
      return;
    }

    try {
      setFirebaseUIStatus('connecting', 'Conectando...');

      // Inicializar o reutilizar app
      if (!firebase.apps.length) {
        fbApp = firebase.initializeApp(config);
      } else {
        fbApp = firebase.app();
      }

      fbDb = firebase.database();

      // Monitor de conexión en vivo (.info/connected)
      fbDb.ref('.info/connected').on('value', (snap) => {
        if (snap.val() === true) {
          setFirebaseUIStatus('connected', 'Firebase: En tiempo real');
        } else {
          setFirebaseUIStatus('connecting', 'Firebase: Conectando...');
        }
      });

      // Escuchar configuración de Webhook en tiempo real desde Firebase
      fbDb.ref('config/gas_webhook_url').on('value', (snap) => {
        const val = snap.val();
        if (val && typeof val === 'string' && val.trim().startsWith('http')) {
          gasWebhookUrl = val.trim();
          try { localStorage.setItem('cec_gas_webhook_url', gasWebhookUrl); } catch (e) { }
          updateWebhookStatusUI(true, gasWebhookUrl);
        } else {
          updateWebhookStatusUI(false);
        }
      });

      // 1. Escuchar cambios en la colección de estados en tiempo real
      fbRef = fbDb.ref('tablero_estado');
      let initialLoad = true;

      fbRef.on('value', (snapshot) => {
        const data = snapshot.val();
        if (data) {
          Object.keys(data).forEach(safeKey => {
            const item = data[safeKey];
            if (item && item.key && item.valor !== undefined) {
              try { localStorage.setItem(item.key, item.valor); } catch (e) { }
              applyRealtimeUpdate(item.key, item.valor, !initialLoad);
            }
          });
        }
        initialLoad = false;
      }, (error) => {
        console.error("Error al escuchar Firebase Realtime:", error);
        setFirebaseUIStatus('error', 'Error en reglas/permisos');
      });

      // 2. Asegurar que los 12 meses (01_Enero a 12_Diciembre) existan ordenados de menor a mayor
      function asegurarMesesEnFirebase() {
        fbDb.ref('meses').once('value').then(snap => {
          const val = snap.val() || {};
          const updates = {};
          let hayCambios = false;

          // Si existían meses sin prefijo de orden (ej: "Enero"), migrarlos a "01_Enero"
          MESES_INFO.forEach(m => {
            if (val[m.name] && !val[m.key]) {
              updates['meses/' + m.key] = val[m.name];
              updates['meses/' + m.key + '/nombre'] = m.name;
              updates['meses/' + m.key + '/numero'] = m.num;
              updates['meses/' + m.name] = null;
              hayCambios = true;
            } else if (!val[m.key]) {
              updates['meses/' + m.key + '/nombre'] = m.name;
              updates['meses/' + m.key + '/numero'] = m.num;
              hayCambios = true;
            }
          });

          if (hayCambios) {
            fbDb.ref().update(updates);
          }
        }).catch(err => {
          console.error("Error al inicializar estructura de meses en Firebase:", err);
        });

        // Migrar automáticamente si existían programas en la raíz anterior
        fbDb.ref('programas').once('value').then(snap => {
          const oldData = snap.val();
          if (oldData && typeof oldData === 'object') {
            const updates = {};
            Object.keys(oldData).forEach(id => {
              const prog = oldData[id];
              if (prog && typeof prog === 'object') {
                const targetMesKey = getMesKey(prog.mes || prog.origen_mes || "Enero");
                const nodeKey = sanitizeFirebaseNodeKey(prog.programa || prog.nombre_del_programa || id);
                updates['meses/' + targetMesKey + '/programas/' + nodeKey] = prog;
                updates['programas/' + id] = null;
              }
            });
            fbDb.ref().update(updates);
          }
        }).catch(() => { });
      }
      asegurarMesesEnFirebase();

      function normalizeProgram(prog, id, mesContext) {
        if (!prog || typeof prog !== 'object') return null;
        const cleanMes = getMesNombreLimpio(prog.mes || prog.origen_mes || mesContext || "Enero");
        const mesKey = getMesKey(cleanMes);
        const nodeKey = id || sanitizeFirebaseNodeKey(prog.programa || prog.nombre_del_programa || prog.nombre || 'prog');
        const cleanId = `${mesKey}_${nodeKey}`;
        const nombre = (prog.programa || prog.nombre_del_programa || prog.nombre || nodeKey).toString().trim();
        const estado = prog.estado || "En preparación";

        // Tabulaciones seguras
        let tabs = prog.tabulaciones;
        if (tabs && typeof tabs === 'object' && !Array.isArray(tabs)) {
          tabs = Object.values(tabs);
        }
        if (!Array.isArray(tabs) || tabs.length === 0) {
          tabs = [
            { label: "Tabulación 1", valor: prog.tabulacion || "", estado: prog.tabulacion_st || "completo" },
            { label: "Tabulación 2", valor: prog.tabulacion_2 || "", estado: prog.tabulacion_2_st || "completo" },
            { label: "Tabulación 3", valor: prog.tabulacion_3 || "", estado: prog.tabulacion_3_st || "completo" },
            { label: "Tabulación 4", valor: prog.tabulacion_4 || "", estado: prog.tabulacion_4_st || "completo" },
            { label: "Tabulación 5", valor: prog.tabulacion_5 || "", estado: prog.tabulacion_5_st || "completo" }
          ];
        }
        const safeTabs = tabs.map((t, idx) => ({
          label: (t && t.label) ? t.label : `Tabulación ${idx + 1}`,
          valor: (t && t.valor) ? t.valor : "",
          estado: (t && t.estado) ? t.estado : "completo"
        }));

        // Salones seguros
        let sals = prog.salones;
        if (sals && typeof sals === 'object' && !Array.isArray(sals)) {
          sals = Object.values(sals);
        }
        if (!Array.isArray(sals) || sals.length === 0) {
          sals = [
            { label: "Salones 1", valor: prog.salones_1 || "", estado: prog.salones_1_st || "completo" },
            { label: "Salones 2", valor: prog.salones_2 || "", estado: prog.salones_2_st || "completo" },
            { label: "Salones 3", valor: prog.salones_3 || "", estado: prog.salones_3_st || "completo" },
            { label: "Salones 4", valor: prog.salones_4 || "", estado: prog.salones_4_st || "completo" }
          ];
        }
        const safeSals = sals.map((s, idx) => ({
          label: (s && s.label) ? s.label : `Salones ${idx + 1}`,
          valor: (s && s.valor) ? s.valor : "",
          estado: (s && s.estado) ? s.estado : "completo"
        }));

        // Análisis horario seguro
        const horarioTxt = (prog.horario || "").toString().trim();
        let an = prog.analisis_horario;
        if (!an || typeof an !== 'object') {
          an = parseHorarioBasico(horarioTxt);
        } else {
          const rawDias = Array.isArray(an.dias_detectados) ? an.dias_detectados : (an.dias_detectados && typeof an.dias_detectados === 'object' ? Object.values(an.dias_detectados) : []);
          const rawHoras = Array.isArray(an.horas) ? an.horas : (an.horas && typeof an.horas === 'object' ? Object.values(an.horas) : (horarioTxt ? [horarioTxt] : []));
          const rawFechas = Array.isArray(an.fechas_sesion) ? an.fechas_sesion : (an.fechas_sesion && typeof an.fechas_sesion === 'object' ? Object.values(an.fechas_sesion) : []);
          const rawNombres = Array.isArray(an.dias_nombres) ? an.dias_nombres : (an.dias_nombres && typeof an.dias_nombres === 'object' ? Object.values(an.dias_nombres) : []);

          an = {
            fechas_sesion: rawFechas,
            dias_detectados: rawDias,
            dias_nombres: rawNombres,
            horas: rawHoras,
            fuente: an.fuente || "manual",
            confianza: an.confianza || (rawDias.length > 0 ? "ok" : "revisar")
          };
          if (an.dias_detectados.length === 0 && horarioTxt) {
            const parsed = parseHorarioBasico(horarioTxt);
            if (parsed.dias_detectados.length > 0) {
              an.dias_detectados = parsed.dias_detectados;
              an.dias_nombres = parsed.dias_nombres;
              an.confianza = "ok";
            }
          }
        }

        // Horario estructurado seguro
        let horarioConfig = prog.horario_config || null;
        if (horarioConfig && typeof horarioConfig === 'object') {
          let diasList = horarioConfig.dias;
          if (diasList && typeof diasList === 'object' && !Array.isArray(diasList)) {
            diasList = Object.values(diasList);
          }
          if (Array.isArray(diasList)) {
            horarioConfig = {
              dias: diasList.map(d => ({
                dia: d.dia || "",
                diaIndex: parseInt(d.diaIndex, 10),
                tipo: d.tipo || prog.modalidad || "Presencial",
                horaInicio: d.horaInicio || "17:00",
                horaFin: d.horaFin || "21:00"
              }))
            };
          }
        }

        return {
          ...prog,
          id: cleanId,
          _nodeKey: nodeKey,
          _mesKey: mesKey,
          no: prog.no || "",
          nombre: prog.nombre || prog.nombre_contacto || "",
          nombre_contacto: prog.nombre_contacto || prog.nombre || "",
          celular: prog.celular || "",
          programa: nombre,
          nombre_del_programa: nombre,
          nrc: prog.nrc || "",
          modalidad: prog.modalidad || "",
          tipo: prog.tipo || prog.tipo_de_programa || "",
          tipo_de_programa: prog.tipo_de_programa || prog.tipo || "",
          coordinadora: prog.coordinadora || "",
          fecha_inicio: prog.fecha_inicio || "",
          fecha_inicio_disp: prog.fecha_inicio_disp || prog.fecha_inicio || "",
          fecha_fin: prog.fecha_fin || "",
          fecha_fin_disp: prog.fecha_fin_disp || prog.fecha_fin || "",
          horario: horarioTxt,
          horario_config: horarioConfig,
          estado: estado,
          estado_cat: (prog.estado_cat || estado).toLowerCase().replace(/\s+/g, '_'),
          mes: cleanMes,
          origen_mes: cleanMes,
          tabulaciones: safeTabs,
          salones: safeSals,
          analisis_horario: an,
          link: prog.link || prog.links_sesiones_virtuales || "",
          links_sesiones_virtuales: prog.links_sesiones_virtuales || prog.link || "",
          estado_facturacion: prog.estado_facturacion || "",
          comentarios_facturacion: prog.comentarios_facturacion || "",
          descuentos: prog.descuentos || "",
          evaluaciones: prog.evaluaciones || "Sin enviar"
        };
      }

      // 3. Escuchar cambios de todos los meses y sus tablas de programas en tiempo real
      let snapshotMeses = null;
      let snapshotRootProgramas = null;

      function syncAllPrograms() {
        const list = [];
        const seenKeys = new Set();

        // 3.1 Programas organizados por meses (estructura canónica)
        if (snapshotMeses && typeof snapshotMeses === 'object') {
          Object.keys(snapshotMeses).forEach(mesKey => {
            const mesData = snapshotMeses[mesKey];
            const cleanMes = getMesNombreLimpio(mesKey);
            if (mesData && mesData.programas && typeof mesData.programas === 'object') {
              Object.keys(mesData.programas).forEach(id => {
                const prog = mesData.programas[id];
                if (prog) {
                  const norm = normalizeProgram(prog, id, cleanMes);
                  const fullKey = `${mesKey}/${id}`;
                  if (norm && !seenKeys.has(fullKey)) {
                    seenKeys.add(fullKey);
                    list.push(norm);
                  }
                }
              });
            }
          });
        }

        // 3.2 Programas que pudieran existir en la raíz /programas
        if (snapshotRootProgramas && typeof snapshotRootProgramas === 'object') {
          Object.keys(snapshotRootProgramas).forEach(id => {
            const prog = snapshotRootProgramas[id];
            if (prog) {
              const norm = normalizeProgram(prog, id, prog.mes || prog.origen_mes || "Enero");
              const mKey = getMesKey(norm.mes || "Enero");
              const fullKey = `${mKey}/${id}`;
              if (norm && !seenKeys.has(fullKey)) {
                seenKeys.add(fullKey);
                list.push(norm);
              }
            }
          });
        }

        activos = list;
        refreshAll();
      }

      fbDb.ref('meses').on('value', (snapshot) => {
        snapshotMeses = snapshot.val();
        syncAllPrograms();
      }, (error) => {
        console.error("Error al escuchar Firebase Realtime (meses):", error);
        setFirebaseUIStatus('error', 'Error en reglas/permisos');
      });

      fbDb.ref('programas').on('value', (snapshot) => {
        snapshotRootProgramas = snapshot.val();
        syncAllPrograms();
      }, (error) => {
        console.error("Error al escuchar Firebase Realtime (programas):", error);
      });

      // Escuchar cola de creación de Drive para actualizar estado de subida en tiempo real
      fbDb.ref('cola_creacion_drive').on('value', (snapshot) => {
        const queue = snapshot.val();
        const pendingCount = queue ? Object.keys(queue).length : 0;
        driveQueuePendingCount = pendingCount;
        if (pendingCount > 0) {
          isDriveSyncActive = true;
          updateDriveSyncProgress(true);
        } else {
          updateDriveSyncProgress();
        }
      });

      if (typeof initEmailRequestsListener === 'function') {
        initEmailRequestsListener(fbDb);
      }

    } catch (err) {
      console.error("Error inicializando Firebase:", err);
      setFirebaseUIStatus('error', 'Error de config');
    }
  }

  // Estado visual de Firebase (indicador sin modal interactivo)
  const statusBtn = document.getElementById('firebase-status-btn');
  if (statusBtn) {
    statusBtn.style.cursor = 'default';
  }

  // ---- Program CRUD Modal Controller & Schedule Builder ----
  const progModal = document.getElementById('program-modal');
  const progForm = document.getElementById('prog-form');
  const progTitle = document.getElementById('prog-modal-title');
  const progClose = document.getElementById('prog-modal-close');
  const progCancel = document.getElementById('prog-btn-cancel');
  const progDelete = document.getElementById('prog-btn-delete');
  const btnNuevo = document.getElementById('btn-nuevo-programa');
  const btnMigrar = document.getElementById('btn-migrar-firebase');

  // Schedule builder elements
  const schedDayButtonsContainer = document.getElementById('sched-day-buttons');
  const schedSlotsListContainer = document.getElementById('sched-slots-list');
  const schedModalidadBadge = document.getElementById('sched-modalidad-badge');
  const schedPreviewText = document.getElementById('sched-preview-text');
  const schedStatsLine = document.getElementById('sched-stats-line');
  const btnToggleManual = document.getElementById('btn-toggle-manual-horario');
  const horarioInputEl = document.getElementById('f-horario');
  const modalidadSelectEl = document.getElementById('f-modalidad');
  const fechaInicioEl = document.getElementById('f-fecha-inicio');
  const fechaFinEl = document.getElementById('f-fecha-fin');

  let currentScheduleDays = [];
  let isManualHorarioMode = false;

  function renderScheduleBuilder() {
    const modalidad = modalidadSelectEl ? modalidadSelectEl.value : "Presencial";
    const isBlended = modalidad.toLowerCase() === "blended";

    // 1. Badge de modalidad
    if (schedModalidadBadge) {
      if (isBlended) {
        schedModalidadBadge.innerHTML = `Modalidad: <strong>Blended (Híbrido)</strong> · Define cada día`;
      } else {
        schedModalidadBadge.innerHTML = `Modalidad: <strong>${modalidad}</strong>`;
      }
    }

    // 2. Botones de días de la semana
    if (schedDayButtonsContainer) {
      schedDayButtonsContainer.innerHTML = SEMANA_DIAS.map(d => {
        const isSelected = currentScheduleDays.some(sd => sd.diaIndex === d.index);
        return `<button type="button" class="sched-day-btn ${isSelected ? 'active' : ''}" data-day-index="${d.index}">
          ${isSelected ? '✓ ' : ''}${d.key}
        </button>`;
      }).join('');

      schedDayButtonsContainer.querySelectorAll('.sched-day-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.dayIndex, 10);
          toggleScheduleDay(idx);
        });
      });
    }

    // 3. Lista de slots/tarjetas para cada día seleccionado
    if (schedSlotsListContainer) {
      if (currentScheduleDays.length === 0) {
        schedSlotsListContainer.innerHTML = `
          <div style="font-size:12px;color:var(--text-muted);font-style:italic;padding:8px 2px;">
            No has seleccionado días de clase todavía. Haz clic en los días arriba (ej. Lun, Mié, Sáb) para programarlos.
          </div>
        `;
      } else {
        schedSlotsListContainer.innerHTML = currentScheduleDays.map((sd, i) => {
          const duration = calcDurationHours(sd.horaInicio, sd.horaFin);
          const isPres = sd.tipo === "Presencial";

          return `
            <div class="sched-slot-card" data-slot-idx="${i}">
              <div class="sched-slot-head">
                <div class="sched-slot-day-name">
                  <span>📅</span> ${sd.dia}
                </div>

                ${isBlended ? `
                  <div class="sched-seg-control">
                    <button type="button" class="sched-seg-btn ${isPres ? 'active presencial' : ''}" data-set-tipo="Presencial" data-slot-idx="${i}">
                      🏢 Presencial
                    </button>
                    <button type="button" class="sched-seg-btn ${!isPres ? 'active remoto' : ''}" data-set-tipo="Remoto" data-slot-idx="${i}">
                      💻 Remoto
                    </button>
                  </div>
                ` : `
                  <span class="pill ${isPres ? 'blue' : 'green'}">
                    ${isPres ? '🏢 Presencial' : '💻 Remoto'}
                  </span>
                `}

                <button type="button" class="sched-slot-remove" data-remove-slot="${sd.diaIndex}" title="Quitar este día">✕</button>
              </div>

              <div class="sched-slot-body">
                <div class="sched-time-group">
                  <span class="sched-time-label">De:</span>
                  <input type="time" class="sched-time-input sched-input-inicio" value="${sd.horaInicio || '17:00'}" data-slot-idx="${i}">
                  <span class="sched-time-label">a:</span>
                  <input type="time" class="sched-time-input sched-input-fin" value="${sd.horaFin || '21:00'}" data-slot-idx="${i}">
                </div>

                <div class="sched-duration-badge">⏱️ ${duration}h</div>

                <div class="sched-presets-row">
                  <span class="sched-presets-label">Franjas:</span>
                  <button type="button" class="sched-preset-btn" data-slot-idx="${i}" data-h1="08:00" data-h2="12:00">08:00-12:00</button>
                  <button type="button" class="sched-preset-btn" data-slot-idx="${i}" data-h1="14:00" data-h2="18:00">14:00-18:00</button>
                  <button type="button" class="sched-preset-btn" data-slot-idx="${i}" data-h1="17:00" data-h2="21:00">17:00-21:00</button>
                  <button type="button" class="sched-preset-btn" data-slot-idx="${i}" data-h1="18:00" data-h2="21:30">18:00-21:30</button>
                  <button type="button" class="sched-preset-btn" data-slot-idx="${i}" data-h1="08:00" data-h2="13:00">08:00-13:00</button>
                </div>

                ${currentScheduleDays.length > 1 ? `
                  <button type="button" class="sched-copy-btn" data-copy-slot="${i}" title="Aplicar esta misma franja horaria a todos los demás días">
                    📋 Copiar horario a los demás días
                  </button>
                ` : ''}
              </div>
            </div>
          `;
        }).join('');

        // Eventos inputs de tiempo
        schedSlotsListContainer.querySelectorAll('.sched-input-inicio').forEach(inp => {
          inp.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.slotIdx, 10);
            if (currentScheduleDays[idx]) {
              currentScheduleDays[idx].horaInicio = e.target.value;
              updateScheduleBuilderStatsAndPreview();
            }
          });
        });

        schedSlotsListContainer.querySelectorAll('.sched-input-fin').forEach(inp => {
          inp.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.slotIdx, 10);
            if (currentScheduleDays[idx]) {
              currentScheduleDays[idx].horaFin = e.target.value;
              updateScheduleBuilderStatsAndPreview();
            }
          });
        });

        // Eventos segmented controls
        schedSlotsListContainer.querySelectorAll('.sched-seg-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.slotIdx, 10);
            const tipo = btn.dataset.setTipo;
            if (currentScheduleDays[idx]) {
              currentScheduleDays[idx].tipo = tipo;
              renderScheduleBuilder();
            }
          });
        });

        // Eventos quitar día
        schedSlotsListContainer.querySelectorAll('.sched-slot-remove').forEach(btn => {
          btn.addEventListener('click', () => {
            const dayIdx = parseInt(btn.dataset.removeSlot, 10);
            toggleScheduleDay(dayIdx);
          });
        });

        // Eventos franjas rápidas
        schedSlotsListContainer.querySelectorAll('.sched-preset-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.slotIdx, 10);
            if (currentScheduleDays[idx]) {
              currentScheduleDays[idx].horaInicio = btn.dataset.h1;
              currentScheduleDays[idx].horaFin = btn.dataset.h2;
              renderScheduleBuilder();
            }
          });
        });

        // Eventos copiar franja a los demás días
        schedSlotsListContainer.querySelectorAll('.sched-copy-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.copySlot, 10);
            replicateScheduleTime(idx);
          });
        });
      }
    }

    updateScheduleBuilderStatsAndPreview();
  }

  function updateScheduleBuilderStatsAndPreview() {
    const modalidad = modalidadSelectEl ? modalidadSelectEl.value : "Presencial";
    const generatedTxt = buildScheduleReadableText(currentScheduleDays, modalidad);

    if (schedPreviewText) {
      schedPreviewText.textContent = generatedTxt || "Selecciona al menos un día de clase arriba para configurar el horario.";
    }

    if (!isManualHorarioMode && horarioInputEl) {
      horarioInputEl.value = generatedTxt;
    }

    if (schedSlotsListContainer) {
      schedSlotsListContainer.querySelectorAll('.sched-slot-card').forEach((card, idx) => {
        const sd = currentScheduleDays[idx];
        if (sd) {
          const durBadge = card.querySelector('.sched-duration-badge');
          if (durBadge) durBadge.textContent = `⏱️ ${calcDurationHours(sd.horaInicio, sd.horaFin)}h`;
        }
      });
    }

    if (schedStatsLine) {
      const fi = fechaInicioEl ? fechaInicioEl.value : "";
      const ff = fechaFinEl ? fechaFinEl.value : "";
      if (fi && ff && currentScheduleDays.length > 0) {
        const sessions = calculateSessionDates(fi, ff, currentScheduleDays);
        const weeklyHours = currentScheduleDays.reduce((acc, d) => acc + calcDurationHours(d.horaInicio, d.horaFin), 0);
        const avgPerDay = currentScheduleDays.length > 0 ? (weeklyHours / currentScheduleDays.length) : 0;
        const totalEstHours = Math.round(sessions.length * avgPerDay);
        schedStatsLine.style.display = 'flex';
        schedStatsLine.innerHTML = `
          <span class="sched-stat-pill">📅 ${sessions.length} sesiones estimadas</span>
          <span class="sched-stat-pill">⏱️ ~${totalEstHours} horas totales</span>
          <span class="sched-stat-pill">⚡ ${weeklyHours}h / semana</span>
        `;
      } else {
        schedStatsLine.style.display = 'none';
      }
    }
  }

  function toggleScheduleDay(diaIndex) {
    const exists = currentScheduleDays.some(d => d.diaIndex === diaIndex);
    if (exists) {
      currentScheduleDays = currentScheduleDays.filter(d => d.diaIndex !== diaIndex);
    } else {
      const dayDef = SEMANA_DIAS.find(d => d.index === diaIndex);
      if (!dayDef) return;
      const modalidad = modalidadSelectEl ? modalidadSelectEl.value : "Presencial";
      let tipo = (modalidad === "Remoto") ? "Remoto" : "Presencial";

      if (modalidad === "Blended") {
        const hasPres = currentScheduleDays.some(d => d.tipo === "Presencial");
        const hasRem = currentScheduleDays.some(d => d.tipo === "Remoto");
        if (hasPres && !hasRem) tipo = "Remoto";
        else tipo = "Presencial";
      }

      let h1 = "17:00", h2 = "21:00";
      if (diaIndex === 5) {
        h1 = "08:00"; h2 = "12:00";
      } else if (currentScheduleDays.length > 0) {
        h1 = currentScheduleDays[0].horaInicio || "17:00";
        h2 = currentScheduleDays[0].horaFin || "21:00";
      }

      currentScheduleDays.push({
        dia: dayDef.nombre,
        diaIndex: diaIndex,
        tipo: tipo,
        horaInicio: h1,
        horaFin: h2
      });

      currentScheduleDays.sort((a, b) => a.diaIndex - b.diaIndex);
    }
    renderScheduleBuilder();
  }

  function replicateScheduleTime(fromSlotIdx) {
    const src = currentScheduleDays[fromSlotIdx];
    if (!src) return;
    currentScheduleDays.forEach((d, i) => {
      if (i !== fromSlotIdx) {
        d.horaInicio = src.horaInicio;
        d.horaFin = src.horaFin;
      }
    });
    renderScheduleBuilder();
  }

  // Cambio de modalidad en formulario
  if (modalidadSelectEl) {
    modalidadSelectEl.addEventListener('change', () => {
      const newMod = modalidadSelectEl.value;
      if (newMod === "Presencial") {
        currentScheduleDays.forEach(d => d.tipo = "Presencial");
      } else if (newMod === "Remoto") {
        currentScheduleDays.forEach(d => d.tipo = "Remoto");
      } else if (newMod === "Blended") {
        if (currentScheduleDays.length >= 2 && currentScheduleDays.every(d => d.tipo === currentScheduleDays[0].tipo)) {
          currentScheduleDays[0].tipo = "Presencial";
          currentScheduleDays[1].tipo = "Remoto";
        }
      }
      renderScheduleBuilder();
    });
  }

  // Alternar edición manual de texto de horario
  if (btnToggleManual && horarioInputEl) {
    btnToggleManual.addEventListener('click', () => {
      isManualHorarioMode = !isManualHorarioMode;
      horarioInputEl.style.display = isManualHorarioMode ? 'block' : 'none';
      btnToggleManual.textContent = isManualHorarioMode ? '🤖 Usar diseñador automático' : '✏️ Editar texto manualmente';
      if (!isManualHorarioMode) {
        horarioInputEl.value = buildScheduleReadableText(currentScheduleDays, modalidadSelectEl ? modalidadSelectEl.value : 'Presencial');
      }
    });
  }

  function openProgramModal(p) {
    if (!progModal) return;
    progModal.removeAttribute('hidden');
    isManualHorarioMode = false;
    if (horarioInputEl) horarioInputEl.style.display = 'none';
    if (btnToggleManual) btnToggleManual.textContent = '✏️ Editar texto manualmente';

    if (!p) {
      progTitle.textContent = "➕ Nuevo Programa";
      if (progForm) progForm.reset();
      const idEl = document.getElementById('f-id');
      if (idEl) {
        idEl.value = "";
        idEl.dataset.nodeKey = "";
        idEl.dataset.mesKey = "";
      }
      const mesSelect = document.getElementById('f-mes');
      if (mesSelect) {
        mesSelect.value = (activeMonth !== "Todos") ? activeMonth : "Enero";
      }
      currentScheduleDays = [];
      renderScheduleBuilder();
      const drivePanel = document.getElementById('drive-links-panel');
      if (drivePanel) drivePanel.style.display = 'none';
      const autoDriveChk = document.getElementById('f-auto-create-drive');
      if (autoDriveChk) autoDriveChk.checked = true;
      if (progDelete) progDelete.style.display = "none";
      return;
    }

    progTitle.textContent = "✏️ Editar: " + p.programa;
    const idEl = document.getElementById('f-id');
    if (idEl) {
      idEl.value = p.id || "";
      idEl.dataset.nodeKey = p._nodeKey || p.id || sanitizeFirebaseNodeKey(p.programa || "");
      idEl.dataset.mesKey = p._mesKey || getMesKey(p.mes || p.origen_mes || "Enero");
    }
    document.getElementById('f-programa').value = p.programa || p.nombre_del_programa || "";
    document.getElementById('f-no').value = p.no || "";
    document.getElementById('f-nrc').value = p.nrc || "";
    document.getElementById('f-coordinadora').value = p.coordinadora || "";
    document.getElementById('f-modalidad').value = p.modalidad || "Presencial";
    document.getElementById('f-tipo').value = p.tipo || p.tipo_de_programa || "";
    const mesSelect = document.getElementById('f-mes');
    if (mesSelect) {
      mesSelect.value = getMesNombreLimpio(p.mes || p.origen_mes || "Enero");
    }
    document.getElementById('f-estado').value = p.estado || "En curso";
    document.getElementById('f-nombre-contacto').value = p.nombre_contacto || p.nombre || "";
    document.getElementById('f-celular').value = p.celular || "";
    document.getElementById('f-fecha-inicio').value = p.fecha_inicio || "";
    document.getElementById('f-fecha-fin').value = p.fecha_fin || "";
    document.getElementById('f-horario').value = p.horario || "";
    document.getElementById('f-link').value = p.link || p.links_sesiones_virtuales || "";

    // Cargar horario en el Schedule Builder
    if (p.horario_config && Array.isArray(p.horario_config.dias) && p.horario_config.dias.length > 0) {
      currentScheduleDays = JSON.parse(JSON.stringify(p.horario_config.dias));
    } else if (p.horario) {
      currentScheduleDays = parseHorarioToConfig(p.horario, p.modalidad);
    } else {
      currentScheduleDays = [];
    }
    renderScheduleBuilder();

    const tabs = Array.isArray(p.tabulaciones) ? p.tabulaciones : (p.tabulaciones ? Object.values(p.tabulaciones) : []);
    for (let i = 1; i <= 5; i++) {
      const tab = (tabs && tabs[i - 1]) || { valor: "", estado: "completo" };
      const valEl = document.getElementById(`f-tab-${i}-val`);
      const stEl = document.getElementById(`f-tab-${i}-st`);
      if (valEl) valEl.value = tab.valor || "";
      if (stEl) stEl.value = tab.estado || "completo";
    }

    const sals = Array.isArray(p.salones) ? p.salones : (p.salones ? Object.values(p.salones) : []);
    for (let i = 1; i <= 4; i++) {
      const sal = (sals && sals[i - 1]) || { valor: "", estado: "completo" };
      const valEl = document.getElementById(`f-sal-${i}-val`);
      const stEl = document.getElementById(`f-sal-${i}-st`);
      if (valEl) valEl.value = sal.valor || "";
      if (stEl) stEl.value = sal.estado || "completo";
    }

    document.getElementById('f-facturacion-estado').value = p.estado_facturacion || "";
    document.getElementById('f-facturacion-comentarios').value = p.comentarios_facturacion || "";
    document.getElementById('f-descuentos').value = p.descuentos || "";
    document.getElementById('f-evaluaciones').value = p.evaluaciones || "Sin enviar";

    // Panel Google Drive & Asistencia
    const drivePanel = document.getElementById('drive-links-panel');
    const linkFolder = document.getElementById('link-drive-folder');
    const linkSheet = document.getElementById('link-drive-sheet');
    const btnDownloadXlsx = document.getElementById('btn-download-asistencia-xlsx');
    const autoDriveChk = document.getElementById('f-auto-create-drive');

    if (drivePanel) {
      drivePanel.style.display = 'block';
      if (linkFolder) {
        linkFolder.href = p.drive_folder_url || '#';
        linkFolder.style.display = p.drive_folder_url ? 'inline-flex' : 'none';
      }
      if (linkSheet) {
        linkSheet.href = p.asistencia_sheet_url || '#';
        linkSheet.style.display = p.asistencia_sheet_url ? 'inline-flex' : 'none';
      }
    }
    if (autoDriveChk) {
      autoDriveChk.checked = !p.drive_folder_url;
    }
    if (btnDownloadXlsx) {
      btnDownloadXlsx.onclick = () => exportarPlanillaAsistenciaXLSX(p);
    }

    if (progDelete) progDelete.style.display = "inline-block";
  }

  function closeProgramModal() {
    if (progModal) progModal.setAttribute('hidden', '');
  }

  // Auto-sincronizar mes y recalculador a partir de fechas
  if (fechaInicioEl) {
    fechaInicioEl.addEventListener('change', (e) => {
      if (e.target.value) {
        const m = parseInt(e.target.value.split('-')[1], 10);
        const MESES_MAP = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
        if (m >= 1 && m <= 12) {
          const mesSelect = document.getElementById('f-mes');
          if (mesSelect) mesSelect.value = MESES_MAP[m - 1];
        }
      }
      updateScheduleBuilderStatsAndPreview();
    });
  }

  if (fechaFinEl) {
    fechaFinEl.addEventListener('change', updateScheduleBuilderStatsAndPreview);
  }

  if (btnNuevo) {
    btnNuevo.addEventListener('click', () => openProgramModal(null));
  }
  if (progClose) progClose.addEventListener('click', closeProgramModal);
  if (progCancel) progCancel.addEventListener('click', closeProgramModal);
  if (progModal) {
    progModal.addEventListener('click', (e) => {
      if (e.target === progModal) closeProgramModal();
    });
  }

  if (progForm) {
    progForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const nombre = document.getElementById('f-programa').value.trim();
      const estado = document.getElementById('f-estado').value;
      const modalidadVal = document.getElementById('f-modalidad').value.trim();
      const mesValLimpio = getMesNombreLimpio(document.getElementById('f-mes').value);
      const mesKey = getMesKey(mesValLimpio);

      const horarioTxt = isManualHorarioMode
        ? document.getElementById('f-horario').value.trim()
        : (buildScheduleReadableText(currentScheduleDays, modalidadVal) || document.getElementById('f-horario').value.trim());

      const horarioParsed = parseHorarioBasico(horarioTxt);
      const fi = document.getElementById('f-fecha-inicio').value;
      const ff = document.getElementById('f-fecha-fin').value;
      const calculatedSessions = calculateSessionDates(fi, ff, currentScheduleDays);

      // El título/nodo en Firebase es el nombre del programa
      const progTitleKey = sanitizeFirebaseNodeKey(nombre);
      const existingId = document.getElementById('f-id').value;

      const tabulaciones = [];
      for (let i = 1; i <= 5; i++) {
        const val = document.getElementById(`f-tab-${i}-val`).value.trim();
        const st = document.getElementById(`f-tab-${i}-st`).value;
        tabulaciones.push({ label: `Tabulación ${i}`, valor: val, estado: st });
      }

      const salones = [];
      for (let i = 1; i <= 4; i++) {
        const val = document.getElementById(`f-sal-${i}-val`).value.trim();
        const st = document.getElementById(`f-sal-${i}-st`).value;
        salones.push({ label: `Salones ${i}`, valor: val, estado: st });
      }

      const tab1Val = document.getElementById('f-tab-1-val').value.trim();
      const tab2Val = document.getElementById('f-tab-2-val').value.trim();
      const tab3Val = document.getElementById('f-tab-3-val').value.trim();
      const tab4Val = document.getElementById('f-tab-4-val').value.trim();
      const tab5Val = document.getElementById('f-tab-5-val').value.trim();

      const sal1Val = document.getElementById('f-sal-1-val').value.trim();
      const sal2Val = document.getElementById('f-sal-2-val').value.trim();
      const sal3Val = document.getElementById('f-sal-3-val').value.trim();
      const sal4Val = document.getElementById('f-sal-4-val').value.trim();

      const idEl = document.getElementById('f-id');
      const prevNodeKey = (idEl && idEl.dataset.nodeKey) ? idEl.dataset.nodeKey : null;
      const prevMesKey = (idEl && idEl.dataset.mesKey) ? idEl.dataset.mesKey : null;

      const prev = activos.find(p => (existingId && p.id === existingId) || (prevNodeKey && p._nodeKey === prevNodeKey && p._mesKey === prevMesKey) || (p.programa === nombre && getMesKey(p.mes) === mesKey));
      const effectivePrevMesKey = prevMesKey || (prev ? (prev._mesKey || getMesKey(prev.mes || prev.origen_mes)) : null);
      const effectivePrevNodeKey = prevNodeKey || (prev ? (prev._nodeKey || prev.id || sanitizeFirebaseNodeKey(prev.programa)) : null);

      const analysisFinal = {
        fechas_sesion: calculatedSessions.length ? calculatedSessions : ((prev && prev.analisis_horario && prev.analisis_horario.fechas_sesion) || []),
        dias_detectados: currentScheduleDays.length ? currentScheduleDays.map(d => d.diaIndex) : horarioParsed.dias_detectados,
        dias_nombres: currentScheduleDays.length ? currentScheduleDays.map(d => d.dia) : horarioParsed.dias_nombres,
        horas: currentScheduleDays.length
          ? currentScheduleDays.map(d => `${d.dia}: ${formatTime12h(d.horaInicio)} - ${formatTime12h(d.horaFin)}${modalidadVal === 'Blended' ? ' (' + d.tipo + ')' : ''}`)
          : horarioParsed.horas,
        fuente: currentScheduleDays.length ? "configurador" : "manual",
        confianza: (currentScheduleDays.length > 0 || horarioParsed.confianza === "ok") ? "ok" : "revisar"
      };

      const updated = {
        ...(prev || {}),
        id: progTitleKey,
        no: document.getElementById('f-no').value.trim(),
        nombre: document.getElementById('f-nombre-contacto').value.trim(),
        nombre_contacto: document.getElementById('f-nombre-contacto').value.trim(),
        celular: document.getElementById('f-celular').value.trim(),
        programa: nombre,
        nombre_del_programa: nombre,
        nrc: document.getElementById('f-nrc').value.trim(),
        modalidad: modalidadVal,
        tipo: document.getElementById('f-tipo').value.trim(),
        tipo_de_programa: document.getElementById('f-tipo').value.trim(),
        coordinadora: document.getElementById('f-coordinadora').value.trim(),
        fecha_inicio: fi,
        fecha_inicio_disp: fi,
        fecha_fin: ff,
        fecha_fin_disp: ff,
        horario: horarioTxt,
        horario_config: { dias: currentScheduleDays },
        estado: estado,
        estado_cat: estado.toLowerCase().replace(/\s+/g, '_'),
        mes: mesValLimpio,
        origen_mes: mesValLimpio,
        // Tabulaciones 1 a 5
        tabulacion: tab1Val,
        tabulacion_2: tab2Val,
        tabulacion_3: tab3Val,
        tabulacion_4: tab4Val,
        tabulacion_5: tab5Val,
        tabulaciones: tabulaciones,
        // Links
        link: document.getElementById('f-link').value.trim(),
        links_sesiones_virtuales: document.getElementById('f-link').value.trim(),
        // Salones 1 a 4
        salones_1: sal1Val,
        salones_2: sal2Val,
        salones_3: sal3Val,
        salones_4: sal4Val,
        salones: salones,
        // Facturación, comentarios, descuentos y evaluaciones
        estado_facturacion: document.getElementById('f-facturacion-estado').value.trim(),
        comentarios_facturacion: document.getElementById('f-facturacion-comentarios').value.trim(),
        descuentos: document.getElementById('f-descuentos').value.trim(),
        evaluaciones: document.getElementById('f-evaluaciones').value,
        analisis_horario: analysisFinal
      };

      if (fbDb) {
        const updates = {};
        // Si el programa cambió de mes o cambió de nombre, borrar el nodo anterior
        const targetNodeKey = sanitizeFirebaseNodeKey(nombre);
        if (effectivePrevMesKey && effectivePrevNodeKey && (effectivePrevMesKey !== mesKey || effectivePrevNodeKey !== targetNodeKey)) {
          updates['meses/' + effectivePrevMesKey + '/programas/' + effectivePrevNodeKey] = null;
        }
        updates['meses/' + mesKey + '/programas/' + targetNodeKey] = updated;

        // Si está marcado crear en Google Drive, registrar en la cola de creación y disparar Webhook en tiempo real
        const autoDrive = document.getElementById('f-auto-create-drive');
        if (autoDrive && autoDrive.checked) {
          const isNewProg = !existingId;
          const currentProgObj = activos.find(p => p.id === existingId || p.id === progTitleKey || p.programa === nombre) || {};
          const drivePayload = {
            action: isNewProg ? 'create' : 'edit',
            ...updated,
            folderId: currentProgObj.drive_folder_id || '',
            nodeKey: targetNodeKey,
            mesKey: mesKey,
            solicitado_el: new Date().toISOString()
          };
          updates['cola_creacion_drive/' + targetNodeKey] = drivePayload;
          sendGasWebhook(drivePayload);
        }

        fbDb.ref().update(updates).then(() => {
          closeProgramModal();
        }).catch(err => {
          alert("Error guardando en Firebase: " + err.message);
        });
      } else {
        const idx = activos.findIndex(p => p.id === existingId || p.id === progTitleKey || p.programa === nombre);
        if (idx >= 0) activos[idx] = updated;
        else activos.unshift(updated);
        refreshAll();
        closeProgramModal();
      }
    });
  }

  if (progDelete) {
    progDelete.addEventListener('click', () => {
      const nombre = document.getElementById('f-programa').value.trim();
      const idEl = document.getElementById('f-id');
      const existingId = idEl ? idEl.value : "";
      const progTitleKey = (idEl && idEl.dataset.nodeKey) ? idEl.dataset.nodeKey : sanitizeFirebaseNodeKey(nombre);
      const mesValLimpio = getMesNombreLimpio(document.getElementById('f-mes').value);
      const mesKey = (idEl && idEl.dataset.mesKey) ? idEl.dataset.mesKey : getMesKey(mesValLimpio);
      if (!nombre && !progTitleKey) return;
      if (confirm(`¿Deseas eliminar permanentemente el programa "${nombre}"?`)) {
        if (fbDb) {
          const currentProg = activos.find(p => p.id === existingId || p.id === progTitleKey || p.programa === nombre) || {};
          const delUpdates = {};
          delUpdates['meses/' + mesKey + '/programas/' + progTitleKey] = null;
          const delPayload = {
            action: 'delete',
            folderId: currentProg.drive_folder_id || '',
            folderUrl: currentProg.drive_folder_url || '',
            nombre: nombre,
            nrc: currentProg.nrc || '',
            mes: mesValLimpio,
            mesKey: mesKey,
            nodeKey: progTitleKey,
            solicitado_el: new Date().toISOString()
          };
          delUpdates['cola_eliminacion_drive/' + progTitleKey] = delPayload;

          // Disparar Webhook en tiempo real para eliminar carpeta de Drive inmediatamente
          sendGasWebhook(delPayload);

          fbDb.ref().update(delUpdates).then(() => {
            closeProgramModal();
          }).catch(err => {
            alert("Error eliminando: " + err.message);
          });
        } else {
          activos = activos.filter(p => p.id !== progTitleKey && p.programa !== nombre);
          refreshAll();
          closeProgramModal();
        }
      }
    });
  }

  // Botón Sincronizar todos los cursos a Google Drive
  const btnSyncAllDrive = document.getElementById('btn-sync-all-drive');
  if (btnSyncAllDrive) {
    btnSyncAllDrive.addEventListener('click', () => {
      if (!fbDb) {
        alert("Firebase no está conectado.");
        return;
      }
      if (!activos || activos.length === 0) {
        alert("No hay cursos en el tablero para sincronizar.");
        return;
      }

      const pending = activos.filter(p => !p.drive_folder_url || !p.asistencia_sheet_url);
      if (pending.length === 0) {
        alert(`✓ Los ${activos.length} cursos ya cuentan con carpeta y planilla en Google Drive.`);
        return;
      }

      if (confirm(`Se encontraron ${pending.length} curso(s) sin montar en Google Drive.\n\n¿Deseas montarlos en Google Drive en tiempo real ahora?`)) {
        btnSyncAllDrive.disabled = true;
        btnSyncAllDrive.innerHTML = '<span>⏳</span> Sincronizando...';
        isDriveSyncActive = true;
        userDismissedSyncCard = false;
        driveQueuePendingCount = pending.length;
        updateDriveSyncProgress(true);

        const queueUpdates = {};
        const batchItems = [];
        pending.forEach(prog => {
          const mesKey = prog._mesKey || getMesKey(prog.mes || prog.origen_mes || "Enero");
          const nodeKey = prog._nodeKey || prog.id || sanitizeFirebaseNodeKey(prog.programa);
          const queueItem = {
            ...prog,
            nodeKey: nodeKey,
            mesKey: mesKey,
            solicitado_el: new Date().toISOString()
          };
          queueUpdates['cola_creacion_drive/' + nodeKey] = queueItem;
          batchItems.push(queueItem);
        });

        // Disparar Webhook en tiempo real para procesar lote inmediatamente
        sendGasWebhook({
          action: 'batch_create',
          items: batchItems
        });

        fbDb.ref().update(queueUpdates).then(() => {
          btnSyncAllDrive.disabled = false;
          btnSyncAllDrive.innerHTML = '<span>📁</span> Sincronizar Drive';
          const detailEl = document.getElementById('sync-progress-detail');
          if (detailEl) detailEl.textContent = `⚡ Webhook enviado. Creando ${pending.length} carpetas y planillas en Google Drive en vivo...`;
        }).catch(err => {
          btnSyncAllDrive.disabled = false;
          btnSyncAllDrive.innerHTML = '<span>📁</span> Sincronizar Drive';
          alert("Error al encolar cursos: " + err.message);
        });
      }
    });
  }

  // Botón Vaciar Base de Datos (Comenzar de cero clasificado por meses)
  const btnLimpiar = document.getElementById('btn-limpiar-db');
  if (btnLimpiar) {
    btnLimpiar.addEventListener('click', () => {
      const confirmMsg = fbDb
        ? "⚠️ ¿Estás seguro de que deseas reiniciar la Realtime Database?\n\nSe restablecerán los 12 meses (01_Enero a 12_Diciembre) vacíos y se solicitará la eliminación de las carpetas de Drive en tiempo real."
        : "⚠️ ¿Deseas vaciar todos los datos locales para iniciar una base de datos vacía clasificada por meses?";
      if (confirm(confirmMsg)) {
        if (fbDb) {
          const mesesTree = {};
          MESES_INFO.forEach(m => {
            mesesTree[m.key] = {
              nombre: m.name,
              numero: m.num
            };
          });

          const delQueueKey = 'vaciar_' + Date.now();
          const delDriveUpdate = {};
          delDriveUpdate['cola_eliminacion_drive/' + delQueueKey] = {
            action: 'vaciar_todo',
            solicitado_el: new Date().toISOString()
          };

          // Disparar Webhook en tiempo real para vaciar carpetas de Drive
          sendGasWebhook({ action: 'vaciar_todo' });

          Promise.all([
            fbDb.ref('meses').set(mesesTree),
            fbDb.ref('programas').remove(),
            fbDb.ref('tablero_estado').set(null),
            fbDb.ref('cola_creacion_drive').remove(),
            fbDb.ref().update(delDriveUpdate)
          ]).then(() => {
            activos = [];
            try { localStorage.clear(); } catch (e) { }
            refreshAll();
            alert("✓ Base de datos reiniciada: Todos los meses de Enero a Diciembre están ordenados de menor a mayor (01 a 12) y vacíos.");
          }).catch(err => {
            alert("Error al reiniciar base de datos en Firebase: " + err.message);
          });
        } else {
          activos = [];
          try { localStorage.clear(); } catch (e) { }
          refreshAll();
          alert("✓ Base de datos vaciada con éxito.");
        }
      }
    });
  }

  // Controladores de UI para el Webhook de Google Apps Script
  const btnSaveWebhook = document.getElementById('btn-save-gas-webhook');
  const btnTestWebhook = document.getElementById('btn-test-gas-webhook');
  const inputWebhook = document.getElementById('gas-webhook-url-input');
  const feedbackWebhook = document.getElementById('gas-webhook-feedback');

  if (btnSaveWebhook && inputWebhook) {
    if (gasWebhookUrl) {
      inputWebhook.value = gasWebhookUrl;
      updateWebhookStatusUI(true, gasWebhookUrl);
    }

    btnSaveWebhook.addEventListener('click', () => {
      const val = inputWebhook.value.trim();
      if (!val) {
        alert("Por favor ingresa la URL de tu Webhook de Google Apps Script.");
        return;
      }
      if (!val.startsWith('http')) {
        alert("La URL debe comenzar con https://");
        return;
      }
      gasWebhookUrl = val;
      try { localStorage.setItem('cec_gas_webhook_url', val); } catch (e) { }
      if (fbDb) {
        fbDb.ref('config/gas_webhook_url').set(val).then(() => {
          updateWebhookStatusUI(true, val);
          if (feedbackWebhook) {
            feedbackWebhook.style.display = 'block';
            feedbackWebhook.style.background = '#ecfdf5';
            feedbackWebhook.style.color = '#065f46';
            feedbackWebhook.style.border = '1px solid #a7f3d0';
            feedbackWebhook.innerHTML = '✅ <strong>Webhook guardado en Firebase:</strong> Creación, edición y eliminación operarán en tiempo real.';
            setTimeout(() => { feedbackWebhook.style.display = 'none'; }, 6000);
          }
        }).catch(err => {
          alert("Error guardando en Firebase: " + err.message);
        });
      } else {
        updateWebhookStatusUI(true, val);
        alert("Webhook guardado localmente.");
      }
    });
  }

  if (btnTestWebhook && inputWebhook) {
    btnTestWebhook.addEventListener('click', () => {
      const val = inputWebhook.value.trim() || gasWebhookUrl;
      if (!val) {
        alert("Por favor ingresa la URL del Webhook primero.");
        return;
      }
      btnTestWebhook.disabled = true;
      btnTestWebhook.textContent = 'Probando...';
      if (feedbackWebhook) {
        feedbackWebhook.style.display = 'block';
        feedbackWebhook.style.background = '#eff6ff';
        feedbackWebhook.style.color = '#1e40af';
        feedbackWebhook.style.border = '1px solid #bfdbfe';
        feedbackWebhook.textContent = 'Enviando ping de prueba al Webhook de Google Apps Script...';
      }

      fetch(val, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'ping', timestamp: new Date().toISOString() })
      }).then(() => {
        btnTestWebhook.disabled = false;
        btnTestWebhook.textContent = '🧪 Probar Conexión';
        if (feedbackWebhook) {
          feedbackWebhook.style.background = '#ecfdf5';
          feedbackWebhook.style.color = '#065f46';
          feedbackWebhook.style.border = '1px solid #a7f3d0';
          feedbackWebhook.innerHTML = '✅ <strong>¡Conexión exitosa!</strong> El Webhook respondió y está listo para recibir operaciones en tiempo real.';
        }
        updateWebhookStatusUI(true, val);
      }).catch(err => {
        btnTestWebhook.disabled = false;
        btnTestWebhook.textContent = '🧪 Probar Conexión';
        if (feedbackWebhook) {
          feedbackWebhook.style.background = '#fef2f2';
          feedbackWebhook.style.color = '#991b1b';
          feedbackWebhook.style.border = '1px solid #fecaca';
          feedbackWebhook.textContent = 'Error al conectar con el Webhook: ' + err.message;
        }
      });
    });
  }

  // Inicialización automática (desde FIREBASE_CONFIG o Hosting init.js)
  if (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey && window.FIREBASE_CONFIG.databaseURL) {
    initFirebase(window.FIREBASE_CONFIG);
  } else if (window.firebase && firebase.apps && firebase.apps.length) {
    initFirebase(firebase.app().options);
  } else {
    setFirebaseUIStatus('', 'Esperando config');
  }

  // ---- EXCEL IMPORT CONTROLLER ----
  const btnImportar = document.getElementById('btn-importar-excel');
  const excelFileInput = document.getElementById('excel-file-input');
  const importModal = document.getElementById('import-modal');
  const importModalClose = document.getElementById('import-modal-close');
  const importBtnCancel = document.getElementById('import-btn-cancel');
  const importBtnConfirm = document.getElementById('import-btn-confirm');
  const importSheetsGrid = document.getElementById('import-sheets-grid');
  const importPreviewThead = document.getElementById('import-preview-thead');
  const importPreviewTbody = document.getElementById('import-preview-tbody');
  const importPreviewCount = document.getElementById('import-preview-count');
  const importFileName = document.getElementById('import-file-name');
  const importFileMeta = document.getElementById('import-file-meta');
  const importSummaryEl = document.getElementById('import-summary');
  const importSummaryText = document.getElementById('import-summary-text');

  let importWorkbook = null;
  let importParsedSheets = {};
  let importSelectedSheets = new Set();

  // Column header mapping: Excel column name (lowercased/trimmed) → internal field
  const EXCEL_COL_MAP = {
    'no.': 'no',
    'no': 'no',
    'nombre': 'nombre_contacto',
    'celular': 'celular',
    'nombre del programa': 'programa',
    'nrc': 'nrc',
    'modalidad': 'modalidad',
    'tipo de programa': 'tipo',
    'coordinadora': 'coordinadora',
    'fecha inicio': 'fecha_inicio',
    'fecha fin': 'fecha_fin',
    'horario': 'horario',
    'estado': 'estado',
    'tabulacion': 'tabulacion',
    'tabulación': 'tabulacion',
    'tabulacion 2': 'tabulacion_2',
    'tabulación 2': 'tabulacion_2',
    'tabulacion 3': 'tabulacion_3',
    'tabulación 3': 'tabulacion_3',
    'tabulacion 4': 'tabulacion_4',
    'tabulación 4': 'tabulacion_4',
    'tabulacion 5': 'tabulacion_5',
    'tabulación 5': 'tabulacion_5',
    'links sesiones virtuales': 'link',
    'salones': 'salones_1',
    'salones 2': 'salones_2',
    'salones 3': 'salones_3',
    'salones 4': 'salones_4',
    'estado facturación': 'estado_facturacion',
    'estado facturacion': 'estado_facturacion',
    'comentarios facturación': 'comentarios_facturacion',
    'comentarios facturacion': 'comentarios_facturacion',
    'descuentos': 'descuentos',
    'evaluaciones': 'evaluaciones'
  };

  function excelDateToISO(val) {
    if (!val) return '';
    // Already a string date format
    if (typeof val === 'string') {
      // Try ISO format
      if (/^\d{4}-\d{2}-\d{2}/.test(val)) return val.split('T')[0];
      // Try dd/mm/yyyy or dd-mm-yyyy
      const parts = val.split(/[\/\-\.]/);
      if (parts.length === 3) {
        let [a, b, c] = parts;
        // If first part is 4 digits, it's yyyy-mm-dd
        if (a.length === 4) return `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`;
        // If last part is 4 digits, assume dd/mm/yyyy
        if (c.length === 4) return `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
      }
      return val;
    }
    // Excel serial number (days since 1900-01-01 with a known bug for 1900-02-29)
    if (typeof val === 'number') {
      const epoch = new Date(1899, 11, 30);
      epoch.setDate(epoch.getDate() + val);
      const y = epoch.getFullYear();
      const m = String(epoch.getMonth() + 1).padStart(2, '0');
      const d = String(epoch.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    // Date object
    if (val instanceof Date) {
      const y = val.getFullYear();
      const m = String(val.getMonth() + 1).padStart(2, '0');
      const d = String(val.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    return String(val);
  }

  function parseExcelSheet(sheet) {
    if (!window.XLSX) return [];
    const jsonRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    return jsonRows;
  }

  function mapExcelRowToProgram(row, sheetName) {
    const mapped = {};
    // Map each column using the header mapping
    Object.keys(row).forEach(col => {
      const colLower = col.toLowerCase().trim();
      const field = EXCEL_COL_MAP[colLower];
      if (field) {
        mapped[field] = row[col];
      }
    });

    // Skip completely empty rows (no programa name)
    const progName = (mapped.programa || '').toString().trim();
    if (!progName) return null;

    // Convert dates
    mapped.fecha_inicio = excelDateToISO(mapped.fecha_inicio);
    mapped.fecha_fin = excelDateToISO(mapped.fecha_fin);

    // Normalize strings
    mapped.no = (mapped.no || '').toString().trim();
    mapped.nombre_contacto = (mapped.nombre_contacto || '').toString().trim();
    mapped.celular = (mapped.celular || '').toString().trim();
    mapped.programa = progName;
    mapped.nombre_del_programa = progName;
    mapped.nrc = (mapped.nrc || '').toString().trim();
    mapped.modalidad = (mapped.modalidad || 'Presencial').toString().trim();
    mapped.tipo = (mapped.tipo || '').toString().trim();
    mapped.tipo_de_programa = mapped.tipo;
    mapped.coordinadora = (mapped.coordinadora || '').toString().trim();
    mapped.horario = (mapped.horario || '').toString().trim();
    mapped.estado = (mapped.estado || 'En preparación').toString().trim();
    mapped.link = (mapped.link || '').toString().trim();
    mapped.links_sesiones_virtuales = mapped.link;
    mapped.estado_facturacion = (mapped.estado_facturacion || '').toString().trim();
    mapped.comentarios_facturacion = (mapped.comentarios_facturacion || '').toString().trim();
    mapped.descuentos = (mapped.descuentos || '').toString().trim();
    mapped.evaluaciones = (mapped.evaluaciones || 'Sin enviar').toString().trim();

    // Build tabulaciones array
    const tabulaciones = [];
    for (let i = 1; i <= 5; i++) {
      const key = i === 1 ? 'tabulacion' : `tabulacion_${i}`;
      const val = (mapped[key] || '').toString().trim();
      tabulaciones.push({ label: `Tabulación ${i}`, valor: val, estado: val ? 'completo' : 'no_aplica' });
    }
    mapped.tabulaciones = tabulaciones;

    // Build salones array
    const salones = [];
    for (let i = 1; i <= 4; i++) {
      const key = `salones_${i}`;
      const val = (mapped[key] || '').toString().trim();
      salones.push({ label: `Salones ${i}`, valor: val, estado: val ? 'completo' : 'no_aplica' });
    }
    mapped.salones = salones;

    // Set month from sheet name
    const mesNombre = sheetName.replace(/^\d+_/, '').trim();
    mapped.mes = mesNombre;
    mapped.origen_mes = mesNombre;

    // Set estado_cat
    mapped.estado_cat = (mapped.estado || '').toLowerCase().replace(/\s+/g, '_');

    // Parse horario to build analisis_horario
    const horarioParsed = parseHorarioBasico(mapped.horario);
    mapped.analisis_horario = horarioParsed;

    // Parse horario to build horario_config
    if (mapped.horario) {
      const configDays = parseHorarioToConfig(mapped.horario, mapped.modalidad);
      if (configDays.length > 0) {
        mapped.horario_config = { dias: configDays };
        // Recalculate session dates
        if (mapped.fecha_inicio && mapped.fecha_fin) {
          mapped.analisis_horario.fechas_sesion = calculateSessionDates(
            mapped.fecha_inicio, mapped.fecha_fin, configDays
          );
        }
      }
    }

    // Generate ID
    mapped.id = sanitizeFirebaseNodeKey(progName);

    return mapped;
  }

  function processExcelFile(file) {
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        if (!window.XLSX) {
          alert('Error: La librería SheetJS (XLSX) no se ha cargado correctamente.');
          return;
        }
        const data = new Uint8Array(e.target.result);
        importWorkbook = XLSX.read(data, { type: 'array', cellDates: true });

        importParsedSheets = {};
        importSelectedSheets = new Set();
        let totalRows = 0;

        importWorkbook.SheetNames.forEach(name => {
          const sheet = importWorkbook.Sheets[name];
          const rows = parseExcelSheet(sheet);
          const mapped = rows.map(r => mapExcelRowToProgram(r, name)).filter(Boolean);
          importParsedSheets[name] = mapped;
          totalRows += mapped.length;
          if (mapped.length > 0) {
            importSelectedSheets.add(name);
          }
        });

        // Update file info
        importFileName.textContent = file.name;
        importFileMeta.textContent = `${importWorkbook.SheetNames.length} hojas · ${totalRows} programas detectados`;

        // Render sheets grid
        renderImportSheetsGrid();
        renderImportPreview();
        updateImportSummary();

        // Show modal
        importModal.removeAttribute('hidden');
      } catch (err) {
        console.error('Error procesando Excel:', err);
        alert('Error al leer el archivo Excel: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function renderImportSheetsGrid() {
    if (!importSheetsGrid) return;
    importSheetsGrid.innerHTML = Object.keys(importParsedSheets).map(name => {
      const count = importParsedSheets[name].length;
      const selected = importSelectedSheets.has(name);
      return `<button type="button" class="import-sheet-chip ${selected ? 'selected' : ''}" data-sheet="${name}">
        📄 ${name}
        <span class="sheet-count">${count}</span>
      </button>`;
    }).join('');

    importSheetsGrid.querySelectorAll('.import-sheet-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.sheet;
        if (importSelectedSheets.has(name)) {
          importSelectedSheets.delete(name);
        } else {
          importSelectedSheets.add(name);
        }
        renderImportSheetsGrid();
        renderImportPreview();
        updateImportSummary();
      });
    });
  }

  function renderImportPreview() {
    if (!importPreviewThead || !importPreviewTbody) return;

    const previewCols = ['Mes', 'Programa', 'Coordinadora', 'Modalidad', 'Estado', 'Fecha inicio', 'Fecha fin', 'Horario'];
    importPreviewThead.innerHTML = `<tr>${previewCols.map(c => `<th>${c}</th>`).join('')}</tr>`;

    let allRows = [];
    importSelectedSheets.forEach(name => {
      const rows = importParsedSheets[name] || [];
      rows.forEach(r => allRows.push({ ...r, _sheet: name }));
    });

    importPreviewCount.textContent = `${allRows.length} programas`;

    if (allRows.length === 0) {
      importPreviewTbody.innerHTML = `<tr><td colspan="${previewCols.length}" style="text-align:center;padding:20px;color:var(--slate-400);">No hay datos para mostrar. Selecciona al menos una hoja.</td></tr>`;
      return;
    }

    // Show up to 50 rows in preview
    const previewRows = allRows.slice(0, 50);
    importPreviewTbody.innerHTML = previewRows.map(r => `<tr>
      <td><span class="import-row-mes">${r._sheet}</span></td>
      <td title="${r.programa || ''}">${r.programa || '—'}</td>
      <td>${r.coordinadora || '—'}</td>
      <td>${r.modalidad || '—'}</td>
      <td>${r.estado || '—'}</td>
      <td>${r.fecha_inicio ? fmtDate(r.fecha_inicio) : '—'}</td>
      <td>${r.fecha_fin ? fmtDate(r.fecha_fin) : '—'}</td>
      <td title="${r.horario || ''}">${r.horario || '—'}</td>
    </tr>`).join('');

    if (allRows.length > 50) {
      importPreviewTbody.innerHTML += `<tr><td colspan="${previewCols.length}" style="text-align:center;padding:10px;color:var(--slate-400);font-style:italic;">… y ${allRows.length - 50} programas más</td></tr>`;
    }
  }

  function updateImportSummary() {
    let totalCount = 0;
    importSelectedSheets.forEach(name => {
      totalCount += (importParsedSheets[name] || []).length;
    });

    if (totalCount === 0) {
      importSummaryEl.className = 'import-summary';
      importSummaryText.textContent = 'Selecciona al menos una hoja con datos para importar.';
      if (importBtnConfirm) importBtnConfirm.disabled = true;
    } else {
      importSummaryEl.className = 'import-summary';
      importSummaryText.textContent = `Se importarán ${totalCount} programas de ${importSelectedSheets.size} hoja(s) a Firebase.`;
      if (importBtnConfirm) importBtnConfirm.disabled = false;
    }
  }

  function closeImportModal() {
    if (importModal) importModal.setAttribute('hidden', '');
    if (excelFileInput) excelFileInput.value = '';
  }

  function executeImport() {
    if (!fbDb) {
      alert('Firebase no está conectado. Conéctate primero antes de importar.');
      return;
    }

    const overwrite = document.getElementById('import-opt-overwrite').checked;
    const mountDrive = document.getElementById('import-opt-drive') ? document.getElementById('import-opt-drive').checked : true;
    const updates = {};
    const importedForDrive = [];
    let importCount = 0;

    importSelectedSheets.forEach(sheetName => {
      const rows = importParsedSheets[sheetName] || [];
      rows.forEach(prog => {
        const mesKey = getMesKey(prog.mes || sheetName);
        const baseKey = sanitizeFirebaseNodeKey(prog.programa);
        let nodeKey = baseKey;
        let counter = 1;
        while (updates['meses/' + mesKey + '/programas/' + nodeKey]) {
          nodeKey = `${baseKey}_${counter++}`;
        }

        if (!overwrite) {
          // Check if program already exists in current activos for this month
          const existing = activos.find(p =>
            ((p._nodeKey && p._nodeKey === nodeKey) || sanitizeFirebaseNodeKey(p.programa) === baseKey) &&
            getMesKey(p.mes || p.origen_mes) === mesKey
          );
          if (existing) return; // skip existing
        }

        prog.id = nodeKey;
        updates['meses/' + mesKey + '/programas/' + nodeKey] = prog;
        if (mountDrive) {
          const driveItem = {
            ...prog,
            nodeKey: nodeKey,
            mesKey: mesKey,
            solicitado_el: new Date().toISOString()
          };
          updates['cola_creacion_drive/' + nodeKey] = driveItem;
          importedForDrive.push(driveItem);
        }
        importCount++;
      });
    });

    if (importCount === 0) {
      importSummaryEl.className = 'import-summary error';
      importSummaryText.textContent = 'No hay programas nuevos para importar (todos ya existen).';
      return;
    }

    // Show loading state
    importBtnConfirm.disabled = true;
    importBtnConfirm.innerHTML = '<div class="import-spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:6px;"></div> Importando...';

    // Disparar Webhook en tiempo real para Google Drive si está marcado
    if (mountDrive && importedForDrive.length > 0) {
      isDriveSyncActive = true;
      userDismissedSyncCard = false;
      driveQueuePendingCount = importedForDrive.length;
      updateDriveSyncProgress(true);
      sendGasWebhook({
        action: 'batch_create',
        items: importedForDrive
      });
    }

    fbDb.ref().update(updates).then(() => {
      importSummaryEl.className = 'import-summary success';
      importSummaryText.textContent = `✓ ${importCount} programas importados a Firebase${mountDrive ? ' y procesándose en Google Drive en tiempo real' : ''}.`;
      importBtnConfirm.innerHTML = '✓ Importación completa';
      if (mountDrive) updateDriveSyncProgress(true);

      setTimeout(() => {
        closeImportModal();
      }, 1800);
    }).catch(err => {
      console.error('Error importando a Firebase:', err);
      importSummaryEl.className = 'import-summary error';
      importSummaryText.textContent = 'Error al importar: ' + err.message;
      importBtnConfirm.disabled = false;
      importBtnConfirm.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Reintentar importación`;
    });
  }

  // Event Listeners
  if (btnImportar) {
    btnImportar.addEventListener('click', () => {
      if (excelFileInput) excelFileInput.click();
    });
  }
  if (excelFileInput) {
    excelFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) processExcelFile(file);
    });
  }
  if (importModalClose) importModalClose.addEventListener('click', closeImportModal);
  if (importBtnCancel) importBtnCancel.addEventListener('click', closeImportModal);
  if (importModal) {
    importModal.addEventListener('click', (e) => {
      if (e.target === importModal) closeImportModal();
    });
  }
  if (importBtnConfirm) {
    importBtnConfirm.addEventListener('click', executeImport);
  }

  // =============================================================================
  // CONTROLADOR DE SOLICITUDES DE APERTURA DE CURSO DESDE GMAIL (IA + FIREBASE)
  // =============================================================================

  const btnBandejaHeader = document.getElementById('btn-bandeja-correos');
  const btnBandejaToolbar = document.getElementById('btn-apertura-correo-tb');
  const badgeCorreosHeader = document.getElementById('badge-correos');
  const badgeCorreosToolbar = document.getElementById('badge-correos-tb');
  const emailToast = document.getElementById('email-toast-notification');
  const emailToastDesc = document.getElementById('email-toast-desc');
  const emailToastBtn = document.getElementById('email-toast-btn');
  const emailToastClose = document.getElementById('email-toast-close');

  const emailModal = document.getElementById('email-requests-modal');
  const emailModalClose = document.getElementById('email-modal-close');
  const emailModalBtnClose = document.getElementById('email-modal-btn-close');
  const emailTabCounter = document.getElementById('email-tab-counter');
  const emailEmptyState = document.getElementById('email-empty-state');
  const emailRequestsList = document.getElementById('email-requests-list');

  // Pestañas
  const emailTabBtns = document.querySelectorAll('.email-tab-btn');
  const emailPanels = {
    pendientes: document.getElementById('email-panel-pendientes'),
    simulador: document.getElementById('email-panel-simulador'),
    config: document.getElementById('email-panel-config')
  };

  // Simulador
  const emailSimSubject = document.getElementById('email-sim-subject');
  const emailSimSender = document.getElementById('email-sim-sender');
  const emailSimBody = document.getElementById('email-sim-body');
  const emailSimExtractBtn = document.getElementById('email-sim-extract-btn');
  const emailSimResult = document.getElementById('email-sim-result');
  const simPresetBtns = document.querySelectorAll('.sim-preset-btn');

  // Config y script de Google Apps Script
  const gasCodeDisplay = document.getElementById('gas-code-display');
  const btnCopyGasCode = document.getElementById('btn-copy-gas-code');

  const GAS_SCRIPT_SOURCE = `/**
 * =============================================================================
 * CEC UNINORTE - SINCRONIZADOR AUTOMÁTICO DE GMAIL + GOOGLE DRIVE (IA + FIREBASE)
 * =============================================================================
 * 
 * Este script corre de forma automática y gratuita 24/7 en Google Apps Script
 * dentro de tu cuenta de Google Workspace / Gmail.
 * 
 * FUNCIONALIDADES:
 * 1. GMAIL: Detecta correos de "Apertura de curso" en tiempo real sin duplicados
 *    y los envía a Firebase para aprobación.
 * 2. GOOGLE DRIVE: Crea automáticamente la jerarquía de carpetas:
 *    Cursos CEC / [Mes] / [Nombre del Curso] - NRC [NRC] /
 *    y genera la planilla de cálculo de asistencia estructurada por sesiones.
 * 
 * PASOS PARA INSTALARLO EN 1 MINUTO:
 * 1. Ve a https://script.google.com/
 * 2. Abre tu proyecto (o crea uno nuevo llamado "CEC-Sincronizador").
 * 3. Pega este código completo reemplazando todo y haz clic en Guardar (ícono de disco).
 * 4. Implementa el Webhook:
 *    - Haz clic en "Implementar" (arriba a la derecha) -> "Nueva implementación"
 *    - Tipo: "Aplicación web"
 *    - Ejecutar como: "Yo" (tu cuenta)
 *    - Quién tiene acceso: "Cualquiera"
 *    - Haz clic en "Implementar", copia la URL que termina en /exec y pégala en la web del CEC.
 * 5. (Opcional) Limpia activadores viejos ejecutando la función 'eliminarActivadoresMinuterosViejos'.
 *    Tu Tablero Web sincronizará automáticamente los correos por Webhook al entrar o con un clic.
 */

// CONFIGURACIÓN DE TU PROYECTO FIREBASE
const FIREBASE_DB_URL = "https://cec-web-ff198-default-rtdb.firebaseio.com";

// (Opcional pero recomendado para máxima precisión con IA libre)
// Obtén una clave gratis en: https://aistudio.google.com/app/apikey
const GEMINI_API_KEY = ""; // Deja vacío si no tienes, usará el extractor inteligente integrado

/**
 * 1. FUNCIÓN PRINCIPAL DE GMAIL + PROCESAMIENTO DE COLA DRIVE
 */
function revisarCorreosAperturaCurso() {
  // A. Procesar cola de creación de carpetas y asistencias de Google Drive
  try {
    procesarColaDrive();
  } catch (errDrive) {
    Logger.log("Nota procesando cola Drive: " + errDrive.message);
  }

  // B. Procesar cola de eliminación en Google Drive (papelera para cursos borrados)
  try {
    procesarColaEliminacionDrive();
  } catch (errDel) {
    Logger.log("Nota procesando cola eliminación Drive: " + errDel.message);
  }

  // C. Buscar correos no leídos por palabras clave (apertura, solicitud de apertura o diplomado, excluyendo boletines y spam)
  const query = 'is:unread (subject:apertura OR "solicitud de apertura" OR (subject:diplomado (apertura OR nrc OR horario OR inicio OR fecha OR salon))) -quora -zoom -digest -newsletter -marketing -label:CEC-Procesado';
  const threads = GmailApp.search(query, 0, 15);

  Logger.log("Búsqueda con query: " + query);
  Logger.log("Hilos encontrados: " + (threads ? threads.length : 0));

  if (!threads || threads.length === 0) {
    Logger.log("No se encontraron correos nuevos sin procesar.");
    return;
  }

  let labelProcesado = null;
  try {
    labelProcesado = GmailApp.getUserLabelByName("CEC-Procesado") || GmailApp.createLabel("CEC-Procesado");
  } catch (e) {
    Logger.log("Nota sobre etiqueta: " + e.message);
  }

  for (let t = 0; t < threads.length; t++) {
    const thread = threads[t];
    const messages = thread.getMessages();
    if (!messages || messages.length === 0) continue;

    const unreadMessages = messages.filter(function (m) { return m.isUnread(); });
    if (unreadMessages.length === 0) {
      if (labelProcesado) thread.addLabel(labelProcesado);
      continue;
    }

    for (let m = 0; m < unreadMessages.length; m++) {
      const msg = unreadMessages[m];
      const msgId = msg.getId(); // ID inmutable de Gmail (garantiza cero duplicados)
      const threadId = thread.getId();
      const subject = msg.getSubject() || "";
      const from = msg.getFrom() || "";
      const date = msg.getDate();
      const plainBody = msg.getPlainBody() || "";

      // Filtro anti-falsos positivos (descarta Quora, Zoom, newsletters o correos sin datos de curso)
      if (!esCorreoAperturaValido(subject, plainBody, from)) {
        if (labelProcesado) thread.addLabel(labelProcesado);
        continue;
      }

      Logger.log("✓ Correo válido detectado ID: " + msgId + " | Asunto: " + subject);

      let datosExtraidos = null;
      if (GEMINI_API_KEY && GEMINI_API_KEY.trim().length > 10) {
        datosExtraidos = extraerConGeminiAI(subject, plainBody);
      }
      if (!datosExtraidos) {
        datosExtraidos = extraerHeuristico(subject, plainBody);
      }

      const requestId = "gmail_" + msgId;
      const payload = {
        id: requestId,
        message_id: msgId,
        thread_id: threadId,
        remitente: from,
        asunto: subject,
        fecha_correo: date ? date.toISOString() : new Date().toISOString(),
        fecha_deteccion: new Date().toISOString(),
        cuerpo_resumen: plainBody.substring(0, 800),
        cuerpo_completo: plainBody.substring(0, 4000),
        datos_extraidos: datosExtraidos,
        estado: "pendiente"
      };

      const url = FIREBASE_DB_URL + "/solicitudes_pendientes/" + requestId + ".json";
      try {
        UrlFetchApp.fetch(url, {
          method: "put",
          contentType: "application/json",
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });
        msg.markRead();
      } catch (err) {
        Logger.log("Error al guardar en Firebase: " + err.message);
      }
    }

    try {
      thread.markRead();
      if (labelProcesado) thread.addLabel(labelProcesado);
    } catch (e) {
      Logger.log("Error etiquetando hilo: " + e.message);
    }
  }
}

/**
 * 2. PROCESADOR DE LA COLA DE GOOGLE DRIVE EN FIREBASE
 * Guarda inmediatamente cada curso procesado en Firebase para no perder progreso ante timeouts.
 */
function procesarColaDrive() {
  const url = FIREBASE_DB_URL + "/cola_creacion_drive.json";
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return;

  const text = res.getContentText();
  if (!text || text === "null") return;

  const cola = JSON.parse(text);
  if (!cola || typeof cola !== "object") return;

  const colaKeys = Object.keys(cola);
  Logger.log("Elementos en cola de creación Drive: " + colaKeys.length);

  // Procesamos hasta 25 por turno para mantener un tiempo de respuesta óptimo en Apps Script
  const maxToProcess = Math.min(colaKeys.length, 25);

  for (let i = 0; i < maxToProcess; i++) {
    const k = colaKeys[i];
    const item = cola[k];
    if (!item) continue;

    try {
      const mesKey = item.mesKey || getMesKeyDrive(item.mes || item.origen_mes || "General");
      const nodeKey = item.nodeKey || item.id || sanitizeFirebaseKeyGas(item.programa || item.nombre || "prog");

      // VERIFICACIÓN: Comprobar si el programa aún existe en Firebase
      // Si la BD fue vaciada o el curso eliminado, NO lo recreamos
      const checkRes = UrlFetchApp.fetch(FIREBASE_DB_URL + "/meses/" + mesKey + "/programas/" + nodeKey + ".json", { muteHttpExceptions: true });
      if (checkRes.getResponseCode() !== 200 || !checkRes.getContentText() || checkRes.getContentText() === "null") {
        Logger.log("El programa ya fue eliminado de la BD, omitiendo recreación: " + nodeKey);
        UrlFetchApp.fetch(FIREBASE_DB_URL + "/cola_creacion_drive/" + k + ".json", { method: "delete", muteHttpExceptions: true });
        continue;
      }

      const resDrive = crearEstructuraDriveYAsistencia(item);

      const itemUpdates = {};
      itemUpdates["meses/" + mesKey + "/programas/" + nodeKey + "/drive_folder_url"] = resDrive.folderUrl;
      itemUpdates["meses/" + mesKey + "/programas/" + nodeKey + "/drive_folder_id"] = resDrive.folderId;
      itemUpdates["meses/" + mesKey + "/programas/" + nodeKey + "/asistencia_sheet_url"] = resDrive.sheetUrl;
      itemUpdates["meses/" + mesKey + "/programas/" + nodeKey + "/asistencia_sheet_id"] = resDrive.sheetId;
      itemUpdates["meses/" + mesKey + "/programas/" + nodeKey + "/drive_creado_el"] = new Date().toISOString();
      itemUpdates["cola_creacion_drive/" + k] = null; // Quitar de cola inmediatamente

      UrlFetchApp.fetch(FIREBASE_DB_URL + "/.json", {
        method: "patch",
        contentType: "application/json",
        payload: JSON.stringify(itemUpdates),
        muteHttpExceptions: true
      });

      Logger.log("✓ (" + (i + 1) + "/" + maxToProcess + ") Creado en Drive: " + (item.programa || item.nombre));
    } catch (e) {
      Logger.log("Error creando Drive para elemento " + k + ": " + e.message);
    }
  }
}

/**
 * 2.1 PROCESADOR DE LA COLA DE ELIMINACIÓN DE GOOGLE DRIVE EN FIREBASE
 * Envía a la papelera de Drive las carpetas y planillas de cursos borrados de la web.
 */
function procesarColaEliminacionDrive() {
  const url = FIREBASE_DB_URL + "/cola_eliminacion_drive.json";
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return;

  const text = res.getContentText();
  if (!text || text === "null") return;

  const cola = JSON.parse(text);
  if (!cola || typeof cola !== "object") return;

  const colaKeys = Object.keys(cola);
  Logger.log("Elementos en cola de eliminación Drive: " + colaKeys.length);

  for (let i = 0; i < colaKeys.length; i++) {
    const k = colaKeys[i];
    const item = cola[k];
    if (!item) continue;

    try {
      if (item.action === "vaciar_todo") {
        eliminarTodasLasCarpetasCursosDrive();
      } else if (item.folderId) {
        try {
          const folder = DriveApp.getFolderById(item.folderId);
          folder.setTrashed(true);
          Logger.log("✓ Carpeta enviada a papelera de Drive por ID: " + item.folderId);
        } catch (errId) {
          eliminarCarpetaCursoPorNombre(item.mes, item.nombre, item.nrc);
        }
      } else if (item.nombre) {
        eliminarCarpetaCursoPorNombre(item.mes, item.nombre, item.nrc);
      }

      // Eliminar de la cola de eliminación
      UrlFetchApp.fetch(FIREBASE_DB_URL + "/cola_eliminacion_drive/" + k + ".json", {
        method: "delete",
        muteHttpExceptions: true
      });
    } catch (e) {
      Logger.log("Error eliminando carpeta en Drive para " + k + ": " + e.message);
    }
  }
}

function eliminarCarpetaCursoPorNombre(mes, nombreCurso, nrc) {
  try {
    const rootIter = DriveApp.getFoldersByName("Cursos CEC");
    if (!rootIter.hasNext()) return;
    const rootFolder = rootIter.next();

    const cleanCurso = (nombreCurso + (nrc ? (" - NRC " + nrc) : "")).replace(/[\\/:*?"<>|]/g, "_").substring(0, 100);
    const mesFolderName = getMesKeyDrive(mes || "");
    const mesIter = rootFolder.getFoldersByName(mesFolderName);
    const parentFolder = mesIter.hasNext() ? mesIter.next() : rootFolder;

    const subIter = parentFolder.getFoldersByName(cleanCurso);
    while (subIter.hasNext()) {
      const f = subIter.next();
      f.setTrashed(true);
      Logger.log("✓ Carpeta enviada a papelera por nombre: " + cleanCurso);
    }
  } catch (err) {
    Logger.log("Nota buscando carpeta para eliminar: " + err.message);
  }
}

function eliminarTodasLasCarpetasCursosDrive() {
  try {
    const rootIter = DriveApp.getFoldersByName("Cursos CEC");
    if (!rootIter.hasNext()) return;
    const rootFolder = rootIter.next();
    const subFolders = rootFolder.getFolders();
    while (subFolders.hasNext()) {
      const sf = subFolders.next();
      sf.setTrashed(true);
      Logger.log("✓ Carpeta de mes enviada a papelera de Drive: " + sf.getName());
    }
  } catch (err) {
    Logger.log("Nota vaciando carpetas en Drive: " + err.message);
  }
}

/**
 * 2.2 SINCRONIZADOR MASIVO DIRECTO DE TODOS LOS CURSOS DE FIREBASE A GOOGLE DRIVE
 * Selecciona esta función arriba y haz clic en "Ejecutar" para montar absolutamente todos
 * los cursos que aún no tienen carpeta o planilla en Google Drive.
 */
function sincronizarTodosLosCursosADrive() {
  Logger.log("Iniciando sincronización masiva de todos los cursos a Google Drive...");
  const res = UrlFetchApp.fetch(FIREBASE_DB_URL + "/meses.json", { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    Logger.log("Error al leer /meses.json de Firebase");
    return;
  }

  const mesesData = JSON.parse(res.getContentText());
  if (!mesesData) {
    Logger.log("No se encontraron datos en meses.");
    return;
  }

  let totalProcesados = 0;
  let yaSincronizados = 0;

  const mesKeys = Object.keys(mesesData);
  for (let m = 0; m < mesKeys.length; m++) {
    const mesKey = mesKeys[m];
    const mesObj = mesesData[mesKey];
    if (!mesObj || !mesObj.programas) continue;

    const progKeys = Object.keys(mesObj.programas);
    for (let p = 0; p < progKeys.length; p++) {
      const progKey = progKeys[p];
      const prog = mesObj.programas[progKey];
      if (!prog) continue;

      if (prog.drive_folder_url && prog.asistencia_sheet_url) {
        yaSincronizados++;
        continue;
      }

      try {
        Logger.log("Sincronizando a Drive: " + (prog.programa || prog.nombre_del_programa || progKey));
        const resDrive = crearEstructuraDriveYAsistencia({
          ...prog,
          mesKey: mesKey,
          nodeKey: progKey
        });

        const updates = {};
        updates["meses/" + mesKey + "/programas/" + progKey + "/drive_folder_url"] = resDrive.folderUrl;
        updates["meses/" + mesKey + "/programas/" + progKey + "/drive_folder_id"] = resDrive.folderId;
        updates["meses/" + mesKey + "/programas/" + progKey + "/asistencia_sheet_url"] = resDrive.sheetUrl;
        updates["meses/" + mesKey + "/programas/" + progKey + "/asistencia_sheet_id"] = resDrive.sheetId;
        updates["meses/" + mesKey + "/programas/" + progKey + "/drive_creado_el"] = new Date().toISOString();

        UrlFetchApp.fetch(FIREBASE_DB_URL + "/.json", {
          method: "patch",
          contentType: "application/json",
          payload: JSON.stringify(updates),
          muteHttpExceptions: true
        });

        totalProcesados++;
        Logger.log("✓ Sincronizado (" + totalProcesados + "): " + (prog.programa || progKey));
      } catch (err) {
        Logger.log("Error sincronizando " + progKey + ": " + err.message);
      }
    }
  }

  Logger.log("FIN DE SINCRONIZACIÓN: " + totalProcesados + " cursos montados a Google Drive. (" + yaSincronizados + " ya estaban sincronizados).");
}

/**
 * 3. MOTOR DE CREACIÓN DE CARPETAS Y PLANILLA DE ASISTENCIA EN GOOGLE DRIVE
 */
function crearEstructuraDriveYAsistencia(prog) {
  if (!prog) throw new Error("Datos de programa no proporcionados");

  const ROOT_FOLDER_NAME = "Cursos CEC";
  const nombreCurso = (prog.programa || prog.nombre_del_programa || prog.nombre || "Curso Sin Nombre").trim();
  const nrc = (prog.nrc || "").toString().trim();
  const mes = (prog.mes || prog.origen_mes || "General").trim();
  const coordinadora = (prog.coordinadora || prog.nombre_contacto || prog.nombre || "Por asignar").trim();
  const celular = (prog.celular || "").toString().trim();
  const modalidad = (prog.modalidad || "Presencial").trim();
  const horario = (prog.horario || "").trim();
  const salon = (prog.salones_1_val || (prog.salones && prog.salones[0] && prog.salones[0].valor) || "").trim();
  const fechaInicio = prog.fecha_inicio || prog.fechaInicio || "";
  const fechaFin = prog.fecha_fin || prog.fechaFin || "";
  const fechasSesion = (prog.analisis_horario && prog.analisis_horario.fechas_sesion) || prog.fechas_sesion || [];

  // 1. Obtener o crear carpeta raíz "Cursos CEC"
  let rootFolder = null;
  const rootIter = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  if (rootIter.hasNext()) {
    rootFolder = rootIter.next();
  } else {
    rootFolder = DriveApp.createFolder(ROOT_FOLDER_NAME);
  }

  // 2. Obtener o crear subcarpeta del mes (ej: "05_Mayo")
  const MESES_MAP = {
    "enero": "01_Enero", "febrero": "02_Febrero", "marzo": "03_Marzo", "abril": "04_Abril",
    "mayo": "05_Mayo", "junio": "06_Junio", "julio": "07_Julio", "agosto": "08_Agosto",
    "septiembre": "09_Septiembre", "setiembre": "09_Septiembre", "octubre": "10_Octubre",
    "noviembre": "11_Noviembre", "diciembre": "12_Diciembre"
  };
  const mesKeyNorm = mes.toLowerCase().replace(/^[0-9]+_/, "");
  let mesFolderName = MESES_MAP[mesKeyNorm] || (mes.includes("_") ? mes : ("Mes_" + mes));

  let mesFolder = null;
  const mesIter = rootFolder.getFoldersByName(mesFolderName);
  if (mesIter.hasNext()) {
    mesFolder = mesIter.next();
  } else {
    mesFolder = rootFolder.createFolder(mesFolderName);
  }

  // 3. Obtener o crear subcarpeta del curso: "[Nombre] - NRC [NRC]"
  const cleanCursoFolder = (nombreCurso + (nrc ? (" - NRC " + nrc) : "")).replace(/[\\/:*?"<>|]/g, "_").substring(0, 100);
  let cursoFolder = null;
  const cursoIter = mesFolder.getFoldersByName(cleanCursoFolder);
  if (cursoIter.hasNext()) {
    cursoFolder = cursoIter.next();
  } else {
    cursoFolder = mesFolder.createFolder(cleanCursoFolder);
  }

  // 4. Crear o buscar archivo de asistencia (Google Sheet)
  const sheetFileName = "Asistencia - " + nombreCurso + (nrc ? (" (NRC " + nrc + ")") : "");
  let spreadsheet = null;

  const fileIter = cursoFolder.getFilesByName(sheetFileName);
  if (fileIter.hasNext()) {
    const existingFile = fileIter.next();
    spreadsheet = SpreadsheetApp.open(existingFile);
  } else {
    spreadsheet = SpreadsheetApp.create(sheetFileName);
    const sheetFile = DriveApp.getFileById(spreadsheet.getId());
    sheetFile.moveTo(cursoFolder);

    // Formatear y diseñar la planilla de asistencia con estilo institucional CEC
    disenarPlanillaAsistencia(spreadsheet, {
      nombreCurso: nombreCurso,
      nrc: nrc,
      mes: mes,
      coordinadora: coordinadora,
      celular: celular,
      modalidad: modalidad,
      horario: horario,
      salon: salon,
      fechaInicio: fechaInicio,
      fechaFin: fechaFin,
      fechasSesion: fechasSesion
    });
  }

  try {
    const sheet = spreadsheet.getSheetByName("Control Asistencia") || spreadsheet.getActiveSheet();
    const mesKey = prog.mesKey || prog._mesKey || getMesKeyDrive(mes);
    const nodeKey = prog.nodeKey || prog._nodeKey || prog.id || sanitizeFirebaseKeyGas(nombreCurso);
    sheet.getRange("Z1").setValue(JSON.stringify({ mesKey: mesKey, nodeKey: nodeKey, sheetId: spreadsheet.getId() }));
    sheet.hideColumns(26);
    asegurarActivadorDeEdicion(spreadsheet);
  } catch (eTrig) {
    Logger.log("Nota vinculando activador de edición al crear: " + eTrig.message);
  }

  return {
    success: true,
    folderId: cursoFolder.getId(),
    folderUrl: cursoFolder.getUrl(),
    sheetId: spreadsheet.getId(),
    sheetUrl: spreadsheet.getUrl()
  };
}

/**
 * 4. DISEÑO PROFESIONAL DE LA PLANILLA DE ASISTENCIA
 */
function disenarPlanillaAsistencia(spreadsheet, data) {
  const sheet = spreadsheet.getActiveSheet();
  sheet.setName("Control Asistencia");
  sheet.clear();

  // 1. Títulos institucionales
  sheet.getRange("A1:M1").merge()
    .setValue("UNIVERSIDAD DEL NORTE — CENTRO DE EDUCACIÓN CONTINUADA (CEC)")
    .setFontFamily("Arial").setFontSize(13).setFontWeight("bold")
    .setBackground("#0f172a").setFontColor("#ffffff")
    .setHorizontalAlignment("center").setVerticalAlignment("middle");
  sheet.setRowHeight(1, 36);

  sheet.getRange("A2:M2").merge()
    .setValue("CONTROL Y REGISTRO OFICIAL DE ASISTENCIA")
    .setFontFamily("Arial").setFontSize(10).setFontWeight("bold")
    .setBackground("#1e293b").setFontColor("#93c5fd")
    .setHorizontalAlignment("center").setVerticalAlignment("middle");
  sheet.setRowHeight(2, 24);

  // 2. Ficha técnica del curso
  sheet.getRange("A4:B4").merge().setValue("PROGRAMA:").setFontWeight("bold");
  sheet.getRange("C4:G4").merge().setValue(data.nombreCurso).setFontWeight("bold").setFontColor("#1e3a8a");
  sheet.getRange("H4:I4").merge().setValue("NRC:").setFontWeight("bold");
  sheet.getRange("J4:M4").merge().setValue(data.nrc || "Sin asignar").setFontColor("#1e3a8a").setFontWeight("bold");

  sheet.getRange("A5:B5").merge().setValue("DOCENTE / COORD:").setFontWeight("bold");
  sheet.getRange("C5:G5").merge().setValue(data.coordinadora + (data.celular ? " · Tel: " + data.celular : ""));
  sheet.getRange("H5:I5").merge().setValue("MODALIDAD / SALÓN:").setFontWeight("bold");
  sheet.getRange("J5:M5").merge().setValue(data.modalidad + (data.salon ? " · " + data.salon : ""));

  sheet.getRange("A6:B6").merge().setValue("FECHAS Y HORARIO:").setFontWeight("bold");
  sheet.getRange("C6:M6").merge().setValue(
    (data.fechaInicio ? (data.fechaInicio + " al " + data.fechaFin) : "") +
    (data.horario ? (" | Horario: " + data.horario) : "")
  );

  sheet.getRange("A4:M6").setBackground("#f8fafc").setFontSize(9).setFontFamily("Arial");
  sheet.getRange("A4:M6").setBorder(true, true, true, true, true, true, "#cbd5e1", SpreadsheetApp.BorderStyle.SOLID);

  // 3. Columnas de asistencia dinámicas
  const headers = ["#", "No. Documento", "Nombre Completo del Participante", "Correo Electrónico"];
  const sesiones = (data.fechasSesion && Array.isArray(data.fechasSesion) && data.fechasSesion.length > 0)
    ? data.fechasSesion
    : [];
  const numSesiones = Math.max(sesiones.length, 8); // Al menos 8 sesiones predefinidas

  for (let s = 0; s < numSesiones; s++) {
    const fStr = sesiones[s] ? sesiones[s] : "";
    headers.push("Sesión " + (s + 1) + (fStr ? ("\n" + fStr) : ""));
  }

  headers.push("Total Asist.");
  headers.push("% Asistencia");
  headers.push("Estado Final");

  const startRow = 8;
  const numCols = headers.length;
  const headerRange = sheet.getRange(startRow, 1, 1, numCols);
  headerRange.setValues([headers]);
  headerRange.setBackground("#1e3a8a").setFontColor("#ffffff")
    .setFontWeight("bold").setFontSize(9).setFontFamily("Arial")
    .setHorizontalAlignment("center").setVerticalAlignment("middle")
    .setWrap(true);
  sheet.setRowHeight(startRow, 34);

  // 4. Filas para participantes (30 cupos pre-configurados con fórmulas de porcentaje)
  const numStudents = 30;
  const rows = [];
  const startColSesiones = 5; // Columna E
  const endColSesiones = startColSesiones + numSesiones - 1;

  function colToLetter(col) {
    let letter = "";
    while (col > 0) {
      let mod = (col - 1) % 26;
      letter = String.fromCharCode(65 + mod) + letter;
      col = Math.floor((col - mod) / 26);
    }
    return letter;
  }

  const colLetterStart = colToLetter(startColSesiones);
  const colLetterEnd = colToLetter(endColSesiones);
  const colLetterTotal = colToLetter(numCols - 2);
  const colLetterPercent = colToLetter(numCols - 1);

  for (let i = 1; i <= numStudents; i++) {
    const rowNum = startRow + i;
    const r = [i, "", "", ""];
    for (let s = 0; s < numSesiones; s++) {
      r.push(""); // Celda para marcar: P = Presente, F = Falta, E = Excusa
    }
    // Fórmulas automáticas de asistencia y aprobación (80% requerido por el CEC)
    r.push('=COUNTIF(' + colLetterStart + rowNum + ':' + colLetterEnd + rowNum + ', "P")');
    r.push('=' + colLetterTotal + rowNum + ' / ' + numSesiones);
    r.push('=IF(' + colLetterPercent + rowNum + '>=0.8, "APROBADO", IF(' + colLetterTotal + rowNum + '>0, "EN CURSO", "PENDIENTE"))');
    rows.push(r);
  }

  const dataRange = sheet.getRange(startRow + 1, 1, numStudents, numCols);
  dataRange.setValues(rows);
  dataRange.setFontSize(9).setFontFamily("Arial");
  dataRange.setBorder(true, true, true, true, true, true, "#e2e8f0", SpreadsheetApp.BorderStyle.SOLID);

  // Formato porcentaje en la columna %
  sheet.getRange(startRow + 1, numCols - 1, numStudents, 1).setNumberFormat("0.0%");
  sheet.getRange(startRow + 1, 1, numStudents, 1).setHorizontalAlignment("center");
  sheet.getRange(startRow + 1, startColSesiones, numStudents, numSesiones + 3).setHorizontalAlignment("center");

  // Anchos de columna
  sheet.setColumnWidth(1, 35);
  sheet.setColumnWidth(2, 110);
  sheet.setColumnWidth(3, 230);
  sheet.setColumnWidth(4, 180);
  for (let s = startColSesiones; s <= endColSesiones; s++) {
    sheet.setColumnWidth(s, 76);
  }
  sheet.setColumnWidth(numCols - 2, 85);
  sheet.setColumnWidth(numCols - 1, 95);
  sheet.setColumnWidth(numCols, 105);

  // Leyenda explicativa al pie
  const footRow = startRow + numStudents + 2;
  sheet.getRange("A" + footRow + ":M" + footRow).merge()
    .setValue("Convenciones para control de asistencia:  P = Presente  |  F = Falta injustificada  |  E = Excusa médica / laboral.  Requisito mínimo de certificación: 80% de asistencia.")
    .setFontSize(8).setFontColor("#64748b").setFontStyle("italic");
}

/**
 * 4.5. SINCRONIZACIÓN DE PARTICIPANTES Y ASISTENCIA CON GOOGLE SHEETS
 */
function sincronizarParticipantesASheet(data) {
  try {
    let spreadsheet = null;
    if (data.sheetId) {
      spreadsheet = SpreadsheetApp.openById(data.sheetId);
    } else if (data.sheetUrl) {
      const match = data.sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (match && match[1]) {
        spreadsheet = SpreadsheetApp.openById(match[1]);
      }
    }

    if (!spreadsheet) {
      const folderId = data.folderId || data.drive_folder_id;
      if (folderId) {
        try {
          const folder = DriveApp.getFolderById(folderId);
          const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
          if (files.hasNext()) spreadsheet = SpreadsheetApp.open(files.next());
        } catch (eF) { }
      }
    }

    if (!spreadsheet) {
      return { success: false, error: "No se encontró la hoja de cálculo de Google Drive." };
    }

    const sheet = spreadsheet.getSheetByName("Control Asistencia") || spreadsheet.getActiveSheet();
    const startRow = 8;
    const numCols = Math.max(sheet.getLastColumn(), 15);
    const headerValues = sheet.getRange(startRow, 1, 1, numCols).getValues()[0];

    // Detectar cuántas columnas de sesión hay
    let numSesiones = 0;
    for (let c = 4; c < headerValues.length; c++) {
      const hStr = (headerValues[c] || "").toString().toLowerCase();
      if (hStr.includes("total") || hStr.includes("%") || hStr.includes("estado")) {
        numSesiones = c - 4;
        break;
      }
    }
    if (numSesiones <= 0) numSesiones = 8;

    const rawPart = data.participantes;
    const participantes = Array.isArray(rawPart)
      ? rawPart
      : (rawPart && typeof rawPart === 'object' ? Object.values(rawPart) : []);

    const numRowsToWrite = Math.max(participantes.length, 30);
    const startColSesiones = 5;
    const endColSesiones = startColSesiones + numSesiones - 1;
    const totalCols = endColSesiones + 3;

    function colToLetter(col) {
      let letter = "";
      while (col > 0) {
        let mod = (col - 1) % 26;
        letter = String.fromCharCode(65 + mod) + letter;
        col = Math.floor((col - mod) / 26);
      }
      return letter;
    }

    const colLetterStart = colToLetter(startColSesiones);
    const colLetterEnd = colToLetter(endColSesiones);
    const colLetterTotal = colToLetter(totalCols - 2);
    const colLetterPercent = colToLetter(totalCols - 1);

    const rows = [];
    for (let i = 0; i < numRowsToWrite; i++) {
      const rowNum = startRow + 1 + i;
      const part = participantes[i] || null;
      const r = [
        i + 1,
        part ? (part.documento || "") : "",
        part ? (part.nombre || "") : "",
        part ? (part.correo || "") : ""
      ];

      for (let s = 0; s < numSesiones; s++) {
        let mark = "";
        if (part && part.asistencias) {
          mark = part.asistencias["sesion_" + s] || part.asistencias[s] || "";
        }
        r.push(mark);
      }

      // Fórmulas
      r.push('=COUNTIF(' + colLetterStart + rowNum + ':' + colLetterEnd + rowNum + ', "P")');
      r.push('=' + colLetterTotal + rowNum + ' / ' + numSesiones);
      r.push('=IF(' + colLetterPercent + rowNum + '>=0.8, "APROBADO", IF(' + colLetterTotal + rowNum + '>0, "EN CURSO", "PENDIENTE"))');
      rows.push(r);
    }

    sheet.getRange(startRow + 1, 1, numRowsToWrite, totalCols).setValues(rows);
    sheet.getRange(startRow + 1, totalCols - 1, numRowsToWrite, 1).setNumberFormat("0.0%");
    sheet.getRange(startRow + 1, 1, numRowsToWrite, 1).setHorizontalAlignment("center");
    sheet.getRange(startRow + 1, startColSesiones, numRowsToWrite, numSesiones + 3).setHorizontalAlignment("center");

    try {
      if (data.mesKey && data.nodeKey) {
        sheet.getRange("Z1").setValue(JSON.stringify({ mesKey: data.mesKey, nodeKey: data.nodeKey, sheetId: spreadsheet.getId() }));
        sheet.hideColumns(26);
      }
      asegurarActivadorDeEdicion(spreadsheet);
    } catch (eTrig) { }

    SpreadsheetApp.flush();

    return {
      success: true,
      count: participantes.length,
      sheetUrl: spreadsheet.getUrl(),
      message: "Se sincronizaron " + participantes.length + " participantes con la planilla de Google Drive."
    };
  } catch (err) {
    Logger.log("Error sincronizando participantes a Sheet: " + err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 4.6. LECTURA DE ASISTENCIA DESDE GOOGLE SHEETS PARA TABULACIÓN
 */
function leerAsistenciaDeSheet(data) {
  try {
    let spreadsheet = null;
    if (data.sheetId) {
      spreadsheet = SpreadsheetApp.openById(data.sheetId);
    } else if (data.sheetUrl) {
      const match = data.sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (match && match[1]) {
        spreadsheet = SpreadsheetApp.openById(match[1]);
      }
    }

    if (!spreadsheet) {
      return { success: false, error: "No se encontró la hoja de cálculo." };
    }

    const sheet = spreadsheet.getSheetByName("Control Asistencia") || spreadsheet.getActiveSheet();
    const startRow = 8;
    const lastRow = sheet.getLastRow();
    const numCols = sheet.getLastColumn();

    if (lastRow <= startRow) {
      return { success: true, participantes: [], sesionesTabuladas: {} };
    }

    const headerValues = sheet.getRange(startRow, 1, 1, numCols).getValues()[0];
    let numSesiones = 0;
    for (let c = 4; c < headerValues.length; c++) {
      const hStr = (headerValues[c] || "").toString().toLowerCase();
      if (hStr.includes("total") || hStr.includes("%") || hStr.includes("estado")) {
        numSesiones = c - 4;
        break;
      }
    }
    if (numSesiones <= 0) numSesiones = 8;

    const dataRows = sheet.getRange(startRow + 1, 1, lastRow - startRow, numCols).getValues();
    const participantes = [];
    const sesionesTabuladas = {};

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const doc = (row[1] || "").toString().trim();
      const nom = (row[2] || "").toString().trim();
      const cor = (row[3] || "").toString().trim();

      if (!doc && !nom && !cor) continue;

      const asistencias = {};
      for (let s = 0; s < numSesiones; s++) {
        const val = (row[4 + s] || "").toString().trim().toUpperCase();
        if (val) {
          asistencias["sesion_" + s] = val;
          sesionesTabuladas["sesion_" + s] = true;
        }
      }

      participantes.push({
        documento: doc,
        nombre: nom,
        correo: cor,
        asistencias: asistencias
      });
    }

    // Si viene mesKey y nodeKey, guardar directo en Firebase
    if (data.mesKey && data.nodeKey && participantes.length > 0) {
      try {
        sheet.getRange("Z1").setValue(JSON.stringify({ mesKey: data.mesKey, nodeKey: data.nodeKey, sheetId: spreadsheet.getId() }));
        sheet.hideColumns(26);
        asegurarActivadorDeEdicion(spreadsheet);
      } catch (eTrig) { }

      let existingParts = {};
      try {
        const exRes = UrlFetchApp.fetch(FIREBASE_DB_URL + "/meses/" + data.mesKey + "/programas/" + data.nodeKey + "/participantes.json", { muteHttpExceptions: true });
        if (exRes.getResponseCode() === 200) {
          existingParts = JSON.parse(exRes.getContentText()) || {};
        }
      } catch (eEx) { }

      const updates = {};
      const partObj = {};
      participantes.forEach((p, idx) => {
        let pKey = "";
        const cleanDoc = (p.documento || "").replace(/[^0-9A-Za-z_-]/g, "");
        for (const k of Object.keys(existingParts)) {
          const ex = existingParts[k];
          if (!ex) continue;
          const exDoc = String(ex.documento || "").replace(/[^0-9A-Za-z_-]/g, "");
          if (cleanDoc && exDoc && cleanDoc === exDoc) {
            pKey = k;
            break;
          }
          if (p.nombre && ex.nombre && String(ex.nombre).trim().toLowerCase() === String(p.nombre).trim().toLowerCase()) {
            pKey = k;
            break;
          }
        }
        if (!pKey) {
          pKey = "part_" + (cleanDoc || sanitizeFirebaseKeyGas(p.nombre || ("p_" + idx)));
        }
        const existingData = existingParts[pKey] || {};
        partObj[pKey] = {
          ...existingData,
          ...p,
          asistencias: { ...(existingData.asistencias || {}), ...(p.asistencias || {}) }
        };
      });
      updates["meses/" + data.mesKey + "/programas/" + data.nodeKey + "/participantes"] = partObj;
      updates["meses/" + data.mesKey + "/programas/" + data.nodeKey + "/sesiones_tabuladas"] = sesionesTabuladas;

      UrlFetchApp.fetch(FIREBASE_DB_URL + "/.json", {
        method: "patch",
        contentType: "application/json",
        payload: JSON.stringify(updates),
        muteHttpExceptions: true
      });
    }

    return {
      success: true,
      participantes: participantes,
      sesionesTabuladas: sesionesTabuladas,
      totalSesiones: numSesiones
    };
  } catch (err) {
    Logger.log("Error leyendo asistencia de Sheet: " + err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 4.7. ACTUALIZACIÓN DE MARCA DE ASISTENCIA INDIVIDUAL EN TIEMPO REAL
 */
function actualizarMarcaAsistenciaIndividual(data) {
  try {
    let spreadsheet = null;
    if (data.sheetId) {
      spreadsheet = SpreadsheetApp.openById(data.sheetId);
    } else if (data.sheetUrl) {
      const match = data.sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (match && match[1]) spreadsheet = SpreadsheetApp.openById(match[1]);
    }
    if (!spreadsheet && (data.folderId || data.drive_folder_id)) {
      try {
        const folder = DriveApp.getFolderById(data.folderId || data.drive_folder_id);
        const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
        if (files.hasNext()) spreadsheet = SpreadsheetApp.open(files.next());
      } catch (e) { }
    }
    if (!spreadsheet) return { success: false, error: "Planilla no encontrada" };

    const sheet = spreadsheet.getSheetByName("Control Asistencia") || spreadsheet.getActiveSheet();
    const startRow = 8;
    const lastRow = Math.max(sheet.getLastRow(), startRow + 30);

    const docTarget = (data.documento || "").toString().trim();
    const nomTarget = (data.nombre || "").toString().trim().toLowerCase();
    const studentIdx = parseInt(data.studentIndex, 10);
    const sesIdx = parseInt(data.sesionIndex, 10);
    const markVal = (data.mark || "").toString().trim().toUpperCase();

    let targetRow = -1;
    if (docTarget || nomTarget) {
      const docAndNomRange = sheet.getRange(startRow + 1, 2, Math.min(lastRow - startRow, 50), 2).getValues();
      for (let i = 0; i < docAndNomRange.length; i++) {
        const rowDoc = (docAndNomRange[i][0] || "").toString().trim();
        const rowNom = (docAndNomRange[i][1] || "").toString().trim().toLowerCase();
        if ((docTarget && rowDoc === docTarget) || (nomTarget && rowNom && (rowNom === nomTarget || rowNom.includes(nomTarget) || nomTarget.includes(rowNom)))) {
          targetRow = startRow + 1 + i;
          break;
        }
      }
    }

    if (targetRow === -1 && !isNaN(studentIdx) && studentIdx >= 0) {
      targetRow = startRow + 1 + studentIdx;
    }

    if (targetRow > 0 && !isNaN(sesIdx) && sesIdx >= 0) {
      const col = 5 + sesIdx; // Columna E en adelante
      sheet.getRange(targetRow, col).setValue(markVal);
      SpreadsheetApp.flush();
      return { success: true, updatedRow: targetRow, col: col, mark: markVal };
    }

    return { success: false, error: "No se encontró la fila del alumno" };
  } catch (err) {
    Logger.log("Error en actualizarMarcaAsistenciaIndividual: " + err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 4.8. ACTUALIZACIÓN MASIVA DE SESIÓN EN TIEMPO REAL
 */
function actualizarSesionCompletaAsistencia(data) {
  try {
    let spreadsheet = null;
    if (data.sheetId) {
      spreadsheet = SpreadsheetApp.openById(data.sheetId);
    } else if (data.sheetUrl) {
      const match = data.sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (match && match[1]) spreadsheet = SpreadsheetApp.openById(match[1]);
    }
    if (!spreadsheet && (data.folderId || data.drive_folder_id)) {
      try {
        const folder = DriveApp.getFolderById(data.folderId || data.drive_folder_id);
        const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
        if (files.hasNext()) spreadsheet = SpreadsheetApp.open(files.next());
      } catch (e) { }
    }
    if (!spreadsheet) return { success: false, error: "Planilla no encontrada" };

    const sheet = spreadsheet.getSheetByName("Control Asistencia") || spreadsheet.getActiveSheet();
    const startRow = 8;
    const lastRow = Math.max(sheet.getLastRow(), startRow + 30);
    const sesIdx = parseInt(data.sesionIndex, 10);
    const markVal = (data.mark || "").toString().trim().toUpperCase();
    const countStudents = data.numStudents ? parseInt(data.numStudents, 10) : (lastRow - startRow);

    if (!isNaN(sesIdx) && sesIdx >= 0) {
      const col = 5 + sesIdx;
      const rowsCount = Math.max(countStudents, 1);
      const vals = [];
      for (let i = 0; i < rowsCount; i++) vals.push([markVal]);
      sheet.getRange(startRow + 1, col, rowsCount, 1).setValues(vals);
      SpreadsheetApp.flush();
      return { success: true, updatedCol: col, count: rowsCount, mark: markVal };
    }
    return { success: false, error: "Índice de sesión inválido" };
  } catch (err) {
    Logger.log("Error en actualizarSesionCompletaAsistencia: " + err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 4.9. ACTIVADOR AUTOMÁTICO AL EDITAR EN GOOGLE SHEETS (SHEETS -> FIREBASE EN TIEMPO REAL)
 * Se ejecuta automáticamente en la nube cuando un usuario edita cualquier celda en Google Sheets.
 */
function alModificarPlanillaAsistencia(e) {
  if (!e || !e.range) return;
  try {
    const range = e.range;
    const sheet = range.getSheet();
    if (sheet.getName() !== "Control Asistencia") return;

    const startRow = 8;
    const startColSesiones = 5; // Columna E (Sesión 1)
    const startEditRow = range.getRow();
    const startEditCol = range.getColumn();
    const numEditRows = range.getNumRows();
    const numEditCols = range.getNumColumns();

    // Si toda la edición está en el encabezado o antes de la columna E, ignorar
    if (startEditRow + numEditRows - 1 <= startRow || startEditCol + numEditCols - 1 < startColSesiones) return;

    const numCols = Math.max(sheet.getLastColumn(), 15);
    const headerValues = sheet.getRange(startRow, 1, 1, numCols).getValues()[0];
    let numSesiones = 0;
    for (let c = 4; c < headerValues.length; c++) {
      const hStr = (headerValues[c] || "").toString().toLowerCase();
      if (hStr.includes("total") || hStr.includes("%") || hStr.includes("estado")) {
        numSesiones = c - 4;
        break;
      }
    }
    if (numSesiones <= 0) numSesiones = 8;

    const spreadsheet = e.source || sheet.getParent();
    const sheetId = spreadsheet.getId();

    // 1. Obtener metadatos del curso desde Z1 (optimizado en memoria)
    let mesKey = "";
    let nodeKey = "";
    try {
      const z1Val = sheet.getRange("Z1").getValue().toString().trim();
      if (z1Val && z1Val.startsWith("{")) {
        const meta = JSON.parse(z1Val);
        mesKey = meta.mesKey || "";
        nodeKey = meta.nodeKey || "";
      }
    } catch (eMeta) { }

    // 2. Si no están en Z1, buscar en Firebase
    if (!mesKey || !nodeKey) {
      try {
        const allRes = UrlFetchApp.fetch(FIREBASE_DB_URL + "/meses.json", { muteHttpExceptions: true });
        if (allRes.getResponseCode() === 200) {
          const allMeses = JSON.parse(allRes.getContentText()) || {};
          for (const mKey of Object.keys(allMeses)) {
            const progs = (allMeses[mKey] && allMeses[mKey].programas) || {};
            for (const nKey of Object.keys(progs)) {
              if (progs[nKey] && (progs[nKey].asistencia_sheet_id === sheetId || (progs[nKey].asistencia_sheet_url && progs[nKey].asistencia_sheet_url.includes(sheetId)))) {
                mesKey = mKey;
                nodeKey = nKey;
                break;
              }
            }
            if (mesKey) break;
          }
        }
      } catch (eScan) { }
    }

    if (!mesKey || !nodeKey) return;

    try {
      sheet.getRange("Z1").setValue(JSON.stringify({ mesKey: mesKey, nodeKey: nodeKey, sheetId: sheetId }));
      sheet.hideColumns(26);
    } catch (eZ) { }

    const basePath = "meses/" + mesKey + "/programas/" + nodeKey;

    // Obtener participantes existentes para preservar y matchear claves de forma segura
    let partsObj = {};
    try {
      const partsRes = UrlFetchApp.fetch(FIREBASE_DB_URL + "/" + basePath + "/participantes.json", { muteHttpExceptions: true });
      if (partsRes.getResponseCode() === 200) {
        partsObj = JSON.parse(partsRes.getContentText()) || {};
      }
    } catch (eP) { }

    const editValues = range.getValues();
    const minRow = Math.max(startEditRow, startRow + 1);
    const maxRow = startEditRow + numEditRows - 1;
    const countRows = maxRow - minRow + 1;
    if (countRows <= 0) return;

    // Leer información de alumnos de las filas editadas
    const studentInfoRows = sheet.getRange(minRow, 2, countRows, 3).getValues(); // Columnas B (doc), C (nom), D (cor)
    const updates = {};
    let hasUpdates = false;

    for (let r = 0; r < numEditRows; r++) {
      const curRow = startEditRow + r;
      if (curRow <= startRow) continue;

      const infoIdx = curRow - minRow;
      const doc = (studentInfoRows[infoIdx] && studentInfoRows[infoIdx][0] || "").toString().trim();
      const nom = (studentInfoRows[infoIdx] && studentInfoRows[infoIdx][1] || "").toString().trim();
      const cor = (studentInfoRows[infoIdx] && studentInfoRows[infoIdx][2] || "").toString().trim();
      if (!doc && !nom) continue;

      const cleanDoc = doc.replace(/[^0-9A-Za-z_-]/g, "");
      let pKey = "";

      // Buscar si ya existe por documento o nombre
      for (const k of Object.keys(partsObj)) {
        const p = partsObj[k];
        if (!p) continue;
        const pDoc = String(p.documento || "").replace(/[^0-9A-Za-z_-]/g, "");
        if (cleanDoc && pDoc && cleanDoc === pDoc) {
          pKey = k;
          break;
        }
        if (nom && p.nombre && String(p.nombre).trim().toLowerCase() === nom.toLowerCase()) {
          pKey = k;
          break;
        }
      }

      if (!pKey) {
        pKey = "part_" + (cleanDoc || sanitizeFirebaseKeyGas(nom));
        updates[basePath + "/participantes/" + pKey + "/documento"] = doc;
        updates[basePath + "/participantes/" + pKey + "/nombre"] = nom || "Sin nombre";
        if (cor) updates[basePath + "/participantes/" + pKey + "/correo"] = cor;
      }

      for (let c = 0; c < numEditCols; c++) {
        const curCol = startEditCol + c;
        if (curCol < startColSesiones) continue;

        const sesIdx = curCol - startColSesiones;
        if (sesIdx >= numSesiones) continue; // Columna de total o fuera de rango

        const rawCell = (editValues[r][c] !== undefined ? editValues[r][c] : "").toString().trim().toUpperCase();
        const markVal = (rawCell === "P" || rawCell === "F" || rawCell === "E") ? rawCell : (rawCell === "" ? "" : rawCell);

        updates[basePath + "/participantes/" + pKey + "/asistencias/sesion_" + sesIdx] = markVal ? markVal : null;
        if (markVal) {
          updates[basePath + "/sesiones_tabuladas/sesion_" + sesIdx] = true;
        }
        hasUpdates = true;
      }
    }

    if (hasUpdates && Object.keys(updates).length > 0) {
      UrlFetchApp.fetch(FIREBASE_DB_URL + "/.json", {
        method: "patch",
        contentType: "application/json",
        payload: JSON.stringify(updates),
        muteHttpExceptions: true
      });
      Logger.log("✓ Sincronización instantánea Sheets -> Firebase completada: " + Object.keys(updates).length + " registros");
    }
  } catch (err) {
    Logger.log("Error en alModificarPlanillaAsistencia: " + err.message);
  }
}

/**
 * Asegura que la hoja de cálculo tenga un activador onEdit para Sheets -> Firebase
 */
function asegurarActivadorDeEdicion(spreadsheet) {
  if (!spreadsheet) return;
  try {
    const sheetId = spreadsheet.getId();
    const triggers = ScriptApp.getProjectTriggers();
    let alreadyExists = false;

    for (let i = 0; i < triggers.length; i++) {
      const t = triggers[i];
      try {
        if (t.getHandlerFunction() === "alModificarPlanillaAsistencia" && t.getTriggerSourceId() === sheetId) {
          alreadyExists = true;
          break;
        }
      } catch (eT) { }
    }

    if (!alreadyExists) {
      if (triggers.length >= 18) {
        limpiarActivadoresAntiguos();
      }
      ScriptApp.newTrigger("alModificarPlanillaAsistencia")
        .forSpreadsheet(spreadsheet)
        .onEdit()
        .create();
      Logger.log("✓ Activador de edición vinculado a: " + spreadsheet.getName());
    }
  } catch (err) {
    Logger.log("Nota vinculando activador de edición: " + err.message);
  }
}

function limpiarActivadoresAntiguos() {
  try {
    const triggers = ScriptApp.getProjectTriggers();
    const editTriggers = triggers.filter(t => t.getHandlerFunction() === "alModificarPlanillaAsistencia");
    const countToDelete = Math.min(5, editTriggers.length);
    for (let i = 0; i < countToDelete; i++) {
      ScriptApp.deleteTrigger(editTriggers[i]);
    }
  } catch (e) { }
}

function vincularActivadoresParaTodasLasHojas() {
  let count = 0;
  try {
    const folders = DriveApp.getFoldersByName("Cursos CEC");
    if (!folders.hasNext()) return { success: false, message: "No se encontró carpeta Cursos CEC" };
    const root = folders.next();
    const subMeses = root.getFolders();

    while (subMeses.hasNext()) {
      const mesF = subMeses.next();
      const cursoFs = mesF.getFolders();
      while (cursoFs.hasNext()) {
        const cF = cursoFs.next();
        const files = cF.getFilesByType(MimeType.GOOGLE_SHEETS);
        while (files.hasNext()) {
          try {
            const sp = SpreadsheetApp.open(files.next());
            asegurarActivadorDeEdicion(sp);
            count++;
          } catch (e) { }
        }
      }
    }
  } catch (eGlobal) { }
  return { success: true, count: count };
}

/**
 * ACTUALIZADOR DE CARPETA Y FICHA DE ASISTENCIA EN TIEMPO REAL
 * Se ejecuta mediante Webhook cuando se edita un curso en la web.
 */
function actualizarEstructuraDriveExistente(prog) {
  if (!prog) return { success: false, error: "Datos no proporcionados" };
  const nombreCurso = (prog.programa || prog.nombre_del_programa || prog.nombre || "").trim();
  const nrc = (prog.nrc || "").toString().trim();
  const cleanCursoFolder = (nombreCurso + (nrc ? (" - NRC " + nrc) : "")).replace(/[\\/:*?"<>|]/g, "_").substring(0, 100);

  let cursoFolder = null;
  if (prog.folderId || prog.drive_folder_id) {
    try {
      cursoFolder = DriveApp.getFolderById(prog.folderId || prog.drive_folder_id);
    } catch (e) { }
  }

  // Si no se encontró por ID, buscarlo por nombre
  if (!cursoFolder) {
    const rootIter = DriveApp.getFoldersByName("Cursos CEC");
    if (rootIter.hasNext()) {
      const rootFolder = rootIter.next();
      const mesFolderName = getMesKeyDrive(prog.mes || prog.origen_mes || "");
      const mesIter = rootFolder.getFoldersByName(mesFolderName);
      const parentFolder = mesIter.hasNext() ? mesIter.next() : rootFolder;
      const subIter = parentFolder.getFoldersByName(cleanCursoFolder);
      if (subIter.hasNext()) {
        cursoFolder = subIter.next();
      }
    }
  }

  // Si la carpeta existe, renombrarla si su nombre cambió
  if (cursoFolder) {
    if (cursoFolder.getName() !== cleanCursoFolder) {
      cursoFolder.setName(cleanCursoFolder);
    }

    // Actualizar datos dentro de la hoja de cálculo
    const sheetFileName = "Asistencia - " + nombreCurso + (nrc ? (" (NRC " + nrc + ")") : "");
    const fileIter = cursoFolder.getFilesByType(MimeType.GOOGLE_SHEETS);
    if (fileIter.hasNext()) {
      const sheetFile = fileIter.next();
      if (sheetFile.getName() !== sheetFileName) {
        sheetFile.setName(sheetFileName);
      }
      try {
        const spreadsheet = SpreadsheetApp.openById(sheetFile.getId());
        const sheet = spreadsheet.getActiveSheet();
        sheet.getRange("C4:G4").setValue(nombreCurso);
        sheet.getRange("J4:M4").setValue(nrc || "Sin asignar");
        sheet.getRange("C5:G5").setValue((prog.coordinadora || prog.nombre_contacto || "") + (prog.celular ? " · Tel: " + prog.celular : ""));
        sheet.getRange("J5:M5").setValue((prog.modalidad || "Presencial") + (prog.salon || prog.salones_1_val ? " · " + (prog.salon || prog.salones_1_val) : ""));
        sheet.getRange("C6:M6").setValue(
          (prog.fecha_inicio ? (prog.fecha_inicio + " al " + (prog.fecha_fin || "")) : "") +
          (prog.horario ? (" | Horario: " + prog.horario) : "")
        );
      } catch (eSheet) {
        Logger.log("Nota actualizando hoja: " + eSheet.message);
      }
    }

    return {
      success: true,
      folderId: cursoFolder.getId(),
      folderUrl: cursoFolder.getUrl()
    };
  } else {
    // Si no existía carpeta previa, crearla desde cero
    return crearEstructuraDriveYAsistencia(prog);
  }
}

/**
 * 4.5. PROCESADOR DE CORREOS ENTRANTES POR REENVÍO WEBHOOK (CLOUDMAILIN / ZAPIER / MAKE / HTTP DIRECTO)
 */
function procesarCorreoEntranteJson(data) {
  try {
    // 1. Extraer remitente
    let from = data.from || data.sender || data.remitente || "";
    if (!from && data.headers && data.headers.From) from = data.headers.From;

    // 2. Extraer asunto
    let subject = data.subject || data.asunto || "";
    if (!subject && data.headers && data.headers.Subject) subject = data.headers.Subject;

    // 3. Extraer cuerpo del correo
    let plainBody = data.plain || data.body || data.text || data.cuerpo || "";
    if (!plainBody && data.html) {
      plainBody = data.html.replace(/<[^>]*>/g, " "); // Limpiar HTML básico si solo viene HTML
    }

    if (!subject && !plainBody) {
      return { success: false, error: "Asunto y cuerpo vacíos en el payload recibido" };
    }

    Logger.log("⚡ [INBOUND EMAIL WEBHOOK] Recibido: " + subject + " de " + from);

    // 4. Extraer datos del curso con IA o heurístico
    let datosExtraidos = null;
    if (GEMINI_API_KEY && GEMINI_API_KEY.trim().length > 10) {
      datosExtraidos = extraerConGeminiAI(subject, plainBody);
    }
    if (!datosExtraidos) {
      datosExtraidos = extraerHeuristico(subject, plainBody);
    }

    const uniqueId = "inbound_" + new Date().getTime();
    const payload = {
      id: uniqueId,
      message_id: data.message_id || uniqueId,
      remitente: from || "Remitente Desconocido",
      asunto: subject || "Solicitud de Apertura",
      fecha_correo: data.date || data.fecha || new Date().toISOString(),
      fecha_deteccion: new Date().toISOString(),
      cuerpo_resumen: plainBody.substring(0, 800),
      cuerpo_completo: plainBody.substring(0, 4000),
      datos_extraidos: datosExtraidos,
      estado: "pendiente",
      origen: "filtro_reenvio_webhook"
    };

    // Guardar en Firebase Realtime Database
    const url = FIREBASE_DB_URL + "/solicitudes_pendientes/" + uniqueId + ".json";
    UrlFetchApp.fetch(url, {
      method: "put",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    Logger.log("✓ Solicitud guardada en Firebase desde Webhook de reenvío: " + uniqueId);
    return {
      success: true,
      requestId: uniqueId,
      programa: datosExtraidos ? datosExtraidos.nombre : subject,
      message: "Correo procesado y registrado con éxito en Firebase"
    };
  } catch (err) {
    Logger.log("Error en procesarCorreoEntranteJson: " + err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 5. WEBHOOK HTTP PRINCIPAL (PROCESAMIENTO EN TIEMPO REAL DE CREACIÓN, EDICIÓN Y ELIMINACIÓN)
 */
function doPost(e) {
  try {
    const bodyText = (e && e.postData && e.postData.contents) ? e.postData.contents : "{}";
    const data = JSON.parse(bodyText);

    // 0. NOTIFICACIÓN PUSH DE GMAIL VIA GOOGLE CLOUD PUB/SUB (ESTILO WEBHOOK EN TIEMPO REAL)
    // Cuando entra un correo, Pub/Sub envía inmediatamente este payload a doPost
    if (data && data.message && (data.message.data || data.message.messageId || data.message.message_id)) {
      Logger.log("⚡ [GMAIL PUSH WEBHOOK] Notificación instantánea recibida de Google Cloud Pub/Sub.");
      try {
        if (data.message.data) {
          const decoded = Utilities.newBlob(Utilities.base64Decode(data.message.data)).getDataAsString();
          Logger.log("Payload Gmail Push decodificado: " + decoded);
        }
      } catch (errDec) {
        Logger.log("Nota decodificando Pub/Sub: " + errDec.message);
      }

      // Procesar correos de apertura inmediatamente en tiempo cero
      try {
        revisarCorreosAperturaCurso();
      } catch (errSync) {
        Logger.log("Error en sincronización por push: " + errSync.message);
      }

      // Responder 200 OK con JSON para confirmar recepción a Pub/Sub
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        status: "processed",
        source: "gmail_pubsub_webhook",
        timestamp: new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 0.5. VERIFICACIÓN BAJO DEMANDA DESDE EL TABLERO WEB
    if (data.action === "check_emails" || data.action === "revisar_correos") {
      try {
        revisarCorreosAperturaCurso();
      } catch (errCheck) {
        Logger.log("Error en check_emails: " + errCheck.message);
      }
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        action: "checked_emails",
        message: "Búsqueda de correos de apertura ejecutada en tiempo real.",
        timestamp: new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 0.6. REENVÍO AUTOMÁTICO DE GMAIL (INBOUND EMAIL PARSE / CLOUDMAILIN / ZAPIER / MAKE)
    if (data.action === "inbound_email" || data.headers || data.plain || (data.subject && (data.body || data.text || data.plain)) || (data.asunto && data.cuerpo)) {
      const resultInbound = procesarCorreoEntranteJson(data);
      return ContentService.createTextOutput(JSON.stringify(resultInbound))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 1. PING para verificar el webhook desde la web
    if (data.action === "ping") {
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        status: "connected",
        message: "Webhook de Google Apps Script conectado exitosamente en tiempo real.",
        timestamp: new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 2. ELIMINACIÓN DE CURSO EN TIEMPO REAL
    if (data.action === "delete" || data.action === "delete_folder") {
      if (data.folderId) {
        try {
          DriveApp.getFolderById(data.folderId).setTrashed(true);
          Logger.log("✓ Carpeta enviada a papelera por webhook: " + data.folderId);
        } catch (e2) {
          eliminarCarpetaCursoPorNombre(data.mes, data.nombre, data.nrc);
        }
      } else {
        eliminarCarpetaCursoPorNombre(data.mes, data.nombre, data.nrc);
      }
      return ContentService.createTextOutput(JSON.stringify({ success: true, action: "deleted" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 3. VACIAR BASE DE DATOS / CARPETAS EN TIEMPO REAL
    if (data.action === "vaciar_todo") {
      eliminarTodasLasCarpetasCursosDrive();
      return ContentService.createTextOutput(JSON.stringify({ success: true, action: "emptied" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 4. EDICIÓN DE CURSO EN TIEMPO REAL
    if (data.action === "edit" || data.action === "update") {
      const resultEdit = actualizarEstructuraDriveExistente(data);
      if (data.mesKey && data.nodeKey && resultEdit.success) {
        const updates = {};
        if (resultEdit.folderUrl) updates["meses/" + data.mesKey + "/programas/" + data.nodeKey + "/drive_folder_url"] = resultEdit.folderUrl;
        if (resultEdit.folderId) updates["meses/" + data.mesKey + "/programas/" + data.nodeKey + "/drive_folder_id"] = resultEdit.folderId;
        UrlFetchApp.fetch(FIREBASE_DB_URL + "/.json", {
          method: "patch",
          contentType: "application/json",
          payload: JSON.stringify(updates),
          muteHttpExceptions: true
        });
      }
      return ContentService.createTextOutput(JSON.stringify(resultEdit))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 5. IMPORTACIÓN MASIVA EN TIEMPO REAL (BATCH CREATE)
    if (data.action === "batch_create" && Array.isArray(data.items)) {
      let createdCount = 0;
      for (let i = 0; i < data.items.length; i++) {
        const item = data.items[i];
        if (!item) continue;
        try {
          const resDrive = crearEstructuraDriveYAsistencia(item);
          const mesKey = item.mesKey || getMesKeyDrive(item.mes || item.origen_mes || "General");
          const nodeKey = item.nodeKey || item.id || sanitizeFirebaseKeyGas(item.programa || item.nombre || "prog");

          const updates = {};
          updates["meses/" + mesKey + "/programas/" + nodeKey + "/drive_folder_url"] = resDrive.folderUrl;
          updates["meses/" + mesKey + "/programas/" + nodeKey + "/drive_folder_id"] = resDrive.folderId;
          updates["meses/" + mesKey + "/programas/" + nodeKey + "/asistencia_sheet_url"] = resDrive.sheetUrl;
          updates["meses/" + mesKey + "/programas/" + nodeKey + "/asistencia_sheet_id"] = resDrive.sheetId;
          updates["meses/" + mesKey + "/programas/" + nodeKey + "/drive_creado_el"] = new Date().toISOString();

          UrlFetchApp.fetch(FIREBASE_DB_URL + "/.json", {
            method: "patch",
            contentType: "application/json",
            payload: JSON.stringify(updates),
            muteHttpExceptions: true
          });
          createdCount++;
        } catch (errItem) {
          Logger.log("Error en batch create webhook: " + errItem.message);
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ success: true, createdCount: createdCount }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    // 5.5. SINCRONIZACIÓN DE PARTICIPANTES A GOOGLE SHEETS
    if (data.action === "sync_participants") {
      const resSyncPart = sincronizarParticipantesASheet(data);
      return ContentService.createTextOutput(JSON.stringify(resSyncPart))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 5.6. LECTURA Y AUDITORÍA DE ASISTENCIA DESDE GOOGLE SHEETS
    if (data.action === "read_attendance" || data.action === "sync_attendance") {
      const resReadAtt = leerAsistenciaDeSheet(data);
      return ContentService.createTextOutput(JSON.stringify(resReadAtt))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 5.7. ACTUALIZACIÓN DE MARCA INDIVIDUAL EN TIEMPO REAL
    if (data.action === "update_attendance_mark") {
      const resMark = actualizarMarcaAsistenciaIndividual(data);
      return ContentService.createTextOutput(JSON.stringify(resMark))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 5.8. ACTUALIZACIÓN DE SESIÓN COMPLETA EN TIEMPO REAL
    if (data.action === "update_session_attendance") {
      const resSes = actualizarSesionCompletaAsistencia(data);
      return ContentService.createTextOutput(JSON.stringify(resSes))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 5.9. VINCULAR ACTIVADOR ONEDIT EN TIEMPO REAL (SHEETS -> FIREBASE)
    if (data.action === "setup_sheet_triggers" || data.action === "vincular_activadores") {
      let resTrig = { success: true };
      if (data.sheetId) {
        try {
          const sp = SpreadsheetApp.openById(data.sheetId);
          asegurarActivadorDeEdicion(sp);
          if (data.mesKey && data.nodeKey) {
            const sh = sp.getSheetByName("Control Asistencia") || sp.getActiveSheet();
            sh.getRange("Z1").setValue(JSON.stringify({ mesKey: data.mesKey, nodeKey: data.nodeKey, sheetId: data.sheetId }));
            sh.hideColumns(26);
          }
          resTrig = { success: true, sheetId: data.sheetId, sheetName: sp.getName(), message: "Activador de edición en tiempo real vinculado a la planilla." };
        } catch (eTrig) {
          resTrig = { success: false, error: eTrig.message };
        }
      } else {
        resTrig = vincularActivadoresParaTodasLasHojas();
      }
      return ContentService.createTextOutput(JSON.stringify(resTrig))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 6. SINCRONIZACIÓN DE TODOS LOS CURSOS
    if (data.action === "sync_all") {
      sincronizarTodosLosCursosADrive();
      return ContentService.createTextOutput(JSON.stringify({ success: true, action: "synced_all" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 7. CREACIÓN DE CURSO EN TIEMPO REAL
    if (data.action === "create" || data.action === "crear_curso" || data.action === "create_course" || (!data.action && (data.programa || data.nombre))) {
      const result = crearEstructuraDriveYAsistencia(data);
      if (data.mesKey && data.nodeKey) {
        const updates = {};
        updates["meses/" + data.mesKey + "/programas/" + data.nodeKey + "/drive_folder_url"] = result.folderUrl;
        updates["meses/" + data.mesKey + "/programas/" + data.nodeKey + "/drive_folder_id"] = result.folderId;
        updates["meses/" + data.mesKey + "/programas/" + data.nodeKey + "/asistencia_sheet_url"] = result.sheetUrl;
        updates["meses/" + data.mesKey + "/programas/" + data.nodeKey + "/asistencia_sheet_id"] = result.sheetId;
        updates["meses/" + data.mesKey + "/programas/" + data.nodeKey + "/drive_creado_el"] = new Date().toISOString();

        UrlFetchApp.fetch(FIREBASE_DB_URL + "/.json", {
          method: "patch",
          contentType: "application/json",
          payload: JSON.stringify(updates),
          muteHttpExceptions: true
        });
      }

      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ success: false, error: "Acción no reconocida: " + data.action }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ status: "ok", app: "CEC Uninorte Drive Webhook", timestamp: new Date().toISOString() }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 6. UTILIDADES AUXILIARES Y EXTRACTOR INTELIGENTE
 */
function getMesKeyDrive(mesStr) {
  const MESES_DICT = {
    enero: "01_Enero", febrero: "02_Febrero", marzo: "03_Marzo", abril: "04_Abril",
    mayo: "05_Mayo", junio: "06_Junio", julio: "07_Julio", agosto: "08_Agosto",
    septiembre: "09_Septiembre", setiembre: "09_Septiembre", octubre: "10_Octubre",
    noviembre: "11_Noviembre", diciembre: "12_Diciembre"
  };
  const m = (mesStr || "").toLowerCase().replace(/^[0-9]+_/, "");
  return MESES_DICT[m] || "01_Enero";
}

function sanitizeFirebaseKeyGas(str) {
  return (str || "prog").toString().trim().replace(/[.$#\[\]\/]/g, "_");
}

function extraerConGeminiAI(asunto, texto) {
  try {
    const prompt = 'Analiza el siguiente correo sobre "Apertura de Curso/Programa" en el Centro de Educación Continuada (CEC) y extrae los datos en formato JSON estricto sin bloques markdown:\n' +
      '{\n' +
      '  "nombre": "Nombre completo del curso, diplomado o taller",\n' +
      '  "nrc": "Código NRC numérico de 4 a 6 dígitos",\n' +
      '  "modalidad": "Presencial" | "Remoto" | "Blended",\n' +
      '  "tipo": "Curso" | "Diplomado" | "Taller" | "Seminario" | "Certificación",\n' +
      '  "coordinadora": "Nombre y apellido del docente o coordinadora responsable (sin títulos como Dra. o Lic.)",\n' +
      '  "celular": "Número telefónico o celular limpio (solo dígitos)",\n' +
      '  "fechaInicio": "YYYY-MM-DD",\n' +
      '  "fechaFin": "YYYY-MM-DD",\n' +
      '  "horario": "Texto legible de horario, ej: Lunes y Miércoles 6:00 pm a 9:00 pm",\n' +
      '  "salones": "Salón, aula o link virtual Teams/Zoom",\n' +
      '  "mes": "Nombre del mes de inicio (Enero, Febrero, Marzo, Abril, Mayo, Junio, Julio, Agosto, Septiembre, Octubre, Noviembre, Diciembre)",\n' +
      '  "observaciones": "Cualquier detalle relevante adicional"\n' +
      '}\n\n' +
      'Asunto: ' + asunto + '\n' +
      'Cuerpo del correo:\n' + texto.substring(0, 3000);

    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + GEMINI_API_KEY;
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
      }),
      muteHttpExceptions: true
    });

    if (res.getResponseCode() === 200) {
      const data = JSON.parse(res.getContentText());
      const rawText = data.candidates[0].content.parts[0].text;
      return JSON.parse(rawText);
    }
  } catch (e) {
    Logger.log("Fallo Gemini API: " + e.message);
  }
  return null;
}

/**
 * FILTRO ESTRICTO ANTI-FALSOS POSITIVOS
 * Descarta automáticamente boletines, digestos de Quora, confirmaciones de Zoom,
 * notificaciones de sistemas automáticos y correos que no correspondan a cursos.
 */
function esCorreoAperturaValido(subject, plainBody, from) {
  const s = (subject || "").toLowerCase();
  const f = (from || "").toLowerCase();
  const b = (plainBody || "").toLowerCase();
  const full = s + "\n" + b;

  // 1. Descarte inmediato por remitentes no humanos / listas / sistemas
  if (/quora\.com|zoom\.us|notifications?@|no-?reply|mailer-daemon|postmaster|newsletter|digest|marketing|linkedin|facebook|twitter|instagram|tiktok|googlealerts|youtube|promocion|bounces/i.test(f)) {
    Logger.log("⛔ Descartado por remitente no válido: " + from);
    return false;
  }

  // 2. Descarte inmediato por asuntos típicos de boletines o confirmaciones personales
  if (/quora|digest|confirmaci[oó]n\s+de\s+(?:zoom|reuni[oó]n|cita)|resumen\s+semanal|newsletter|publicidad|promoci[oó]n|estado\s+de\s+cuenta/i.test(s)) {
    Logger.log("⛔ Descartado por asunto no operativo: " + subject);
    return false;
  }

  // 3. Si el asunto contiene explícitamente "apertura" o "solicitud de apertura", es alta probabilidad
  if (/apertura/i.test(s)) {
    return true;
  }

  // 4. Si el asunto no tiene "apertura", pero menciona "diplomado" o en el cuerpo dice "solicitud de apertura":
  // Exigir al menos 2 datos operacionales concretos de curso (NRC, fechas, horario o docente)
  let score = 0;
  if (/\b(nrc|c[oó]digo)\b/i.test(full)) score += 2;
  if (/\b(horario|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|\d{1,2}:\d{2}\s*(?:am|pm)?)\b/i.test(full)) score += 2;
  if (/\b(fecha|inicia|inicio|finaliza|fin|\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre))\b/i.test(full)) score += 2;
  if (/\b(sal[oó]n|link|enlace|presencial|remoto|virtual|blended)\b/i.test(full)) score += 1;
  if (/\b(coordinador|coordinadora|docente|profesor|facilitador)\b/i.test(full)) score += 1;
  if (/solicitud/i.test(full)) score += 1;

  if (score >= 4) {
    return true;
  }

  Logger.log("⛔ Descartado por puntaje insuficiente de datos de curso (score: " + score + "): " + subject);
  return false;
}

function extraerHeuristico(asunto, texto) {
  const full = (asunto || "") + "\n" + (texto || "");

  const nrcMatch = full.match(/\bNRC[:\s#.-]*([0-9]{4,6})\b/i) ||
    full.match(/(?:c[oó]digo(?:\s+nrc)?|id)[:\s#.-]*([0-9]{4,6})\b/i) ||
    full.match(/\(([0-9]{4,6})\)/);
  const nrc = nrcMatch ? nrcMatch[1] : "";

  let modalidad = "Presencial";
  if (/blended|h[ií]brid[oa]|semipresencial/i.test(full)) {
    modalidad = "Blended";
  } else if (/remot[oa]|virtual|online|teams|zoom|meet/i.test(full)) {
    modalidad = "Remoto";
  }

  let tipo = "Curso";
  if (/diplomado/i.test(full)) tipo = "Diplomado";
  else if (/taller/i.test(full)) tipo = "Taller";
  else if (/seminario/i.test(full)) tipo = "Seminario";
  else if (/certificaci[oó]n/i.test(full)) tipo = "Certificación";

  let nombre = "";
  const explicit = (texto || "").match(/(?:nombre(?:\s+del\s+(?:programa|curso|evento|taller|diplomado))?|programa|curso|diplomado|taller)\s*[:=]\s*([^\n\r]+)/i);
  if (explicit && explicit[1].trim().length > 3) {
    nombre = explicit[1].trim();
  }
  if (!nombre) {
    const inlineAction = (texto || "").match(/(?:favor\s+abrir|apertura(?:\s+formal)?(?:\s+del?)?)\s+(?:el\s+)?((?:curso|diplomado|taller|seminario|programa)\s+[^(\n\r,.;]+)/i);
    if (inlineAction && inlineAction[1].trim().length > 3) {
      nombre = inlineAction[1].trim();
    }
  }
  if (!nombre) {
    nombre = (asunto || "").replace(/^(?:fwd|rv|re)[:\s]*/gi, "")
      .replace(/^(?:solicitud(?:\s+de)?\s+)?apertura(?:\s+de|\s+del?)?(?:\s+(?:curso|programa|taller|diplomado|seminario))?[:\s-]*/gi, "")
      .trim();
  }
  nombre = nombre.replace(/^(?:de|del)\s+/i, "")
    .replace(/\s*\(?\s*NRC[:\s#]*[0-9]{4,6}\s*\)?/i, "")
    .replace(/[•\-\*\.]\s*$/g, "")
    .replace(/^[•\-\*\.]\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!nombre) nombre = "Apertura de Curso";

  const MESES_DICT = {
    enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06",
    julio: "07", agosto: "08", septiembre: "09", setiembre: "09", octubre: "10", noviembre: "11", diciembre: "12"
  };
  const MESES_LIST = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  const anioActual = new Date().getFullYear();
  let fechaInicio = "";
  let fechaFin = "";

  const rangeSame = full.match(/(?:del?|desde)?\s*(\d{1,2})\s*(?:al?|a|-)\s*(\d{1,2})\s+de\s+([a-zá-ú]+)(?:\s+de\s+(\d{4}))?/i);
  if (rangeSame && MESES_DICT[rangeSame[3].toLowerCase()]) {
    const m = MESES_DICT[rangeSame[3].toLowerCase()];
    const y = rangeSame[4] || anioActual;
    fechaInicio = y + "-" + m + "-" + String(rangeSame[1]).padStart(2, "0");
    fechaFin = y + "-" + m + "-" + String(rangeSame[2]).padStart(2, "0");
  }

  if (!fechaInicio) {
    const rangeDiff = full.match(/(?:del?|desde)?\s*(\d{1,2})\s+de\s+([a-zá-ú]+)(?:\s+de\s+(\d{4}))?\s*(?:al?|hasta|a|-)\s*(\d{1,2})\s+de\s+([a-zá-ú]+)(?:\s+de\s+(\d{4}))?/i);
    if (rangeDiff && MESES_DICT[rangeDiff[2].toLowerCase()] && MESES_DICT[rangeDiff[5].toLowerCase()]) {
      const y1 = rangeDiff[3] || anioActual;
      const y2 = rangeDiff[6] || y1;
      fechaInicio = y1 + "-" + MESES_DICT[rangeDiff[2].toLowerCase()] + "-" + String(rangeDiff[1]).padStart(2, "0");
      fechaFin = y2 + "-" + MESES_DICT[rangeDiff[5].toLowerCase()] + "-" + String(rangeDiff[4]).padStart(2, "0");
    }
  }

  if (!fechaInicio) {
    const dStart = full.match(/(?:inicio|inicia|desde|fechas?[:\s]*del?)[:\s]*(\d{1,2})\s+de\s+([a-zá-ú]+)(?:\s+de\s+(\d{4}))?/i);
    if (dStart && MESES_DICT[dStart[2].toLowerCase()]) {
      fechaInicio = (dStart[3] || anioActual) + "-" + MESES_DICT[dStart[2].toLowerCase()] + "-" + String(dStart[1]).padStart(2, "0");
    }
  }
  if (!fechaFin) {
    const dEnd = full.match(/(?:fin|finaliza|hasta|cierre)[:\s]*(\d{1,2})\s+de\s+([a-zá-ú]+)(?:\s+de\s+(\d{4}))?/i);
    if (dEnd && MESES_DICT[dEnd[2].toLowerCase()]) {
      fechaFin = (dEnd[3] || anioActual) + "-" + MESES_DICT[dEnd[2].toLowerCase()] + "-" + String(dEnd[1]).padStart(2, "0");
    }
  }

  if (!fechaInicio) {
    const isoMatches = full.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g);
    if (isoMatches && isoMatches.length >= 1) {
      const p1 = isoMatches[0].split(/[-/]/);
      fechaInicio = p1[0] + "-" + String(p1[1]).padStart(2, "0") + "-" + String(p1[2]).padStart(2, "0");
      if (isoMatches.length >= 2) {
        const p2 = isoMatches[1].split(/[-/]/);
        fechaFin = p2[0] + "-" + String(p2[1]).padStart(2, "0") + "-" + String(p2[2]).padStart(2, "0");
      }
    }
  }
  if (!fechaInicio) {
    const latamMatches = full.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/g);
    if (latamMatches && latamMatches.length >= 1) {
      const p1 = latamMatches[0].split(/[-/]/);
      fechaInicio = p1[2] + "-" + String(p1[1]).padStart(2, "0") + "-" + String(p1[0]).padStart(2, "0");
      if (latamMatches.length >= 2) {
        const p2 = latamMatches[1].split(/[-/]/);
        fechaFin = p2[2] + "-" + String(p2[1]).padStart(2, "0") + "-" + String(p2[0]).padStart(2, "0");
      }
    }
  }

  let mes = "";
  if (fechaInicio) {
    const mNum = parseInt(fechaInicio.split("-")[1], 10);
    if (mNum >= 1 && mNum <= 12) mes = MESES_LIST[mNum - 1];
  }
  if (!mes) {
    for (let i = 0; i < MESES_LIST.length; i++) {
      if (new RegExp(MESES_LIST[i], "i").test(full)) {
        mes = MESES_LIST[i];
        break;
      }
    }
  }

  let coordinadora = "";
  const coordMatch = full.match(/(?:coordinador[a]?\s*(?:encargad[oa]|acad[eé]mic[oa]|responsable)?|docente\s*(?:responsable|encargad[oa])?|profesor[a]?|solicitado\s+por|responsable|instructor[a]?|facilitador[a]?|a\s+cargo\s+de)[:\s]+(?:(?:Lic\.|Dra?\.|Ing\.|Mg\.|Prof\.)\s*)?([^\n\r,;()\-•0-9]+)/i);
  if (coordMatch) {
    coordinadora = coordMatch[1].replace(/\s+/g, " ").trim();
    if (/^(?:encargad[oa]|responsable|docente|profesor[a]?)$/i.test(coordinadora)) coordinadora = "";
  }

  const celMatch = full.match(/(?:celular|tel[eé]fono|m[oó]vil|whatsapp|cel|tel)[:\s]*([+0-9\s\-()]{7,20})/i) ||
    full.match(/\b(?:\+?57\s*)?3[0-9]{2}[\s\-]?[0-9]{3}[\s\-]?[0-9]{4}\b/);
  let celular = celMatch ? (celMatch[1] || celMatch[0]).replace(/[^0-9+]/g, "") : "";

  let horario = "";
  const horMatch = full.match(/(?:horario[s]?|d[ií]as\s*(?:y\s*horas?)?|clases?|sesiones?)\s*[:=]\s*([^\n\r]+)/i);
  if (horMatch) {
    horario = horMatch[1].trim();
  } else {
    const daysLine = full.match(/(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?)[^.\n\r]+(?:de\s+\d{1,2}|\d{1,2}:\d{2})/i);
    if (daysLine) horario = daysLine[0].trim();
  }

  let salones = "";
  const salMatch = full.match(/(?:sal[oó]n|aula|espacio|ubicaci[oó]n|laboratorio|enlace|link|teams|zoom|sala)\s*[:=]\s*([^\n\r]+)/i);
  if (salMatch) {
    salones = salMatch[1].trim();
  } else {
    const inlineSalon = full.match(/(?:en\s+el\s+|sal[oó]n\s+)(sal[oó]n\s+[0-9A-Za-z]+|aula\s+[0-9A-Za-z]+|lab(?:oratorio)?\s+[0-9A-Za-z]+)/i);
    if (inlineSalon) salones = inlineSalon[1].trim();
  }

  return {
    nombre: nombre,
    nrc: nrc,
    modalidad: modalidad,
    tipo: tipo,
    coordinadora: coordinadora,
    celular: celular,
    fechaInicio: fechaInicio,
    fechaFin: fechaFin,
    horario: horario,
    salones: salones,
    mes: mes || "Enero",
    observaciones: "Extraído automáticamente de correo"
  };
}

/**
 * Función de prueba: Crea manualmente un curso de prueba en Google Drive
 * Selecciona esta función arriba y haz clic en "Ejecutar" para verificar que se creen las carpetas.
 */
function probarCreacionDriveManual() {
  const testProg = {
    programa: "Curso de Prueba - Inteligencia Artificial y Datos",
    nrc: "98765",
    mes: "Mayo",
    coordinadora: "Dra. Laura Gómez",
    celular: "3001234567",
    modalidad: "Presencial",
    salon: "Salón CEC 302",
    horario: "Martes y Jueves de 6:00 pm a 9:00 pm",
    fecha_inicio: "2026-05-12",
    fecha_fin: "2026-05-28",
    analisis_horario: {
      fechas_sesion: [
        "2026-05-12", "2026-05-14", "2026-05-19", "2026-05-21",
        "2026-05-26", "2026-05-28"
      ]
    }
  };

  const resultado = crearEstructuraDriveYAsistencia(testProg);
  Logger.log("¡ÉXITO CREANDO EN GOOGLE DRIVE!");
  Logger.log("Carpeta Drive URL: " + resultado.folderUrl);
  Logger.log("Planilla Asistencia URL: " + resultado.sheetUrl);
}

// =============================================================================
// 8. UTILIDADES Y LIMPIEZA DE ACTIVADORES
// =============================================================================

/**
 * Elimina cualquier activador minutero obsoleto de 1 minuto que estuviera corriendo
 * Selecciona esta función arriba y haz clic en "Ejecutar" una sola vez para limpiar triggers viejos.
 */
function eliminarActivadoresMinuterosViejos() {
  const triggers = ScriptApp.getProjectTriggers();
  let count = 0;
  for (let i = 0; i < triggers.length; i++) {
    const func = triggers[i].getHandlerFunction();
    if (func === "revisarCorreosAperturaCurso" || func === "sincronizarCorreosConFirebase" || func === "activarGmailPushWatch") {
      ScriptApp.deleteTrigger(triggers[i]);
      count++;
    }
  }
  Logger.log("✓ Se eliminaron " + count + " activadores anteriores.");
}

/**
 * (Opcional) Crea un activador tranquilo cada 30 minutos como respaldo para cuando tu PC esté apagado
 */
function configurarActivadorRespaldo30Min() {
  eliminarActivadoresMinuterosViejos();
  ScriptApp.newTrigger("revisarCorreosAperturaCurso")
    .timeBased()
    .everyMinutes(30)
    .create();
  Logger.log("✓ Activador de respaldo configurado cada 30 minutos.");
}
`;

  // Inicializar el listener en tiempo real de Firebase
  function initEmailRequestsListener(db) {
    if (!db || emailListenerInitialized) return;
    emailListenerInitialized = true;

    db.ref('solicitudes_pendientes').on('value', (snapshot) => {
      const data = snapshot.val() || {};
      currentEmailRequests = data;

      const keys = Object.keys(data).filter(k => data[k] && data[k].estado !== 'aprobado_guardado');
      const count = keys.length;

      // Actualizar contadores
      updateEmailBadges(count);

      // Detectar si hay nuevas solicitudes que no conocíamos
      if (!isFirstEmailLoad) {
        keys.forEach(k => {
          if (!knownEmailRequestIds.has(k)) {
            const req = data[k];
            showEmailToast(req);
          }
        });
      }

      knownEmailRequestIds = new Set(keys);
      isFirstEmailLoad = false;

      // Si el modal está visible, refrescar el listado
      if (emailModal && !emailModal.hasAttribute('hidden')) {
        renderEmailRequestsList();
      }
    }, (err) => {
      console.warn("Nota: Solicitudes pendientes no disponibles:", err);
    });
  }

  function updateEmailBadges(count) {
    const text = count > 99 ? '99+' : count.toString();
    const displayStyle = count > 0 ? 'inline-block' : 'none';

    const bHeader = document.getElementById('badge-correos');
    const bToolbar = document.getElementById('badge-correos-tb');
    const bTab = document.getElementById('email-tab-counter');

    if (bHeader) {
      bHeader.textContent = text;
      bHeader.style.display = displayStyle;
    }
    if (bToolbar) {
      bToolbar.textContent = text;
      bToolbar.style.display = displayStyle;
    }
    if (bTab) {
      bTab.textContent = text;
    }
  }

  function showEmailToast(req) {
    const toast = document.getElementById('email-toast-notification');
    const desc = document.getElementById('email-toast-desc');
    const btn = document.getElementById('email-toast-btn');
    if (!toast) return;
    const datos = (req && req.datos_extraidos) || {};
    const nombre = datos.nombre || req.asunto || "Apertura de Curso";
    if (desc) {
      desc.innerHTML = `Curso detectado: <strong>${escapeHtml(nombre)}</strong>. ¿Deseas almacenarlo en la base de datos?`;
    }
    toast.style.display = 'block';

    if (btn) {
      btn.onclick = () => {
        toast.style.display = 'none';
        openEmailModal(req ? req.id : null);
      };
    }
  }

  const toastCloseBtn = document.getElementById('email-toast-close');
  if (toastCloseBtn) {
    toastCloseBtn.addEventListener('click', () => {
      const toast = document.getElementById('email-toast-notification');
      if (toast) toast.style.display = 'none';
    });
  }

  let lastEmailCheckTime = 0;
  function triggerEmailSync(silent = false) {
    const now = Date.now();
    if (now - lastEmailCheckTime < 8000 && silent) return Promise.resolve(null);
    lastEmailCheckTime = now;

    const btn = document.getElementById('btn-sync-emails-now');
    const icon = document.getElementById('sync-emails-icon');
    const label = document.getElementById('sync-emails-label');

    if (!silent && btn) {
      btn.disabled = true;
      if (icon) icon.textContent = '⏳';
      if (label) label.textContent = 'Buscando correos...';
    }

    return sendGasWebhook({
      action: 'check_emails'
    }).then(res => {
      if (!silent && btn) {
        if (icon) icon.textContent = '✅';
        if (label) label.textContent = '¡Búsqueda lista!';
        setTimeout(() => {
          btn.disabled = false;
          if (icon) icon.textContent = '🔍';
          if (label) label.textContent = 'Buscar Correos';
        }, 2200);
      }
      return res;
    }).catch(err => {
      if (!silent && btn) {
        btn.disabled = false;
        if (icon) icon.textContent = '🔍';
        if (label) label.textContent = 'Buscar Correos';
      }
    });
  }

  function openEmailModal(targetReqId) {
    if (!emailModal) return;
    emailModal.removeAttribute('hidden');
    switchEmailTab('pendientes');
    renderEmailRequestsList();

    // Sincronización inteligente inmediata al abrir la ventana
    triggerEmailSync(true);

    // Cargar código en la pestaña de configuración
    if (gasCodeDisplay && gasCodeDisplay.textContent.includes('Cargando')) {
      gasCodeDisplay.textContent = GAS_SCRIPT_SOURCE;
    }

    if (targetReqId) {
      setTimeout(() => {
        const targetEl = document.getElementById(`email-req-card-${targetReqId}`);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          targetEl.style.outline = '2px solid var(--indigo-500)';
          setTimeout(() => targetEl.style.outline = '', 2000);
        }
      }, 150);
    }
  }

  function closeEmailModal() {
    if (emailModal) emailModal.setAttribute('hidden', '');
  }

  function switchEmailTab(tabKey) {
    emailTabBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabKey);
    });
    Object.keys(emailPanels).forEach(k => {
      if (emailPanels[k]) {
        emailPanels[k].style.display = (k === tabKey) ? 'block' : 'none';
      }
    });
  }

  emailTabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      switchEmailTab(btn.dataset.tab);
    });
  });

  if (btnBandejaHeader) btnBandejaHeader.addEventListener('click', () => openEmailModal(null));
  if (btnBandejaToolbar) btnBandejaToolbar.addEventListener('click', () => openEmailModal(null));
  if (emailModalClose) emailModalClose.addEventListener('click', closeEmailModal);
  if (emailModalBtnClose) emailModalBtnClose.addEventListener('click', closeEmailModal);
  if (emailModal) {
    emailModal.addEventListener('click', (e) => {
      if (e.target === emailModal) closeEmailModal();
    });
  }

  const btnIrSimulador = document.getElementById('btn-ir-simulador');
  if (btnIrSimulador) {
    btnIrSimulador.addEventListener('click', () => switchEmailTab('simulador'));
  }
  const btnIrConfig = document.getElementById('btn-ir-config');
  if (btnIrConfig) {
    btnIrConfig.addEventListener('click', () => switchEmailTab('config'));
  }

  // Botón Comprobar Correos Ahora (disparo de Webhook bajo demanda)
  const btnSyncEmailsNow = document.getElementById('btn-sync-emails-now');
  if (btnSyncEmailsNow) {
    btnSyncEmailsNow.addEventListener('click', () => {
      triggerEmailSync(false);
    });
  }

  // Búsqueda automática única al abrir la aplicación
  setTimeout(() => {
    if (gasWebhookUrl) {
      console.log("🔍 Búsqueda automática inicial de correos al abrir la aplicación...");
      triggerEmailSync(true);
    }
  }, 2500);

  // Copiar código del script
  if (btnCopyGasCode) {
    btnCopyGasCode.addEventListener('click', () => {
      navigator.clipboard.writeText(GAS_SCRIPT_SOURCE).then(() => {
        const orig = btnCopyGasCode.innerHTML;
        btnCopyGasCode.innerHTML = '✓ ¡Código Copiado!';
        btnCopyGasCode.classList.remove('btn-secondary');
        btnCopyGasCode.classList.add('btn-primary');
        setTimeout(() => {
          btnCopyGasCode.innerHTML = orig;
          btnCopyGasCode.classList.remove('btn-primary');
          btnCopyGasCode.classList.add('btn-secondary');
        }, 2000);
      }).catch(err => {
        alert("Selecciona y copia el texto del código manualmente.");
      });
    });
  }



  // Renderizar la lista de solicitudes de correo pendientes (con deduplicación inteligente)
  function renderEmailRequestsList() {
    if (!emailRequestsList) return;

    const allKeys = Object.keys(currentEmailRequests).filter(k => {
      const item = currentEmailRequests[k];
      return item && item.estado !== 'aprobado_guardado' && item.estado !== 'descartado';
    });

    // Deduplicación inteligente: evitar mostrar dos tarjetas para el mismo correo o curso
    const seenMap = new Map();
    const pendingKeys = [];
    const redundantKeysToDelete = [];

    allKeys.forEach(k => {
      const req = currentEmailRequests[k];
      const d = (req && req.datos_extraidos) || {};
      const nrc = (d.nrc || "").trim();
      const nombreNorm = (d.nombre || req.asunto || "").toLowerCase().replace(/[^a-zá-ú0-9]/gi, '');
      const threadId = req.thread_id || "";
      const msgId = req.message_id || "";

      // Clave de unicidad: prioriza message_id -> NRC -> thread_id -> nombre + fechas
      const dedupKey = msgId ? `msg_${msgId}` :
        (nrc ? `nrc_${nrc}` :
          (threadId ? `thread_${threadId}` : `nom_${nombreNorm}_${d.fechaInicio || ''}_${d.fechaFin || ''}`));

      if (!seenMap.has(dedupKey)) {
        seenMap.set(dedupKey, k);
        pendingKeys.push(k);
      } else {
        // Marcado como duplicado para limpieza en segundo plano
        redundantKeysToDelete.push(k);
      }
    });

    // Limpiar duplicados redundantes de Firebase si existieran de ejecuciones anteriores
    if (fbDb && redundantKeysToDelete.length > 0) {
      const delUpdates = {};
      redundantKeysToDelete.forEach(rk => {
        delUpdates[`solicitudes_pendientes/${rk}`] = null;
        delete currentEmailRequests[rk];
      });
      fbDb.ref().update(delUpdates).catch(() => { });
    }

    if (pendingKeys.length === 0) {
      if (emailEmptyState) emailEmptyState.style.display = 'block';
      emailRequestsList.innerHTML = '';
      return;
    }

    if (emailEmptyState) emailEmptyState.style.display = 'none';

    emailRequestsList.innerHTML = pendingKeys.map(k => {
      const req = currentEmailRequests[k];
      const d = req.datos_extraidos || {};
      const fechaTxt = req.fecha_correo ? new Date(req.fecha_correo).toLocaleString('es-CO') : "Reciente";
      const mesSugerido = d.mes || (activeMonth !== "Todos" ? activeMonth : "Enero");

      return `
        <div class="email-request-card pending" id="email-req-card-${k}" data-req-id="${k}">
          <div class="email-card-header">
            <div>
              <div class="email-card-sender">👤 ${escapeHtml(req.remitente || "Remitente desconocido")}</div>
              <div class="email-card-meta">
                <span>📅 ${fechaTxt}</span>
                <span>•</span>
                <span style="color:var(--indigo-600);font-weight:600;">ID: ${k}</span>
              </div>
            </div>
            <span class="email-card-badge pending">⏳ Pendiente de Confirmación</span>
          </div>

          <div class="email-card-subject">
            <span>✉️</span>
            <strong>${escapeHtml(req.asunto || "Apertura de Curso")}</strong>
          </div>

          <!-- Toggle cuerpo original -->
          <button type="button" class="email-raw-toggle" data-toggle-target="raw-${k}">
            <span>👁️ Ver texto original del correo recibido</span>
          </button>
          <div id="raw-${k}" class="email-raw-body" style="display:none;">
${escapeHtml(req.cuerpo_completo || req.cuerpo_resumen || "Sin cuerpo de texto.")}
          </div>

          <div style="font-size:12px;font-weight:700;color:var(--slate-700);margin-bottom:8px;display:flex;align-items:center;gap:6px;">
            <span>✨ Datos extraídos automáticamente con IA (puedes ajustarlos):</span>
          </div>

          <!-- Campos editables antes de almacenar -->
          <div class="email-fields-grid">
            <div class="email-field-group" style="grid-column: span 2;">
              <label class="email-field-label">Nombre del Programa / Curso *</label>
              <input type="text" class="email-field-input ef-nombre" value="${escapeHtml(d.nombre || '')}" placeholder="Nombre del curso...">
            </div>

            <div class="email-field-group">
              <label class="email-field-label">Código NRC</label>
              <input type="text" class="email-field-input ef-nrc" value="${escapeHtml(d.nrc || '')}" placeholder="Ej: 45120">
            </div>

            <div class="email-field-group">
              <label class="email-field-label">Modalidad</label>
              <select class="email-field-input ef-modalidad">
                <option value="Presencial" ${d.modalidad === 'Presencial' ? 'selected' : ''}>Presencial</option>
                <option value="Remoto" ${d.modalidad === 'Remoto' ? 'selected' : ''}>Remoto</option>
                <option value="Blended" ${d.modalidad === 'Blended' ? 'selected' : ''}>Blended (Híbrido)</option>
              </select>
            </div>

            <div class="email-field-group">
              <label class="email-field-label">Tipo de Programa</label>
              <select class="email-field-input ef-tipo">
                <option value="Curso" ${d.tipo === 'Curso' ? 'selected' : ''}>Curso</option>
                <option value="Diplomado" ${d.tipo === 'Diplomado' ? 'selected' : ''}>Diplomado</option>
                <option value="Taller" ${d.tipo === 'Taller' ? 'selected' : ''}>Taller</option>
                <option value="Seminario" ${d.tipo === 'Seminario' ? 'selected' : ''}>Seminario</option>
              </select>
            </div>

            <div class="email-field-group">
              <label class="email-field-label">Coordinadora / Docente</label>
              <input type="text" class="email-field-input ef-coordinadora" value="${escapeHtml(d.coordinadora || '')}" placeholder="Nombre responsable">
            </div>

            <div class="email-field-group">
              <label class="email-field-label">Celular / Teléfono</label>
              <input type="text" class="email-field-input ef-celular" value="${escapeHtml(d.celular || '')}" placeholder="300...">
            </div>

            <div class="email-field-group">
              <label class="email-field-label">Fecha de Inicio</label>
              <input type="date" class="email-field-input ef-fechainicio" value="${d.fechaInicio || ''}">
            </div>

            <div class="email-field-group">
              <label class="email-field-label">Fecha de Fin</label>
              <input type="date" class="email-field-input ef-fechafin" value="${d.fechaFin || ''}">
            </div>

            <div class="email-field-group" style="grid-column: span 2;">
              <label class="email-field-label">Horario</label>
              <input type="text" class="email-field-input ef-horario" value="${escapeHtml(d.horario || '')}" placeholder="Ej: Lunes y Miércoles 6:00 pm a 9:00 pm">
            </div>

            <div class="email-field-group">
              <label class="email-field-label">Mes de Destino en BD</label>
              <select class="email-field-input ef-mes">
                ${MESES_INFO.map(m => `<option value="${m.name}" ${m.name.toLowerCase() === mesSugerido.toLowerCase() ? 'selected' : ''}>${m.name}</option>`).join('')}
              </select>
            </div>

            <div class="email-field-group">
              <label class="email-field-label">Salón o Link Virtual</label>
              <input type="text" class="email-field-input ef-salon" value="${escapeHtml(d.salones || '')}" placeholder="Ej: Salón 302 o Teams">
            </div>
          </div>

          <!-- Caja de Confirmación: ¿Deseas almacenarla en la base de datos? -->
          <div class="email-confirm-box">
            <div class="email-confirm-question">
              <span class="email-confirm-q-icon">❓</span>
              <div>
                <div class="email-confirm-q-title">¿Deseas almacenar este programa en la base de datos de Firebase?</div>
                <div class="email-confirm-q-desc">Se creará con todas sus tabulaciones y configuraciones en el mes seleccionado.</div>
              </div>
            </div>
            <div class="email-confirm-actions">
              <button type="button" class="btn btn-secondary btn-sm btn-discard-email-req" data-req-id="${k}">
                🗑️ Descartar
              </button>
              <button type="button" class="btn btn-primary btn-sm btn-approve-email-req" data-req-id="${k}" style="font-weight:700;">
                ✅ Sí, Almacenar en la BD
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Conectar eventos de los elementos generados
    emailRequestsList.querySelectorAll('.email-raw-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.toggleTarget;
        const target = document.getElementById(targetId);
        if (target) {
          const isHidden = target.style.display === 'none';
          target.style.display = isHidden ? 'block' : 'none';
          btn.innerHTML = isHidden ? '<span>🙈 Ocultar texto original</span>' : '<span>👁️ Ver texto original del correo recibido</span>';
        }
      });
    });

    emailRequestsList.querySelectorAll('.btn-approve-email-req').forEach(btn => {
      btn.addEventListener('click', () => {
        const reqId = btn.dataset.reqId;
        const card = document.getElementById(`email-req-card-${reqId}`);
        almacenarProgramaDesdeCorreo(reqId, card);
      });
    });

    emailRequestsList.querySelectorAll('.btn-discard-email-req').forEach(btn => {
      btn.addEventListener('click', () => {
        const reqId = btn.dataset.reqId;
        descartarSolicitudCorreo(reqId);
      });
    });

    // Auto-actualizar mes si cambia la fecha de inicio
    emailRequestsList.querySelectorAll('.ef-fechainicio').forEach(input => {
      input.addEventListener('change', (e) => {
        if (e.target.value) {
          const mNum = parseInt(e.target.value.split('-')[1], 10);
          if (mNum >= 1 && mNum <= 12) {
            const card = e.target.closest('.email-request-card');
            const selMes = card ? card.querySelector('.ef-mes') : null;
            if (selMes) selMes.value = MESES_INFO[mNum - 1].name;
          }
        }
      });
    });
  }

  // Guardar programa aprobado en Firebase
  function almacenarProgramaDesdeCorreo(reqId, cardEl) {
    if (!fbDb) {
      alert("Error: Firebase no está conectado.");
      return;
    }
    if (!cardEl) return;

    const nombre = cardEl.querySelector('.ef-nombre').value.trim();
    if (!nombre) {
      alert("Por favor ingresa un nombre para el programa antes de guardarlo.");
      cardEl.querySelector('.ef-nombre').focus();
      return;
    }

    const nrc = cardEl.querySelector('.ef-nrc').value.trim();
    const modalidad = cardEl.querySelector('.ef-modalidad').value;
    const tipo = cardEl.querySelector('.ef-tipo').value;
    const coordinadora = cardEl.querySelector('.ef-coordinadora').value.trim();
    const celular = cardEl.querySelector('.ef-celular').value.trim();
    const fechaInicio = cardEl.querySelector('.ef-fechainicio').value;
    const fechaFin = cardEl.querySelector('.ef-fechafin').value;
    const horarioTxt = cardEl.querySelector('.ef-horario').value.trim();
    const mesNombre = cardEl.querySelector('.ef-mes').value;
    const salonValor = cardEl.querySelector('.ef-salon').value.trim();

    const mesKey = getMesKey(mesNombre);
    const progTitleKey = sanitizeFirebaseNodeKey(nombre);

    // Salones
    const salones = [
      { label: "Salones 1", valor: salonValor, estado: salonValor ? "completo" : "pendiente" },
      { label: "Salones 2", valor: "", estado: "completo" },
      { label: "Salones 3", valor: "", estado: "completo" },
      { label: "Salones 4", valor: "", estado: "completo" }
    ];

    // Tabulaciones 1-5
    const tabulaciones = [
      { label: "Tabulación 1", valor: "", estado: "pendiente" },
      { label: "Tabulación 2", valor: "", estado: "pendiente" },
      { label: "Tabulación 3", valor: "", estado: "pendiente" },
      { label: "Tabulación 4", valor: "", estado: "pendiente" },
      { label: "Tabulación 5", valor: "", estado: "pendiente" }
    ];

    const parsedHorario = parseHorarioBasico(horarioTxt);
    const calculatedSessions = calculateSessionDates(fechaInicio, fechaFin, []);

    const newProgram = {
      id: progTitleKey,
      no: nrc || "1",
      nombre: coordinadora || nombre,
      nombre_contacto: coordinadora,
      celular: celular,
      programa: nombre,
      nombre_del_programa: nombre,
      nrc: nrc,
      modalidad: modalidad,
      tipo: tipo,
      tipo_de_programa: tipo,
      coordinadora: coordinadora,
      fecha_inicio: fechaInicio,
      fecha_inicio_disp: fechaInicio,
      fecha_fin: fechaFin,
      fecha_fin_disp: fechaFin,
      horario: horarioTxt,
      horario_config: { dias: [] },
      estado: "En preparación",
      estado_cat: "en_preparacion",
      mes: mesNombre,
      origen_mes: mesNombre,
      tabulacion_1_val: "",
      tabulacion_1_st: "pendiente",
      salones_1_val: salonValor,
      salones_1_st: salonValor ? "completo" : "pendiente",
      tabulaciones: tabulaciones,
      salones: salones,
      analisis_horario: {
        fechas_sesion: calculatedSessions,
        dias_detectados: parsedHorario.dias_detectados,
        dias_nombres: parsedHorario.dias_nombres,
        horas: parsedHorario.horas,
        fuente: "correo_ia",
        confianza: "ok"
      },
      origen: "correo_gmail",
      creado_el: new Date().toISOString()
    };

    const approveBtn = cardEl.querySelector('.btn-approve-email-req');
    if (approveBtn) {
      approveBtn.disabled = true;
      approveBtn.innerHTML = '💾 Guardando en Firebase...';
    }

    const updates = {};
    updates[`meses/${mesKey}/programas/${progTitleKey}`] = newProgram;
    updates[`solicitudes_pendientes/${reqId}`] = null; // Eliminar de solicitudes pendientes
    const driveEmailItem = {
      action: 'create',
      ...newProgram,
      nodeKey: progTitleKey,
      mesKey: mesKey,
      solicitado_el: new Date().toISOString()
    };
    updates[`cola_creacion_drive/${progTitleKey}`] = driveEmailItem;

    // Disparar Webhook en tiempo real para Google Drive
    sendGasWebhook(driveEmailItem);

    // Limpiar cualquier otra solicitud duplicada con el mismo NRC, nombre o hilo
    const currentReq = currentEmailRequests[reqId];
    const cleanedOtherIds = [];
    Object.keys(currentEmailRequests).forEach(otherId => {
      if (otherId !== reqId) {
        const o = currentEmailRequests[otherId];
        const od = (o && o.datos_extraidos) || {};
        if (
          (currentReq && currentReq.thread_id && o.thread_id && currentReq.thread_id === o.thread_id) ||
          (currentReq && currentReq.message_id && o.message_id && currentReq.message_id === o.message_id) ||
          (nrc && od.nrc && od.nrc === nrc) ||
          (od.nombre && sanitizeFirebaseNodeKey(od.nombre) === progTitleKey && (od.mes || mesNombre) === mesNombre)
        ) {
          updates[`solicitudes_pendientes/${otherId}`] = null;
          cleanedOtherIds.push(otherId);
        }
      }
    });

    fbDb.ref().update(updates).then(() => {
      // Remover tarjeta localmente con animación
      cardEl.style.transition = 'all 0.3s ease';
      cardEl.style.opacity = '0';
      cardEl.style.transform = 'translateY(-10px)';

      setTimeout(() => {
        delete currentEmailRequests[reqId];
        cleanedOtherIds.forEach(oid => delete currentEmailRequests[oid]);
        renderEmailRequestsList();
        updateEmailBadges(Object.keys(currentEmailRequests).length);
      }, 300);

      // Cambiar a la vista del mes guardado y refrescar tablero
      if (typeof activeMonth !== 'undefined') {
        activeMonth = mesNombre;
      }
      if (typeof refreshAll === 'function') {
        refreshAll();
      }

      alert(`✅ ¡Programa "${nombre}" almacenado con éxito en la base de datos de Firebase (Mes: ${mesNombre})!`);
    }).catch(err => {
      console.error("Error guardando programa desde correo:", err);
      alert("Error al almacenar el programa: " + err.message);
      if (approveBtn) {
        approveBtn.disabled = false;
        approveBtn.innerHTML = '✅ Sí, Almacenar en la BD';
      }
    });
  }

  // Descartar solicitud de correo
  function descartarSolicitudCorreo(reqId) {
    if (!confirm("¿Estás seguro de que deseas descartar esta solicitud de correo de apertura? No se almacenará en la base de datos.")) {
      return;
    }

    if (fbDb) {
      const currentReq = currentEmailRequests[reqId];
      const curNrc = (currentReq && currentReq.datos_extraidos && currentReq.datos_extraidos.nrc) || "";
      const curNombre = (currentReq && currentReq.datos_extraidos && currentReq.datos_extraidos.nombre) || "";
      const delUpdates = {};
      delUpdates[`solicitudes_pendientes/${reqId}`] = null;

      // Limpiar cualquier otra solicitud duplicada idéntica
      const cleanedOtherIds = [];
      Object.keys(currentEmailRequests).forEach(otherId => {
        if (otherId !== reqId) {
          const o = currentEmailRequests[otherId];
          const od = (o && o.datos_extraidos) || {};
          if (
            (currentReq && currentReq.thread_id && o.thread_id && currentReq.thread_id === o.thread_id) ||
            (currentReq && currentReq.message_id && o.message_id && currentReq.message_id === o.message_id) ||
            (curNrc && od.nrc && od.nrc === curNrc) ||
            (curNombre && od.nombre && curNombre.toLowerCase().trim() === od.nombre.toLowerCase().trim())
          ) {
            delUpdates[`solicitudes_pendientes/${otherId}`] = null;
            cleanedOtherIds.push(otherId);
          }
        }
      });

      fbDb.ref().update(delUpdates).then(() => {
        delete currentEmailRequests[reqId];
        cleanedOtherIds.forEach(oid => delete currentEmailRequests[oid]);
        renderEmailRequestsList();
        updateEmailBadges(Object.keys(currentEmailRequests).length);
      }).catch(err => {
        console.error("Error al descartar:", err);
        alert("Error al descartar: " + err.message);
      });
    } else {
      delete currentEmailRequests[reqId];
      renderEmailRequestsList();
    }
  }

  // Extractor heurístico avanzado de alta precisión del lado del cliente
  function extraerDatosDeCorreoTexto(asunto, texto) {
    const full = (asunto || "") + "\n" + (texto || "");

    // 1. NRC
    const nrcMatch = full.match(/\bNRC[:\s#.-]*([0-9]{4,6})\b/i) ||
      full.match(/(?:c[oó]digo(?:\s+nrc)?|id)[:\s#.-]*([0-9]{4,6})\b/i) ||
      full.match(/\(([0-9]{4,6})\)/);
    const nrc = nrcMatch ? nrcMatch[1] : "";

    // 2. Modalidad
    let modalidad = "Presencial";
    if (/blended|h[ií]brid[oa]|semipresencial/i.test(full)) {
      modalidad = "Blended";
    } else if (/remot[oa]|virtual|online|teams|zoom|meet/i.test(full)) {
      modalidad = "Remoto";
    }

    // 3. Tipo
    let tipo = "Curso";
    if (/diplomado/i.test(full)) tipo = "Diplomado";
    else if (/taller/i.test(full)) tipo = "Taller";
    else if (/seminario/i.test(full)) tipo = "Seminario";
    else if (/certificaci[oó]n/i.test(full)) tipo = "Certificación";

    // 4. Nombre
    let nombre = "";
    const explicit = (texto || "").match(/(?:nombre(?:\s+del\s+(?:programa|curso|evento|taller|diplomado))?|programa|curso|diplomado|taller)\s*[:=]\s*([^\n\r]+)/i);
    if (explicit && explicit[1].trim().length > 3) {
      nombre = explicit[1].trim();
    }
    if (!nombre) {
      const inlineAction = (texto || "").match(/(?:favor\s+abrir|apertura(?:\s+formal)?(?:\s+del?)?)\s+(?:el\s+)?((?:curso|diplomado|taller|seminario|programa)\s+[^(\n\r,.;]+)/i);
      if (inlineAction && inlineAction[1].trim().length > 3) {
        nombre = inlineAction[1].trim();
      }
    }
    if (!nombre) {
      nombre = (asunto || "").replace(/^(?:fwd|rv|re)[:\s]*/gi, "")
        .replace(/^(?:solicitud(?:\s+de)?\s+)?apertura(?:\s+de|\s+del?)?(?:\s+(?:curso|programa|taller|diplomado|seminario))?[:\s-]*/gi, "")
        .trim();
    }
    nombre = nombre.replace(/^(?:de|del)\s+/i, "")
      .replace(/\s*\(?\s*NRC[:\s#]*[0-9]{4,6}\s*\)?/i, "")
      .replace(/[•\-\*\.]\s*$/g, "")
      .replace(/^[•\-\*\.]\s*/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!nombre) nombre = "Apertura de Curso";

    // 5. Fechas (Inicio y Fin)
    const MESES_DICT = {
      enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06",
      julio: "07", agosto: "08", septiembre: "09", setiembre: "09", octubre: "10", noviembre: "11", diciembre: "12"
    };
    const MESES_LIST = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
    const anioActual = new Date().getFullYear();
    let fechaInicio = "";
    let fechaFin = "";

    // Caso A: Rango en el mismo mes "del 12 al 28 de mayo (de 2026)?" o "12 a 28 de mayo"
    const rangeSame = full.match(/(?:del?|desde)?\s*(\d{1,2})\s*(?:al?|a|-)\s*(\d{1,2})\s+de\s+([a-zá-ú]+)(?:\s+de\s+(\d{4}))?/i);
    if (rangeSame && MESES_DICT[rangeSame[3].toLowerCase()]) {
      const m = MESES_DICT[rangeSame[3].toLowerCase()];
      const y = rangeSame[4] || anioActual;
      fechaInicio = y + "-" + m + "-" + String(rangeSame[1]).padStart(2, "0");
      fechaFin = y + "-" + m + "-" + String(rangeSame[2]).padStart(2, "0");
    }

    // Caso B: Rango entre meses distintos "del 15 de mayo al 10 de junio"
    if (!fechaInicio) {
      const rangeDiff = full.match(/(?:del?|desde)?\s*(\d{1,2})\s+de\s+([a-zá-ú]+)(?:\s+de\s+(\d{4}))?\s*(?:al?|hasta|a|-)\s*(\d{1,2})\s+de\s+([a-zá-ú]+)(?:\s+de\s+(\d{4}))?/i);
      if (rangeDiff && MESES_DICT[rangeDiff[2].toLowerCase()] && MESES_DICT[rangeDiff[5].toLowerCase()]) {
        const y1 = rangeDiff[3] || anioActual;
        const y2 = rangeDiff[6] || y1;
        fechaInicio = y1 + "-" + MESES_DICT[rangeDiff[2].toLowerCase()] + "-" + String(rangeDiff[1]).padStart(2, "0");
        fechaFin = y2 + "-" + MESES_DICT[rangeDiff[5].toLowerCase()] + "-" + String(rangeDiff[4]).padStart(2, "0");
      }
    }

    // Caso C: Fechas naturales individuales "Inicio: 12 de mayo" / "Fin: 28 de mayo"
    if (!fechaInicio) {
      const dStart = full.match(/(?:inicio|inicia|desde|fechas?[:\s]*del?)[:\s]*(\d{1,2})\s+de\s+([a-zá-ú]+)(?:\s+de\s+(\d{4}))?/i);
      if (dStart && MESES_DICT[dStart[2].toLowerCase()]) {
        fechaInicio = (dStart[3] || anioActual) + "-" + MESES_DICT[dStart[2].toLowerCase()] + "-" + String(dStart[1]).padStart(2, "0");
      }
    }
    if (!fechaFin) {
      const dEnd = full.match(/(?:fin|finaliza|hasta|cierre)[:\s]*(\d{1,2})\s+de\s+([a-zá-ú]+)(?:\s+de\s+(\d{4}))?/i);
      if (dEnd && MESES_DICT[dEnd[2].toLowerCase()]) {
        fechaFin = (dEnd[3] || anioActual) + "-" + MESES_DICT[dEnd[2].toLowerCase()] + "-" + String(dEnd[1]).padStart(2, "0");
      }
    }

    // Caso D: Formatos numéricos ISO (YYYY-MM-DD) y Latino (DD/MM/YYYY)
    if (!fechaInicio) {
      const isoMatches = full.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g);
      if (isoMatches && isoMatches.length >= 1) {
        const p1 = isoMatches[0].split(/[-/]/);
        fechaInicio = p1[0] + "-" + String(p1[1]).padStart(2, "0") + "-" + String(p1[2]).padStart(2, "0");
        if (isoMatches.length >= 2) {
          const p2 = isoMatches[1].split(/[-/]/);
          fechaFin = p2[0] + "-" + String(p2[1]).padStart(2, "0") + "-" + String(p2[2]).padStart(2, "0");
        }
      }
    }
    if (!fechaInicio) {
      const latamMatches = full.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/g);
      if (latamMatches && latamMatches.length >= 1) {
        const p1 = latamMatches[0].split(/[-/]/);
        fechaInicio = p1[2] + "-" + String(p1[1]).padStart(2, "0") + "-" + String(p1[0]).padStart(2, "0");
        if (latamMatches.length >= 2) {
          const p2 = latamMatches[1].split(/[-/]/);
          fechaFin = p2[2] + "-" + String(p2[1]).padStart(2, "0") + "-" + String(p2[0]).padStart(2, "0");
        }
      }
    }

    // 6. Mes de Destino
    let mes = "";
    if (fechaInicio) {
      const mNum = parseInt(fechaInicio.split("-")[1], 10);
      if (mNum >= 1 && mNum <= 12) mes = MESES_LIST[mNum - 1];
    }
    if (!mes) {
      for (let i = 0; i < MESES_LIST.length; i++) {
        if (new RegExp(MESES_LIST[i], "i").test(full)) {
          mes = MESES_LIST[i];
          break;
        }
      }
    }

    // 7. Coordinadora / Docente / Responsable
    let coordinadora = "";
    const coordMatch = full.match(/(?:coordinador[a]?\s*(?:encargad[oa]|acad[eé]mic[oa]|responsable)?|docente\s*(?:responsable|encargad[oa])?|profesor[a]?|solicitado\s+por|responsable|instructor[a]?|facilitador[a]?|a\s+cargo\s+de)[:\s]+(?:(?:Lic\.|Dra?\.|Ing\.|Mg\.|Prof\.)\s*)?([^\n\r,;()\-•0-9]+)/i);
    if (coordMatch) {
      coordinadora = coordMatch[1].replace(/\s+/g, " ").trim();
      if (/^(?:encargad[oa]|responsable|docente|profesor[a]?)$/i.test(coordinadora)) coordinadora = "";
    }

    // 8. Celular / Teléfono
    const celMatch = full.match(/(?:celular|tel[eé]fono|m[oó]vil|whatsapp|cel|tel)[:\s]*([+0-9\s\-()]{7,20})/i) ||
      full.match(/\b(?:\+?57\s*)?3[0-9]{2}[\s\-]?[0-9]{3}[\s\-]?[0-9]{4}\b/);
    let celular = celMatch ? (celMatch[1] || celMatch[0]).replace(/[^0-9+]/g, "") : "";

    // 9. Horario
    let horario = "";
    const horMatch = full.match(/(?:horario[s]?|d[ií]as\s*(?:y\s*horas?)?|clases?|sesiones?)\s*[:=]\s*([^\n\r]+)/i);
    if (horMatch) {
      horario = horMatch[1].trim();
    } else {
      const daysLine = full.match(/(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?)[^.\n\r]+(?:de\s+\d{1,2}|\d{1,2}:\d{2})/i);
      if (daysLine) horario = daysLine[0].trim();
    }

    // 10. Salones o Enlace Virtual
    let salones = "";
    const salMatch = full.match(/(?:sal[oó]n|aula|espacio|ubicaci[oó]n|laboratorio|enlace|link|teams|zoom|sala)\s*[:=]\s*([^\n\r]+)/i);
    if (salMatch) {
      salones = salMatch[1].trim();
    } else {
      const inlineSalon = full.match(/(?:en\s+el\s+|sal[oó]n\s+)(sal[oó]n\s+[0-9A-Za-z]+|aula\s+[0-9A-Za-z]+|lab(?:oratorio)?\s+[0-9A-Za-z]+)/i);
      if (inlineSalon) salones = inlineSalon[1].trim();
    }

    return {
      nombre,
      nrc,
      modalidad,
      tipo,
      coordinadora,
      celular,
      fechaInicio,
      fechaFin,
      horario,
      salones,
      mes: mes || (activeMonth !== "Todos" ? activeMonth : "Enero")
    };
  }

  // Presets para el Simulador
  const SIM_PRESETS = {
    excel: {
      asunto: "Apertura de Curso - Excel Avanzado y Power BI",
      remitente: "direccion.academica@uninorte.edu.co",
      cuerpo: "Buenas tardes Coordinación CEC,\n\nPor favor proceder con la apertura formal del curso 'Excel Avanzado y Power BI' con código NRC 48920.\nEl curso será dictado por la docente María Paula Gómez (Celular 3154897210) en modalidad Presencial en el Salón 402B.\n\nLas fechas programadas van del 2026-03-10 al 2026-03-28, con clases los días Martes y Jueves de 6:00 pm a 9:00 pm.\n\nMuchas gracias por su apoyo,\nDirección Académica CEC"
    },
    proyectos: {
      asunto: "Solicitud Apertura Diplomado en Gestión Ágil de Proyectos",
      remitente: "c.mendoza@uninorte.edu.co",
      cuerpo: "Estimado equipo del Centro de Educación Continuada,\n\nConfirmamos la apertura del Diplomado en Gestión Ágil de Proyectos (NRC 52140).\nCoordinadora académica: Ing. Claudia Mendoza (Celular: 3009876543).\nModalidad: Blended.\nFecha de inicio: 2026-04-15 y finalización: 2026-05-30.\nHorarios de clase: Sábados de 8:00 am a 1:00 pm (Salón 201A) y Miércoles de 6:30 pm a 8:30 pm (Virtual Teams)."
    },
    ia: {
      asunto: "Apertura de Programa: Taller de Inteligencia Artificial Generativa",
      remitente: "posgrados.cec@uninorte.edu.co",
      cuerpo: "Hola a todos,\n\nSe abre la convocatoria para el nuevo Taller de Inteligencia Artificial Generativa para Empresas, NRC 33104.\nModalidad: 100% Remota vía Zoom.\nDocente responsable: Dr. Carlos Henríquez (3105551234).\nFechas: del 2026-05-05 al 2026-05-22.\nHorario: Lunes, Miércoles y Viernes de 7:00 pm a 9:30 pm."
    }
  };

  simPresetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const presetKey = btn.dataset.preset;
      const data = SIM_PRESETS[presetKey];
      if (data) {
        if (emailSimSubject) emailSimSubject.value = data.asunto;
        if (emailSimSender) emailSimSender.value = data.remitente;
        if (emailSimBody) emailSimBody.value = data.cuerpo;
        if (emailSimResult) emailSimResult.style.display = 'none';
      }
    });
  });

  // Ejecutar extracción en el Simulador
  if (emailSimExtractBtn) {
    emailSimExtractBtn.addEventListener('click', () => {
      const asunto = emailSimSubject ? emailSimSubject.value.trim() : "";
      const remitente = emailSimSender ? emailSimSender.value.trim() : "correo@uninorte.edu.co";
      const cuerpo = emailSimBody ? emailSimBody.value.trim() : "";

      if (!cuerpo) {
        alert("Por favor pega o escribe el texto del correo en el campo.");
        if (emailSimBody) emailSimBody.focus();
        return;
      }

      emailSimExtractBtn.disabled = true;
      emailSimExtractBtn.innerHTML = '<span>⚡</span> Analizando con IA...';

      setTimeout(() => {
        const datos = extraerDatosDeCorreoTexto(asunto, cuerpo);
        emailSimExtractBtn.disabled = false;
        emailSimExtractBtn.innerHTML = '<span>✨</span> Analizar y Extraer con IA';

        if (emailSimResult) {
          const simId = "sim_" + new Date().getTime();
          emailSimResult.style.display = 'block';
          emailSimResult.innerHTML = `
            <div class="email-request-card" id="email-req-card-${simId}" style="border: 2px solid var(--indigo-500);box-shadow:0 8px 24px rgba(99,102,241,0.15);">
              <div class="email-card-header">
                <div>
                  <div class="email-card-sender">👤 ${escapeHtml(remitente)}</div>
                  <div class="email-card-meta">
                    <span>✨ Extracción de Prueba en Vivo</span>
                  </div>
                </div>
                <span class="email-card-badge" style="background:var(--emerald-100);color:var(--emerald-700);">✓ IA Procesada</span>
              </div>

              <div class="email-card-subject">
                <span>✉️</span>
                <strong>${escapeHtml(asunto || "Apertura de Curso")}</strong>
              </div>

              <div class="email-fields-grid">
                <div class="email-field-group" style="grid-column: span 2;">
                  <label class="email-field-label">Nombre del Programa / Curso *</label>
                  <input type="text" class="email-field-input ef-nombre" value="${escapeHtml(datos.nombre || '')}">
                </div>
                <div class="email-field-group">
                  <label class="email-field-label">Código NRC</label>
                  <input type="text" class="email-field-input ef-nrc" value="${escapeHtml(datos.nrc || '')}">
                </div>
                <div class="email-field-group">
                  <label class="email-field-label">Modalidad</label>
                  <select class="email-field-input ef-modalidad">
                    <option value="Presencial" ${datos.modalidad === 'Presencial' ? 'selected' : ''}>Presencial</option>
                    <option value="Remoto" ${datos.modalidad === 'Remoto' ? 'selected' : ''}>Remoto</option>
                    <option value="Blended" ${datos.modalidad === 'Blended' ? 'selected' : ''}>Blended</option>
                  </select>
                </div>
                <div class="email-field-group">
                  <label class="email-field-label">Tipo</label>
                  <select class="email-field-input ef-tipo">
                    <option value="Curso" ${datos.tipo === 'Curso' ? 'selected' : ''}>Curso</option>
                    <option value="Diplomado" ${datos.tipo === 'Diplomado' ? 'selected' : ''}>Diplomado</option>
                    <option value="Taller" ${datos.tipo === 'Taller' ? 'selected' : ''}>Taller</option>
                    <option value="Seminario" ${datos.tipo === 'Seminario' ? 'selected' : ''}>Seminario</option>
                  </select>
                </div>
                <div class="email-field-group">
                  <label class="email-field-label">Coordinadora</label>
                  <input type="text" class="email-field-input ef-coordinadora" value="${escapeHtml(datos.coordinadora || '')}">
                </div>
                <div class="email-field-group">
                  <label class="email-field-label">Celular</label>
                  <input type="text" class="email-field-input ef-celular" value="${escapeHtml(datos.celular || '')}">
                </div>
                <div class="email-field-group">
                  <label class="email-field-label">Fecha de Inicio</label>
                  <input type="date" class="email-field-input ef-fechainicio" value="${datos.fechaInicio || ''}">
                </div>
                <div class="email-field-group">
                  <label class="email-field-label">Fecha de Fin</label>
                  <input type="date" class="email-field-input ef-fechafin" value="${datos.fechaFin || ''}">
                </div>
                <div class="email-field-group" style="grid-column: span 2;">
                  <label class="email-field-label">Horario</label>
                  <input type="text" class="email-field-input ef-horario" value="${escapeHtml(datos.horario || '')}">
                </div>
                <div class="email-field-group">
                  <label class="email-field-label">Mes de Destino</label>
                  <select class="email-field-input ef-mes">
                    ${MESES_INFO.map(m => `<option value="${m.name}" ${m.name.toLowerCase() === datos.mes.toLowerCase() ? 'selected' : ''}>${m.name}</option>`).join('')}
                  </select>
                </div>
                <div class="email-field-group">
                  <label class="email-field-label">Salón o Link</label>
                  <input type="text" class="email-field-input ef-salon" value="${escapeHtml(datos.salones || '')}">
                </div>
              </div>

              <div class="email-confirm-box">
                <div class="email-confirm-question">
                  <span class="email-confirm-q-icon">❓</span>
                  <div>
                    <div class="email-confirm-q-title">¿Deseas almacenar este programa en la base de datos de Firebase?</div>
                    <div class="email-confirm-q-desc">El programa se insertará en el mes seleccionado con todas sus tabulaciones y salones.</div>
                  </div>
                </div>
                <div class="email-confirm-actions">
                  <button type="button" class="btn btn-secondary btn-sm" id="btn-sim-send-pending">
                    📤 Enviar a Bandeja de Pendientes
                  </button>
                  <button type="button" class="btn btn-primary btn-sm btn-approve-email-req" data-req-id="${simId}" style="font-weight:700;">
                    ✅ Sí, Almacenar en la BD
                  </button>
                </div>
              </div>
            </div>
          `;

          // Evento de confirmación en el simulador
          const cardSim = document.getElementById(`email-req-card-${simId}`);
          if (cardSim) {
            const approveBtn = cardSim.querySelector('.btn-approve-email-req');
            if (approveBtn) {
              approveBtn.addEventListener('click', () => {
                almacenarProgramaDesdeCorreo(simId, cardSim);
              });
            }

            const sendPendingBtn = document.getElementById('btn-sim-send-pending');
            if (sendPendingBtn && fbDb) {
              sendPendingBtn.addEventListener('click', () => {
                const reqId = "req_" + new Date().getTime();
                const payload = {
                  id: reqId,
                  remitente: remitente,
                  asunto: asunto,
                  fecha_correo: new Date().toISOString(),
                  fecha_deteccion: new Date().toISOString(),
                  cuerpo_resumen: cuerpo.substring(0, 800),
                  cuerpo_completo: cuerpo,
                  datos_extraidos: datos,
                  estado: "pendiente"
                };
                fbDb.ref('solicitudes_pendientes/' + reqId).set(payload).then(() => {
                  alert("✓ Solicitud enviada a la bandeja de pendientes como si acabara de llegar a Gmail.");
                  switchEmailTab('pendientes');
                });
              });
            }
          }
        }
      }, 350);
    });
  }

  // Cargar preset inicial de ejemplo en el simulador si está vacío
  if (emailSimBody && !emailSimBody.value) {
    emailSimBody.value = SIM_PRESETS.excel.cuerpo;
  }

  // Inicializar el listener de correos si Firebase ya se inicializó
  if (fbDb && typeof initEmailRequestsListener === 'function') {
    initEmailRequestsListener(fbDb);
  }

  // ============================================================================
  // CONTROLADOR COMPLETO DE PARTICIPANTES Y MATRIZ DE ASISTENCIA OFICIAL
  // ============================================================================
  currentPartCourse = null;
  let currentPartTab = 'alumnos';
  let currentPartSearch = '';

  partModal = document.getElementById('participants-modal');
  const partModalClose = document.getElementById('part-modal-close');
  const partModalBtnClose = document.getElementById('part-modal-btn-close');
  const partModalTitle = document.getElementById('part-modal-title');
  const partModalNrcBadge = document.getElementById('part-modal-nrc-badge');
  const partModalSubtitle = document.getElementById('part-modal-subtitle');
  const partLinkSheet = document.getElementById('part-link-sheet');
  const partLinkDrive = document.getElementById('part-link-drive');

  const partKpiMatriculados = document.getElementById('part-kpi-matriculados');
  const partKpiSesiones = document.getElementById('part-kpi-sesiones');
  const partKpiPendientes = document.getElementById('part-kpi-pendientes');
  const partKpiCardPendientes = document.getElementById('part-kpi-card-pendientes');
  const partKpiPromedio = document.getElementById('part-kpi-promedio');
  const partTabProgressLabel = document.getElementById('part-tab-progress-label');
  const partTabProgressPct = document.getElementById('part-tab-progress-pct');
  const partTabProgressBar = document.getElementById('part-tab-progress-bar');

  const partTabBtnAlumnos = document.getElementById('part-tab-btn-alumnos');
  const partTabBtnMatriz = document.getElementById('part-tab-btn-matriz');
  const partTabBadgeAlumnos = document.getElementById('part-tab-badge-alumnos');
  const partTabBadgeMatriz = document.getElementById('part-tab-badge-matriz');
  const partTabContentAlumnos = document.getElementById('part-tab-content-alumnos');
  const partTabContentMatriz = document.getElementById('part-tab-content-matriz');

  const partBtnToggleAddForm = document.getElementById('part-btn-toggle-add-form');
  const partSingleFormBox = document.getElementById('part-single-form-box');
  const partSingleFormClose = document.getElementById('part-single-form-close');
  const partInDoc = document.getElementById('part-in-doc');
  const partInNom = document.getElementById('part-in-nom');
  const partInCor = document.getElementById('part-in-cor');
  const partInTel = document.getElementById('part-in-tel');
  const partBtnSubmitSingle = document.getElementById('part-btn-submit-single');

  const partBtnToggleBatch = document.getElementById('part-btn-toggle-batch');
  const partBatchFormBox = document.getElementById('part-batch-form-box');
  const partBatchFormClose = document.getElementById('part-batch-form-close');
  const partBatchTextarea = document.getElementById('part-batch-textarea');
  const partBatchPreviewLine = document.getElementById('part-batch-preview-line');
  const partBatchReplaceChk = document.getElementById('part-batch-replace-chk');
  const partBtnParseBatch = document.getElementById('part-btn-parse-batch');
  const partBtnSubmitBatch = document.getElementById('part-btn-submit-batch');

  const partBtnCopyEmails = document.getElementById('part-btn-copy-emails');
  const partSearchInput = document.getElementById('part-search-input');
  const partAlumnosTbody = document.getElementById('part-alumnos-tbody');

  const partMatrixThead = document.getElementById('part-matrix-thead');
  const partMatrixTbody = document.getElementById('part-matrix-tbody');
  const partMatrixBtnPull = document.getElementById('part-matrix-btn-pull');
  const partMatrixBtnPush = document.getElementById('part-matrix-btn-push');

  const partSaveStatusIndicator = document.getElementById('part-save-status-indicator');
  const partBtnExportExcelModal = document.getElementById('part-btn-export-excel-modal');

  function openParticipantsModal(course, initialTab) {
    if (!course || !partModal) return;
    currentPartCourse = course;
    currentPartSearch = '';
    if (partSearchInput) partSearchInput.value = '';

    if (partSingleFormBox) partSingleFormBox.style.display = 'none';
    if (partBatchFormBox) partBatchFormBox.style.display = 'none';

    const nombre = course.programa || course.nombre_del_programa || course.nombre || 'Curso';
    const nrc = course.nrc ? `NRC: ${course.nrc}` : 'NRC: Sin asignar';
    const coord = course.coordinadora || 'Sin coordinadora';
    const fi = course.fecha_inicio ? fmtDate(course.fecha_inicio) : '';
    const ff = course.fecha_fin ? fmtDate(course.fecha_fin) : '';
    const fechas = (fi && ff) ? `${fi} – ${ff}` : (fi || 'Fechas por definir');

    if (partModalTitle) partModalTitle.textContent = nombre;
    if (partModalNrcBadge) partModalNrcBadge.textContent = nrc;
    if (partModalSubtitle) {
      partModalSubtitle.textContent = `Docente/Coord: ${coord} · ${fechas} · Modalidad: ${course.modalidad || 'Presencial'}`;
    }

    if (partLinkSheet) {
      if (course.asistencia_sheet_url) {
        partLinkSheet.href = course.asistencia_sheet_url;
        partLinkSheet.style.display = 'inline-flex';
      } else {
        partLinkSheet.style.display = 'none';
      }
    }
    if (partLinkDrive) {
      if (course.drive_folder_url) {
        partLinkDrive.href = course.drive_folder_url;
        partLinkDrive.style.display = 'inline-flex';
      } else {
        partLinkDrive.style.display = 'none';
      }
    }

    partModal.removeAttribute('hidden');
    refreshParticipantsModalUI();
    switchParticipantsTab(initialTab === 'matriz' ? 'matriz' : 'alumnos');
    pullAttendanceFromDriveSilencioso();
    startAutoPollingAttendance();
    if (course.asistencia_sheet_id || course.asistencia_sheet_url) {
      sendGasWebhook({
        action: 'setup_sheet_triggers',
        sheetId: course.asistencia_sheet_id,
        sheetUrl: course.asistencia_sheet_url,
        mesKey: course._mesKey,
        nodeKey: course._nodeKey
      }).catch(() => {});
    }
  }

  function closeParticipantsModal() {
    if (!partModal) return;
    stopAutoPollingAttendance();
    partModal.setAttribute('hidden', '');
    currentPartCourse = null;
  }

  function switchParticipantsTab(tabKey) {
    currentPartTab = tabKey;
    if (partTabBtnAlumnos) partTabBtnAlumnos.classList.toggle('active', tabKey === 'alumnos');
    if (partTabBtnMatriz) partTabBtnMatriz.classList.toggle('active', tabKey === 'matriz');

    if (partTabContentAlumnos) partTabContentAlumnos.style.display = (tabKey === 'alumnos') ? 'block' : 'none';
    if (partTabContentMatriz) partTabContentMatriz.style.display = (tabKey === 'matriz') ? 'block' : 'none';
  }

  function refreshParticipantsModalUI() {
    if (!currentPartCourse) return;

    const freshCourse = activos.find(p => p.id === currentPartCourse.id || (p._nodeKey && p._nodeKey === currentPartCourse._nodeKey)) || currentPartCourse;
    currentPartCourse = freshCourse;

    const calc = calcularEstadoTabulacionCurso(freshCourse);

    if (partKpiMatriculados) partKpiMatriculados.textContent = calc.matriculadosCount;
    if (partKpiSesiones) partKpiSesiones.textContent = `${calc.tabuladasCount} / ${calc.totalSesiones}`;
    if (partKpiPendientes) partKpiPendientes.textContent = calc.pendientesVencidas;
    if (partKpiCardPendientes) {
      partKpiCardPendientes.style.borderColor = calc.pendientesVencidas > 0 ? 'var(--rose-300)' : 'var(--border)';
      partKpiCardPendientes.style.background = calc.pendientesVencidas > 0 ? 'var(--rose-50)' : 'var(--slate-50)';
    }
    if (partKpiPromedio) partKpiPromedio.textContent = `${calc.promedioPct}%`;

    if (partTabBadgeAlumnos) partTabBadgeAlumnos.textContent = calc.matriculadosCount;
    if (partTabBadgeMatriz) partTabBadgeMatriz.textContent = `${calc.tabuladasCount}/${calc.totalSesiones}`;

    const pctTab = calc.totalSesiones > 0 ? Math.round((calc.tabuladasCount / calc.totalSesiones) * 100) : 0;
    if (partTabProgressPct) partTabProgressPct.textContent = `${pctTab}%`;
    if (partTabProgressBar) partTabProgressBar.style.width = `${pctTab}%`;
    if (partTabProgressLabel) {
      partTabProgressLabel.textContent = `Progreso de tabulación: ${calc.tabuladasCount} de ${calc.totalSesiones} sesiones completadas ${calc.pendientesVencidas > 0 ? '· (' + calc.pendientesVencidas + ' retrasadas)' : ''}`;
    }

    renderParticipantsListTab(calc);
    renderAttendanceMatrixTab(calc);
  }

  function renderParticipantsListTab(calc) {
    if (!partAlumnosTbody) return;
    const parts = calc.participantes || [];

    const filtered = parts.filter(p => {
      if (!currentPartSearch) return true;
      const s = currentPartSearch.toLowerCase();
      const n = (p.nombre || '').toLowerCase();
      const d = (p.documento || '').toLowerCase();
      const c = (p.correo || '').toLowerCase();
      return n.includes(s) || d.includes(s) || c.includes(s);
    });

    if (filtered.length === 0) {
      const msg = parts.length === 0
        ? 'Sin participantes matriculados en este curso todavía.<br><span style="font-size:12px;color:var(--slate-500);margin-top:4px;display:inline-block;">Haz clic en <strong>+ Añadir Alumno</strong> o <strong>📋 Pegar masivo desde Excel</strong> arriba para registrar participantes.</span>'
        : 'No se encontraron alumnos que coincidan con la búsqueda.';
      partAlumnosTbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--slate-500);">${msg}</td></tr>`;
      return;
    }

    partAlumnosTbody.innerHTML = filtered.map((p, idx) => {
      let pCount = 0;
      let fCount = 0;
      for (let s = 0; s < calc.totalSesiones; s++) {
        const mark = p.asistencias && (p.asistencias['sesion_' + s] || p.asistencias[s]);
        if (mark === 'P') pCount++;
        else if (mark === 'F') fCount++;
      }
      const pct = calc.totalSesiones > 0 ? Math.round((pCount / calc.totalSesiones) * 100) : 0;
      let estPill = '<span class="pill grey">Pendiente</span>';
      if (pct >= 80) estPill = '<span class="pill green">Aprobado</span>';
      else if (pCount > 0 || fCount > 0) estPill = '<span class="pill amber">En riesgo</span>';

      const pKey = p._key || p.id || ('part_' + (p.documento ? p.documento.replace(/[.$#\[\]\/]/g, '_') : idx));

      return `
        <tr>
          <td style="padding:10px 14px;color:var(--slate-400);font-weight:600;">${idx + 1}</td>
          <td style="padding:10px 14px;font-family:var(--font-mono);font-size:12px;color:var(--slate-700);">${escapeHtml(p.documento || '—')}</td>
          <td style="padding:10px 14px;font-weight:600;color:var(--slate-900);">${escapeHtml(p.nombre || '—')}</td>
          <td style="padding:10px 14px;color:var(--slate-600);">${p.correo ? `<a href="mailto:${escapeHtml(p.correo)}" style="color:var(--indigo-600);text-decoration:none;">${escapeHtml(p.correo)}</a>` : '—'}</td>
          <td style="padding:10px 14px;color:var(--slate-600);">${p.celular ? `<a href="tel:${escapeHtml(p.celular)}" style="color:var(--slate-700);text-decoration:none;">${escapeHtml(p.celular)}</a>` : '—'}</td>
          <td style="padding:10px 14px;text-align:center;font-weight:700;color:var(--slate-800);">${pCount} / ${calc.totalSesiones}</td>
          <td style="padding:10px 14px;text-align:center;font-weight:700;color:${pct >= 80 ? 'var(--emerald-600)' : 'var(--amber-600)'};">${pct}%</td>
          <td style="padding:10px 14px;text-align:center;">${estPill}</td>
          <td style="padding:10px 14px;text-align:right;">
            <button type="button" class="btn-action btn-delete-participant" data-key="${pKey}" data-nom="${p.nombre || ''}" title="Eliminar alumno de este curso" style="color:var(--rose-600);">
              🗑️
            </button>
          </td>
        </tr>
      `;
    }).join("");

    partAlumnosTbody.querySelectorAll('.btn-delete-participant').forEach(btn => {
      btn.addEventListener('click', () => {
        const pKey = btn.dataset.key;
        const pNom = btn.dataset.nom || 'este alumno';
        if (confirm(`¿Estás seguro de eliminar a "${pNom}" de este curso?`)) {
          eliminarParticipante(pKey);
        }
      });
    });
  }

  function renderAttendanceMatrixTab(calc) {
    if (!partMatrixThead || !partMatrixTbody) return;
    const parts = calc.participantes || [];

    let theadHtml = `
      <tr>
        <th class="sticky-col-idx">#</th>
        <th class="sticky-col-name">Participante</th>
    `;

    calc.sesionesDetalle.forEach(sd => {
      const badgeCls = sd.estado === 'completo' ? 'green' : (sd.estado === 'vencido' ? 'red' : (sd.estado === 'hoy' ? 'amber' : 'grey'));
      const badgeTxt = sd.estado === 'completo' ? '✓ Tabulado' : (sd.estado === 'vencido' ? '⚠️ Retrasada' : (sd.estado === 'hoy' ? '⏰ Hoy' : '🗓️ Futura'));

      theadHtml += `
        <th style="min-width:110px;text-align:center;padding:8px;">
          <div style="font-size:12px;font-weight:800;color:var(--slate-800);">${sd.label.split(' (')[0]}</div>
          <div style="font-size:11px;color:var(--slate-500);font-weight:600;margin-top:1px;">${sd.fecha ? fmtDate(sd.fecha) : 'Sin fecha'}</div>
          <div style="margin:4px 0;">
            <span class="pill ${badgeCls}" style="font-size:9.5px;padding:1px 6px;">${badgeTxt}</span>
          </div>
          <div style="display:flex;gap:3px;justify-content:center;margin-top:4px;">
            <button type="button" class="btn btn-secondary btn-sm btn-session-all-p" data-ses-idx="${sd.index}" title="Marcar a todos como Presentes (P)" style="font-size:9.5px;padding:2px 5px;height:20px;line-height:1;">
              ✓ Todos P
            </button>
            <button type="button" class="btn btn-secondary btn-sm btn-session-clear" data-ses-idx="${sd.index}" title="Limpiar todas las marcas de esta sesión" style="font-size:9.5px;padding:2px 5px;height:20px;line-height:1;color:var(--rose-600);">
              ✖
            </button>
          </div>
        </th>
      `;
    });

    theadHtml += `
        <th style="min-width:70px;text-align:center;">Total P</th>
        <th style="min-width:70px;text-align:center;">% Asist.</th>
        <th style="min-width:90px;text-align:center;">Estado</th>
      </tr>
    `;
    partMatrixThead.innerHTML = theadHtml;

    if (parts.length === 0) {
      partMatrixTbody.innerHTML = `<tr><td colspan="${calc.totalSesiones + 5}" style="text-align:center;padding:32px;color:var(--slate-400);">Sin participantes matriculados en este curso.<br>Añade alumnos en la pestaña anterior para empezar a tabular asistencia.</td></tr>`;
      return;
    }

    let tbodyHtml = '';
    parts.forEach((p, idx) => {
      const pKey = p._key || p.id || ('part_' + (p.documento ? p.documento.replace(/[.$#\[\]\/]/g, '_') : idx));
      let pCount = 0;
      let cellsHtml = '';

      for (let s = 0; s < calc.totalSesiones; s++) {
        const mark = (p.asistencias && (p.asistencias['sesion_' + s] || p.asistencias[s])) || '';
        if (mark === 'P') pCount++;

        let btnCls = 'att-btn att-empty';
        let btnTxt = '—';
        if (mark === 'P') { btnCls = 'att-btn att-p'; btnTxt = 'P'; }
        else if (mark === 'F') { btnCls = 'att-btn att-f'; btnTxt = 'F'; }
        else if (mark === 'E') { btnCls = 'att-btn att-e'; btnTxt = 'E'; }

        cellsHtml += `
          <td>
            <button type="button" class="${btnCls}" data-part-key="${pKey}" data-student-index="${idx}" data-ses-idx="${s}" data-mark="${mark}" title="Clic para alternar P -> F -> E -> Vacío">
              ${btnTxt}
            </button>
          </td>
        `;
      }

      const pct = calc.totalSesiones > 0 ? Math.round((pCount / calc.totalSesiones) * 100) : 0;
      let estPill = '<span class="pill grey">Pendiente</span>';
      if (pct >= 80) estPill = '<span class="pill green">Aprobado</span>';
      else if (pCount > 0) estPill = '<span class="pill amber">En riesgo</span>';

      tbodyHtml += `
        <tr data-part-key="${pKey}">
          <td class="sticky-col-idx">${idx + 1}</td>
          <td class="sticky-col-name" title="${p.nombre || ''}">
            <div style="font-weight:700;color:var(--slate-800);">${p.nombre || 'Sin nombre'}</div>
            <div style="font-size:10.5px;color:var(--slate-400);font-family:var(--font-mono);">${p.documento || '—'}</div>
          </td>
          ${cellsHtml}
          <td style="font-weight:700;color:var(--slate-800);" class="part-row-total-p">${pCount} / ${calc.totalSesiones}</td>
          <td style="font-weight:700;color:${pct >= 80 ? 'var(--emerald-600)' : 'var(--amber-600)'};" class="part-row-pct">${pct}%</td>
          <td class="part-row-status">${estPill}</td>
        </tr>
      `;
    });
    partMatrixTbody.innerHTML = tbodyHtml;

    partMatrixTbody.querySelectorAll('.att-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleAttendanceCell(btn);
      });
    });

    partMatrixThead.querySelectorAll('.btn-session-all-p').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const s = parseInt(btn.dataset.sesIdx, 10);
        marcarTodosPresentesSesion(s);
      });
    });
    partMatrixThead.querySelectorAll('.btn-session-clear').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const s = parseInt(btn.dataset.sesIdx, 10);
        limpiarMarcasSesion(s);
      });
    });
  }

  function toggleAttendanceCell(btn) {
    if (!currentPartCourse || !btn) return;
    const pKey = btn.dataset.partKey;
    const s = btn.dataset.sesIdx;
    const currentMark = btn.dataset.mark || '';

    let nextMark = '';
    if (currentMark === '') nextMark = 'P';
    else if (currentMark === 'P') nextMark = 'F';
    else if (currentMark === 'F') nextMark = 'E';
    else if (currentMark === 'E') nextMark = '';

    btn.dataset.mark = nextMark;
    if (nextMark === 'P') { btn.className = 'att-btn att-p'; btn.textContent = 'P'; }
    else if (nextMark === 'F') { btn.className = 'att-btn att-f'; btn.textContent = 'F'; }
    else if (nextMark === 'E') { btn.className = 'att-btn att-e'; btn.textContent = 'E'; }
    else { btn.className = 'att-btn att-empty'; btn.textContent = '—'; }

    if (!currentPartCourse.participantes) currentPartCourse.participantes = {};
    let part = currentPartCourse.participantes[pKey];
    if (!part && Array.isArray(currentPartCourse.participantes)) {
      part = currentPartCourse.participantes.find(x => x && (x._key === pKey || x.documento === pKey));
    }
    if (!part) {
      part = { documento: btn.dataset.doc || '', nombre: btn.dataset.nombre || '', asistencias: {} };
      currentPartCourse.participantes[pKey] = part;
    }
    if (!part.asistencias) part.asistencias = {};
    if (nextMark) part.asistencias['sesion_' + s] = nextMark;
    else delete part.asistencias['sesion_' + s];

    const mesKey = currentPartCourse._mesKey || getMesKey(currentPartCourse.mes || currentPartCourse.origen_mes || "General");
    const nodeKey = currentPartCourse._nodeKey || currentPartCourse.id || sanitizeFirebaseNodeKey(currentPartCourse.programa || "prog");

    if (fbDb && mesKey && nodeKey) {
      const path = `meses/${mesKey}/programas/${nodeKey}/participantes/${pKey}/asistencias/sesion_${s}`;
      fbDb.ref(path).set(nextMark || null).catch(err => {
        console.error("Error guardando asistencia en Firebase:", err);
      });
    }

    // Actualizar fila visualmente de inmediato sin perder foco ni scroll
    const row = btn.closest('tr');
    if (row && part) {
      const calc = calcularEstadoTabulacionCurso(currentPartCourse);
      let pCount = 0;
      for (let si = 0; si < calc.totalSesiones; si++) {
        if (part.asistencias && (part.asistencias['sesion_' + si] === 'P' || part.asistencias[si] === 'P')) pCount++;
      }
      const pct = calc.totalSesiones > 0 ? Math.round((pCount / calc.totalSesiones) * 100) : 0;
      let estPill = '<span class="pill grey">Pendiente</span>';
      if (pct >= 80) estPill = '<span class="pill green">Aprobado</span>';
      else if (pCount > 0) estPill = '<span class="pill amber">En riesgo</span>';

      const totalEl = row.querySelector('.part-row-total-p');
      const pctEl = row.querySelector('.part-row-pct');
      const statEl = row.querySelector('.part-row-status');
      if (totalEl) totalEl.textContent = `${pCount} / ${calc.totalSesiones}`;
      if (pctEl) {
        pctEl.textContent = `${pct}%`;
        pctEl.style.color = pct >= 80 ? 'var(--emerald-600)' : 'var(--amber-600)';
      }
      if (statEl) statEl.innerHTML = estPill;

      if (partKpiSesiones) partKpiSesiones.textContent = `${calc.tabuladasCount} / ${calc.totalSesiones}`;
      if (partKpiPendientes) partKpiPendientes.textContent = calc.pendientesVencidas;
      if (partKpiPromedio) partKpiPromedio.textContent = `${calc.promedioPct}%`;
    }

    // SINCRONIZACIÓN EN TIEMPO REAL CON GOOGLE SHEETS
    mostrarStatusGuardado('⚡ Sincronizando con Google Sheets...');
    sincronizarParticipantesADriveDebounced();
  }

  function marcarTodosPresentesSesion(sIndex) {
    if (!currentPartCourse) return;
    const calc = calcularEstadoTabulacionCurso(currentPartCourse);
    const parts = calc.participantes || [];
    if (parts.length === 0) return;

    const mesKey = currentPartCourse._mesKey || getMesKey(currentPartCourse.mes || currentPartCourse.origen_mes || "General");
    const nodeKey = currentPartCourse._nodeKey || currentPartCourse.id || sanitizeFirebaseNodeKey(currentPartCourse.programa || "prog");

    const updates = {};
    parts.forEach(p => {
      const pKey = p._key || p.id || ('part_' + (p.documento ? p.documento.replace(/[.$#\[\]\/]/g, '_') : ''));
      if (!p.asistencias) p.asistencias = {};
      p.asistencias['sesion_' + sIndex] = 'P';
      if (currentPartCourse.participantes && currentPartCourse.participantes[pKey]) {
        if (!currentPartCourse.participantes[pKey].asistencias) currentPartCourse.participantes[pKey].asistencias = {};
        currentPartCourse.participantes[pKey].asistencias['sesion_' + sIndex] = 'P';
      }
      if (mesKey && nodeKey) {
        updates[`meses/${mesKey}/programas/${nodeKey}/participantes/${pKey}/asistencias/sesion_${sIndex}`] = 'P';
      }
    });

    if (fbDb && Object.keys(updates).length > 0) {
      fbDb.ref().update(updates).then(() => {
        mostrarStatusGuardado('⚡ Sesión marcada, sincronizando con Sheets...');
      });
    }

    refreshParticipantsModalUI();

    // Sincronización en tiempo real con Google Sheets
    sincronizarParticipantesADriveSilencioso();
  }

  function limpiarMarcasSesion(sIndex) {
    if (!currentPartCourse) return;
    const calc = calcularEstadoTabulacionCurso(currentPartCourse);
    const parts = calc.participantes || [];
    if (parts.length === 0) return;

    if (!confirm(`¿Deseas limpiar todas las asistencias registradas para la Sesión ${sIndex + 1}?`)) return;

    const mesKey = currentPartCourse._mesKey || getMesKey(currentPartCourse.mes || currentPartCourse.origen_mes || "General");
    const nodeKey = currentPartCourse._nodeKey || currentPartCourse.id || sanitizeFirebaseNodeKey(currentPartCourse.programa || "prog");

    const updates = {};
    parts.forEach(p => {
      const pKey = p._key || p.id || ('part_' + (p.documento ? p.documento.replace(/[.$#\[\]\/]/g, '_') : ''));
      if (p.asistencias) delete p.asistencias['sesion_' + sIndex];
      if (currentPartCourse.participantes && currentPartCourse.participantes[pKey] && currentPartCourse.participantes[pKey].asistencias) {
        delete currentPartCourse.participantes[pKey].asistencias['sesion_' + sIndex];
      }
      if (mesKey && nodeKey) {
        updates[`meses/${mesKey}/programas/${nodeKey}/participantes/${pKey}/asistencias/sesion_${sIndex}`] = null;
      }
    });

    if (fbDb && Object.keys(updates).length > 0) {
      fbDb.ref().update(updates).then(() => {
        mostrarStatusGuardado('⚡ Sesión limpiada, sincronizando con Sheets...');
      });
    }

    refreshParticipantsModalUI();

    // Sincronización en tiempo real con Google Sheets
    sincronizarParticipantesADriveSilencioso();
  }

  function parseBatchParticipantsText(text) {
    if (!text || typeof text !== 'string') return [];
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const result = [];

    lines.forEach(line => {
      if (/^(no|num|documento|c[eé]dula|identificaci[oó]n|nombre|apellido|correo|email|tel|celular)\b/i.test(line)) {
        return;
      }

      let parts = line.includes('\t') ? line.split('\t') : (line.includes(';') ? line.split(';') : line.split(','));
      parts = parts.map(p => p.trim().replace(/^["']|["']$/g, ''));
      if (parts.length === 0) return;

      let doc = '';
      let nom = '';
      let cor = '';
      let tel = '';

      parts.forEach(col => {
        if (!col) return;
        if (/@/.test(col)) {
          cor = col.toLowerCase();
        } else if (/^\+?[0-9]{7,15}$/.test(col.replace(/[\s-]/g, ''))) {
          if (!doc) doc = col.replace(/[\s-]/g, '');
          else if (!tel) tel = col.replace(/[\s-]/g, '');
        } else if (!nom && col.length > 2 && !/^[0-9]+$/.test(col)) {
          nom = col;
        } else if (!doc && /^[0-9]+$/.test(col)) {
          doc = col;
        }
      });

      if (!doc && parts[0]) doc = parts[0];
      if (!nom && parts[1]) nom = parts[1];
      if (!cor && parts[2] && parts[2].includes('@')) cor = parts[2];
      if (!tel && parts[3]) tel = parts[3];

      if (doc || nom) {
        result.push({
          documento: doc || ('DOC_' + (result.length + 1)),
          nombre: nom || 'Sin nombre',
          correo: cor || '',
          celular: tel || '',
          asistencias: {}
        });
      }
    });

    return result;
  }

  function registrarAlumnoIndividual() {
    if (!currentPartCourse) return;
    const doc = (partInDoc ? partInDoc.value : '').trim();
    const nom = (partInNom ? partInNom.value : '').trim();
    const cor = (partInCor ? partInCor.value : '').trim();
    const tel = (partInTel ? partInTel.value : '').trim();

    if (!doc && !nom) {
      alert("Por favor ingresa al menos el Documento o el Nombre Completo del participante.");
      return;
    }

    const pKey = 'part_' + (doc ? doc.replace(/[.$#\[\]\/]/g, '_') : ('p_' + Date.now()));
    const newPart = {
      documento: doc,
      nombre: nom || 'Sin nombre',
      correo: cor,
      celular: tel,
      asistencias: {}
    };

    if (fbDb && currentPartCourse._mesKey && currentPartCourse._nodeKey) {
      fbDb.ref(`meses/${currentPartCourse._mesKey}/programas/${currentPartCourse._nodeKey}/participantes/${pKey}`).set(newPart).then(() => {
        if (partInDoc) partInDoc.value = '';
        if (partInNom) partInNom.value = '';
        if (partInCor) partInCor.value = '';
        if (partInTel) partInTel.value = '';
        if (partSingleFormBox) partSingleFormBox.style.display = 'none';

        if (!currentPartCourse.participantes) currentPartCourse.participantes = {};
        currentPartCourse.participantes[pKey] = newPart;

        refreshParticipantsModalUI();
        mostrarStatusGuardado('✓ Alumno registrado exitosamente');
        sincronizarParticipantesADriveSilencioso();
      }).catch(err => {
        alert("Error al guardar alumno: " + err.message);
      });
    }
  }

  function eliminarParticipante(pKey) {
    if (!currentPartCourse || !fbDb) return;
    fbDb.ref(`meses/${currentPartCourse._mesKey}/programas/${currentPartCourse._nodeKey}/participantes/${pKey}`).remove().then(() => {
      if (currentPartCourse.participantes) {
        delete currentPartCourse.participantes[pKey];
      }
      refreshParticipantsModalUI();
      mostrarStatusGuardado('✓ Participante eliminado');
      sincronizarParticipantesADriveSilencioso();
    }).catch(err => {
      alert("Error eliminando participante: " + err.message);
    });
  }

  function ejecutarImportacionMasivaParticipantes() {
    if (!currentPartCourse || !partBatchTextarea) return;
    const raw = partBatchTextarea.value || '';
    const parsed = parseBatchParticipantsText(raw);
    if (parsed.length === 0) {
      alert("No se detectaron participantes válidos en el texto.");
      return;
    }

    const replaceAll = partBatchReplaceChk && partBatchReplaceChk.checked;
    const updates = {};
    const baseObj = replaceAll ? {} : (currentPartCourse.participantes || {});

    parsed.forEach((p, idx) => {
      const pKey = 'part_' + (p.documento ? p.documento.replace(/[.$#\[\]\/]/g, '_') : ('b_' + Date.now() + '_' + idx));
      updates[`meses/${currentPartCourse._mesKey}/programas/${currentPartCourse._nodeKey}/participantes/${pKey}`] = p;
      baseObj[pKey] = p;
    });

    if (fbDb) {
      const promise = replaceAll
        ? fbDb.ref(`meses/${currentPartCourse._mesKey}/programas/${currentPartCourse._nodeKey}/participantes`).set(baseObj)
        : fbDb.ref().update(updates);

      promise.then(() => {
        currentPartCourse.participantes = baseObj;
        partBatchTextarea.value = '';
        if (partBatchFormBox) partBatchFormBox.style.display = 'none';
        if (partBatchPreviewLine) partBatchPreviewLine.style.display = 'none';
        refreshParticipantsModalUI();
        mostrarStatusGuardado(`✓ Se importaron ${parsed.length} participantes exitosamente`);
        sincronizarParticipantesADriveSilencioso();
        alert(`¡Éxito! Se importaron ${parsed.length} participantes en el curso "${currentPartCourse.programa}".`);
      }).catch(err => {
        alert("Error al importar participantes: " + err.message);
      });
    }
  }

  let driveSyncDebounceTimer = null;
  function sincronizarParticipantesADriveDebounced() {
    if (driveSyncDebounceTimer) clearTimeout(driveSyncDebounceTimer);
    driveSyncDebounceTimer = setTimeout(() => {
      sincronizarParticipantesADriveSilencioso();
    }, 400);
  }

  function sincronizarParticipantesADriveSilencioso() {
    if (!currentPartCourse) return;
    const sheetUrl = currentPartCourse.asistencia_sheet_url || '';
    const sheetId = currentPartCourse.asistencia_sheet_id || '';
    const folderId = currentPartCourse.drive_folder_id || '';
    if (!sheetUrl && !sheetId && !folderId) return;

    const calc = calcularEstadoTabulacionCurso(currentPartCourse);
    const mesKey = currentPartCourse._mesKey || getMesKey(currentPartCourse.mes || currentPartCourse.origen_mes || "General");
    const nodeKey = currentPartCourse._nodeKey || currentPartCourse.id || sanitizeFirebaseNodeKey(currentPartCourse.programa || "prog");

    sendGasWebhook({
      action: 'sync_participants',
      sheetUrl: sheetUrl,
      sheetId: sheetId,
      folderId: folderId,
      participantes: calc.participantes,
      mesKey: mesKey,
      nodeKey: nodeKey
    }).then(() => {
      mostrarStatusGuardado('✓ Asistencia sincronizada en Google Sheets y Firebase');
    }).catch(err => {
      console.warn("Webhook asistencia:", err);
    });
  }

  function mostrarStatusGuardado(msg) {
    if (!partSaveStatusIndicator) return;
    partSaveStatusIndicator.innerHTML = `<span class="dot green"></span> <strong style="color:var(--emerald-600);">${msg}</strong>`;
    setTimeout(() => {
      if (partSaveStatusIndicator) {
        partSaveStatusIndicator.innerHTML = `<span class="dot green"></span> Conectado a Firebase en tiempo real`;
      }
    }, 3500);
  }

  // Listeners de eventos del modal de participantes
  if (partModalClose) partModalClose.addEventListener('click', closeParticipantsModal);
  if (partModalBtnClose) partModalBtnClose.addEventListener('click', closeParticipantsModal);
  if (partModal) {
    partModal.addEventListener('click', (e) => {
      if (e.target === partModal) closeParticipantsModal();
    });
  }

  if (partTabBtnAlumnos) partTabBtnAlumnos.addEventListener('click', () => switchParticipantsTab('alumnos'));
  if (partTabBtnMatriz) partTabBtnMatriz.addEventListener('click', () => switchParticipantsTab('matriz'));

  if (partBtnToggleAddForm && partSingleFormBox) {
    partBtnToggleAddForm.addEventListener('click', () => {
      const isHidden = partSingleFormBox.style.display === 'none';
      partSingleFormBox.style.display = isHidden ? 'block' : 'none';
      if (isHidden && partBatchFormBox) partBatchFormBox.style.display = 'none';
      if (isHidden && partInDoc) partInDoc.focus();
    });
  }
  if (partSingleFormClose && partSingleFormBox) {
    partSingleFormClose.addEventListener('click', () => {
      partSingleFormBox.style.display = 'none';
    });
  }
  if (partBtnSubmitSingle) {
    partBtnSubmitSingle.addEventListener('click', registrarAlumnoIndividual);
  }

  if (partBtnToggleBatch && partBatchFormBox) {
    partBtnToggleBatch.addEventListener('click', () => {
      const isHidden = partBatchFormBox.style.display === 'none';
      partBatchFormBox.style.display = isHidden ? 'block' : 'none';
      if (isHidden && partSingleFormBox) partSingleFormBox.style.display = 'none';
      if (isHidden && partBatchTextarea) partBatchTextarea.focus();
    });
  }
  if (partBatchFormClose && partBatchFormBox) {
    partBatchFormClose.addEventListener('click', () => {
      partBatchFormBox.style.display = 'none';
    });
  }
  if (partBatchTextarea) {
    partBatchTextarea.addEventListener('input', () => {
      const parsed = parseBatchParticipantsText(partBatchTextarea.value || '');
      if (partBatchPreviewLine) {
        if (parsed.length > 0) {
          partBatchPreviewLine.style.display = 'block';
          partBatchPreviewLine.innerHTML = `✓ Se detectaron <strong>${parsed.length} participantes válidos</strong>.`;
          if (partBtnSubmitBatch) partBtnSubmitBatch.disabled = false;
        } else {
          partBatchPreviewLine.style.display = 'none';
          if (partBtnSubmitBatch) partBtnSubmitBatch.disabled = true;
        }
      }
    });
  }
  if (partBtnParseBatch) {
    partBtnParseBatch.addEventListener('click', () => {
      const parsed = parseBatchParticipantsText(partBatchTextarea ? partBatchTextarea.value : '');
      alert(`Análisis completado: se detectaron ${parsed.length} filas válidas con datos de participantes.`);
    });
  }
  if (partBtnSubmitBatch) {
    partBtnSubmitBatch.addEventListener('click', ejecutarImportacionMasivaParticipantes);
  }

  if (partSearchInput) {
    partSearchInput.addEventListener('input', (e) => {
      currentPartSearch = e.target.value.trim();
      if (currentPartCourse) {
        const calc = calcularEstadoTabulacionCurso(currentPartCourse);
        renderParticipantsListTab(calc);
      }
    });
  }

  if (partBtnCopyEmails) {
    partBtnCopyEmails.addEventListener('click', () => {
      if (!currentPartCourse) return;
      const calc = calcularEstadoTabulacionCurso(currentPartCourse);
      const emails = (calc.participantes || []).map(p => (p.correo || '').trim()).filter(Boolean);
      if (emails.length === 0) {
        alert("No hay correos registrados para copiar.");
        return;
      }
      const emailListStr = emails.join("; ");
      navigator.clipboard.writeText(emailListStr).then(() => {
        alert(`✓ Se copiaron ${emails.length} correos electrónicos al portapapeles.`);
      }).catch(() => {
        prompt("Copia la lista de correos:", emailListStr);
      });
    });
  }

  if (partMatrixBtnPush) {
    partMatrixBtnPush.addEventListener('click', () => {
      if (!currentPartCourse) return;
      if (!currentPartCourse.asistencia_sheet_url) {
        alert("Este curso aún no tiene una planilla de asistencia vinculada en Google Drive.");
        return;
      }
      partMatrixBtnPush.disabled = true;
      partMatrixBtnPush.textContent = "⏳ Sincronizando...";

      const calc = calcularEstadoTabulacionCurso(currentPartCourse);
      sendGasWebhook({
        action: 'sync_participants',
        sheetUrl: currentPartCourse.asistencia_sheet_url,
        sheetId: currentPartCourse.asistencia_sheet_id,
        folderId: currentPartCourse.drive_folder_id,
        participantes: calc.participantes,
        mesKey: currentPartCourse._mesKey,
        nodeKey: currentPartCourse._nodeKey
      }).then(() => {
        partMatrixBtnPush.disabled = false;
        partMatrixBtnPush.textContent = "📤 Sincronizar a Drive";
        mostrarStatusGuardado("✓ Planilla de Google Drive actualizada con éxito");
        alert("✓ Los participantes y asistencias se enviaron correctamente a la planilla de Google Drive.");
      }).catch(err => {
        partMatrixBtnPush.disabled = false;
        partMatrixBtnPush.textContent = "📤 Sincronizar a Drive";
        alert("Nota: La solicitud fue enviada a Google Drive.");
      });
    });
  }

  function pullAttendanceFromDriveSilencioso() {
    if (!currentPartCourse) return Promise.resolve(null);
    const sheetUrl = currentPartCourse.asistencia_sheet_url || '';
    const sheetId = currentPartCourse.asistencia_sheet_id || '';
    if (!sheetUrl && !sheetId) return Promise.resolve(null);

    const mesKey = currentPartCourse._mesKey || getMesKey(currentPartCourse.mes || currentPartCourse.origen_mes || "General");
    const nodeKey = currentPartCourse._nodeKey || currentPartCourse.id || sanitizeFirebaseNodeKey(currentPartCourse.programa || "prog");

    return sendGasWebhook({
      action: 'read_attendance',
      sheetUrl: sheetUrl,
      sheetId: sheetId,
      mesKey: mesKey,
      nodeKey: nodeKey
    });
  }

  let autoPollAttendanceTimer = null;
  function startAutoPollingAttendance() {
    // La sincronización en tiempo real se realiza mediante el trigger onEdit de Sheets -> Firebase
    // y al abrir el modal o presionar "Traer de Drive", evitando agotar la cuota de Google Apps Script.
    stopAutoPollingAttendance();
  }

  function stopAutoPollingAttendance() {
    if (autoPollAttendanceTimer) {
      clearInterval(autoPollAttendanceTimer);
      autoPollAttendanceTimer = null;
    }
  }

  if (partMatrixBtnPull) {
    partMatrixBtnPull.addEventListener('click', () => {
      if (!currentPartCourse) return;
      if (!currentPartCourse.asistencia_sheet_url && !currentPartCourse.asistencia_sheet_id) {
        alert("Este curso no tiene una planilla en Google Drive asignada aún.");
        return;
      }
      partMatrixBtnPull.disabled = true;
      partMatrixBtnPull.textContent = "⏳ Leyendo Drive...";

      pullAttendanceFromDriveSilencioso().then(() => {
        partMatrixBtnPull.disabled = false;
        partMatrixBtnPull.textContent = "📥 Traer de Drive";
        mostrarStatusGuardado("✓ Asistencias actualizadas desde Drive");
      }).catch(err => {
        partMatrixBtnPull.disabled = false;
        partMatrixBtnPull.textContent = "📥 Traer de Drive";
        console.error(err);
      });
    });
  }

  if (partBtnExportExcelModal) {
    partBtnExportExcelModal.addEventListener('click', () => {
      if (!currentPartCourse) return;
      exportarPlanillaAsistenciaXLSX(currentPartCourse);
    });
  }

  // ===========================================================================
  // SISTEMA DE NOTIFICACIONES TOAST Y MODO TELEVISOR KIOSKO
  // ===========================================================================

  // Helper para mensajes flotantes Toast
  window.showToast = function (msg, type = 'info', duration = 3500) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast-item toast-${type}`;
    const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warning' ? '⚠️' : 'ℹ️';
    toast.innerHTML = `<span style="font-size:16px;">${icon}</span><span>${escapeHtml(msg)}</span>`;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 400);
    }, duration);
  };

  // Quick Status Filter buttons event binding
  document.querySelectorAll('.quick-filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.quick-filter-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTrafficFilter = btn.dataset.filter || 'all';
      renderTable();
    });
  });

  // ---- CONTROLADOR DEL MODO TELEVISOR (TV KIOSK DASHBOARD) ----
  const tvView = document.getElementById('view-tv');
  const btnOpenTv = document.getElementById('btn-open-tv-mode');
  const btnExitTv = document.getElementById('tv-btn-exit');
  const btnFullscreenTv = document.getElementById('tv-btn-fullscreen');
  const btnThemeTv = document.getElementById('tv-btn-theme');
  const btnAutoscrollTv = document.getElementById('tv-btn-autoscroll');

  let tvClockTimer = null;
  let tvAutoscrollTimer = null;
  let tvIsAutoscrolling = true;
  let tvScrollDirection = 1; // 1 = down, -1 = up
  let tvUserInteractedTimer = null;

  function updateTvClock() {
    const elTime = document.getElementById('tv-clock-time');
    const elDate = document.getElementById('tv-clock-date');
    if (!elTime || !elDate) return;
    const now = new Date();
    elTime.textContent = now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    elDate.textContent = now.toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }

  function getCoordinatorColor(coord) {
    const c = (coord || '').toLowerCase();
    if (c.includes('patricia')) return { bg: 'rgba(79, 70, 229, 0.25)', text: '#c7d2fe', border: 'rgba(129, 140, 248, 0.5)' };
    if (c.includes('andrea')) return { bg: 'rgba(124, 58, 237, 0.25)', text: '#ddd6fe', border: 'rgba(167, 139, 250, 0.5)' };
    if (c.includes('liliam')) return { bg: 'rgba(16, 185, 129, 0.25)', text: '#a7f3d0', border: 'rgba(52, 211, 153, 0.5)' };
    if (c.includes('karen')) return { bg: 'rgba(245, 158, 11, 0.25)', text: '#fde68a', border: 'rgba(251, 191, 36, 0.5)' };
    return { bg: 'rgba(100, 116, 139, 0.25)', text: '#e2e8f0', border: 'rgba(148, 163, 184, 0.4)' };
  }

  function renderTvDashboard() {
    if (!tvView) return;

    // 1. Métricas clave
    const redProgs = activos.filter(p => semaforo(p) === 'red');
    const amberProgs = activos.filter(p => semaforo(p) === 'amber');
    const greenProgs = activos.filter(p => semaforo(p) === 'green');

    let tabVencidasCount = 0;
    let salonesPendCount = 0;

    activos.forEach(p => {
      const calc = calcularEstadoTabulacionCurso(p);
      tabVencidasCount += (calc.pendientesVencidas || 0);
      const sals = Array.isArray(p.salones) ? p.salones : (p.salones ? Object.values(p.salones) : []);
      salonesPendCount += sals.filter(s => s && (s.estado === 'pendiente' || s.estado === 'por_confirmar')).length;
    });

    const enCursoCount = activos.filter(p => /curso/i.test(p.estado || '')).length;

    // Conteo de aperturas por correo
    const emailBadge = document.getElementById('badge-correos');
    const emailCount = (emailBadge && emailBadge.style.display !== 'none') ? parseInt(emailBadge.textContent, 10) || 0 : 0;

    // Actualizar Ribbon de KPIs
    const elRojos = document.getElementById('tv-kpi-rojos'); if (elRojos) elRojos.textContent = redProgs.length;
    const elTabV = document.getElementById('tv-kpi-tab-vencidas'); if (elTabV) elTabV.textContent = tabVencidasCount;
    const elSalP = document.getElementById('tv-kpi-salones-pend'); if (elSalP) elSalP.textContent = salonesPendCount;
    const elAp = document.getElementById('tv-kpi-aperturas'); if (elAp) elAp.textContent = emailCount;
    const elEnC = document.getElementById('tv-kpi-en-curso'); if (elEnC) elEnC.textContent = enCursoCount;
    const elTot = document.getElementById('tv-kpi-total-activos'); if (elTot) elTot.textContent = activos.length;

    // Actualizar badges en headers
    const badgeUrgent = document.getElementById('tv-badge-urgent-count'); if (badgeUrgent) badgeUrgent.textContent = redProgs.length;
    const badgeSchedule = document.getElementById('tv-badge-schedule-count'); if (badgeSchedule) badgeSchedule.textContent = activos.filter(p => /curso|pronto/i.test(p.estado || '')).length;

    // Actualizar badge del botón superior
    const totalPendientes = redProgs.length + tabVencidasCount + salonesPendCount + emailCount;
    const tvPillBadge = document.getElementById('badge-tv-pendientes');
    if (tvPillBadge) {
      if (totalPendientes > 0) {
        tvPillBadge.textContent = totalPendientes;
        tvPillBadge.style.display = 'inline-block';
      } else {
        tvPillBadge.style.display = 'none';
      }
    }

    // 2. Columna 1: Urgente & Alertas Rojas
    const listUrgent = document.getElementById('tv-list-urgent');
    if (listUrgent) {
      if (redProgs.length === 0) {
        listUrgent.innerHTML = `
          <div class="tv-empty-box">
            <span class="tv-empty-icon">✅</span>
            <strong style="color:#34d399;font-size:15px;">Operación 100% al día</strong>
            <span>No hay programas en alerta roja ni bloqueos logísticos activos.</span>
          </div>
        `;
      } else {
        listUrgent.innerHTML = redProgs.map(p => {
          const cColor = getCoordinatorColor(p.coordinadora);
          const calc = calcularEstadoTabulacionCurso(p);
          const sals = Array.isArray(p.salones) ? p.salones : (p.salones ? Object.values(p.salones) : []);
          const salPend = sals.filter(s => s && s.estado === 'pendiente');

          const alertsHtml = [];
          if (calc.pendientesVencidas > 0) {
            alertsHtml.push(`<span class="tv-alert-badge red">⚠️ ${calc.pendientesVencidas} Tabulación(es) vencida(s)</span>`);
          }
          if (salPend.length > 0) {
            alertsHtml.push(`<span class="tv-alert-badge red">🚪 Salón pendiente por asignar</span>`);
          }
          if (/reprogram/i.test(p.estado || '')) {
            alertsHtml.push(`<span class="tv-alert-badge red">🔄 Programa Reprogramado</span>`);
          }
          if (alertsHtml.length === 0) {
            alertsHtml.push(`<span class="tv-alert-badge amber">⚠️ Revisión logística requerida</span>`);
          }

          const horarioTxt = (p.analisis_horario && p.analisis_horario.horas && p.analisis_horario.horas[0]) || p.horario || 'Horario por definir';

          return `
            <div class="tv-card tv-card-urgent">
              <div class="tv-card-header">
                <span style="background:${cColor.bg};color:${cColor.text};border:1px solid ${cColor.border};font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;">
                  ${escapeHtml(p.coordinadora || 'Sin coord.')}
                </span>
                <span style="font-size:11px;font-weight:700;color:#fda4af;">NRC: ${escapeHtml(p.nrc || '—')}</span>
              </div>
              <div class="tv-card-title">${escapeHtml(p.programa || p.nombre_del_programa || 'Sin nombre')}</div>
              <div class="tv-card-meta">
                <span class="tv-card-meta-item">🗓️ ${fmtDate(p.fecha_inicio)} – ${fmtDate(p.fecha_fin)}</span>
                <span class="tv-card-meta-item">⏰ ${escapeHtml(horarioTxt)}</span>
              </div>
              <div class="tv-card-alerts">${alertsHtml.join('')}</div>
            </div>
          `;
        }).join('');
      }
    }

    // 3. Columna 2: Clases Activas & Próximos Inicios
    const listSchedule = document.getElementById('tv-list-schedule');
    if (listSchedule) {
      const activeSchedProgs = activos.filter(p => /curso|pronto|preparaci/i.test(p.estado || '')).slice(0, 15);
      if (activeSchedProgs.length === 0) {
        listSchedule.innerHTML = `
          <div class="tv-empty-box">
            <span class="tv-empty-icon">☕</span>
            <strong>Sin clases activas hoy</strong>
            <span>No hay cursos en curso o programados para comenzar próximamente.</span>
          </div>
        `;
      } else {
        listSchedule.innerHTML = activeSchedProgs.map(p => {
          const cColor = getCoordinatorColor(p.coordinadora);
          const isEnCurso = /curso/i.test(p.estado || '');
          const modPill = (p.modalidad || '').toLowerCase() === 'virtual' || (p.modalidad || '').toLowerCase() === 'remoto'
            ? `<span style="background:rgba(59, 130, 246, 0.2);color:#93c5fd;border:1px solid rgba(59, 130, 246, 0.4);font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;">Remoto</span>`
            : (p.modalidad || '').toLowerCase() === 'blended'
              ? `<span style="background:rgba(168, 85, 247, 0.2);color:#d8b4fe;border:1px solid rgba(168, 85, 247, 0.4);font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;">Blended</span>`
              : `<span style="background:rgba(16, 185, 129, 0.2);color:#6ee7b7;border:1px solid rgba(16, 185, 129, 0.4);font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;">Presencial</span>`;

          const horarioTxt = (p.analisis_horario && p.analisis_horario.horas && p.analisis_horario.horas[0]) || p.horario || 'Por confirmar';
          const salonTxt = (p.salones && p.salones[0] && p.salones[0].valor) ? `🚪 Salón: ${p.salones[0].valor}` : (p.link ? `🔗 Enlace Zoom/Teams configurado` : `🚪 Salón por asignar`);

          return `
            <div class="tv-card">
              <div class="tv-card-header">
                <div style="display:flex;align-items:center;gap:6px;">
                  <span style="background:${cColor.bg};color:${cColor.text};border:1px solid ${cColor.border};font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;">
                    ${escapeHtml(p.coordinadora || 'Sin coord.')}
                  </span>
                  ${modPill}
                </div>
                <span style="font-size:11px;font-weight:700;color:${isEnCurso ? '#34d399' : '#f59e0b'};">
                  ${isEnCurso ? '● En curso' : '○ Pronto a iniciar'}
                </span>
              </div>
              <div class="tv-card-title">${escapeHtml(p.programa || p.nombre_del_programa || 'Sin nombre')}</div>
              <div class="tv-card-meta">
                <span class="tv-card-meta-item">🗓️ ${fmtDate(p.fecha_inicio)} – ${fmtDate(p.fecha_fin)}</span>
                <span class="tv-card-meta-item">⏰ ${escapeHtml(horarioTxt)}</span>
                <span class="tv-card-meta-item">${escapeHtml(salonTxt)}</span>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    // 4. Columna 3: Tabulaciones & Recordatorios
    const listReminders = document.getElementById('tv-list-reminders');
    const badgeReminders = document.getElementById('tv-badge-reminders-count');
    if (listReminders) {
      const remItems = [];

      activos.forEach(p => {
        const calc = calcularEstadoTabulacionCurso(p);
        calc.sesionesDetalle.forEach(sd => {
          if (sd.estado === 'vencido' || sd.estado === 'hoy') {
            remItems.push({
              coord: p.coordinadora,
              programa: p.programa || p.nombre_del_programa || 'Sin nombre',
              detalle: `${sd.label} pendiente de tabulación`,
              vencido: sd.estado === 'vencido'
            });
          }
        });
      });

      if (badgeReminders) badgeReminders.textContent = remItems.length;

      if (remItems.length === 0) {
        listReminders.innerHTML = `
          <div class="tv-empty-box">
            <span class="tv-empty-icon">📋</span>
            <strong style="color:#34d399;font-size:15px;">Listas de asistencia al día</strong>
            <span>Todas las tabulaciones de cursos activos han sido procesadas.</span>
          </div>
        `;
      } else {
        listReminders.innerHTML = remItems.slice(0, 15).map(r => {
          const cColor = getCoordinatorColor(r.coord);
          return `
            <div class="tv-card">
              <div class="tv-card-header">
                <span style="background:${cColor.bg};color:${cColor.text};border:1px solid ${cColor.border};font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;">
                  ${escapeHtml(r.coord || 'Coordinadora')}
                </span>
                <span class="tv-alert-badge ${r.vencido ? 'red' : 'amber'}">${r.vencido ? 'Vencida' : 'Vence hoy'}</span>
              </div>
              <div class="tv-card-title">${escapeHtml(r.programa)}</div>
              <div class="tv-card-meta">
                <span>📌 ${escapeHtml(r.detalle)}</span>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    const timeUpdate = document.getElementById('tv-footer-time-update');
    if (timeUpdate) {
      const now = new Date();
      timeUpdate.textContent = 'Actualizado ' + now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    }
  }

  // Motor de Auto-Scroll para Kiosko / Televisor
  function startTvAutoscroll() {
    stopTvAutoscroll();
    tvAutoscrollTimer = setInterval(() => {
      if (!tvIsAutoscrolling || !tvView || tvView.style.display === 'none') return;
      const scrollCols = tvView.querySelectorAll('.tv-col-scroll');
      scrollCols.forEach(col => {
        if (col.scrollHeight > col.clientHeight) {
          const maxScroll = col.scrollHeight - col.clientHeight;
          if (col.scrollTop >= maxScroll - 2) {
            tvScrollDirection = -1;
          } else if (col.scrollTop <= 2) {
            tvScrollDirection = 1;
          }
          col.scrollTop += (tvScrollDirection * 1.5);
        }
      });
    }, 50);
  }

  function stopTvAutoscroll() {
    if (tvAutoscrollTimer) {
      clearInterval(tvAutoscrollTimer);
      tvAutoscrollTimer = null;
    }
  }

  function openTvMode() {
    if (!tvView) return;
    tvView.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    updateTvClock();
    if (!tvClockTimer) tvClockTimer = setInterval(updateTvClock, 1000);
    renderTvDashboard();
    startTvAutoscroll();
    if (window.location.hash !== '#tv') {
      history.replaceState(null, '', '#tv');
    }
    window.showToast("Modo TV Kiosko activado", "info", 2500);
  }

  function closeTvMode() {
    if (!tvView) return;
    tvView.style.display = 'none';
    document.body.style.overflow = '';
    stopTvAutoscroll();
    if (tvClockTimer) {
      clearInterval(tvClockTimer);
      tvClockTimer = null;
    }
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => { });
    }
    if (window.location.hash === '#tv') {
      history.replaceState(null, '', window.location.pathname);
    }
  }

  function initTvMode() {
    if (btnOpenTv) {
      btnOpenTv.addEventListener('click', openTvMode);
    }
    if (btnExitTv) {
      btnExitTv.addEventListener('click', closeTvMode);
    }

    if (btnFullscreenTv) {
      btnFullscreenTv.addEventListener('click', () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(err => {
            console.warn("Fullscreen request error:", err);
          });
        } else {
          document.exitFullscreen().catch(() => { });
        }
      });
    }

    if (btnThemeTv) {
      // Cargar preferencia guardada
      const savedTheme = localStorage.getItem('tv_theme');
      if (savedTheme === 'light') {
        tvView.classList.add('tv-theme-light');
        const icon = document.getElementById('tv-theme-icon');
        const lbl = document.getElementById('tv-theme-label');
        if (icon) icon.textContent = '☀️';
        if (lbl) lbl.textContent = 'Día';
      }

      btnThemeTv.addEventListener('click', () => {
        const isLight = tvView.classList.toggle('tv-theme-light');
        localStorage.setItem('tv_theme', isLight ? 'light' : 'dark');
        const icon = document.getElementById('tv-theme-icon');
        const lbl = document.getElementById('tv-theme-label');
        if (icon) icon.textContent = isLight ? '☀️' : '🌙';
        if (lbl) lbl.textContent = isLight ? 'Día' : 'Noche';
      });
    }

    if (btnAutoscrollTv) {
      btnAutoscrollTv.addEventListener('click', () => {
        tvIsAutoscrolling = !tvIsAutoscrolling;
        btnAutoscrollTv.classList.toggle('active', tvIsAutoscrolling);
        const icon = document.getElementById('tv-autoscroll-icon');
        if (icon) icon.textContent = tvIsAutoscrolling ? '⏸' : '▶';
        window.showToast(tvIsAutoscrolling ? "Auto-scroll activado" : "Auto-scroll pausado", "info", 1500);
      });
    }

    // Pausar auto-scroll si el usuario interactúa manualmente
    if (tvView) {
      tvView.addEventListener('wheel', () => {
        tvIsAutoscrolling = false;
        if (btnAutoscrollTv) btnAutoscrollTv.classList.remove('active');
        clearTimeout(tvUserInteractedTimer);
        tvUserInteractedTimer = setTimeout(() => {
          tvIsAutoscrolling = true;
          if (btnAutoscrollTv) btnAutoscrollTv.classList.add('active');
        }, 8000);
      }, { passive: true });
    }

    // Atajos de teclado: Esc para salir, T para alternar TV
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && tvView && tvView.style.display !== 'none') {
        closeTvMode();
      } else if ((e.key === 't' || e.key === 'T') && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        if (tvView && tvView.style.display !== 'none') {
          closeTvMode();
        } else {
          openTvMode();
        }
      }
    });

    // Detectar si la página fue abierta directamente con #tv o ?mode=tv
    if (window.location.hash === '#tv' || window.location.search.includes('mode=tv') || window.location.search.includes('tv=1')) {
      setTimeout(openTvMode, 300);
    }
  }

  initTvMode();

})();


