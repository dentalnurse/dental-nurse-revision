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
let reflectionWeekOffset = 0;
let reflectionAutoSaveTimer = null;

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

    const assignedIds = studentData.assignedResources || [];
    if (assignedIds.length) {
      const resourceDocs = await Promise.all(assignedIds.map(id => getDoc(doc(db, 'resources', id))));
      allResources = resourceDocs
        .filter(d => d.exists())
        .map(d => ({ id: d.id, ...d.data() }));
    }

    showScreen('app');
    renderResourcesList();
    renderPlanner();
  } catch(e) {
    console.error(e);
    showScreen('error-screen');
  }
}

// ── Tab switching ─────────────────────────────────────────────
window.switchTab = (tab) => {
  ['resources','planner','reflections'].forEach(t => {
    g(`tab-${t}`)?.classList.toggle('hidden', t !== tab);
    g(`tab-${t}-btn`)?.classList.toggle('active', t === tab);
  });
  if (tab === 'reflections') renderReflections();
};

// ── Resources list ────────────────────────────────────────────
function renderResourcesList() {
  const grid  = g('resources-grid');
  showEl('resources-list-view');
  hide('resource-viewer-view');

  if (!allResources.length) {
    grid.innerHTML = '';
    show('resources-empty');
    return;
  }
  hide('resources-empty');

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

  if (resource.type === 'worksheet') {
    renderWorksheet(resource, saved);
  } else if (resource.type === 'canvas') {
    renderCanvas(resource, saved);
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
const DISPLAY_TYPES = ['section', 'instruction', 'image'];

function renderWorksheet(resource, saved) {
  const answers = saved?.answers || {};
  const fields = resource.fields || [{ id: 'notes', label: 'Your notes', type: 'textarea' }];

  g('rv-body').innerHTML = fields.map(f => {
    if (DISPLAY_TYPES.includes(f.type)) {
      return fieldInput(f, '');
    }
    const val = answers[f.id] || '';
    return `<div class="ws-field">
      <label class="ws-label">${esc(f.label)}</label>
      ${fieldInput(f, val)}
    </div>`;
  }).join('');

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
  if (f.type === 'section') {
    return `<div class="ws-section-heading">${esc(f.label)}</div>`;
  }
  if (f.type === 'instruction') {
    return `<div class="ws-instruction">${esc(f.label)}</div>`;
  }
  if (f.type === 'image') {
    return f.label
      ? `<div class="ws-image-wrap"><img src="${f.label}" alt="" class="ws-image" onerror="this.closest('.ws-image-wrap').style.display='none'"></div>`
      : '';
  }
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

// ── Canvas resource ───────────────────────────────────────────
function renderCanvas(resource, saved) {
  const answers = saved?.answers || {};
  const overlays = resource.overlays || [];

  g('rv-body').innerHTML = `
    <div class="canvas-container">
      <img src="${esc(resource.imageUrl || '')}" alt="" class="canvas-bg-img"
           onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<p class=\\'text-sm text-muted\\' style=\\'padding:20px;\\'>Image could not be loaded.</p>')">
      ${overlays.map(o => `
        <textarea class="canvas-overlay-field" data-field="${esc(o.id)}"
          placeholder="${esc(o.label)}"
          style="left:${o.x}%;top:${o.y}%;width:${o.width || 28}%;"
        >${esc(answers[o.id] || '')}</textarea>`).join('')}
    </div>`;

  g('rv-body').querySelectorAll('textarea').forEach(el => el.addEventListener('input', scheduleAutoSave));
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
    if (resource.type === 'worksheet' || resource.type === 'canvas') {
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

// ── Planner (timetable + study plan) ─────────────────────────
const LEARNING_STYLE_DATA = {
  visual: {
    label: 'Visual Learner', icon: '👁️', badge: 'badge-blue',
    hint: 'You learn best through images, diagrams, and colour-coded notes.',
    tips: [
      'Use mind maps to link ideas visually',
      'Colour-code your notes by topic',
      'Draw dental anatomy diagrams from memory',
      'Turn key facts into image flashcards',
      'Use the image-based resources in your workbook first'
    ]
  },
  auditory: {
    label: 'Auditory Learner', icon: '👂', badge: 'badge-rose',
    hint: 'You learn best by listening, speaking, and discussing ideas.',
    tips: [
      'Read your notes aloud when revising',
      'Record yourself summarising each topic, then play it back',
      'Explain topics to a friend or family member',
      'Create rhymes or mnemonics for drug names and lists',
      'Use written resources as prompts to speak your answers aloud'
    ]
  },
  reading: {
    label: 'Reading/Writing Learner', icon: '✍️', badge: 'badge-neutral',
    hint: 'You learn best through reading, writing, and making detailed notes.',
    tips: [
      'Rewrite key points in your own words after each topic',
      'Create bullet-point summaries and glossaries',
      'Write out definitions and key terms repeatedly',
      'Summarise each lecture topic as a short paragraph',
      'Make written lists and checklists to organise information'
    ]
  },
  kinesthetic: {
    label: 'Kinesthetic Learner', icon: '🤲', badge: 'badge-rose',
    hint: 'You learn best through doing, practising, and hands-on activities.',
    tips: [
      'Use physical or digital flashcards you can actively sort and test yourself with',
      'Study in short focused bursts — 25 minutes on, 5 minutes break',
      'Practise clinical scenarios in your head as if you\'re in the dental chair',
      'Write notes by hand rather than typing',
      'Test yourself constantly — don\'t just re-read notes'
    ]
  }
};

function renderPlanner() {
  const content = g('planner-content');
  const empty   = g('planner-empty');
  if (!content) return;

  const timetable = studentData?.timetable || [];
  const quiz      = studentData?.quizResults || [];
  const ls        = LEARNING_STYLE_DATA[studentData?.learningStyle];
  const lifestyle = studentData?.lifestyle || {};

  const hasTimetable = timetable.length > 0;
  const hasPlan = quiz.length || ls || lifestyle.hoursPerWeek;

  if (!hasTimetable && !hasPlan) {
    content.innerHTML = '';
    show('planner-empty');
    return;
  }
  hide('planner-empty');

  const sections = [];

  // Timetable section
  if (hasTimetable) {
    const byDay = {};
    timetable.forEach(e => {
      if (!byDay[e.day]) byDay[e.day] = [];
      byDay[e.day].push(e);
    });
    const orderedDays = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
      .filter(d => byDay[d]);

    const dayHTML = orderedDays.map(day => {
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

    sections.push(`<div class="plan-section">
      <h3 class="plan-section-title">📅 Your Revision Timetable</h3>
      <div class="timetable-view">${dayHTML}</div>
    </div>`);
  }

  // Learning style section
  if (ls) {
    sections.push(`<div class="plan-section">
      <h3 class="plan-section-title">${ls.icon} Your Learning Style</h3>
      <span class="badge ${ls.badge}" style="margin-bottom:10px;display:inline-block;">${ls.label}</span>
      <p class="ls-hint">${ls.hint}</p>
      <ul class="ls-tips">${ls.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
    </div>`);
  }

  // Topics section
  if (quiz.length) {
    const notDone = quiz.filter(r => !r.completed);
    const weak    = quiz.filter(r => r.completed && r.score < 90).sort((a,b) => a.score - b.score);
    const strong  = quiz.filter(r => r.completed && r.score >= 90);

    sections.push(`<div class="plan-section">
      <h3 class="plan-section-title">🎯 Topics to Focus On</h3>
      ${notDone.length ? `<div class="plan-topic-group">
        <span class="plan-group-label plan-group-missing">Not yet completed</span>
        ${notDone.map(topicRowHTML).join('')}
      </div>` : ''}
      ${weak.length ? `<div class="plan-topic-group">
        <span class="plan-group-label plan-group-weak">Needs more revision</span>
        ${weak.map(topicRowHTML).join('')}
      </div>` : ''}
      ${!notDone.length && !weak.length ? `<p class="plan-all-good">All topics completed at 90% or above — great work! Keep revisiting to maintain those scores.</p>` : ''}
      ${strong.length ? `<details class="plan-details">
        <summary>Topics at 90%+ (${strong.length})</summary>
        <div class="plan-topic-group" style="margin-top:10px;">${strong.map(topicRowHTML).join('')}</div>
      </details>` : ''}
    </div>`);
  }

  // Suggested schedule
  if (lifestyle.hoursPerWeek) {
    sections.push(generateScheduleHTML(lifestyle, quiz));
  }

  // Resources quick-links
  if (allResources.length) {
    sections.push(`<div class="plan-section">
      <h3 class="plan-section-title">📚 Your Resources</h3>
      <p class="text-sm text-muted mb-4">Open these from the Resources tab to get started.</p>
      ${allResources.map(r => `
        <div class="plan-resource-item" onclick="switchTab('resources');setTimeout(()=>openResource('${r.id}'),50)">
          <div class="pri-info">
            <span class="badge ${typeIcon(r.type).badge}">${capitalize(r.type)}</span>
            <span class="pri-title">${esc(r.title)}</span>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </div>`).join('')}
    </div>`);
  }

  content.innerHTML = sections.join('');
}

function topicRowHTML(r) {
  const cls  = !r.completed ? 'topic-score-missing' : r.score < 70 ? 'topic-score-low' : r.score < 90 ? 'topic-score-mid' : 'topic-score-good';
  const text = !r.completed ? 'Not done' : `${r.score}%`;
  return `<div class="topic-row">
    <span class="topic-name">${esc(r.topic)}</span>
    <span class="topic-score ${cls}">${text}</span>
  </div>`;
}

function generateScheduleHTML(lifestyle, quiz) {
  const hours    = lifestyle.hoursPerWeek || 5;
  const time     = lifestyle.bestTime || 'both';
  const stress   = parseInt(lifestyle.stressLevel) || 3;
  const sessions = hours <= 3 ? 2 : hours <= 7 ? 3 : hours <= 12 ? 4 : 5;
  const length   = stress >= 4 ? '20–25 min' : hours <= 5 ? '30 min' : '45 min';
  const timeLabel = time === 'morning' ? 'Morning sessions work best for you' : time === 'evening' ? 'Evening sessions work best for you' : 'Flexible — morning or evening';

  const priority = quiz.filter(r => !r.completed || r.score < 90).sort((a,b) => (a.score??-1) - (b.score??-1));
  const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
  const rows = priority.length
    ? priority.slice(0, sessions).map((t,i) => `
        <div class="schedule-row">
          <span class="schedule-day">${DAYS[i % 5]}</span>
          <span class="schedule-details"><strong>${esc(t.topic)}</strong> <span class="text-sm text-muted">· ${length}</span></span>
        </div>`).join('')
    : '<p class="text-sm text-muted">All topics are above 90% — keep doing regular review sessions to maintain your scores.</p>';

  return `<div class="plan-section">
    <h3 class="plan-section-title">📅 Suggested Weekly Schedule</h3>
    <div class="schedule-meta">
      <span class="schedule-chip">${hours}h/week</span>
      <span class="schedule-chip">${sessions} sessions/week</span>
      <span class="schedule-chip">${length} per session</span>
    </div>
    <p class="text-sm text-muted mb-4">${timeLabel}. Prioritising your lowest-scoring topics first.</p>
    ${rows}
    ${stress >= 4 ? `<div class="plan-wellbeing-tip"><strong>Wellbeing reminder:</strong> Your stress level is high — shorter, more frequent sessions are more effective than long study marathons. Take breaks and be kind to yourself.</div>` : ''}
  </div>`;
}

// ── Reflections ──────────────────────────────────────────────
function getWeekKey(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset * 7);
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const weekNum = Math.ceil(((d - jan4) / 86400000 + jan4.getDay() + 1) / 7);
  return `${d.getFullYear()}W${String(weekNum).padStart(2, '0')}`;
}

function weekLabel(offset) {
  if (offset === 0) return 'This Week';
  if (offset === -1) return 'Last Week';
  if (offset < 0) return `${Math.abs(offset)} weeks ago`;
  return `${offset} week${offset > 1 ? 's' : ''} ahead`;
}

function renderReflections() {
  g('reflection-week-label').textContent = weekLabel(reflectionWeekOffset);
  const nextBtn = g('reflection-next-btn');
  if (nextBtn) nextBtn.disabled = reflectionWeekOffset >= 0;

  ['ref-went-well','ref-challenges','ref-revisit','ref-goals'].forEach(id => {
    const el = g(id);
    if (el) el.oninput = scheduleReflectionAutoSave;
  });

  const wb = g('ref-wellbeing');
  if (wb) {
    wb.querySelectorAll('.rating-btn').forEach(btn => {
      btn.onclick = () => {
        wb.querySelectorAll('.rating-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        scheduleReflectionAutoSave();
      };
    });
  }

  loadReflection();
}

async function loadReflection() {
  const key = getWeekKey(reflectionWeekOffset);
  const statusEl = g('ref-save-status');
  if (statusEl) { statusEl.textContent = 'Loading…'; statusEl.className = 'save-status'; }

  try {
    const snap = await getDoc(doc(db, 'studentWork', `${studentCode}_ref_${key}`));
    const data = snap.exists() ? snap.data() : {};

    const setVal = (id, val) => { const el = g(id); if (el) el.value = val || ''; };
    setVal('ref-went-well', data.wentWell);
    setVal('ref-challenges', data.challenges);
    setVal('ref-revisit', data.revisit);
    setVal('ref-goals', data.goals);

    const wb = g('ref-wellbeing');
    if (wb) {
      wb.querySelectorAll('.rating-btn').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.value === String(data.wellbeing || ''));
      });
    }

    if (snap.exists() && data.savedAt) {
      const d = data.savedAt.toDate();
      if (statusEl) { statusEl.textContent = `✓ Saved ${relativeDate(d)}`; statusEl.className = 'save-status saved'; }
    } else {
      if (statusEl) { statusEl.textContent = 'Not saved yet'; statusEl.className = 'save-status'; }
    }
  } catch(e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Not saved yet';
  }
}

function scheduleReflectionAutoSave() {
  clearTimeout(reflectionAutoSaveTimer);
  const statusEl = g('ref-save-status');
  if (statusEl) { statusEl.textContent = 'Unsaved changes…'; statusEl.className = 'save-status'; }
  reflectionAutoSaveTimer = setTimeout(saveReflection, 3000);
}

window.saveReflection = async () => {
  const key = getWeekKey(reflectionWeekOffset);
  const wellbeingEl = g('ref-wellbeing')?.querySelector('.rating-btn.selected');
  const statusEl = g('ref-save-status');

  const data = {
    savedAt: serverTimestamp(),
    studentCode,
    weekKey: key,
    wentWell:   (g('ref-went-well')?.value || ''),
    challenges: (g('ref-challenges')?.value || ''),
    revisit:    (g('ref-revisit')?.value || ''),
    goals:      (g('ref-goals')?.value || ''),
    wellbeing:  wellbeingEl ? parseInt(wellbeingEl.dataset.value) : null,
  };

  try {
    await setDoc(doc(db, 'studentWork', `${studentCode}_ref_${key}`), data, { merge: true });
    const now = new Date();
    if (statusEl) { statusEl.textContent = `✓ Saved ${relativeDate(now)}`; statusEl.className = 'save-status saved'; }
  } catch(e) {
    console.error(e);
    if (statusEl) { statusEl.textContent = 'Save failed — please try again'; statusEl.className = 'save-status'; }
  }
};

window.changeReflectionWeek = (delta) => {
  const newOffset = reflectionWeekOffset + delta;
  if (newOffset > 0) return;
  reflectionWeekOffset = newOffset;
  clearTimeout(reflectionAutoSaveTimer);
  renderReflections();
};

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
  if (type === 'canvas')    return { badge: 'badge-blue' };
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
