const API = '/api';
const TOKEN_KEY = 'hmm_admin_token';

let state = {
  user: null,
  orders: [],
  users: [],
  services: [],
  pricing: null,
  selectedOrderId: null,
  selectedUserUid: null,
  notifications: [],
  unreadCount: 0,
  pollTimer: null,
};

let suppressNavPush = false;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2500);
}

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    logout();
    throw new Error('Session expired');
  }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  state.user = null;
  clearInterval(state.pollTimer);
  $('#login-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString();
}

function statusBadge(s) {
  return `<span class="badge ${s}">${s}</span>`;
}

function photoImg(url) {
  if (!url) return '';
  const src = url.startsWith('data:') ? url : url;
  return `<img src="${src}" alt="photo" onclick="window.open(this.src)">`;
}

function userName(uid) {
  const u = state.users.find(x => x.uid === uid);
  return u ? (u.name || u.email) : '—';
}

function userLink(uid, label) {
  if (!uid) return esc(label || '—');
  const u = state.users.find(x => x.uid === uid);
  if (!u || u.role === 'admin') return esc(label || u?.name || '—');
  const text = label || u.name || u.email;
  return `<button type="button" class="link-btn" data-user="${uid}">${esc(text)}</button>`;
}

function wireUserLinks(root) {
  (root || document).querySelectorAll('[data-user]').forEach(btn => {
    btn.addEventListener('click', () => openUser(btn.dataset.user));
  });
}

function switchTab(tab) {
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-panel').forEach(p => p.classList.add('hidden'));
  $(`#tab-${tab}`).classList.remove('hidden');
  const activeBtn = [...$$('.nav-btn')].find(b => b.dataset.tab === tab);
  $('#page-title').textContent = activeBtn ? activeBtn.textContent.trim() : tab;
}

function parseNavFromUrl() {
  const p = new URLSearchParams(location.search);
  return {
    tab: p.get('tab') || 'overview',
    orderId: p.get('job') || null,
    userUid: p.get('user') || null,
  };
}

function buildNavUrl(nav) {
  const p = new URLSearchParams();
  if (nav.tab && nav.tab !== 'overview') p.set('tab', nav.tab);
  if (nav.orderId) p.set('job', nav.orderId);
  if (nav.userUid) p.set('user', nav.userUid);
  const qs = p.toString();
  return qs ? `${location.pathname}?${qs}` : location.pathname;
}

function applyNav(nav, { rerender = true } = {}) {
  state.selectedOrderId = nav.orderId || null;
  state.selectedUserUid = nav.userUid || null;
  const tab = nav.tab || 'overview';
  switchTab(tab);

  if (tab === 'jobs') {
    const showDetail = !!nav.orderId;
    $('#jobs-list-panel').classList.toggle('hidden', showDetail);
    $('#job-detail-panel').classList.toggle('hidden', !showDetail);
    if (showDetail && rerender) renderJobDetail();
  } else {
    $('#jobs-list-panel').classList.remove('hidden');
    $('#job-detail-panel').classList.add('hidden');
  }

  if (tab === 'users') {
    const showDetail = !!nav.userUid;
    $('#users-list-panel').classList.toggle('hidden', showDetail);
    $('#user-detail-panel').classList.toggle('hidden', !showDetail);
    if (showDetail && rerender) renderUserDetail();
  } else {
    $('#users-list-panel').classList.remove('hidden');
    $('#user-detail-panel').classList.add('hidden');
  }

  if (tab === 'pricing' && rerender) renderPricing();
}

function pushNav(nav) {
  if (suppressNavPush) return;
  history.pushState(nav, '', buildNavUrl(nav));
}

function replaceNav(nav) {
  history.replaceState(nav, '', buildNavUrl(nav));
}

function navigate(nav) {
  applyNav(nav);
  pushNav(nav);
}

function openUser(uid) {
  navigate({
    tab: 'users',
    orderId: state.selectedOrderId,
    userUid: uid,
  });
}

function taskTemplateOptions() {
  const names = state.services.map(s => s.name).filter(Boolean);
  const opts = names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  return `
    <option value="">— Choose a registered task —</option>
    ${opts}
    <option value="__custom__">✏️ Type custom task…</option>
  `;
}

function appendChecklistRow(title) {
  const list = $('#checklist');
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'checklist-row';
  div.innerHTML = `
    <input type="checkbox" data-field="done">
    <input type="text" value="${esc(title)}" data-field="title">
    <button class="btn btn-ghost" data-action="remove">✕</button>
  `;
  div.querySelector('[data-action=remove]').onclick = () => div.remove();
  list.appendChild(div);
}

function wireChecklistRemoves() {
  $('#checklist').querySelectorAll('[data-action=remove]').forEach(btn => {
    btn.onclick = () => btn.closest('.checklist-row').remove();
  });
}

// ── Auth ────────────────────────────────────────────────────────────

async function login(email, password) {
  const res = await api('POST', '/auth/login', { email, password });
  if (res.user.role !== 'admin') throw new Error('Admin accounts only');
  localStorage.setItem(TOKEN_KEY, res.token);
  state.user = res.user;
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#admin-name').textContent = res.user.name || res.user.email;
  await refreshAll();
  const nav = { tab: 'overview', orderId: null, userUid: null };
  suppressNavPush = true;
  applyNav(nav);
  replaceNav(nav);
  suppressNavPush = false;
  state.pollTimer = setInterval(refreshAll, 10000);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  err.textContent = '';
  try {
    await login($('#email').value.trim(), $('#password').value);
  } catch (ex) {
    err.textContent = ex.message;
  }
});

$('#logout-btn').addEventListener('click', logout);

window.addEventListener('popstate', (e) => {
  suppressNavPush = true;
  applyNav(e.state || parseNavFromUrl());
  suppressNavPush = false;
});

// ── Navigation ──────────────────────────────────────────────────────

$$('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    navigate({
      tab,
      orderId: null,
      userUid: null,
    });
  });
});

// ── Data ────────────────────────────────────────────────────────────

async function refreshAll() {
  const [orders, users, services, pricing] = await Promise.all([
    api('GET', '/orders'),
    api('GET', '/admin/users'),
    api('GET', '/services'),
    api('GET', '/admin/pricing'),
  ]);
  state.orders = orders;
  state.users = users;
  state.services = services;
  state.pricing = pricing;
  renderOverview();
  renderJobsTable();
  renderUsersTable();
  renderServicesTable();
  renderPricing();
  if (state.selectedOrderId) renderJobDetail();
  if (state.selectedUserUid) renderUserDetail();
  await refreshNotifications();
}

async function refreshNotifications() {
  if (!state.user) return;
  try {
    const [items, countRes] = await Promise.all([
      api('GET', '/notifications?limit=30'),
      api('GET', '/notifications/unread-count'),
    ]);
    state.notifications = items;
    state.unreadCount = countRes.count || 0;
    renderNotificationUI();
  } catch { /* ignore poll errors */ }
}

function renderNotificationUI() {
  const badge = $('#notif-count');
  if (state.unreadCount > 0) {
    badge.textContent = state.unreadCount > 99 ? '99+' : state.unreadCount;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  const list = $('#notif-list');
  if (!list) return;
  list.innerHTML = state.notifications.map(n => `
    <div class="notif-item ${n.read ? '' : 'unread'}" data-notif="${n.id}" data-order="${esc(n.orderId || '')}">
      <div class="n-title">${esc(n.title)}</div>
      <div class="n-body">${esc(n.body)}</div>
      <div class="n-time">${fmtDate(n.createdAt)}</div>
    </div>
  `).join('') || '<p class="empty" style="padding:12px">No notifications yet.</p>';

  list.querySelectorAll('[data-notif]').forEach(el => {
    el.addEventListener('click', async () => {
      try {
        await api('PATCH', `/notifications/${el.dataset.notif}/read`);
        if (el.dataset.order) openJob(el.dataset.order);
        await refreshNotifications();
      } catch (ex) { toast(ex.message); }
    });
  });

  const pref = $('#admin-notify-app');
  if (pref && state.user) pref.checked = state.user.notifyApp !== false;
}

$('#notif-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#notif-panel').classList.toggle('hidden');
  refreshNotifications();
});

$('#notif-read-all').addEventListener('click', async (e) => {
  e.stopPropagation();
  try {
    await api('POST', '/notifications/read-all');
    await refreshNotifications();
    toast('All marked read');
  } catch (ex) { toast(ex.message); }
});

$('#admin-notify-app').addEventListener('change', async (e) => {
  try {
    const user = await api('PATCH', '/users/me/profile', { notifyApp: e.target.checked });
    state.user = user;
    toast(e.target.checked ? 'App notifications on' : 'App notifications off');
  } catch (ex) {
    e.target.checked = !e.target.checked;
    toast(ex.message);
  }
});

$('#notif-panel')?.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => $('#notif-panel')?.classList.add('hidden'));

// ── Overview / Stats ────────────────────────────────────────────────

function computeStats() {
  const customers = state.users.filter(u => u.role === 'customer');
  const now = Date.now();
  const monthAgo = now - 30 * 86400000;
  const active = customers.filter(u => u.subscriptionStatus === 'active');
  const cancelled = customers.filter(u => u.subscriptionStatus === 'cancelled');
  const newMembers = customers.filter(u => u.createdAt && new Date(u.createdAt).getTime() >= monthAgo);
  const openJobs = state.orders.filter(o => !['completed', 'cancelled'].includes(o.status));
  const pendingJobs = state.orders.filter(o => o.status === 'pendingConfirmation');
  const workers = state.users.filter(u => u.role === 'worker');
  const recentJoins = [...customers]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 8);
  const recentCancelled = [...cancelled]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 8);
  return { customers, active, cancelled, newMembers, openJobs, pendingJobs, workers, recentJoins, recentCancelled };
}

function renderOverview() {
  const s = computeStats();
  const joinRows = s.recentJoins.map(u => `
    <tr>
      <td>${userLink(u.uid, u.name || '—')}</td>
      <td>${esc(u.region || '—')}</td>
      <td>${u.subscriptionPlan === 'annual' ? 'Annual' : 'Monthly'}</td>
      <td class="sub-active">active</td>
      <td>${fmtDate(u.createdAt)}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="empty">No recent signups.</td></tr>';

  const cancelRows = s.recentCancelled.map(u => `
    <tr>
      <td>${userLink(u.uid, u.name || '—')}</td>
      <td>${esc(u.region || '—')}</td>
      <td>${u.subscriptionPlan === 'annual' ? 'Annual' : 'Monthly'}</td>
      <td class="sub-cancelled">cancelled</td>
      <td>${fmtDate(u.createdAt)}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="empty">No cancellations yet.</td></tr>';

  $('#overview-content').innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="num">${s.customers.length}</div><div class="lbl">Total Customers</div></div>
      <div class="stat-card"><div class="num">${s.active.length}</div><div class="lbl">Active Subscriptions</div></div>
      <div class="stat-card"><div class="num">${s.cancelled.length}</div><div class="lbl">Cancelled</div></div>
      <div class="stat-card"><div class="num">${s.newMembers.length}</div><div class="lbl">New (Last 30 Days)</div></div>
      <div class="stat-card"><div class="num">${s.openJobs.length}</div><div class="lbl">Open Jobs</div></div>
      <div class="stat-card"><div class="num">${s.pendingJobs.length}</div><div class="lbl">Awaiting Confirm</div></div>
      <div class="stat-card"><div class="num">${s.workers.length}</div><div class="lbl">Workers</div></div>
    </div>
    <div class="overview-cols">
      <div class="card">
        <h3>Recent Signups</h3>
        <table>
          <thead><tr><th>Name</th><th>Region</th><th>Plan</th><th>Status</th><th>Joined</th></tr></thead>
          <tbody>${joinRows}</tbody>
        </table>
      </div>
      <div class="card">
        <h3>Cancelled Subscriptions</h3>
        <table>
          <thead><tr><th>Name</th><th>Region</th><th>Plan</th><th>Status</th><th>Since</th></tr></thead>
          <tbody>${cancelRows}</tbody>
        </table>
      </div>
    </div>
  `;
  wireUserLinks($('#overview-content'));
}

// ── Jobs ────────────────────────────────────────────────────────────

function collectRegions() {
  const set = new Set();
  state.orders.forEach(o => { if (o.region) set.add(o.region); });
  state.users.filter(u => u.role === 'customer').forEach(u => { if (u.region) set.add(u.region); });
  return [...set].sort((a, b) => a.localeCompare(b));
}

function renderRegionFilter() {
  const sel = $('#job-region-filter');
  if (!sel) return;
  const prev = sel.value;
  const regions = collectRegions();
  sel.innerHTML = '<option value="all">All regions</option>'
    + regions.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
  if (prev && (prev === 'all' || regions.includes(prev))) sel.value = prev;
}

function renderJobsTable() {
  renderRegionFilter();
  const filter = $('#job-filter').value;
  const regionFilter = $('#job-region-filter')?.value || 'all';
  const q = ($('#job-search').value || '').toLowerCase();
  let rows = state.orders;
  if (filter !== 'all') rows = rows.filter(o => o.status === filter);
  if (regionFilter !== 'all') rows = rows.filter(o => o.region === regionFilter);
  if (q) rows = rows.filter(o =>
    (o.region || '').toLowerCase().includes(q) ||
    (o.unitNumber || '').toLowerCase().includes(q) ||
    (o.customerNote || '').toLowerCase().includes(q)
  );

  const tbody = $('#jobs-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">No jobs found.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(o => `
    <tr>
      <td><strong>${esc(o.region || '—')}</strong></td>
      <td><button class="link-btn" data-id="${o.id}">${esc(o.unitNumber ? `Unit ${o.unitNumber}` : 'View')}</button></td>
      <td>${o.status === 'pendingConfirmation' ? 'Awaiting confirm' : fmtDate(o.scheduledDate)}</td>
      <td>${statusBadge(o.status)}</td>
      <td>${userLink(o.assignedWorkerUID, userName(o.assignedWorkerUID))}</td>
      <td>${(o.requestedServices || []).join(', ') || '—'}</td>
      <td>$${o.estimatedPrice || 0}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.link-btn[data-id]').forEach(btn => {
    btn.addEventListener('click', () => openJob(btn.dataset.id));
  });
  wireUserLinks(tbody);
}

function openJob(id) {
  navigate({
    tab: 'jobs',
    orderId: id,
    userUid: state.selectedUserUid,
  });
}

$('#back-jobs').addEventListener('click', () => history.back());

function renderJobDetail() {
  const o = state.orders.find(x => x.id === state.selectedOrderId);
  const el = $('#job-detail');
  if (!o) { el.innerHTML = '<p class="empty">Job not found.</p>'; return; }

  const workers = state.users.filter(u => u.role === 'worker');
  const workerOpts = workers.map(w =>
    `<option value="${w.uid}" ${o.assignedWorkerUID === w.uid ? 'selected' : ''}>${w.name || w.email}</option>`
  ).join('');

  const checklist = (o.checklistItems || []).map((item, i) => `
    <div class="checklist-row" data-idx="${i}">
      <input type="checkbox" ${item.isCompleted ? 'checked' : ''} data-field="done">
      <input type="text" value="${esc(item.title)}" data-field="title">
      <button class="btn btn-ghost" data-action="remove">✕</button>
    </div>
  `).join('');

  const preferredDates = (o.preferredDates || []).map(d => `<li>${fmtDate(d)}</li>`).join('')
    || (o.scheduledDate ? `<li>${fmtDate(o.scheduledDate)}</li>` : '<li class="empty">None</li>');
  const isPending = o.status === 'pendingConfirmation';

  const workerNotes = (o.workerNotes || []).map(n => `
    <div class="note-block">
      <div class="note-meta">${fmtDate(n.createdAt)} · Worker</div>
      ${esc(n.text)}
    </div>
  `).join('') || (o.workerNote ? `<div class="note-block">${esc(o.workerNote)}</div>` : '<p class="empty">No worker notes.</p>');

  el.innerHTML = `
    <div class="toolbar">
      <span>${statusBadge(o.status)}</span>
    </div>
    <div class="detail-grid">
      <div>
        <div class="card">
          <h3>Job Info</h3>
          <p><strong>Region:</strong> ${esc(o.region || '—')}</p>
          <p><strong>Unit:</strong> ${esc(o.unitNumber)}</p>
          <p><strong>Address:</strong> ${esc(o.address)}</p>
          <p><strong>Scheduled:</strong> ${isPending ? '— (not confirmed)' : fmtDate(o.scheduledDate)}</p>
          ${o.confirmedAt ? `<p><strong>Confirmed:</strong> ${fmtDate(o.confirmedAt)}</p>` : ''}
          ${o.redoFromOrderId ? `<p><strong>Redo from job:</strong> ${esc(o.redoFromOrderId)}</p>` : ''}
          <p><strong>Customer:</strong> ${userLink(o.customerUID, userName(o.customerUID))}</p>
          <p><strong>Services:</strong> ${(o.requestedServices || []).join(', ') || '—'}</p>
          <p><strong>Price:</strong> $${o.estimatedPrice || 0}</p>
          <div class="card" style="margin-top:12px;padding:12px;background:#111">
            <strong>Customer Preferred Dates</strong>
            <ul style="margin:8px 0 0;padding-left:18px;color:var(--muted)">${preferredDates}</ul>
          </div>
          ${isPending ? `
          <div class="field" style="margin-top:12px">
            <label>Confirm Visit Date</label>
            <input type="datetime-local" id="f-confirm-date" value="${toLocalInput(o.scheduledDate)}">
          </div>
          <button type="button" class="btn btn-primary" id="confirm-schedule" style="margin-top:8px">Confirm Schedule & Notify Customer</button>
          ` : ''}
          <div class="field" style="margin-top:12px">
            <label>Assign Worker</label>
            <select id="f-worker"><option value="">— Unassigned —</option>${workerOpts}</select>
          </div>
          <div class="field">
            <label>Status</label>
            <select id="f-status">
              ${['pendingConfirmation','scheduled','inProgress','paused','needsRevisit','completed','cancelled'].map(s =>
                `<option value="${s}" ${o.status===s?'selected':''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Scheduled Date</label>
            <input type="datetime-local" id="f-date" value="${toLocalInput(o.scheduledDate)}">
          </div>
        </div>
        <div class="card">
          <h3>Admin Note (private)</h3>
          <textarea id="f-admin-note" rows="4">${esc(o.adminNote || '')}</textarea>
        </div>
        <div class="card">
          <h3>Checklist</h3>
          <div id="checklist">${checklist || '<p class="empty">No tasks yet.</p>'}</div>
          <div class="add-task-box">
            <label>Add Task</label>
            <div class="add-task-row">
              <select id="task-pick">${taskTemplateOptions()}</select>
              <input id="task-custom" type="text" class="hidden" placeholder="Type custom task…">
              <button type="button" class="btn btn-ghost" id="confirm-add-task">+ Add</button>
            </div>
          </div>
        </div>
        <div class="actions">
          <button class="btn btn-primary" id="save-job">Save Changes</button>
          <button class="btn btn-danger" id="delete-job">Delete Job</button>
        </div>
      </div>
      <div>
        <div class="card">
          <h3>Customer Note</h3>
          <div class="note-block">${esc(o.customerNote) || '<span class="empty">—</span>'}</div>
        </div>
        <div class="card">
          <h3>Worker Notes</h3>
          ${workerNotes}
        </div>
        <div class="card">
          <h3>Customer Photos (${(o.customerPhotos||[]).length})</h3>
          <div class="photos">${(o.customerPhotos||[]).map(photoImg).join('') || '<p class="empty">None</p>'}</div>
        </div>
        <div class="card">
          <h3>Worker Photos (${(o.workerPhotos||[]).length})</h3>
          <div class="photos">${(o.workerPhotos||[]).map(photoImg).join('') || '<p class="empty">None</p>'}</div>
        </div>
        ${o.workTimeLog?.length ? `<div class="card"><h3>Work Time</h3>${o.workTimeLog.map(e =>
          `<div class="note-meta">${e.event} · ${fmtDate(e.timestamp)}</div>`).join('')}</div>` : ''}
      </div>
    </div>
  `;

  wireChecklistRemoves();

  const taskPick = $('#task-pick');
  const taskCustom = $('#task-custom');
  taskPick.addEventListener('change', () => {
    const custom = taskPick.value === '__custom__';
    taskCustom.classList.toggle('hidden', !custom);
    if (custom) taskCustom.focus();
    else taskCustom.value = '';
  });
  $('#confirm-add-task').addEventListener('click', () => {
    let title = '';
    if (taskPick.value === '__custom__') {
      title = taskCustom.value.trim();
      if (!title) { toast('Enter a custom task title'); return; }
    } else if (taskPick.value) {
      title = taskPick.value;
    } else {
      toast('Choose a task or type custom');
      return;
    }
    const existing = getChecklist().some(i => i.title.toLowerCase() === title.toLowerCase());
    if (existing) { toast('Task already on checklist'); return; }
    appendChecklistRow(title);
    taskPick.value = '';
    taskCustom.value = '';
    taskCustom.classList.add('hidden');
    toast('Task added — click Save Changes');
  });

  wireUserLinks(el);

  const confirmBtn = $('#confirm-schedule');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      try {
        const dateVal = $('#f-confirm-date').value;
        if (!dateVal) { toast('Pick a date to confirm'); return; }
        await api('POST', `/admin/orders/${o.id}/confirm-schedule`, {
          scheduledDate: new Date(dateVal).toISOString(),
        });
        await refreshAll();
        toast('Visit confirmed — customer notified');
      } catch (ex) { toast(ex.message); }
    });
  }

  $('#save-job').addEventListener('click', () => saveJob(o.id));
  $('#delete-job').addEventListener('click', () => deleteJob(o.id));
}

function getChecklist() {
  return [...$('#checklist').querySelectorAll('.checklist-row')].map((row, i) => ({
    id: `item-${i}`,
    title: row.querySelector('[data-field=title]').value.trim(),
    isCompleted: row.querySelector('[data-field=done]').checked,
  })).filter(x => x.title);
}

async function saveJob(id) {
  try {
    const body = {
      assignedWorkerUID: $('#f-worker').value || '',
      status: $('#f-status').value,
      scheduledDate: new Date($('#f-date').value).toISOString(),
      adminNote: $('#f-admin-note').value,
      checklistItems: getChecklist(),
    };
    await api('PATCH', `/orders/${id}`, body);
    await refreshAll();
    toast('Job saved');
  } catch (ex) { toast(ex.message); }
}

async function deleteJob(id) {
  if (!confirm('Delete this job permanently?')) return;
  try {
    await api('DELETE', `/orders/${id}`);
    await refreshAll();
    toast('Job deleted');
    history.back();
  } catch (ex) { toast(ex.message); }
}

$('#job-filter').addEventListener('change', renderJobsTable);
$('#job-region-filter').addEventListener('change', renderJobsTable);
$('#job-search').addEventListener('input', renderJobsTable);

// ── Users ───────────────────────────────────────────────────────────

function renderUsersTable() {
  const role = $('#user-filter').value;
  let rows = state.users;
  if (role !== 'all') rows = rows.filter(u => u.role === role);
  const tbody = $('#users-tbody');
  tbody.innerHTML = rows.map(u => {
    const subClass = u.subscriptionStatus === 'cancelled' ? 'sub-cancelled'
      : u.subscriptionStatus === 'active' ? 'sub-active' : '';
    const plan = u.role === 'customer'
      ? (u.subscriptionPlan === 'annual' ? 'Annual' : 'Monthly')
      : '—';
    const locked = u.role === 'customer'
      ? `$${u.planAmount ?? (u.subscriptionPlan === 'annual' ? u.lockedAnnualPrice : u.lockedMonthlyPrice) ?? '—'}`
      : '—';
    const alerts = u.notifyApp !== false ? '🔔' : '🔕';
    return `
    <tr>
      <td>${u.role === 'admin' ? esc(u.name || '—') : userLink(u.uid, u.name || '—')}</td>
      <td>${esc(u.email)}</td>
      <td>${u.role}</td>
      <td>${esc(u.region || '—')}</td>
      <td>${plan}</td>
      <td>${locked}</td>
      <td>${alerts}</td>
      <td class="${subClass}">${u.subscriptionStatus || '—'}</td>
      <td>${fmtDate(u.createdAt)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="empty">No users.</td></tr>';
  wireUserLinks(tbody);
}

$('#user-filter').addEventListener('change', renderUsersTable);

$('#back-users').addEventListener('click', () => history.back());

function planLabel(plan) {
  if (plan === 'signup_fee') return 'Signup Fee';
  if (plan === 'annual') return 'Annual';
  if (plan === 'monthly') return 'Monthly';
  return plan || '—';
}

async function renderUserDetail() {
  const el = $('#user-detail');
  const uid = state.selectedUserUid;
  if (!uid) return;
  el.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const data = await api('GET', `/admin/users/${uid}/history`);
    const u = data.user;
    const orders = data.orders || [];
    const payments = data.payments || [];

    const subClass = u.subscriptionStatus === 'cancelled' ? 'sub-cancelled'
      : u.subscriptionStatus === 'active' ? 'sub-active' : '';

    let profileExtra = '';
    if (u.role === 'customer') {
      profileExtra = `
        <p><strong>Region:</strong> ${esc(u.region || '—')}</p>
        <p><strong>Unit:</strong> ${esc(u.unitNumber || '—')}</p>
        <p><strong>Address:</strong> ${esc(u.address || '—')}</p>
        <p><strong>Phone:</strong> ${esc(u.phoneNumber || '—')}</p>
        <p><strong>Plan:</strong> ${u.subscriptionPlan === 'annual' ? 'Annual' : 'Monthly'}</p>
        <p><strong>Locked Rate:</strong> $${u.planAmount ?? u.lockedMonthlyPrice ?? '—'}</p>
        <p><strong>Subscription:</strong> <span class="${subClass}">${u.subscriptionStatus || '—'}</span></p>
        <p><strong>Renewal:</strong> ${fmtDate(u.renewalDate)}</p>
        <p><strong>Signup Fee:</strong> ${u.signupFeePaid ? `$${u.signupFeeAmount ?? 0} paid` : '—'}</p>
        <p><strong>Card:</strong> ${u.cardBrand && u.cardLast4 ? `${u.cardBrand} •••• ${u.cardLast4}` : '—'}</p>
        <p><strong>App alerts:</strong> ${u.notifyApp !== false ? 'On' : 'Off'}</p>
      `;
    }

    const orderRows = orders.map(o => `
      <tr>
        <td>${esc(o.region || '—')}</td>
        <td><button class="link-btn" data-id="${o.id}">${esc(o.unitNumber ? `Unit ${o.unitNumber}` : 'View')}</button></td>
        <td>${fmtDate(o.scheduledDate)}</td>
        <td>${statusBadge(o.status)}</td>
        <td>${(o.requestedServices || []).join(', ') || '—'}</td>
        <td>$${o.estimatedPrice || 0}</td>
        <td>${u.role === 'customer' ? userLink(o.assignedWorkerUID, userName(o.assignedWorkerUID)) : userLink(o.customerUID, userName(o.customerUID))}</td>
        <td>${o.completedAt ? fmtDate(o.completedAt) : '—'}</td>
      </tr>
    `).join('') || `<tr><td colspan="8" class="empty">No ${u.role === 'worker' ? 'jobs assigned' : 'service requests'} yet.</td></tr>`;

    const paymentRows = payments.map(p => `
      <tr>
        <td>${fmtDate(p.date)}</td>
        <td>$${p.amount ?? 0}</td>
        <td>${planLabel(p.plan)}</td>
        <td class="${p.status === 'paid' ? 'sub-active' : ''}">${p.status || '—'}</td>
        <td>${esc(p.note || '—')}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" class="empty">No payments yet.</td></tr>';

    const orderTitle = u.role === 'worker' ? 'Job History' : 'Service Requests';
    const orderHeaders = u.role === 'worker'
      ? '<th>Region</th><th>Unit</th><th>Scheduled</th><th>Status</th><th>Services</th><th>Price</th><th>Customer</th><th>Completed</th>'
      : '<th>Region</th><th>Unit</th><th>Scheduled</th><th>Status</th><th>Services</th><th>Price</th><th>Worker</th><th>Completed</th>';

    el.innerHTML = `
      <div class="card" style="margin-bottom:20px">
        <h3>${esc(u.name || u.email)}</h3>
        <p><strong>Email:</strong> ${esc(u.email)}</p>
        <p><strong>Role:</strong> ${u.role}</p>
        <p><strong>Joined:</strong> ${fmtDate(u.createdAt)}</p>
        ${profileExtra}
        ${u.role === 'customer' ? `
        <form id="admin-user-form" style="margin-top:16px">
          <div class="field"><label>Region / Area</label><input id="u-region" value="${esc(u.region || '')}" placeholder="e.g. Lougheed, Gastown"></div>
          <div class="field"><label>Address (admin only)</label><input id="u-address" value="${esc(u.address || '')}"></div>
          <div class="field"><label>Unit Number</label><input id="u-unit" value="${esc(u.unitNumber || '')}"></div>
          <div class="field"><label>Phone</label><input id="u-phone" value="${esc(u.phoneNumber || '')}"></div>
          <div class="field" style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" id="u-notify-app" ${u.notifyApp !== false ? 'checked' : ''} style="width:auto">
            <label for="u-notify-app" style="margin:0">App notifications</label>
          </div>
          <button type="submit" class="btn btn-primary">Save Customer Info</button>
        </form>
        <p class="empty" style="margin-top:8px">Set region (e.g. Lougheed, Gastown) for job filtering and worker batching. Address is admin-only.</p>
        ` : ''}
      </div>
      <div class="card" style="margin-bottom:20px">
        <h3>${orderTitle} (${orders.length})</h3>
        <table>
          <thead><tr>${orderHeaders}</tr></thead>
          <tbody>${orderRows}</tbody>
        </table>
      </div>
      ${u.role === 'customer' ? `
      <div class="card">
        <h3>Payment History (${payments.length})</h3>
        <table>
          <thead><tr><th>Date</th><th>Amount</th><th>Type</th><th>Status</th><th>Note</th></tr></thead>
          <tbody>${paymentRows}</tbody>
        </table>
      </div>` : ''}
    `;

    el.querySelectorAll('.link-btn[data-id]').forEach(btn => {
      btn.addEventListener('click', () => openJob(btn.dataset.id));
    });
    wireUserLinks(el);

    const userForm = el.querySelector('#admin-user-form');
    if (userForm) {
      userForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('PATCH', `/users/${uid}`, {
            region: $('#u-region').value.trim(),
            address: $('#u-address').value.trim(),
            unitNumber: $('#u-unit').value.trim(),
            phoneNumber: $('#u-phone').value.trim(),
            notifyApp: $('#u-notify-app').checked,
          });
          await refreshAll();
          toast('Customer info saved');
        } catch (ex) { toast(ex.message); }
      });
    }
  } catch (ex) {
    el.innerHTML = `<p class="empty">${esc(ex.message)}</p>`;
  }
}

// ── Services ────────────────────────────────────────────────────────

function renderServicesTable() {
  const tbody = $('#services-tbody');
  tbody.innerHTML = state.services.map(s => `
    <tr>
      <td>${esc(s.name)}</td>
      <td>$${s.price}</td>
      <td>${s.sortOrder ?? 0}</td>
      <td><button class="link-btn" data-del-service="${s.id}">Delete</button></td>
    </tr>
  `).join('') || '<tr><td colspan="4" class="empty">No services.</td></tr>';

  tbody.querySelectorAll('[data-del-service]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this service?')) return;
      try {
        await api('DELETE', `/admin/services/${btn.dataset.delService}`);
        await refreshAll();
        toast('Service deleted');
      } catch (ex) { toast(ex.message); }
    });
  });
}

// ── Pricing ─────────────────────────────────────────────────────────

function renderPricing() {
  const p = state.pricing;
  if (!p) return;
  $('#price-signup').value = p.signupFee ?? 99;
  $('#price-monthly').value = p.monthlyPriceNew ?? 99;
  $('#price-annual').value = p.annualPriceNew ?? 990;

  const customers = state.users.filter(u => u.role === 'customer');
  const tbody = $('#pricing-customers-tbody');
  tbody.innerHTML = customers.map(u => `
    <tr>
      <td>${userLink(u.uid, u.name || '—')}</td>
      <td>${esc(u.region || '—')}</td>
      <td>${u.signupFeePaid ? `$${u.signupFeeAmount ?? 0}` : '—'}</td>
      <td>$${u.lockedMonthlyPrice ?? '—'}/mo</td>
      <td>$${u.lockedAnnualPrice ?? '—'}/yr</td>
      <td>${fmtDate(u.pricingLockedAt || u.createdAt)}</td>
    </tr>
  `).join('') || '<tr><td colspan="6" class="empty">No customers yet.</td></tr>';
  wireUserLinks(tbody);
}

$('#pricing-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await api('PATCH', '/admin/pricing', {
      signupFee: Number($('#price-signup').value),
      monthlyPriceNew: Number($('#price-monthly').value),
      annualPriceNew: Number($('#price-annual').value),
    });
    state.pricing = res;
    renderPricing();
    toast(res.message || 'Pricing saved');
  } catch (ex) { toast(ex.message); }
});

$('#add-service-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/admin/services', {
      name: $('#svc-name').value.trim(),
      price: Number($('#svc-price').value) || 0,
      sortOrder: Number($('#svc-order').value) || 0,
    });
    e.target.reset();
    await refreshAll();
    toast('Service added');
  } catch (ex) { toast(ex.message); }
});

// ── Helpers ─────────────────────────────────────────────────────────

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Boot ────────────────────────────────────────────────────────────

(async function boot() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return;
  try {
    const user = await api('GET', '/auth/me').then(r => r.user);
    if (user.role !== 'admin') { logout(); return; }
    state.user = user;
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    $('#admin-name').textContent = user.name || user.email;
    await refreshAll();
    const nav = parseNavFromUrl();
    suppressNavPush = true;
    applyNav(nav);
    replaceNav(nav);
    suppressNavPush = false;
    state.pollTimer = setInterval(refreshAll, 10000);
  } catch { logout(); }
})();
