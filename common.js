async function api(path, options = {}) {
  const opts = Object.assign({ credentials: 'include' }, options);
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch('/api' + path, opts);
  let data = {};
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Xatolik yuz berdi');
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function fmtMoney(n) {
  return Number(n || 0).toLocaleString('ru-RU').replace(/,/g, ' ');
}

function fmtDate(ts) {
  const d = new Date(Number(ts));
  return d.toLocaleString('uz-UZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function statusBadge(status) {
  const map = {
    pending: ['status_pending', 'badge-pending'],
    delivered: ['status_delivered', 'badge-delivered'],
    approved: ['status_approved', 'badge-approved'],
    rejected: ['status_rejected', 'badge-rejected']
  };
  const [key, cls] = map[status] || [status, 'badge-pending'];
  return `<span class="badge ${cls}">${I18N.t(key)}</span>`;
}

async function renderNavbar(activePage) {
  const root = document.getElementById('navbar-root');
  if (!root) return;

  let user = null;
  try {
    const data = await api('/auth/me');
    user = data.user;
  } catch (e) { /* not logged in */ }

  const linkClass = (page) => 'navlink' + (page === activePage ? ' active' : '');

  root.innerHTML = `
    <div class="navbar">
      <div class="container navbar-inner">
        <a href="/" class="brand"><span>PUBG</span><span class="dot">UC</span> Shop</a>
        <div class="nav-links">
          <a href="/" class="${linkClass('home')}" data-i18n="nav_home">Bosh sahifa</a>
          ${user ? `<a href="/profile.html" class="${linkClass('profile')}" data-i18n="nav_profile">Profil</a>` : ''}
          ${user ? `<a href="/support.html" class="${linkClass('support')}" data-i18n="nav_support">Yordam</a>` : ''}
          <a href="/admin.html" class="${linkClass('admin')}" data-i18n="nav_admin">Admin</a>
          ${user ? `
            <span class="balance-pill">💰 <span id="nav-balance">${fmtMoney(user.balance)}</span> <span data-i18n="sum">so'm</span></span>
            <a href="#" id="nav-logout" class="navlink" data-i18n="nav_logout">Chiqish</a>
          ` : `
            <a href="/login.html" class="${linkClass('login')}" data-i18n="nav_login">Kirish</a>
            <a href="/register.html" class="btn btn-accent btn-sm" data-i18n="nav_register">Ro'yxatdan o'tish</a>
          `}
          <div class="lang-switch">
            <button data-lang="uz">UZ</button>
            <button data-lang="ru">RU</button>
          </div>
        </div>
      </div>
    </div>
  `;

  I18N.initSwitcher();
  I18N.loadLang(I18N.getLang());

  const logoutBtn = document.getElementById('nav-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      await api('/auth/logout', { method: 'POST' });
      window.location.href = '/';
    });
  }

  return user;
}
