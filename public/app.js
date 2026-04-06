// Main application JavaScript — served as a static file so it can be
// cached by the browser and allowed by CSP without 'unsafe-inline'.

let currentRange = 'yesterday';
let csrfToken = '';
let allEmails = [];
let sortCol = 'domain';
let sortDir = 'asc';
let isGrouped = true;
let expandedDomains = new Set();
let unsubscribedDomains = new Set();
let searchQuery = '';

function toggleDark() {
  const dark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', dark ? 'dark' : 'light');
}

function renderUserInfo(user) {
  const el = document.getElementById('user-info');
  const initials = ((user.firstName?.[0] || '') + (user.lastName?.[0] || '')).toUpperCase() || user.email[0].toUpperCase();
  const avatar = user.picture
    ? `<img src="${esc(user.picture)}" class="user-avatar" referrerpolicy="no-referrer">`
    : `<div class="avatar-initials">${initials}</div>`;
  el.innerHTML = `${avatar}<span>${esc(user.firstName || user.email)}</span>`;
  if (user.isAdmin) document.getElementById('admin-link').style.display = 'inline-flex';
}

function setRange(range) {
  currentRange = range;
  ['yesterday', 'week', 'month'].forEach(r =>
    document.getElementById(`btn-${r}`).classList.toggle('active', range === r)
  );
}

// ── Search / filter ───────────────────────────────────────────────────────
let searchDebounceTimer = null;
function onSearch() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchQuery = document.getElementById('search-input').value;
    if (allEmails.length) applyFilters();
  }, 250);
}

function applyFilters() {
  const q = searchQuery.toLowerCase().trim();
  const filtered = q
    ? allEmails.filter(e =>
        e.domain.toLowerCase().includes(q) ||
        e.subject.toLowerCase().includes(q) ||
        e.senderEmail.toLowerCase().includes(q))
    : allEmails;

  const meta = document.getElementById('results-meta');
  const wrap = document.getElementById('table-wrap');
  const empty = document.getElementById('empty-state');

  if (!filtered.length) {
    wrap.style.display = 'none';
    empty.style.display = 'block';
    empty.querySelector('p').textContent = q
      ? 'No emails match your filter.'
      : 'No emails with unsubscribe links for this time period.';
    meta.textContent = q ? `No results for "${q}"` : '';
    document.getElementById('export-btn').style.display = 'none';
  } else {
    empty.style.display = 'none';
    wrap.style.display = 'block';
    document.getElementById('export-btn').style.display = '';
    const domainCount = new Set(filtered.map(e => e.domain)).size;
    meta.textContent = isGrouped
      ? `${domainCount} domain${domainCount !== 1 ? 's' : ''}, ${filtered.length} email${filtered.length !== 1 ? 's' : ''}`
      : `${filtered.length} result${filtered.length !== 1 ? 's' : ''}`;
    renderTable(filtered);
  }
}

// ── Export CSV ────────────────────────────────────────────────────────────
function exportCsv() {
  const q = searchQuery.toLowerCase().trim();
  const data = q
    ? allEmails.filter(e =>
        e.domain.toLowerCase().includes(q) ||
        e.subject.toLowerCase().includes(q) ||
        e.senderEmail.toLowerCase().includes(q))
    : allEmails;

  const rows = data.map(e =>
    [e.domain, e.senderEmail, e.subject, e.date, e.unsubscribeUrl,
      unsubscribedDomains.has(e.domain) ? 'Unsubscribed' : 'Active']
      .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
  );
  const csv = ['Domain,Sender Email,Subject,Date,Unsubscribe URL,Status', ...rows].join('\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' })),
    download: `unsubscribe-${currentRange}-${new Date().toISOString().slice(0, 10)}.csv`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Bulk open ─────────────────────────────────────────────────────────────
function checkCell(domain, senderEmail, url) {
  const d = esc(domain); const s = esc(senderEmail); const u = esc(url);
  return `<td class="check-cell"><input type="checkbox" class="row-check" data-action="check-change" data-url="${u}" data-domain="${d}" data-sender="${s}"></td>`;
}

function onCheckChange() {
  const checked = document.querySelectorAll('.row-check:checked');
  const all = document.querySelectorAll('tbody .row-check');
  const selectAll = document.getElementById('select-all');
  selectAll.indeterminate = checked.length > 0 && checked.length < all.length;
  selectAll.checked = all.length > 0 && checked.length === all.length;
  document.getElementById('bulk-count').textContent = checked.length;
  document.getElementById('bulk-btn').style.display = checked.length > 0 ? '' : 'none';
}

function toggleSelectAll(cb) {
  document.querySelectorAll('tbody .row-check').forEach(c => c.checked = cb.checked);
  onCheckChange();
}

function bulkOpen() {
  const checks = [...document.querySelectorAll('.row-check:checked')];
  checks.forEach(c => {
    window.open(c.dataset.url, '_blank', 'noopener,noreferrer');
    unsubscribedDomains.add(c.dataset.domain);
    fetch('/api/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ domain: c.dataset.domain, senderEmail: c.dataset.sender, unsubscribeUrl: c.dataset.url }),
    }).catch(err => console.warn('Failed to log unsubscribe:', err));
  });
  applyFilters(); // re-render (clears checkboxes, resets bulk btn)
}

function resetBulkState() {
  const selectAll = document.getElementById('select-all');
  if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false; }
  document.getElementById('bulk-btn').style.display = 'none';
  document.getElementById('bulk-count').textContent = '0';
}

// ── Sorting ───────────────────────────────────────────────────────────────
function setSortCol(col) {
  if (sortCol === col) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortCol = col;
    sortDir = col === 'date' ? 'desc' : 'asc';
  }
  applyFilters();
}

function updateSortHeaders() {
  document.querySelectorAll('th[data-col]').forEach(th => {
    const active = th.dataset.col === sortCol;
    th.classList.toggle('sort-active', active);
    th.querySelector('.sort-indicator').textContent =
      active ? (sortDir === 'asc' ? '▲' : '▼') : '⇅';
  });
}

function sorted(emails) {
  return [...emails].sort((a, b) => {
    const va = sortCol === 'date' ? new Date(a.date).getTime() : (a[sortCol] || '').toLowerCase();
    const vb = sortCol === 'date' ? new Date(b.date).getTime() : (b[sortCol] || '').toLowerCase();
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });
}

// ── Grouping ──────────────────────────────────────────────────────────────
function toggleGrouped() {
  isGrouped = !isGrouped;
  expandedDomains.clear();
  document.getElementById('group-btn').classList.toggle('active', isGrouped);
  applyFilters();
}

function toggleDomain(domain) {
  if (expandedDomains.has(domain)) {
    expandedDomains.delete(domain);
  } else {
    expandedDomains.add(domain);
  }
  applyFilters();
}

// ── Rendering ─────────────────────────────────────────────────────────────
function unsubBtn(domain, senderEmail, url, done, oneClick) {
  const d = esc(domain); const s = esc(senderEmail); const u = esc(url);
  const checkIcon = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  if (done) {
    return `<button class="unsub-btn done" data-action="unsubscribe" data-domain="${d}" data-sender="${s}" data-url="${u}">${checkIcon} Unsubscribed</button>`;
  }
  if (oneClick) {
    const zapIcon = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
    return `<button class="unsub-btn one-click" data-action="one-click" data-domain="${d}" data-sender="${s}" data-url="${u}">${zapIcon} 1-Click Unsubscribe</button>`;
  }
  const linkIcon = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
  return `<button class="unsub-btn" data-action="unsubscribe" data-domain="${d}" data-sender="${s}" data-url="${u}">${linkIcon} Unsubscribe</button>`;
}

async function handleUnsubscribe(domain, senderEmail, url) {
  window.open(url, '_blank', 'noopener,noreferrer');
  unsubscribedDomains.add(domain);
  applyFilters();
  fetch('/api/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ domain, senderEmail, unsubscribeUrl: url }),
  }).catch(err => console.warn('Failed to log unsubscribe:', err));
}

async function handleOneClick(btn, domain, senderEmail, url) {
  btn.disabled = true;
  btn.innerHTML = `<span class="btn-spinner"></span> Unsubscribing…`;
  try {
    const res = await fetch('/api/one-click-unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ domain, senderEmail, unsubscribeUrl: url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to unsubscribe');
    unsubscribedDomains.add(domain);
    applyFilters();
  } catch (err) {
    btn.disabled = false;
    const zapIcon = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
    btn.innerHTML = `${zapIcon} 1-Click Unsubscribe`;
    console.error('One-click unsubscribe error:', err);
    alert('Unsubscribe failed: ' + err.message);
  }
}

function renderCards(emails) {
  const container = document.getElementById('email-cards');
  if (!container) return;

  const chevronSvg = open => `<svg class="expand-icon${open ? ' open' : ''}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

  if (!isGrouped) {
    container.innerHTML = sorted(emails).map(e => {
      const done = unsubscribedDomains.has(e.domain);
      return `
        <div class="email-card">
          <div class="email-card-header">
            <div class="email-card-domain">${esc(e.domain)}</div>
            <div style="flex-shrink:0">${unsubBtn(e.domain, e.senderEmail, e.unsubscribeUrl, done, e.oneClick)}</div>
          </div>
          <div class="email-card-meta">
            <span class="email-card-sender">${esc(e.senderEmail)}</span>
            <span class="email-card-date">${esc(e.date)}</span>
          </div>
          <div class="email-card-subject" title="${esc(e.subject)}">${esc(e.subject)}</div>
        </div>`;
    }).join('');
    return;
  }

  const groupMap = new Map();
  emails.forEach(e => {
    if (!groupMap.has(e.domain)) groupMap.set(e.domain, []);
    groupMap.get(e.domain).push(e);
  });
  groupMap.forEach(items => items.sort((a, b) => new Date(b.date) - new Date(a.date)));

  let groups = [...groupMap.entries()].map(([domain, items]) => ({ domain, items, rep: items[0] }));
  groups.sort((a, b) => {
    let va, vb;
    if (sortCol === 'domain')     { va = a.domain.toLowerCase();               vb = b.domain.toLowerCase(); }
    else if (sortCol === 'date')  { va = new Date(a.rep.date).getTime();        vb = new Date(b.rep.date).getTime(); }
    else                          { va = (a.rep[sortCol] || '').toLowerCase();  vb = (b.rep[sortCol] || '').toLowerCase(); }
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  container.innerHTML = groups.map(({ domain, items, rep }) => {
    const expanded = expandedDomains.has(domain);
    const done = unsubscribedDomains.has(domain);
    const countBadge = items.length > 1 ? `<span class="count-badge">${items.length}</span>` : '';
    const unsubBadge = done ? `<span class="badge badge-active" style="margin-left:0">✓ Unsubscribed</span>` : '';

    const expandBtn = items.length > 1 ? `
      <button class="email-card-expand" data-action="toggle-domain" data-domain="${esc(domain)}">
        ${chevronSvg(expanded)}${expanded ? 'Collapse' : `${items.length - 1} more email${items.length - 1 !== 1 ? 's' : ''}`}
      </button>` : '';

    const subs = expanded && items.length > 1 ? `
      <div class="email-card-subs">
        ${items.map(e => `
          <div>
            <div class="email-card-sub-header">
              <span class="email-card-sub-sender">${esc(e.senderEmail)}</span>
              <div style="flex-shrink:0">${unsubBtn(e.domain, e.senderEmail, e.unsubscribeUrl, unsubscribedDomains.has(e.domain), e.oneClick)}</div>
            </div>
            <div class="email-card-sub-subject" title="${esc(e.subject)}">${esc(e.subject)}</div>
            <div class="email-card-sub-date">${esc(e.date)}</div>
          </div>`).join('')}
      </div>` : '';

    return `
      <div class="email-card">
        <div class="email-card-header">
          <div class="email-card-domain">${esc(domain)}${countBadge}${unsubBadge}</div>
          <div style="flex-shrink:0">${unsubBtn(rep.domain, rep.senderEmail, rep.unsubscribeUrl, done, rep.oneClick)}</div>
        </div>
        <div class="email-card-meta">
          <span class="email-card-sender">${esc(rep.senderEmail)}</span>
          <span class="email-card-date">${esc(rep.date)}</span>
        </div>
        <div class="email-card-subject" title="${esc(rep.subject)}">${esc(rep.subject)}</div>
        ${expandBtn}${subs}
      </div>`;
  }).join('');
}

function renderTable(emails) {
  updateSortHeaders();
  resetBulkState();
  renderCards(emails);
  const tbody = document.getElementById('email-tbody');

  if (!isGrouped) {
    tbody.innerHTML = sorted(emails).map(e => `
      <tr>
        ${checkCell(e.domain, e.senderEmail, e.unsubscribeUrl)}
        <td class="domain-cell">${esc(e.domain)}</td>
        <td class="email-cell">${esc(e.senderEmail)}</td>
        <td class="subject-cell" title="${esc(e.subject)}">${esc(e.subject)}</td>
        <td class="date-cell">${esc(e.date)}</td>
        <td>${unsubBtn(e.domain, e.senderEmail, e.unsubscribeUrl, unsubscribedDomains.has(e.domain), e.oneClick)}</td>
      </tr>`).join('');
    return;
  }

  const groupMap = new Map();
  emails.forEach(e => {
    if (!groupMap.has(e.domain)) groupMap.set(e.domain, []);
    groupMap.get(e.domain).push(e);
  });
  groupMap.forEach(items => items.sort((a, b) => new Date(b.date) - new Date(a.date)));

  let groups = [...groupMap.entries()].map(([domain, items]) => ({ domain, items, rep: items[0] }));
  groups.sort((a, b) => {
    let va, vb;
    if (sortCol === 'domain')     { va = a.domain.toLowerCase();               vb = b.domain.toLowerCase(); }
    else if (sortCol === 'date')  { va = new Date(a.rep.date).getTime();        vb = new Date(b.rep.date).getTime(); }
    else                          { va = (a.rep[sortCol] || '').toLowerCase();  vb = (b.rep[sortCol] || '').toLowerCase(); }
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  tbody.innerHTML = groups.flatMap(({ domain, items, rep }) => {
    const expanded = expandedDomains.has(domain);
    const done = unsubscribedDomains.has(domain);
    const chevron = `<svg class="expand-icon ${expanded ? 'open' : ''}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
    const countBadge = items.length > 1 ? `<span class="count-badge">${items.length}</span>` : '';
    const unsubBadge = done ? `<span class="badge badge-active" style="margin-left:7px">✓ Unsubscribed</span>` : '';

    const summary = `
      <tr class="group-row" data-domain="${esc(domain)}">
        ${checkCell(rep.domain, rep.senderEmail, rep.unsubscribeUrl)}
        <td class="domain-cell"><div style="display:flex;align-items:center">${chevron}${esc(domain)}${countBadge}${unsubBadge}</div></td>
        <td class="email-cell">${esc(rep.senderEmail)}</td>
        <td class="subject-cell" title="${esc(rep.subject)}">${esc(rep.subject)}</td>
        <td class="date-cell">${esc(rep.date)}</td>
        <td>${unsubBtn(rep.domain, rep.senderEmail, rep.unsubscribeUrl, done, rep.oneClick)}</td>
      </tr>`;

    if (!expanded || items.length <= 1) return [summary];

    return [summary, ...items.map(e => `
      <tr class="sub-row">
        ${checkCell(e.domain, e.senderEmail, e.unsubscribeUrl)}
        <td></td>
        <td class="email-cell">${esc(e.senderEmail)}</td>
        <td class="subject-cell" title="${esc(e.subject)}">${esc(e.subject)}</td>
        <td class="date-cell">${esc(e.date)}</td>
        <td>${unsubBtn(e.domain, e.senderEmail, e.unsubscribeUrl, unsubscribedDomains.has(e.domain), e.oneClick)}</td>
      </tr>`)];
  }).join('');
}

// Event delegation for dynamically-rendered email list buttons/checkboxes.
// Covers both the table body and the card list — handles clicks on
// unsubscribe/one-click buttons, domain expand toggles, and checkbox changes.
function setupEmailListDelegation() {
  function handleClick(e) {
    // Group-row expand via row click (table only)
    if (e.target.type === 'checkbox') return;
    const row = e.target.closest('.group-row');

    const btn = e.target.closest('[data-action]');
    if (!btn) {
      if (row) toggleDomain(row.dataset.domain);
      return;
    }
    const { action, domain, sender, url } = btn.dataset;
    if (action === 'unsubscribe') handleUnsubscribe(domain, sender, url);
    else if (action === 'one-click') handleOneClick(btn, domain, sender, url);
    else if (action === 'toggle-domain') toggleDomain(domain);
  }

  function handleChange(e) {
    if (e.target.dataset.action === 'check-change') onCheckChange();
  }

  document.getElementById('email-tbody').addEventListener('click', handleClick);
  document.getElementById('email-tbody').addEventListener('change', handleChange);
  document.getElementById('email-cards').addEventListener('click', handleClick);
}

// ── Fetch ─────────────────────────────────────────────────────────────────
async function fetchEmails() {
  const btn = document.getElementById('fetch-btn');
  const loading = document.getElementById('loading');
  const wrap = document.getElementById('table-wrap');
  const empty = document.getElementById('empty-state');
  const err = document.getElementById('error-msg');

  btn.disabled = true;
  loading.style.display = 'block';
  wrap.style.display = 'none';
  empty.style.display = 'none';
  err.style.display = 'none';
  document.getElementById('results-meta').textContent = '';
  document.getElementById('export-btn').style.display = 'none';
  expandedDomains.clear();
  unsubscribedDomains.clear();
  allEmails = [];

  try {
    const res = await fetch(`/api/emails?range=${currentRange}`);
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 401) return window.location.href = '/';
      throw new Error(data.error || 'Failed to fetch emails');
    }
    loading.style.display = 'none';
    if (data.truncated) {
      err.textContent = 'Your inbox is large — showing partial results. Try a shorter date range for complete results.';
      err.style.display = 'block';
    }
    if (!data.emails?.length) {
      if (!data.truncated) empty.style.display = 'block';
    } else {
      allEmails = data.emails;
      unsubscribedDomains = new Set(data.emails.filter(e => e.alreadyUnsubscribed).map(e => e.domain));
      applyFilters();
    }
  } catch (e) {
    loading.style.display = 'none';
    err.textContent = e.message;
    err.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
}

async function logout() {
  await fetch('/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } });
  window.location.href = '/';
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function acceptPolicy() {
  const btn = document.getElementById('policy-accept-btn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/accept-policy', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
    });
    if (!res.ok) throw new Error('Failed to record acceptance');
    document.getElementById('policy-overlay').classList.add('hidden');
  } catch (e) {
    btn.disabled = false;
    alert('Something went wrong. Please try again.');
  }
}

async function declinePolicy() {
  await fetch('/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } });
  window.location.href = '/';
}

// ── Tab switching ─────────────────────────────────────────────────────
let activeTab = 'emails';
function showTab(tab) {
  activeTab = tab;
  document.getElementById('section-emails').style.display    = tab === 'emails'    ? '' : 'none';
  document.getElementById('section-analytics').style.display = tab === 'analytics' ? '' : 'none';
  document.getElementById('tab-btn-emails').classList.toggle('active',    tab === 'emails');
  document.getElementById('tab-btn-analytics').classList.toggle('active', tab === 'analytics');
  if (tab === 'analytics' && !analyticsLoaded) fetchAnalytics();
}

// ── Analytics ─────────────────────────────────────────────────────────
let analyticsLoaded = false;
let analyticsPeriod = 'week';
let analyticsChart = null;
let analyticsAbortController = null;

function setAnalyticsPeriod(period) {
  analyticsPeriod = period;
  document.getElementById('abtn-week').classList.toggle('active',  period === 'week');
  document.getElementById('abtn-month').classList.toggle('active', period === 'month');
  analyticsLoaded = false;
  fetchAnalytics();
}

async function fetchAnalytics() {
  // Abort any in-flight analytics request before starting a new one
  if (analyticsAbortController) analyticsAbortController.abort();
  analyticsAbortController = new AbortController();
  const signal = analyticsAbortController.signal;

  const loading  = document.getElementById('analytics-loading');
  const chartWrap = document.getElementById('analytics-chart-wrap');
  const trendEl  = document.getElementById('analytics-trend');
  const capWarn  = document.getElementById('analytics-cap-warn');

  loading.style.display   = 'block';
  chartWrap.style.display = 'none';
  trendEl.style.display   = 'none';
  capWarn.style.display   = 'none';

  try {
    const res = await fetch(`/api/analytics?period=${analyticsPeriod}`, { signal });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 401) return window.location.href = '/';
      throw new Error(data.error || 'Failed to fetch analytics');
    }

    loading.style.display   = 'none';
    chartWrap.style.display = 'block';
    trendEl.style.display   = 'block';

    if (data.capped) capWarn.style.display = 'block';

    renderAnalyticsChart(data);
    renderTrend(data);
    analyticsLoaded = true;
  } catch (e) {
    if (e.name === 'AbortError') return; // superseded by a newer request — ignore silently
    loading.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`;
  }
}

function renderAnalyticsChart(data) {
  const isDark = document.documentElement.classList.contains('dark');
  const gridColor  = isDark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.07)';
  const labelColor = isDark ? '#9ca3af' : '#6b7280';
  const barColor   = 'rgba(99,102,241,.75)';
  const barHover   = 'rgba(99,102,241,1)';

  if (analyticsChart) { analyticsChart.destroy(); analyticsChart = null; }

  const ctx = document.getElementById('analytics-chart').getContext('2d');
  analyticsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.labels.map(d => {
        const dt = new Date(d + 'T00:00:00');
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      }),
      datasets: [{
        label: 'Unsubscribable emails',
        data: data.counts,
        backgroundColor: barColor,
        hoverBackgroundColor: barHover,
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.parsed.y} email${ctx.parsed.y !== 1 ? 's' : ''}`,
          },
        },
      },
      scales: {
        x: { grid: { color: gridColor }, ticks: { color: labelColor, maxRotation: 45 } },
        y: { grid: { color: gridColor }, ticks: { color: labelColor, precision: 0 }, beginAtZero: true },
      },
    },
  });
}

function renderTrend(data) {
  const el = document.getElementById('analytics-trend');
  const { total, previousTotal } = data;
  const label = analyticsPeriod === 'week' ? '7 days' : '30 days';

  if (previousTotal === 0 && total === 0) {
    el.innerHTML = `<span class="trend-flat">—</span> No unsubscribable emails in either period.`;
    return;
  }
  if (previousTotal === 0) {
    el.innerHTML = `<span class="trend-up">↑ New</span> ${total} email${total !== 1 ? 's' : ''} this period (no data for previous ${label}).`;
    return;
  }

  const pct = Math.round(Math.abs(total - previousTotal) / previousTotal * 100);
  if (total > previousTotal) {
    el.innerHTML = `<span class="trend-up">↑ ${pct}% more</span> than the previous ${label} (${total} vs ${previousTotal}).`;
  } else if (total < previousTotal) {
    el.innerHTML = `<span class="trend-down">↓ ${pct}% fewer</span> than the previous ${label} (${total} vs ${previousTotal}).`;
  } else {
    el.innerHTML = `<span class="trend-flat">— No change</span> vs the previous ${label} (${total} email${total !== 1 ? 's' : ''}).`;
  }
}

// ── Settings ──────────────────────────────────────────────────────────────
let userSettings = {};

async function loadSettings() {
  try {
    const res = await fetch('/api/user-settings');
    if (res.ok) userSettings = await res.json();
  } catch { /* non-critical */ }
}

async function saveSetting(key, value) {
  userSettings[key] = value;
  await fetch('/api/user-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ [key]: value }),
  }).catch(() => {});
}

function openSettings() {
  // Sync toggles to current state before opening
  document.getElementById('setting-dark-mode').checked =
    document.documentElement.classList.contains('dark');
  document.getElementById('settings-overlay').style.display = '';
  requestAnimationFrame(() =>
    document.getElementById('settings-drawer').classList.add('open')
  );
  // Reset delete confirm box
  document.getElementById('delete-confirm-box').style.display = 'none';
  document.getElementById('delete-confirm-input').value = '';
  document.getElementById('delete-confirm-error').style.display = 'none';
}

function closeSettings() {
  document.getElementById('settings-drawer').classList.remove('open');
  setTimeout(() => { document.getElementById('settings-overlay').style.display = 'none'; }, 260);
}

function settingToggleDark() {
  toggleDark();
  document.getElementById('setting-dark-mode').checked =
    document.documentElement.classList.contains('dark');
}

function showDeleteConfirm() {
  document.getElementById('delete-confirm-box').style.display = 'block';
  document.getElementById('delete-confirm-input').focus();
}

async function confirmDeleteAccount() {
  const val = document.getElementById('delete-confirm-input').value.trim();
  const errEl = document.getElementById('delete-confirm-error');
  if (val !== 'DELETE') {
    errEl.textContent = 'Type DELETE (all caps) to confirm.';
    errEl.style.display = 'block';
    return;
  }
  errEl.style.display = 'none';
  const btn = document.getElementById('delete-account-confirm-btn');
  btn.disabled = true; btn.textContent = 'Deleting…';
  try {
    const res = await fetch('/api/account', {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': csrfToken },
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed');
    window.location.href = '/';
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Permanently Delete';
    errEl.textContent = 'Error: ' + e.message;
    errEl.style.display = 'block';
  }
}

async function init() {
  const res = await fetch('/auth/status');
  const data = await res.json();
  if (!data.authenticated) return window.location.href = '/';
  csrfToken = data.csrfToken;
  renderUserInfo(data.user);
  await loadSettings();
  if (data.requiresPolicyAcceptance) {
    document.getElementById('policy-overlay').classList.remove('hidden');
  }
  fetchEmails();
}

// ── Static event listeners ────────────────────────────────────────────────
// Wired up here (external file, defer) rather than as inline onclick= attrs,
// so the CSP script-src does not need 'unsafe-inline'.
document.querySelector('.theme-toggle').addEventListener('click', toggleDark);
document.querySelector('.settings-gear-btn').addEventListener('click', openSettings);
document.getElementById('logout-btn').addEventListener('click', logout);

document.getElementById('tab-btn-emails').addEventListener('click', () => showTab('emails'));
document.getElementById('tab-btn-analytics').addEventListener('click', () => showTab('analytics'));

document.getElementById('abtn-week').addEventListener('click', () => setAnalyticsPeriod('week'));
document.getElementById('abtn-month').addEventListener('click', () => setAnalyticsPeriod('month'));

document.getElementById('btn-yesterday').addEventListener('click', () => setRange('yesterday'));
document.getElementById('btn-week').addEventListener('click', () => setRange('week'));
document.getElementById('btn-month').addEventListener('click', () => setRange('month'));

document.getElementById('fetch-btn').addEventListener('click', fetchEmails);
document.getElementById('group-btn').addEventListener('click', toggleGrouped);
document.getElementById('bulk-btn').addEventListener('click', bulkOpen);
document.getElementById('export-btn').addEventListener('click', exportCsv);
document.getElementById('search-input').addEventListener('input', onSearch);

document.querySelectorAll('th[data-col]').forEach(th =>
  th.addEventListener('click', () => setSortCol(th.dataset.col))
);
document.getElementById('select-all').addEventListener('change', function () { toggleSelectAll(this); });

document.getElementById('settings-overlay').addEventListener('click', closeSettings);
document.getElementById('settings-close-btn').addEventListener('click', closeSettings);
document.getElementById('setting-dark-mode').addEventListener('change', settingToggleDark);

document.getElementById('show-delete-confirm-btn').addEventListener('click', showDeleteConfirm);
document.getElementById('cancel-delete-btn').addEventListener('click', () => {
  document.getElementById('delete-confirm-box').style.display = 'none';
});
document.getElementById('delete-account-confirm-btn').addEventListener('click', confirmDeleteAccount);

document.getElementById('policy-decline-btn').addEventListener('click', declinePolicy);
document.getElementById('policy-accept-btn').addEventListener('click', acceptPolicy);

setupEmailListDelegation();

init();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
