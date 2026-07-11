/* Vigía — kit de emergencia interactivo y plan familiar.
   Página estática sin app.js: todo el estado vive en localStorage,
   nada se envía a ningún servidor. */
'use strict';

const $ = (sel) => document.querySelector(sel);

// ── Checklist del kit de emergencia (72 h, estándar SENAPRED) ────

const KIT_ITEMS = [
  { id: 'agua', label: 'Agua potable (4 litros por persona al día, para 3 días)', perecible: true },
  { id: 'comida', label: 'Alimentos no perecibles para 3 días', perecible: true },
  { id: 'botiquin', label: 'Botiquín básico', perecible: false },
  { id: 'medicamentos', label: 'Medicamentos personales que tomas habitualmente', perecible: true },
  { id: 'radio', label: 'Radio a pilas', perecible: false },
  { id: 'linterna', label: 'Linterna', perecible: false },
  { id: 'pilas', label: 'Pilas de repuesto', perecible: true },
  { id: 'cargador', label: 'Cargador portátil (power bank)', perecible: false },
  { id: 'documentos', label: 'Copias de documentos importantes (cédula, escrituras, seguros) en bolsa hermética', perecible: false },
  { id: 'efectivo', label: 'Dinero en efectivo', perecible: false },
  { id: 'abrigo', label: 'Abrigo o manta', perecible: false },
  { id: 'silbato', label: 'Silbato', perecible: false },
  { id: 'higiene', label: 'Artículos de higiene personal', perecible: false },
  { id: 'mascotas', label: 'Comida y agua para tus mascotas (si corresponde)', perecible: false },
];

const KIT_REVISAR_DIAS = 182; // ~6 meses

function savedKit() {
  try {
    const raw = localStorage.getItem('sinoptica.kit');
    if (raw) {
      const k = JSON.parse(raw);
      if (k && typeof k === 'object' && k.items && typeof k.items === 'object') return k;
    }
  } catch (_) { /* localStorage puede no estar disponible */ }
  return { items: {} };
}

function saveKit(kit) {
  try {
    localStorage.setItem('sinoptica.kit', JSON.stringify(kit));
  } catch (_) { /* localStorage puede no estar disponible */ }
}

function hoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function diasDesde(fechaISO) {
  const [y, m, d] = fechaISO.split('-').map(Number);
  return Math.floor((Date.now() - new Date(y, m - 1, d).getTime()) / 86400000);
}

function pintarKitItem(item, kit) {
  const st = kit.items[item.id] || { ok: false, fecha: null };
  const checkbox = $(`#kit-${item.id}`);
  const fechaEl = $(`[data-fecha-for="${item.id}"]`);
  if (checkbox) checkbox.checked = !!st.ok;
  if (!fechaEl) return;
  if (item.perecible && st.ok && st.fecha) {
    const vencido = diasDesde(st.fecha) > KIT_REVISAR_DIAS;
    fechaEl.textContent = vencido
      ? `revisar (marcado el ${st.fecha})`
      : `marcado el ${st.fecha}`;
    fechaEl.classList.toggle('kit-revisar', vencido);
  } else {
    fechaEl.textContent = '';
    fechaEl.classList.remove('kit-revisar');
  }
}

function pintarKitCounter(kit) {
  const counter = $('#kit-counter');
  if (!counter) return;
  const listos = KIT_ITEMS.filter((it) => kit.items[it.id] && kit.items[it.id].ok).length;
  counter.textContent = `${listos} de ${KIT_ITEMS.length} listos`;
}

function pintarKit() {
  const kit = savedKit();
  KIT_ITEMS.forEach((item) => pintarKitItem(item, kit));
  pintarKitCounter(kit);
}

function setupKit() {
  const lista = $('#kit-list');
  if (!lista) return;
  KIT_ITEMS.forEach((item) => {
    const checkbox = $(`#kit-${item.id}`);
    if (!checkbox) return;
    checkbox.addEventListener('change', () => {
      const kit = savedKit();
      const prev = kit.items[item.id] || {};
      if (checkbox.checked) {
        kit.items[item.id] = { ok: true, fecha: item.perecible ? hoyISO() : (prev.fecha || null) };
      } else {
        kit.items[item.id] = { ok: false, fecha: prev.fecha || null };
      }
      saveKit(kit);
      pintarKit();
    });
  });
  pintarKit();
}

// ── Plan familiar ──────────────────────────────────────────────

function savedPlan() {
  try {
    const raw = localStorage.getItem('sinoptica.plan');
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') return p;
    }
  } catch (_) { /* localStorage puede no estar disponible */ }
  return null;
}

function contactoFila(nombre, telefono) {
  const dd = document.createElement('dd');
  const strong = document.createElement('strong');
  strong.textContent = nombre;
  dd.appendChild(strong);
  if (telefono) {
    dd.appendChild(document.createTextNode(' — '));
    const a = document.createElement('a');
    a.href = `tel:${telefono.replace(/\s+/g, '')}`;
    a.textContent = telefono;
    dd.appendChild(a);
  }
  return dd;
}

function pintarPlan() {
  const plan = savedPlan();
  const resumen = $('#plan-resumen');
  const body = $('#plan-resumen-body');
  if (!resumen || !body) return;
  const tieneContenido = plan && (plan.encuentro || (plan.contactos && plan.contactos.length) || (plan.contactoFuera && plan.contactoFuera.nombre));
  if (!tieneContenido) {
    resumen.hidden = true;
    body.textContent = '';
    return;
  }
  body.textContent = '';
  if (plan.encuentro) {
    const dt = document.createElement('dt');
    dt.textContent = 'Punto de encuentro';
    body.appendChild(dt);
    const dd = document.createElement('dd');
    dd.textContent = plan.encuentro;
    body.appendChild(dd);
  }
  (plan.contactos || []).forEach((c, i) => {
    if (!c.nombre && !c.telefono) return;
    const dt = document.createElement('dt');
    dt.textContent = `Contacto ${i + 1}`;
    body.appendChild(dt);
    body.appendChild(contactoFila(c.nombre || '(sin nombre)', c.telefono));
  });
  if (plan.contactoFuera && (plan.contactoFuera.nombre || plan.contactoFuera.telefono)) {
    const dt = document.createElement('dt');
    dt.textContent = 'Contacto fuera de tu región';
    body.appendChild(dt);
    body.appendChild(contactoFila(plan.contactoFuera.nombre || '(sin nombre)', plan.contactoFuera.telefono));
  }
  resumen.hidden = false;
}

function llenarFormularioDesdeLoQueHay() {
  const plan = savedPlan();
  if (!plan) return;
  if (plan.encuentro) $('#plan-encuentro').value = plan.encuentro;
  (plan.contactos || []).forEach((c, i) => {
    const n = $(`#plan-c${i + 1}-nombre`);
    const t = $(`#plan-c${i + 1}-tel`);
    if (n) n.value = c.nombre || '';
    if (t) t.value = c.telefono || '';
  });
  if (plan.contactoFuera) {
    if ($('#plan-fuera-nombre')) $('#plan-fuera-nombre').value = plan.contactoFuera.nombre || '';
    if ($('#plan-fuera-tel')) $('#plan-fuera-tel').value = plan.contactoFuera.telefono || '';
  }
}

function setupPlan() {
  const form = $('#plan-form');
  const borrar = $('#plan-borrar');
  if (!form) return;
  llenarFormularioDesdeLoQueHay();
  pintarPlan();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const contactos = [1, 2, 3].map((i) => ({
      nombre: ($(`#plan-c${i}-nombre`).value || '').trim(),
      telefono: ($(`#plan-c${i}-tel`).value || '').trim(),
    })).filter((c) => c.nombre || c.telefono);
    const plan = {
      encuentro: ($('#plan-encuentro').value || '').trim(),
      contactos,
      contactoFuera: {
        nombre: ($('#plan-fuera-nombre').value || '').trim(),
        telefono: ($('#plan-fuera-tel').value || '').trim(),
      },
    };
    try {
      localStorage.setItem('sinoptica.plan', JSON.stringify(plan));
    } catch (_) { /* localStorage puede no estar disponible */ }
    pintarPlan();
  });

  if (borrar) {
    borrar.addEventListener('click', () => {
      if (!confirm('¿Borrar el plan familiar guardado en este dispositivo?')) return;
      try {
        localStorage.removeItem('sinoptica.plan');
      } catch (_) { /* localStorage puede no estar disponible */ }
      form.reset();
      pintarPlan();
    });
  }
}

setupKit();
setupPlan();
