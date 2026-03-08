// ── Theme ─────────────────────────────────────────────────────────
if (localStorage.getItem('wf_theme') === 'light') {
  document.documentElement.classList.add('light');
  document.getElementById('btn-theme').textContent = '☾';
}
function toggleTheme() {
  const light = document.documentElement.classList.toggle('light');
  document.getElementById('btn-theme').textContent = light ? '☾' : '☀';
  localStorage.setItem('wf_theme', light ? 'light' : 'dark');
}

// ── Tabs ──────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('auth-login').style.display    = tab === 'login'    ? '' : 'none';
  document.getElementById('auth-register').style.display = tab === 'register' ? '' : 'none';
  document.getElementById('tab-login-btn').classList.toggle('active', tab === 'login');
  document.getElementById('tab-reg-btn').classList.toggle('active',  tab === 'register');
  document.getElementById('auth-err').textContent = '';
}

function goEditor() { window.location.href = '/editor'; }
function err(msg)   { document.getElementById('auth-err').textContent = msg; }

// ── Auth ──────────────────────────────────────────────────────────
async function doLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) return err(window.LABELS?.err_fill_all || 'Please fill all fields');
  const res = await apiFetch('/api/auth/login', 'POST', { email, password });
  if (res.error) return err(res.error);
  localStorage.setItem('wf_token', res.token);
  goEditor();
}

async function doRegister() {
  const email    = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const confirm  = document.getElementById('reg-confirm').value;
  if (password !== confirm) return err(window.LABELS?.err_no_match || 'Passwords do not match');
  const res = await apiFetch('/api/auth/register', 'POST', { email, password });
  if (res.error) return err(res.error);
  localStorage.setItem('wf_token', res.token);
  goEditor();
}

async function apiFetch(path, method, body) {
  try {
    const res = await fetch(path, {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

// ── Enter key ─────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const tab = document.getElementById('auth-register').style.display === 'none' ? 'login' : 'register';
  tab === 'login' ? doLogin() : doRegister();
});

// ── Auto-redirect if already logged in ────────────────────────────
const t = localStorage.getItem('wf_token');
if (t) {
  fetch('/api/auth/me', { headers: { Authorization: `Bearer ${t}` } })
    .then(r => r.json()).then(d => { if (!d.error) goEditor(); })
    .catch(() => {});
}
