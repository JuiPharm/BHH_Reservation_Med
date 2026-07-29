import { apiRequest } from './api.js';
import { clearSession, getSession, loginSuccessDestination, requireAuth, saveSession } from './session.js';
import { clearFieldError, setLoading, showFieldErrors, showToast } from './ui.js';

function renderIdentity(session) {
  const values = {
    'identity-name': session && session.fullName,
    'identity-staff-id': session && session.staffId,
    'identity-department': session && session.department,
    'identity-role': session && session.role,
  };
  for (const [id, value] of Object.entries(values)) {
    const element = document.getElementById(id);
    if (element) element.textContent = value || '—';
  }
}

async function logout() {
  const session = getSession();
  try {
    if (session) await apiRequest('LOGOUT', {});
  } catch (_error) {
    // Clearing the local session remains safe when an offline logout cannot reach the server.
  } finally {
    clearSession();
    window.location.replace('login.html');
  }
}

function installLogin() {
  const form = document.getElementById('login-form');
  if (!form) return;
  form.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', () => clearFieldError(input.name, form));
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    const loading = document.getElementById('page-loading');
    showFieldErrors({}, form);
    const staffId = form.elements['staff-id'].value.trim();
    const pin = form.elements.pin.value.trim();
    const localErrors = [];
    if (!staffId) localErrors.push({ field: 'staff-id', message: 'รหัสเจ้าหน้าที่เป็นข้อมูลที่จำเป็น' });
    if (!pin) localErrors.push({ field: 'pin', message: 'รหัส PIN เป็นข้อมูลที่จำเป็น' });
    if (localErrors.length) {
      showFieldErrors(localErrors, form);
      return;
    }
    submit.disabled = true;
    setLoading(loading, true, 'กำลังตรวจสอบข้อมูลเข้าสู่ระบบ');
    try {
      const result = await apiRequest('LOGIN', {
        staffId,
        pin,
      });
      saveSession(result);
      showFieldErrors({}, form);
      window.location.replace(loginSuccessDestination());
    } catch (error) {
      if (error.errors && error.errors.length) showFieldErrors(error.errors, form);
      showToast(error.message || 'เข้าสู่ระบบไม่สำเร็จ', 'error');
    } finally {
      submit.disabled = false;
      setLoading(loading, false);
    }
  });
}

function installLogout() {
  document.querySelectorAll('[data-action="logout"]').forEach((button) => {
    button.addEventListener('click', logout);
  });
}

function installLogoFallbacks() {
  document.querySelectorAll('.brand-logo').forEach((image) => {
    image.addEventListener('error', () => {
      image.hidden = true;
      const fallback = image.nextElementSibling;
      if (fallback) fallback.hidden = false;
    }, { once: true });
  });
}

function initialize() {
  const body = document.body;
  const roles = (body.dataset.roles || '').split(',').filter(Boolean);
  const session = body.dataset.requiresAuth === 'true' ? requireAuth({ roles }) : getSession();
  renderIdentity(session);
  installLogoFallbacks();
  installLogin();
  installLogout();
}

document.addEventListener('DOMContentLoaded', initialize);
