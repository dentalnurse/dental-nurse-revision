import { db } from './firebase-config.js';
import {
  doc, getDoc, setDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ── State ───────────────────────────────────────────────────
let studentCode = null;
let studentData = null;
let allResources = [];
let currentResourceId = null;
let autoSaveTimer = null;

// ── Bootstrap ────────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
studentCode = (params.get('code') || '').toUpperCase().trim();

if (!studentCode) {
  showScreen('error-screen');
} else {
  loadWorkbook();
}

async function loadWorkbook() {
  try {
    const snap = await getDoc(doc(db, 'students', studentCode));
    if (!snap.exists()) { showScreen('error-screen'); return; }

    studentData = snap.data();
    g('greet-name').textContent = studentData.name || 'Your Workbook';
    g('greet-sub').textContent = 'Welcome back!';

    // Load assigned resources
    const assignedIds = studentData.assignedResources || [];
    if (assignedIds.length) {
      const resourceDocs = await Promise.all(assignedIds.map(id => getDoc(doc(db, 'resources', id))));
      allResources = resourceDocs
        .filter(d => d.exists())
        .map(d => ({ id: d.id, ...d.data() }));
    }

    showScreen('app');
    renderResourcesList();
    renderTimetable();
  } catch(e) {
    console.error(e);
    showScreen('error-screen');
  }
}

// ── Tab switching ─────────────────────────────────────────────
window.switchTab = (tab) => {
  ['resources','timetable'].forEach(t => {
    g(`tab-${t}`)?.classList.toggle('hidden', t !== tab);
    g(`tab-${t}-btn`)?.classList.toggle('active', t === tab);
  });
};

// ── Resources list ────────────────────────────────────────────
function renderResourcesList() {
  const grid  = g('resources-grid');
  const empty = g('resources-empty');
  showEl('resources-list-view');
  hide('resource-viewer-view');

  if (!allResources.length) {
    grid.innerHTML = '';
    show('resources-empty');
    return;
  }
  hide('resources-empty');

  // Load saved work statuses
  Promise.all(allResources.map(r => getDoc(doc(db, 'studentWork', `${studentCode}_${r.id}`))))
    .then(workDocs => {
      grid.innerHTML = allResources.map((r, i) => {
        const hasSaved = workDocs[i]?.exists();
        const savedAt  = hasSaved ? workDocs[i].data().savedAt?.toDate() : null;
        return resourceCardHTML(r, hasSaved, savedAt);
      }).join('');
    });
}

function resourceCardHTML(r, saved, savedAt) {
  const ti = typeIcon(r.type);
  const savedLine = saved
    ? `<span class="rc-saved">✓ Saved ${savedAt ? relativeDate(savedAt) : ''}</span>`
    : `<span class="rc-unsaved">Not started</span>`;

  return `<div class="resource-card" onclick="openResource('${r.id}')">
    <span class="badge ${ti.badge}">${capitalize(r.type)}</span>
    <div class="rc-title">${esc(r.title)}</div>
    ${r.description ? `<div class="rc-desc">${esc(r.description)}</div>` : ''}
    <div class="rc-footer">
      ${savedLine}
      <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openResource('${r.id}')">Open →</button>
    </div>
  </div>`;
}

// ── Open a resource ───────────────────────────────────────────
window.openResource = async (id) => {
  currentResourceId = id;
  const resource = allResources.find(r => r.id === id);
  if (!resource) return;

  hide('resources-list-view');
  show('resource-viewer-view');

  const ti = typeIcon(resource.type);
  g('rv-badge').innerHTML = `<span class="badge ${ti.badge}">${capitalize(resource.type)}</span>`;
  g('rv-title').textContent = resource.title;
  g('rv-desc').textContent = resource.description || '';

  // Load saved work
  const workSnap = await getDoc(doc(db, 'studentWork', `${studentCode}_${id}`));
  const saved = workSnap.exists() ? workSnap.data() : null;

  if (saved) {
    const d = saved.savedAt?.toDate();
    g('save-status').textContent = `Last saved ${d ? relativeDate(d) : ''}`;
    g('save-status').className = 'save-status saved';
  } else {
    g('save-status').textContent = 'Not saved yet';
    g('save-status').className = 'save-status';
  }

  // Render resource body
  if (resource.type === 'worksheet') {
    renderWorksheet(resource, saved);
  } else if (resource.type === 'link') {
    renderLink(resource, saved);
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.backToList = () => {
  clearTimeout(autoSaveTimer);
  currentResourceId = null;
  showEl('resources-list-view');
  hide('resource-viewer-view');
  renderResourcesList();
};

// ── Worksheet ─────────────────────────────────────────────────
function renderWorksheet(resource, saved) {
  const answers = saved?.answers || {};
  const fields = resource.fields || [{ id: 'notes', label: 'Your notes', type: 'textarea' }];

  g('rv-body').innerHTML = fields.map(f => {
    const val = answers[f.id] || '';
    return `<div class="ws-field">
      <label class="ws-label">${esc(f.label)}</label>
      ${fieldInput(f, val)}
    </div>`;
  }).join('');

  // Auto-save on change
  g('rv-body').querySelectorAll('input,textarea').forEach(el => {
    el.addEventListener('input', scheduleAutoSave);
  });
  g('rv-body').querySelectorAll('.rating-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.rating-group');
      group.querySelectorAll('.rating-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      scheduleAutoSave();
    });
  });
  g('rv-body').querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', scheduleAutoSave);
  });
}

function fieldInput(f, val) {
  if (f.type === 'textarea') {
    return `<textarea data-field="${f.id}" rows="4" placeholder="Write your answer here…">${esc(val)}</textarea>`;
  }
  if (f.type === 'text') {
    return `<input type="text" data-field="${f.id}" placeholder="Your answer…" value="${esc(val)}">`;
  }
  if (f.type === 'checkbox') {
    return `<label class="checkbox-wrapper">
      <input type="checkbox" data-field="${f.id}" ${val === 'true' ? 'checked' : ''}>
      <span>Completed</span>
    </label>`;
  }
  if (f.type === 'rating') {
    return `<div class="rating-group">${[1,2,3,4,5].map(n =>
      `<button class="rating-btn ${val===String(n)?'selected':''}" data-field="${f.id}" data-value="${n}">${n}</button>`
    ).join('')}</div>`;
  }
  return '';
}

function collectAnswers() {
  const answers = {};
  const body = g('rv-body');
  body.querySelectorAll('[data-field]').forEach(el => {
    const fid = el.dataset.field;
    if (el.type === 'checkbox') { answers[fid] = String(el.checked); }
    else if (el.classList.contains('rating-btn') && el.classList.contains('selected')) { answers[fid] = el.dataset.value; }
    else if (!el.classList.contains('rating-btn')) { answers[fid] = el.value; }
  });
  return answers;
}

// ── Link resource ─────────────────────────────────────────────
function renderLink(resource, saved) {
  const notes = saved?.notes || '';
  g('rv-body').innerHTML = `
    <div class="link-resource">
      <div class="text-sm" style="color:var(--blue-dark);font-weight:600;">🔗 External Resource</div>
      <div class="link-url">${esc(resource.linkUrl || '')}</div>
      <a href="${resource.linkUrl}" target="_blank" rel="noopener" class="btn btn-blue btn-sm">Open Resource →</a>
    </div>
    <div class="ws-field">
      <label class="ws-label">Your Notes</label>
      <textarea data-field="notes" rows="5" placeholder="Add your notes about this resource…">${esc(notes)}</textarea>
    </div>`;

  g('rv-body').querySelector('textarea')?.addEventListener('input', scheduleAutoSave);
}

// ── Save work ─────────────────────────────────────────────────
function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  g('save-status').textContent = 'Unsaved changes…';
  g('save-status').className = 'save-status';
  autoSaveTimer = setTimeout(saveWork, 3000);
}

window.saveWork = async () => {
  if (!currentResourceId) return;
  const resource = allResources.find(r => r.id === currentResourceId);
  if (!resource) return;

  const btn = g('save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    let workData = { savedAt: serverTimestamp(), studentCode, resourceId: currentResourceId };
    if (resource.type === 'worksheet') {
      workData.answers = collectAnswers();
    } else {
      const ta = g('rv-body').querySelector('[data-field="notes"]');
      workData.notes = ta?.value || '';
    }

    await setDoc(doc(db, 'studentWork', `${studentCode}_${currentResourceId}`), workData, { merge: true });

    const now = new Date();
    g('save-status').textContent = `✓ Saved ${relativeDate(now)}`;
    g('save-status').className = 'save-status saved';
  } catch(e) {
    console.error(e);
    g('save-status').textContent = 'Save failed — please try again';
    g('save-status').className = 'save-status';
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save Work`;
  }
};

// ── Timetable ─────────────────────────────────────────────────
function renderTimetable() {
  const entries = studentData.timetable || [];
  const view  = g('timetable-view');
  const empty = g('timetable-empty');

  if (!entries.length) { view.innerHTML = ''; show('timetable-empty'); return; }
  hide('timetable-empty');

  const byDay = {};
  entries.forEach(e => {
    if (!byDay[e.day]) byDay[e.day] = [];
    byDay[e.day].push(e);
  });

  const orderedDays = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
    .filter(d => byDay[d]);

  view.innerHTML = orderedDays.map(day => {
    const dayEntries = byDay[day];
    return `<div class="day-block">
      <div class="day-header">${day}</div>
      ${dayEntries.map(e => {
        const linkedRes = e.resourceId ? allResources.find(r => r.id === e.resourceId) : null;
        return `<div class="day-entry">
          <div class="entry-time">${esc(e.period || '—')}</div>
          <div class="entry-body">
            <div class="entry-topic">${esc(e.topic || '')}</div>
            ${e.notes ? `<div class="entry-notes">${esc(e.notes)}</div>` : ''}
            ${linkedRes ? `<div class="entry-link"><button class="btn btn-primary btn-sm" onclick="openResource('${linkedRes.id}')">Open: ${esc(linkedRes.title)} →</button></div>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');
}

// ── Utility ──────────────────────────────────────────────────
function showScreen(id) {
  hide('loading-screen');
  hide('error-screen');
  hide('app');
  show(id);
}

function show(id)   { g(id)?.classList.remove('hidden'); }
function hide(id)   { g(id)?.classList.add('hidden'); }
function showEl(id) { g(id)?.classList.remove('hidden'); }
function g(id)      { return document.getElementById(id); }
function esc(str)   { return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

function typeIcon(type) {
  if (type === 'worksheet') return { badge: 'badge-rose' };
  if (type === 'link')      return { badge: 'badge-blue' };
  return { badge: 'badge-neutral' };
}

function relativeDate(date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
