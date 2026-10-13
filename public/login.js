const form = document.getElementById('loginForm');
const btn = document.getElementById('submitBtn');
const btnLabel = document.getElementById('btnLabel');
const errEl = document.getElementById('err');

// Toggle mostrar/ocultar contraseña — reutilizado igual en el modal de cambiar clave
const EYE_OPEN = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"></path><circle cx="12" cy="12" r="3"></circle>';
const EYE_OFF = '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.76 19.76 0 0 1 4.22-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a19.65 19.65 0 0 1-2.29 3.31M14.12 14.12a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
function wireEyeToggle(inputEl, buttonEl) {
  const icon = buttonEl.querySelector('svg');
  buttonEl.addEventListener('click', () => {
    const showing = inputEl.type === 'text';
    inputEl.type = showing ? 'password' : 'text';
    icon.innerHTML = showing ? EYE_OPEN : EYE_OFF;
    buttonEl.setAttribute('aria-label', showing ? 'Mostrar contraseña' : 'Ocultar contraseña');
  });
}
wireEyeToggle(document.getElementById('password'), document.getElementById('toggleEye'));

function setLoading(loading) {
  btn.disabled = loading;
  btnLabel.innerHTML = loading ? '<span class="spinner"></span> Verificando…' : 'Entrar';
}

function showError(msg) {
  errEl.textContent = msg;
  errEl.classList.remove('shake');
  // Reforzar el reflow para que la animación se repita en errores seguidos
  void errEl.offsetWidth;
  errEl.classList.add('shake');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errEl.textContent = '';
  setLoading(true);
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('password').value }),
    });
    const data = await r.json();
    if (data.ok) {
      window.location.href = '/';
      return;
    }
    showError(data.error || 'Clave incorrecta');
  } catch {
    showError('Error de conexión');
  }
  setLoading(false);
});
