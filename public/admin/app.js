const API = '/api';
const TOKEN_KEY = 'hmm_admin_token';

let state = {
  user: null,
  orders: [],
  users: [],
  services: [],
  pricing: null,
  selectedOrderId: null,
  pollTimer: null,
};

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

// ── Navigation ──────────────────────────────────────────────────────

$$('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $$('.tab-panel').forEach(p => p.classList.add('hidden'));
    $(`#tab-${tab}`).classList.remove('hidden');
    $('#page-title').textContent = btn.textContent.trim();
    if (tab === 'jobs' && state.selectedOrderId) renderJobDetail();
    if (tab === 'pricing') renderPricing();
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
  renderSidebarStats();
  renderOverview();
  renderJobsTable();
  renderUsersTable();
  renderServicesTable();
  renderPricing();
  if (state.selectedOrderId) renderJobDetail();
}

// ── Overview / Stats ────────────────────────────────────────────────

function computeStats() {
  const customers = state.users.filter(u => u.role === 'customer');
  const now = Date.now();
  const monthAgo = now - 30 * 86400000;
  const active = customers.filter(u => u.subscriptionStatus === 'active');
  const cancelled = customers.filter(u => u.subscriptionStatus === 'cancelled');
  const newMembers = customers.filter(u => u.createdAt && new Date(u.createdAt).getTime() >= monthAgo);
  const openJobs = state.orders.filter(o => !['completed', 'cancelled'].includes(o.status));
  const workers = state.users.filter(u => u.role === 'worker');
  const recentJoins = [...customers]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 8);
  const recentCancelled = [...cancelled]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 8);
  return { customers, active, cancelled, newMembers, openJobs, workers, recentJoins, recentCancelled };
}

function renderSidebarStats() {
  const s = computeStats();
  $('#sidebar-stats').innerHTML = `
    <div class="stat-line ok"><span>Active subs</span><strong>${s.active.length}</strong></div>
    <div class="stat-line bad"><span>Cancelled</span><strong>${s.cancelled.length}</strong></div>
    <div class="stat-line warn"><span>New (30d)</span><strong>${s.newMembers.length}</strong></div>
    <div class="stat-line"><span>Open jobs</span><strong>${s.openJobs.length}</strong></div>
    <div class="stat-line"><span>Workers</span><strong>${s.workers.length}</strong></div>
  `;
}

function renderOverview() {
  const s = computeStats();
  const joinRows = s.recentJoins.map(u => `
    <tr>
      <td>${esc(u.name || '—')}</td>
      <td>${esc(u.unitNumber || '—')}</td>
      <td>${u.subscriptionPlan === 'annual' ? 'Annual' : 'Monthly'}</td>
      <td class="sub-active">active</td>
      <td>${fmtDate(u.createdAt)}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="empty">No recent signups.</td></tr>';

  const cancelRows = s.recentCancelled.map(u => `
    <tr>
      <td>${esc(u.name || '—')}</td>
      <td>${esc(u.unitNumber || '—')}</td>
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
      <div class="stat-card"><div class="num">${s.workers.length}</div><div class="lbl">Workers</div></div>
    </div>
    <div class="overview-cols">
      <div class="card">
        <h3>Recent Signups</h3>
        <table>
          <thead><tr><th>Name</th><th>Unit</th><th>Plan</th><th>Status</th><th>Joined</th></tr></thead>
          <tbody>${joinRows}</tbody>
        </table>
      </div>
      <div class="card">
        <h3>Cancelled Subscriptions</h3>
        <table>
          <thead><tr><th>Name</th><th>Unit</th><th>Plan</th><th>Status</th><th>Since</th></tr></thead>
          <tbody>${cancelRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

// ── Jobs ────────────────────────────────────────────────────────────

function renderJobsTable() {
  const filter = $('#job-filter').value;
  const q = ($('#job-search').value || '').toLowerCase();
  let rows = state.orders;
  if (filter !== 'all') rows = rows.filter(o => o.status === filter);
  if (q) rows = rows.filter(o =>
    (o.unitNumber || '').toLowerCase().includes(q) ||
    (o.address || '').toLowerCase().includes(q) ||
    (o.customerNote || '').toLowerCase().includes(q)
  );

  const tbody = $('#jobs-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No jobs found.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(o => `
    <tr>
      <td><button class="link-btn" data-id="${o.id}">Unit ${o.unitNumber || '—'}</button></td>
      <td>${fmtDate(o.scheduledDate)}</td>
      <td>${statusBadge(o.status)}</td>
      <td>${userName(o.assignedWorkerUID)}</td>
      <td>${(o.requestedServices || []).join(', ') || '—'}</td>
      <td>$${o.estimatedPrice || 0}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.link-btn').forEach(btn => {
    btn.addEventListener('click', () => openJob(btn.dataset.id));
  });
}

function openJob(id) {
  state.selectedOrderId = id;
  $('#jobs-list-panel').classList.add('hidden');
  $('#job-detail-panel').classList.remove('hidden');
  renderJobDetail();
}

$('#back-jobs').addEventListener('click', () => {
  state.selectedOrderId = null;
  $('#job-detail-panel').classList.add('hidden');
  $('#jobs-list-panel').classList.remove('hidden');
});

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
          <p><strong>Unit:</strong> ${esc(o.unitNumber)}</p>
          <p><strong>Address:</strong> ${esc(o.address)}</p>
          <p><strong>Scheduled:</strong> ${fmtDate(o.scheduledDate)}</p>
          <p><strong>Customer:</strong> ${userName(o.customerUID)}</p>
          <p><strong>Services:</strong> ${(o.requestedServices || []).join(', ') || '—'}</p>
          <p><strong>Price:</strong> $${o.estimatedPrice || 0}</p>
          <div class="field" style="margin-top:12px">
            <label>Assign Worker</label>
            <select id="f-worker"><option value="">— Unassigned —</option>${workerOpts}</select>
          </div>
          <div class="field">
            <label>Status</label>
            <select id="f-status">
              ${['scheduled','inProgress','paused','needsRevisit','completed','cancelled'].map(s =>
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
    state.selectedOrderId = null;
    $('#job-detail-panel').classList.add('hidden');
    $('#jobs-list-panel').classList.remove('hidden');
    await refreshAll();
    toast('Job deleted');
  } catch (ex) { toast(ex.message); }
}

$('#job-filter').addEventListener('change', renderJobsTable);
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
    return `
    <tr>
      <td>${esc(u.name || '—')}</td>
      <td>${esc(u.email)}</td>
      <td>${u.role}</td>
      <td>${esc(u.unitNumber || '—')}</td>
      <td>${plan}</td>
      <td>${locked}</td>
      <td class="${subClass}">${u.subscriptionStatus || '—'}</td>
      <td>${fmtDate(u.createdAt)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="empty">No users.</td></tr>';
}

$('#user-filter').addEventListener('change', renderUsersTable);

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
      <td>${esc(u.name || '—')}</td>
      <td>${esc(u.unitNumber || '—')}</td>
      <td>${u.signupFeePaid ? `$${u.signupFeeAmount ?? 0}` : '—'}</td>
      <td>$${u.lockedMonthlyPrice ?? '—'}/mo</td>
      <td>$${u.lockedAnnualPrice ?? '—'}/yr</td>
      <td>${fmtDate(u.pricingLockedAt || u.createdAt)}</td>
    </tr>
  `).join('') || '<tr><td colspan="6" class="empty">No customers yet.</td></tr>';
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
    state.pollTimer = setInterval(refreshAll, 10000);
  } catch { logout(); }
})();
