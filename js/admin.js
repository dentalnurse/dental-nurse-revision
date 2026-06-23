import { db, auth } from './firebase-config.js';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ── State ──────────────────────────────────────────────────
let currentStudentCode = null;
let allResources = [];
let wsFields = [];        // worksheet fields being built
let currentResourceType = 'worksheet';
let timetableRows = [];   // live timetable rows for editing

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ── Bootstrap ───────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  try {
    if (user) {
      const userDoc = await getDoc(doc(db, 'users', user.uid));
      if (!userDoc.exists() || userDoc.data().role !== 'admin') {
        await signOut(auth);
        showAuthPage('login');
        showLoginError('Access denied. Admin credentials required.');
        return;
      }
      document.getElementById('sidebar-email').textContent = user.email;
      showApp();
      loadDashboard();
    } else {
      try {
        const setupSnap = await getDoc(doc(db, 'config', 'setup'));
        if (!setupSnap.exists() || !setupSnap.data().adminCreated) {
          showAuthPage('setup');
        } else {
          showAuthPage('login');
        }
      } catch {
        // Firestore not yet accessible (rules not published) — show setup form
        showAuthPage('setup');
      }
    }
  } catch (e) {
    console.error('Auth init error:', e);
    showAuthPage('login');
  }
}, error => {
  console.error('Auth error:', error);
  showAuthPage('login');
});

// ── Auth helpers ────────────────────────────────────────────
function showAuthPage(section) {
  hide('loading-screen');
  hide('app');
  show('auth-page');
  if (section === 'setup') {
    show('setup-section'); hide('login-section');
  } else {
    show('login-section'); hide('setup-section');
  }
}

function showApp() {
  hide('loading-screen');
  hide('auth-page');
  show('app');
}

window.showLogin = () => { hide('setup-section'); show('login-section'); };
window.showSetup = () => { hide('login-section'); show('setup-section'); };

window.adminLogin = async () => {
  const email = v('login-email');
  const password = v('login-password');
  if (!email || !password) { showLoginError('Please enter your email and password.'); return; }
  setBtn('login-btn', true, 'Signing in…');
  hide('login-error');
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (e) {
    setBtn('login-btn', false, 'Sign In');
    showLoginError(friendlyAuthError(e.code));
  }
};

window.adminSetup = async () => {
  const email = v('setup-email');
  const pwd   = v('setup-password');
  const conf  = v('setup-confirm');
  hide('setup-error'); hide('setup-success');

  if (!email || !pwd) { showSetupError('Please fill in all fields.'); return; }
  if (pwd.length < 8)  { showSetupError('Password must be at least 8 characters.'); return; }
  if (pwd !== conf)    { showSetupError('Passwords do not match.'); return; }

  // Block if admin already exists
  const setupSnap = await getDoc(doc(db, 'config', 'setup'));
  if (setupSnap.exists() && setupSnap.data().adminCreated) {
    showSetupError('An admin account already exists. Please log in instead.');
    return;
  }

  setBtn('setup-btn', true, 'Creating account…');
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pwd);
    await setDoc(doc(db, 'users', cred.user.uid), { email, role: 'admin', createdAt: serverTimestamp() });
    await setDoc(doc(db, 'config', 'setup'), { adminCreated: true, createdAt: serverTimestamp() });
    // onAuthStateChanged will fire and show the app
  } catch (e) {
    setBtn('setup-btn', false, 'Create Account');
    showSetupError(friendlyAuthError(e.code));
  }
};

window.adminLogout = async () => {
  await signOut(auth);
  window.location.reload();
};

// ── Navigation ──────────────────────────────────────────────
window.showPage = (page) => {
  document.querySelectorAll('.page-section').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

  show(`page-${page}`);
  const navEl = document.getElementById(`nav-${page.split('-')[0]}`);
  if (navEl) navEl.classList.add('active');

  const titles = { dashboard:'Dashboard', students:'Students', 'student-detail':'Student Detail', resources:'Resource Library' };
  document.getElementById('topbar-title').textContent = titles[page] || page;
  document.getElementById('topbar-actions').innerHTML = '';
  closeSidebar();

  if (page === 'dashboard')  loadDashboard();
  if (page === 'students')   loadStudents();
  if (page === 'resources')  loadResources();
};

// Mobile sidebar
window.toggleSidebar = () => {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-backdrop').classList.toggle('visible');
};
window.closeSidebar = () => {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-backdrop').classList.remove('visible');
};

// ── Dashboard ───────────────────────────────────────────────
async function loadDashboard() {
  const [studs, ress] = await Promise.all([
    getDocs(collection(db, 'students')),
    getDocs(collection(db, 'resources'))
  ]);
  document.getElementById('stat-students').textContent = studs.size;
  document.getElementById('stat-resources').textContent = ress.size;

  const list = document.getElementById('dash-student-list');
  const items = studs.docs.slice(0, 5);
  if (!items.length) {
    list.innerHTML = '<p class="text-sm text-muted">No students yet.</p>';
    return;
  }
  list.innerHTML = items.map(s => studentItemHTML(s.data())).join('');
}

// ── Students ────────────────────────────────────────────────
async function loadStudents() {
  const snap = await getDocs(collection(db, 'students'));
  const list = document.getElementById('students-list');
  const empty = document.getElementById('students-empty');
  if (snap.empty) { list.innerHTML = ''; show('students-empty'); return; }
  hide('students-empty');
  list.innerHTML = snap.docs.map(d => studentItemHTML(d.data())).join('');
}

function studentItemHTML(s) {
  return `<div class="item-card clickable" onclick="openStudentDetail('${s.accessCode}')">
    <div class="item-icon item-icon-rose">👩‍🎓</div>
    <div class="item-info">
      <div class="item-name">${esc(s.name)}</div>
      <div class="item-meta">Code: ${s.accessCode}${s.email ? ' · ' + esc(s.email) : ''} · ${(s.assignedResources||[]).length} resource${(s.assignedResources||[]).length===1?'':'s'}</div>
    </div>
    <div class="item-actions">
      <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();copyTextToClipboard('${s.accessCode}','Code copied!')">Copy Code</button>
    </div>
  </div>`;
}

window.openNewStudentModal = () => {
  g('ns-name').value = '';
  g('ns-email').value = '';
  hide('new-student-error');
  openModal('modal-new-student');
};

window.createStudent = async () => {
  const name = v('ns-name');
  const email = v('ns-email');
  if (!name) { showErr('new-student-error', 'Please enter the student\'s name.'); return; }
  setBtn('create-student-btn', true, 'Creating…');

  const code = await generateUniqueCode();
  try {
    await setDoc(doc(db, 'students', code), {
      name, email, accessCode: code,
      assignedResources: [], timetable: [], notes: '',
      createdAt: serverTimestamp()
    });
    closeModal('modal-new-student');
    openStudentDetail(code);
  } catch(e) {
    setBtn('create-student-btn', false, 'Create Student');
    showErr('new-student-error', 'Failed to create student. Please try again.');
    console.error(e);
  }
};

async function generateUniqueCode() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = Array.from({length: 8}, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    const snap = await getDoc(doc(db, 'students', code));
    if (!snap.exists()) return code;
  }
  throw new Error('Could not generate unique code after 10 attempts');
}

// ── Student Detail ──────────────────────────────────────────
window.openStudentDetail = async (code) => {
  currentStudentCode = code;
  showPage('student-detail');
  document.getElementById('topbar-title').textContent = 'Student Detail';

  const snap = await getDoc(doc(db, 'students', code));
  if (!snap.exists()) { showPage('students'); return; }
  const s = snap.data();

  g('detail-name').textContent = s.name;
  g('detail-sub').textContent = s.email ? s.email : 'No email on record';
  g('detail-code').textContent = s.accessCode;
  g('detail-notes').value = s.notes || '';

  const origin = window.location.origin + window.location.pathname.replace('admin.html','');
  const link = `${origin}student.html?code=${s.accessCode}`;
  g('detail-link').textContent = link;

  // Delete button
  g('delete-student-btn').onclick = () => confirmDelete(
    `Delete ${s.name}?`,
    `This will permanently delete ${s.name}'s workbook and cannot be undone.`,
    async () => {
      await deleteDoc(doc(db, 'students', code));
      showPage('students');
    }
  );

  // Load assigned resources
  allResources = await loadAllResources();
  renderAssignedResources(s.assignedResources || []);

  // Load timetable
  timetableRows = [...(s.timetable || [])];
  renderTimetableEditor();
};

window.copyCode = () => copyTextToClipboard(g('detail-code').textContent, 'Access code copied!');
window.copyLink = () => copyTextToClipboard(g('detail-link').textContent, 'Link copied!');

window.saveStudentNotes = async () => {
  await updateDoc(doc(db, 'students', currentStudentCode), { notes: g('detail-notes').value });
  flashMessage('Notes saved!');
};

// ── Assign Resources ────────────────────────────────────────
function renderAssignedResources(assigned) {
  const el = g('assigned-resources-list');
  const noMsg = g('no-resources-msg');
  if (!assigned.length) { el.innerHTML = ''; show('no-resources-msg'); return; }
  hide('no-resources-msg');
  el.innerHTML = assigned.map(rId => {
    const r = allResources.find(x => x.id === rId);
    const name = r ? r.title : rId;
    return `<span class="resource-tag">
      ${esc(name)}
      <button class="remove-btn" onclick="unassignResource('${rId}')" title="Remove">×</button>
    </span>`;
  }).join('');
}

window.openAssignModal = async () => {
  const snap = await getDoc(doc(db, 'students', currentStudentCode));
  const assigned = snap.data().assignedResources || [];
  const list = g('assign-resource-list');
  const available = allResources.filter(r => !assigned.includes(r.id));

  if (!available.length) {
    list.innerHTML = '<p class="text-sm text-muted">All resources are already assigned, or your library is empty.</p>';
    openModal('modal-assign');
    return;
  }

  list.innerHTML = available.map(r => `
    <div class="item-card" style="cursor:pointer;" onclick="assignResource('${r.id}')">
      <div class="item-icon ${typeIcon(r.type).bg}">${typeIcon(r.type).emoji}</div>
      <div class="item-info">
        <div class="item-name">${esc(r.title)}</div>
        <div class="item-meta">${capitalize(r.type)}${r.description ? ' · ' + esc(r.description).slice(0,60) : ''}</div>
      </div>
    </div>`).join('');
  openModal('modal-assign');
};

window.assignResource = async (resourceId) => {
  const snap = await getDoc(doc(db, 'students', currentStudentCode));
  const assigned = snap.data().assignedResources || [];
  if (assigned.includes(resourceId)) return;
  const updated = [...assigned, resourceId];
  await updateDoc(doc(db, 'students', currentStudentCode), { assignedResources: updated });
  renderAssignedResources(updated);
  closeModal('modal-assign');
};

window.unassignResource = async (resourceId) => {
  const snap = await getDoc(doc(db, 'students', currentStudentCode));
  const assigned = (snap.data().assignedResources || []).filter(id => id !== resourceId);
  await updateDoc(doc(db, 'students', currentStudentCode), { assignedResources: assigned });
  renderAssignedResources(assigned);
};

// ── Timetable Editor ─────────────────────────────────────────
function renderTimetableEditor() {
  const el = g('timetable-editor');
  if (!timetableRows.length) {
    el.innerHTML = '<p class="text-sm text-muted mb-4">No entries yet. Click "+ Add Entry" to get started.</p>';
    return;
  }

  const resourceOptions = allResources.map(r =>
    `<option value="${r.id}">${esc(r.title)}</option>`).join('');

  el.innerHTML = timetableRows.map((row, i) => `
    <div class="timetable-entry-row" data-index="${i}">
      <select onchange="updateRow(${i},'day',this.value)">
        ${DAYS.map(d => `<option value="${d}" ${row.day===d?'selected':''}>${d}</option>`).join('')}
      </select>
      <input type="text" placeholder="e.g. Morning / 2pm" value="${esc(row.period||'')}" oninput="updateRow(${i},'period',this.value)">
      <input type="text" placeholder="Topic" value="${esc(row.topic||'')}" oninput="updateRow(${i},'topic',this.value)">
      <select onchange="updateRow(${i},'resourceId',this.value)">
        <option value="">No linked resource</option>
        ${resourceOptions}
      </select>
      <button class="btn btn-ghost btn-icon" onclick="removeTimetableRow(${i})" title="Remove entry">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`).join('');

  // Set resource selects to current values
  timetableRows.forEach((row, i) => {
    const sel = el.querySelectorAll('select[onchange]')[i * 2 + 1];
    if (sel && row.resourceId) sel.value = row.resourceId;
  });
}

window.addTimetableRow = () => {
  timetableRows.push({ day: 'Monday', period: '', topic: '', resourceId: '', notes: '' });
  renderTimetableEditor();
};

window.removeTimetableRow = (i) => {
  timetableRows.splice(i, 1);
  renderTimetableEditor();
};

window.updateRow = (i, field, value) => {
  timetableRows[i][field] = value;
};

window.saveTimetable = async () => {
  await updateDoc(doc(db, 'students', currentStudentCode), { timetable: timetableRows });
  const msg = g('timetable-save-msg');
  msg.textContent = '✓ Saved!';
  show('timetable-save-msg');
  setTimeout(() => hide('timetable-save-msg'), 2500);
};

// ── Resource Library ─────────────────────────────────────────
async function loadAllResources() {
  const snap = await getDocs(collection(db, 'resources'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function loadResources() {
  allResources = await loadAllResources();
  const list = g('resources-list');
  const empty = g('resources-empty');
  if (!allResources.length) { list.innerHTML = ''; show('resources-empty'); return; }
  hide('resources-empty');
  list.innerHTML = allResources.map(r => resourceItemHTML(r)).join('');
}

function resourceItemHTML(r) {
  const ti = typeIcon(r.type);
  return `<div class="item-card">
    <div class="item-icon ${ti.bg}">${ti.emoji}</div>
    <div class="item-info">
      <div class="item-name">${esc(r.title)}</div>
      <div class="item-meta">${capitalize(r.type)}${r.description ? ' · ' + esc(r.description).slice(0,70) : ''}</div>
    </div>
    <div class="item-actions">
      <button class="btn btn-secondary btn-sm" onclick="editResource('${r.id}')">Edit</button>
      <button class="btn btn-ghost btn-icon" onclick="confirmDeleteResource('${r.id}','${esc(r.title)}')" title="Delete">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      </button>
    </div>
  </div>`;
}

window.openNewResourceModal = () => {
  g('r-title').value = '';
  g('r-desc').value = '';
  g('r-link').value = '';
  g('r-editing-id').value = '';
  g('resource-modal-title').textContent = 'New Resource';
  g('save-resource-btn').textContent = 'Save Resource';
  hide('new-resource-error');
  wsFields = [];
  renderWsFields();
  setResourceType('worksheet');
  openModal('modal-new-resource');
};

window.editResource = async (id) => {
  const snap = await getDoc(doc(db, 'resources', id));
  if (!snap.exists()) return;
  const r = snap.data();

  g('r-title').value = r.title;
  g('r-desc').value = r.description || '';
  g('r-editing-id').value = id;
  g('resource-modal-title').textContent = 'Edit Resource';
  g('save-resource-btn').textContent = 'Update Resource';
  hide('new-resource-error');

  setResourceType(r.type);
  wsFields = r.type === 'worksheet' ? [...(r.fields || [])] : [];
  renderWsFields();
  if (r.type === 'link') g('r-link').value = r.linkUrl || '';

  openModal('modal-new-resource');
};

window.setResourceType = (type) => {
  currentResourceType = type;
  ['worksheet','link'].forEach(t => {
    g(`rtype-${t}`).classList.toggle('active', t === type);
    g(`${t}-builder`).classList.toggle('hidden', t !== type);
  });
};

// ── Worksheet field builder ───────────────────────────────────
window.addWorksheetField = () => {
  wsFields.push({ id: `field_${Date.now()}`, label: '', type: 'textarea' });
  renderWsFields();
};

window.removeWsField = (index) => {
  wsFields.splice(index, 1);
  renderWsFields();
};

window.updateWsField = (index, key, value) => {
  wsFields[index][key] = value;
};

function renderWsFields() {
  const el = g('ws-fields-list');
  if (!wsFields.length) {
    el.innerHTML = '<p class="text-sm text-muted mb-4">No questions added yet — students will get a free-write area by default.</p>';
    return;
  }
  el.innerHTML = wsFields.map((f, i) => `
    <div class="field-row">
      <input type="text" placeholder="Question or prompt…" value="${esc(f.label)}" oninput="updateWsField(${i},'label',this.value)">
      <select onchange="updateWsField(${i},'type',this.value)">
        <option value="textarea" ${f.type==='textarea'?'selected':''}>Long answer</option>
        <option value="text" ${f.type==='text'?'selected':''}>Short answer</option>
        <option value="checkbox" ${f.type==='checkbox'?'selected':''}>Checkbox</option>
        <option value="rating" ${f.type==='rating'?'selected':''}>Rating (1–5)</option>
      </select>
      <button class="btn btn-ghost btn-icon" onclick="removeWsField(${i})" title="Remove">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`).join('');
}

// ── Save Resource ────────────────────────────────────────────
window.saveResource = async () => {
  const title = v('r-title');
  const desc  = v('r-desc');
  const editingId = v('r-editing-id');
  if (!title) { showErr('new-resource-error', 'Please enter a title.'); return; }

  setBtn('save-resource-btn', true, 'Saving…');
  hide('new-resource-error');

  try {
    let data = { title, description: desc, type: currentResourceType, updatedAt: serverTimestamp() };

    if (currentResourceType === 'worksheet') {
      data.fields = wsFields.length ? wsFields : [{ id: 'notes', label: 'Your notes', type: 'textarea' }];
    }

    if (currentResourceType === 'link') {
      const link = v('r-link');
      if (!link) { showErr('new-resource-error', 'Please enter a URL.'); setBtn('save-resource-btn', false, 'Save Resource'); return; }
      data.linkUrl = link;
    }

    if (editingId) {
      await updateDoc(doc(db, 'resources', editingId), data);
    } else {
      data.createdAt = serverTimestamp();
      const newRef = doc(collection(db, 'resources'));
      await setDoc(newRef, data);
    }

    closeModal('modal-new-resource');
    loadResources();
  } catch(e) {
    console.error(e);
    showErr('new-resource-error', 'Failed to save resource: ' + e.message);
    setBtn('save-resource-btn', false, editingId ? 'Update Resource' : 'Save Resource');
  }
};

window.confirmDeleteResource = (id, title) => {
  confirmDelete(`Delete "${title}"?`,
    'This will permanently delete this resource. Students who have it assigned will lose access to it.',
    async () => {
      await deleteDoc(doc(db, 'resources', id));
      loadResources();
    }
  );
};

// ── Confirm Dialog ────────────────────────────────────────────
function confirmDelete(title, body, onConfirm) {
  g('confirm-title').textContent = title;
  g('confirm-body').textContent = body;
  g('confirm-ok-btn').onclick = async () => {
    closeModal('modal-confirm');
    await onConfirm();
  };
  openModal('modal-confirm');
}

// ── Utility functions ─────────────────────────────────────────
function show(id)  { g(id)?.classList.remove('hidden'); }
function hide(id)  { g(id)?.classList.add('hidden'); }
function g(id)     { return document.getElementById(id); }
function v(id)     { return (g(id)?.value || '').trim(); }
function esc(str)  { return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

function setBtn(id, disabled, text) {
  const el = g(id);
  if (!el) return;
  el.disabled = disabled;
  el.textContent = text;
}

function showErr(id, msg) { const el = g(id); if (el) { el.textContent = msg; show(id); } }
function showLoginError(msg) { showErr('login-error', msg); setBtn('login-btn', false, 'Sign In'); }
function showSetupError(msg) { showErr('setup-error', msg); setBtn('setup-btn', false, 'Create Account'); }

function openModal(id)  { show(id); document.body.style.overflow = 'hidden'; }
function closeModal(id) { hide(id); document.body.style.overflow = ''; }
window.closeModal = closeModal;

function typeIcon(type) {
  if (type === 'worksheet') return { emoji: '📝', bg: 'item-icon-rose' };
  if (type === 'link')      return { emoji: '🔗', bg: 'item-icon-blue' };
  return { emoji: '📌', bg: 'item-icon-cream' };
}

function copyTextToClipboard(text, msg = 'Copied!') {
  navigator.clipboard?.writeText(text).then(() => flashMessage(msg));
}

function flashMessage(msg) {
  const toast = document.createElement('div');
  toast.textContent = msg;
  Object.assign(toast.style, {
    position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
    background: 'var(--dark)', color: '#fff',
    padding: '10px 20px', borderRadius: '100px',
    fontSize: '0.875rem', fontFamily: 'var(--font-body)',
    zIndex: '9999', boxShadow: 'var(--shadow-lg)',
    animation: 'slideUp 0.25s ease'
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2200);
}

function friendlyAuthError(code) {
  const map = {
    'auth/wrong-password': 'Incorrect password. Please try again.',
    'auth/user-not-found': 'No account found with this email.',
    'auth/invalid-email': 'Please enter a valid email address.',
    'auth/email-already-in-use': 'An account with this email already exists.',
    'auth/weak-password': 'Password must be at least 8 characters.',
    'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
    'auth/invalid-credential': 'Incorrect email or password.',
  };
  return map[code] || 'Something went wrong. Please try again.';
}

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

// Enter key in auth forms
document.getElementById('login-password')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') window.adminLogin();
});
