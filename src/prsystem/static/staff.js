/* One shared, memory-only link form. No third-party scripts or storage. */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const routes = {
    '/staff/activate': {title:'Admin эрхээ идэвхжүүлэх',endpoint:'/auth/admin/activate',activation:true},
    '/staff/accept': {title: 'Урилгаа зөвшөөрөх', endpoint: '/auth/invitations/accept'},
    '/staff/restaurant-accept': {title: 'Рестораны урилгаа зөвшөөрөх', endpoint: '/auth/restaurants/invitations/accept'},
    '/staff/reset': {title: 'Нууц үгээ шинэчлэх', endpoint: '/auth/password/reset/complete', reset: true},
  };
  const route = routes[location.pathname];
  let secret = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  // Remove secret from this history entry before any interaction or fetch.
  history.replaceState(null, '', location.pathname);
  const form = byId('form'), password = byId('password'), submit = byId('submit');
  const feedback = byId('feedback'), error = byId('field-error');
  let busy = false;
  const say = (message, failed = false) => {
    feedback.textContent = message;
    feedback.dataset.error = String(failed);
    feedback.focus();
  };
  if (!route || !/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(secret)) {
    secret = '';
    byId('title').textContent = 'Холбоос дутуу эсвэл буруу байна';
    document.title = 'Холбоос буруу · PRsystem';
    byId('intro').textContent = 'Email дэх хамгийн сүүлд ирсэн холбоосыг бүтнээр нь дахин нээнэ үү.';
    return;
  }
  byId('title').textContent = route.title;
  document.title = `${route.title} · PRsystem`;
  byId('scope').textContent = location.pathname.includes('restaurant') ? 'Рестораны ажилтан' : 'Ажилтны эрх';
  byId('intro').textContent = route.activation ? 'Буудлынхаа Admin эрхийг ашиглах нууц үгээ үүсгэнэ үү.' : route.reset
    ? 'Шинэ нууц үг хадгалагдмагц бүх төхөөрөмжөөс гарна. Дараа нь дахин нэвтэрнэ үү.'
    : 'Урилгыг зөвшөөрснөөр танд олгосон ажлын эрх идэвхжинэ.';
  byId('account-kind').hidden = Boolean(route.reset || route.activation);
  const isNew = () => route.reset || route.activation || form.elements.kind.value === 'new';
  const update = () => {
    password.autocomplete = isNew() ? 'new-password' : 'current-password';
    byId('password-label').textContent = isNew() ? 'Шинэ нууц үг' : 'Одоогийн нууц үг';
    byId('password-help').textContent = isNew()
      ? '12–128 тэмдэгттэй нууц үг оруулна уу.'
      : 'Бүртгэлтэй бол одоогийн нууц үгээ оруулна. Урилга таны нууц үгийг солихгүй.';
  };
  form.addEventListener('change', update);
  update();
  submit.textContent = route.activation ? 'Эрх идэвхжүүлэх' : route.reset ? 'Нууц үг шинэчлэх' : 'Урилга зөвшөөрөх';
  const label = submit.textContent;
  form.hidden = false;
  byId('reveal').addEventListener('click', () => {
    const visible = password.type === 'password';
    password.type = visible ? 'text' : 'password';
    byId('reveal').textContent = visible ? 'Нуух' : 'Харуулах';
    byId('reveal').setAttribute('aria-pressed', String(visible));
  });
  byId('reveal').disabled = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !secret || event.isComposing) return;
    error.textContent = '';
    password.removeAttribute('aria-invalid');
    const length = [...password.value].length;
    if (length < (isNew() ? 12 : 1) || length > 128) {
      error.textContent = isNew() ? '12–128 тэмдэгттэй нууц үг оруулна уу.' : 'Одоогийн нууц үгээ оруулна уу.';
      password.setAttribute('aria-invalid', 'true');
      password.focus();
      return;
    }
    busy = true;
    form.setAttribute('aria-busy', 'true');
    for (const control of form.elements) control.disabled = true;
    submit.textContent = 'Хадгалж байна…';
    feedback.textContent = 'Хариуг хүлээнэ үү.';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(route.endpoint, {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({token: secret, password: password.value}), signal: controller.signal,
      });
      const data = response.status === 204 ? {} : await response.json();
      if (response.ok) {
        secret = '';
        password.value = '';
        form.hidden = true;
        say(route.activation ? 'Admin эрх идэвхжлээ. Ажлын системдээ нэвтэрнэ үү.' : route.reset ? 'Нууц үг шинэчлэгдлээ. Шинэ нууц үгээрээ дахин нэвтэрнэ үү.'
          : 'Урилга зөвшөөрөгдлөө. Ажлын системдээ нэвтэрч эрхээ ашиглана уу.');
      } else if (data.code === 'INVALID_LINK') {
        secret = '';
        password.value = '';
        form.hidden = true;
        say('Холбоос хүчингүй эсвэл ашиглагдсан байна. Хэрэв өмнөх оролдлого амжилттай болсон бол нэвтэрнэ үү. Үгүй бол шинэ холбоос авна уу.', true);
      } else {
        const messages = {
          INVALID_PASSWORD: 'Нууц үгээ шалгана уу. Шинэ нууц үг 12–128 тэмдэгттэй байна.',
          INVALID_CREDENTIALS: 'Бүртгэлтэй бол одоогийн нууц үгээ оруулна уу.',
          RATE_LIMITED: 'Хэт олон оролдлого хийсэн байна. Хэсэг хүлээгээд дахин оролдоно уу.',
        };
        password.value = '';
        say(messages[data.code] || 'Одоогоор хадгалж чадсангүй. Түр хүлээгээд дахин оролдоно уу.', true);
      }
    } catch {
      password.value = '';
      say('Хариу ирсэнгүй. Үйлдэл хийгдсэн байж болно. Нэвтрэх эсвэл холбоосоор дахин оролдоно уу.', true);
    } finally {
      clearTimeout(timeout);
      busy = false;
      for (const control of form.elements) control.disabled = false;
      form.removeAttribute('aria-busy');
      submit.textContent = label;
      password.type = 'password';
      byId('reveal').textContent = 'Харуулах';
      byId('reveal').setAttribute('aria-pressed', 'false');
    }
  });
  addEventListener('pageshow', event => {
    if (event.persisted && !secret) say('Email дэх холбоосоо дахин нээнэ үү. Энэ хуудсанд нууц утгыг хадгалдаггүй.', true);
  });
  addEventListener('pagehide', () => { secret = ''; password.value = ''; form.hidden = true; });
})();
