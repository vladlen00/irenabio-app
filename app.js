// irenabio-app: чекаут + возврат после оплаты (экран пароля) + заглушка доступа.
// WayForPay (основная кнопка): create-checkout -> {ok:true, invoiceUrl} -> редирект на оплату.
//   person создаётся внутри create-checkout, отдельный register-person не нужен.
// Lava (ссылка "другой способ"): пока заглушка register-person -> экран "аккаунт создан".
// Возврат с оплаты (?paid=1&order=): resolve-paid-order -> пароль -> signUp/signIn ->
//   attach-web-identity -> verify-access-web (с ретраями) -> "Доступ открыт".
// Чекаут на чистом fetch; supabase-js (CDN) только для auth-экранов (пароль+гейт).

const SUPABASE_URL = "https://kjzxrpwqyyjcykwbqskn.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_pOloEHMZ5QjMhnbfhygqmA_CQPSP1hU";
const CREATE_CHECKOUT_URL = SUPABASE_URL + "/functions/v1/create-checkout";
const REGISTER_URL = SUPABASE_URL + "/functions/v1/register-person";
const RESOLVE_ORDER_URL = SUPABASE_URL + "/functions/v1/resolve-paid-order";
const ATTACH_IDENTITY_URL = SUPABASE_URL + "/functions/v1/attach-web-identity";
const VERIFY_ACCESS_URL = SUPABASE_URL + "/functions/v1/verify-access-web";

const PLANS = {
  "1m":  { months: 1,  eur: 11, label: "1 месяц" },
  "6m":  { months: 6,  eur: 55, label: "6 месяцев" },
  "12m": { months: 12, eur: 99, label: "12 месяцев" },
};

// Состояние. plan и method переживут шаг оплаты (plan дублируем в URL).
const state = {
  plan: "6m",
  method: "wayforpay", // wayforpay | lava
};

const els = {
  form: document.getElementById("checkout-form"),
  plans: document.getElementById("plans"),
  email: document.getElementById("email"),
  emailError: document.getElementById("email-error"),
  formError: document.getElementById("form-error"),
  btnPay: document.getElementById("btn-pay"),
  altLink: document.getElementById("alt-pay-link"),
  viewCheckout: document.getElementById("view-checkout"),
  viewPending: document.getElementById("view-pending"),
  pendingPlan: document.getElementById("pending-plan"),
  pendingEmail: document.getElementById("pending-email"),
  btnBack: document.getElementById("btn-back"),
  // экран пароля после оплаты
  viewPassword: document.getElementById("view-password"),
  viewAccess: document.getElementById("view-access"),
  pwForm: document.getElementById("pw-form"),
  pwEmail: document.getElementById("pw-email"),
  password: document.getElementById("password"),
  password2: document.getElementById("password2"),
  pwEye: document.getElementById("pw-eye"),
  pwError: document.getElementById("pw-error"),
  pwResolveError: document.getElementById("pw-resolve-error"),
  btnEnter: document.getElementById("btn-enter"),
  btnRetry: document.getElementById("btn-retry"),
  accessUntil: document.getElementById("access-until"),
};

// supabase-js клиент (только auth-экраны). Гард: если CDN не загрузился, чекаут не ломаем.
const sb = (window.supabase && window.supabase.createClient)
  ? window.supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY)
  : null;

// --- URL <-> state (тариф переживает перезагрузку, пригодится шагу оплаты) ---
function readPlanFromUrl() {
  const p = new URLSearchParams(location.search).get("plan");
  if (p && PLANS[p]) {
    state.plan = p;
    const radio = els.plans.querySelector(`input[value="${p}"]`);
    if (radio) radio.checked = true;
  }
}
function writePlanToUrl() {
  const url = new URL(location.href);
  url.searchParams.set("plan", state.plan);
  history.replaceState(null, "", url);
}

// --- подсветка выбранной карточки (дубль к :has для старых WebView) ---
function paintSelected() {
  els.plans.querySelectorAll(".plan").forEach((label) => {
    const input = label.querySelector("input");
    label.classList.toggle("selected", input.checked);
  });
}

// --- email ---
function normalizeEmail(raw) {
  return String(raw || "").trim().toLowerCase();
}
function emailValid(email) {
  return email.length >= 6 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// --- сообщения об ошибке ---
function showEmailError(msg) {
  els.emailError.textContent = msg || "";
  els.emailError.hidden = !msg;
}
function showFormError(msg) {
  els.formError.textContent = msg || "";
  els.formError.hidden = !msg;
}
function clearErrors() {
  showEmailError("");
  showFormError("");
}
const EMAIL_HINT = "Проверьте адрес почты. Пример: ваша@почта.com";
const RATE_MSG = "Слишком много попыток. Подождите минуту и попробуйте снова.";
// Сетевой сбой у аудитории в заблокированных регионах лечит VPN.
const NET_MSG = "Не получилось связаться с сервером. Включите VPN и попробуйте снова.";

// --- экраны ---
function goPending(email) {
  const plan = PLANS[state.plan];
  els.pendingPlan.textContent = `Тариф: ${plan.label}, ${plan.eur} EUR`;
  els.pendingEmail.textContent = email;
  els.viewCheckout.hidden = true;
  els.viewPending.hidden = false;
  window.scrollTo(0, 0);
}
function goCheckout() {
  els.viewPending.hidden = true;
  els.viewCheckout.hidden = false;
}

// --- индикатор загрузки на кнопке (защита от двойных кликов/заказов) ---
function setLoading(on, label) {
  els.btnPay.disabled = on;
  els.altLink.classList.toggle("disabled", on);
  els.btnPay.textContent = on ? (label || "Загрузка...") : "Оформить подписку";
}

// --- общий вход: валидация почты, затем ветка способа оплаты ---
async function submit(method) {
  clearErrors();
  state.method = method;

  const email = normalizeEmail(els.email.value);
  if (!emailValid(email)) {
    showEmailError(EMAIL_HINT);
    els.email.focus();
    return;
  }

  if (method === "wayforpay") {
    await payWayforpay(email);
  } else {
    await registerStub(email); // lava - пока заглушка
  }
}

// --- WayForPay: создаём заказ на сервере и уводим на страницу оплаты ---
async function payWayforpay(email) {
  setLoading(true, "Открываем оплату...");
  try {
    const res = await fetch(CREATE_CHECKOUT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, plan: state.plan, method: "wayforpay" }),
    });

    let data = {};
    try { data = await res.json(); } catch { data = {}; }

    if (res.ok && data.ok && data.invoiceUrl) {
      // Успех: уходим на оплату. Кнопку НЕ разблокируем - страница сейчас сменится.
      window.location.href = data.invoiceUrl;
      return;
    }

    if (res.status === 429) {
      showFormError(RATE_MSG);
    } else if (res.status === 400 || data.error === "invalid_email") {
      showEmailError(EMAIL_HINT);
    } else {
      showFormError("Не удалось открыть оплату. Попробуйте ещё раз.");
    }
    setLoading(false);
  } catch (err) {
    showFormError(NET_MSG);
    setLoading(false);
  }
}

// --- Lava (пока заглушка): тихо создаём person, показываем экран ожидания оплаты ---
async function registerStub(email) {
  setLoading(true, "Создаём аккаунт...");
  try {
    const res = await fetch(REGISTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    if (res.status === 429) {
      showFormError(RATE_MSG);
      return;
    }

    let data = {};
    try { data = await res.json(); } catch { data = {}; }

    if (res.ok && data.ok) {
      goPending(email);
      return;
    }
    if (res.status === 400 || data.error === "invalid_email") {
      showEmailError(EMAIL_HINT);
      return;
    }
    showFormError("Что-то пошло не так. Попробуйте ещё раз через минуту.");
  } catch (err) {
    showFormError(NET_MSG);
  } finally {
    setLoading(false);
  }
}

// ===================== ВОЗВРАТ ПОСЛЕ ОПЛАТЫ: ЭКРАН ПАРОЛЯ =====================
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function showPwError(msg) { els.pwError.textContent = msg || ""; els.pwError.hidden = !msg; }
function pwLoading(on, label) {
  els.btnEnter.disabled = on;
  els.password.disabled = on;
  els.password2.disabled = on;
  els.btnEnter.textContent = on ? (label || "Минутку...") : "Открыть доступ";
}

// Гейт кнопки: активна только когда первый пароль >=8 и второй точно совпадает.
function validatePw() {
  const p1 = els.password.value || "";
  const p2 = els.password2.value || "";
  const ok = p1.length >= 8 && p2.length > 0 && p1 === p2;
  els.btnEnter.disabled = !ok;
  showPwError(p2.length > 0 && p1 !== p2 ? "Пароли не совпадают." : "");
  return ok;
}

// Вход на возврате с оплаты: показать экран пароля, подставить email по оплаченному заказу.
async function enterPaymentReturn(order) {
  state.order = order;
  els.viewCheckout.hidden = true;
  els.viewPending.hidden = true;
  els.viewPassword.hidden = false;
  window.scrollTo(0, 0);

  if (!sb) {
    els.pwForm.hidden = true;
    els.pwResolveError.textContent = "Не удалось загрузить вход. Обновите страницу.";
    els.pwResolveError.hidden = false;
    return;
  }
  try {
    const res = await fetch(RESOLVE_ORDER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderReference: order }),
    });
    let data = {};
    try { data = await res.json(); } catch { data = {}; }
    if (res.ok && data.ok && data.email) {
      state.email = data.email;
      els.pwEmail.textContent = data.email;
      els.pwForm.hidden = false;
      els.pwResolveError.hidden = true;
    } else {
      els.pwForm.hidden = true;
      els.pwResolveError.textContent = "Не видим оплату по этой ссылке. Если вы оплачивали и доступ не открылся - напишите в поддержку, проверим.";
      els.pwResolveError.hidden = false;
    }
  } catch {
    els.pwForm.hidden = true;
    els.pwResolveError.textContent = "Не получилось проверить оплату. Включите VPN и обновите страницу.";
    els.pwResolveError.hidden = false;
  }
}

// Confirm email OFF -> signUp сразу даёт сессию. Существующий email -> нет сессии ->
// пробуем signIn тем же паролем (идемпотентно, покрывает двойной клик и повторный возврат).
async function signUpOrSignIn(email, password) {
  const up = await sb.auth.signUp({ email, password });
  if (up.data && up.data.session) return { session: up.data.session };
  const inn = await sb.auth.signInWithPassword({ email, password });
  if (inn.data && inn.data.session) return { session: inn.data.session };
  return { error: true };
}

async function onEnter() {
  showPwError("");
  els.btnRetry.hidden = true;
  const password = els.password.value || "";
  const password2 = els.password2.value || "";
  if (password.length < 8) {
    showPwError("Пароль минимум 8 символов.");
    els.password.focus();
    return;
  }
  if (password !== password2) {
    showPwError("Пароли не совпадают.");
    els.password2.focus();
    return;
  }
  pwLoading(true, "Входим...");
  try {
    const r = await signUpOrSignIn(state.email, password);
    if (r.error || !r.session) {
      showPwError("Аккаунт с этой почтой уже есть. Введите пароль от него.");
      pwLoading(false);
      return;
    }
    await attachAndVerify(r.session.access_token);
  } catch {
    showPwError(NET_MSG);
    pwLoading(false);
  }
}

// Склейка identity (идемпотентна) + проверка доступа с ретраями (гонка с вебхуком).
async function attachAndVerify(accessToken) {
  pwLoading(true, "Открываем доступ...");
  // 1) привязка supabase-логина к оплатившему person
  try {
    const a = await fetch(ATTACH_IDENTITY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + accessToken },
      body: JSON.stringify({ orderReference: state.order }),
    });
    if (!a.ok) {
      showPwError("Не удалось открыть доступ. Нажмите «Повторить».");
      els.btnRetry.hidden = false;
      pwLoading(false);
      return;
    }
  } catch {
    showPwError(NET_MSG);
    els.btnRetry.hidden = false;
    pwLoading(false);
    return;
  }
  // 2) проверка доступа: 3 попытки по ~2с (вебхук мог ещё не активировать подписку)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const v = await fetch(VERIFY_ACCESS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + accessToken },
      });
      if (v.ok) {
        let data = {};
        try { data = await v.json(); } catch { data = {}; }
        if (data.access) { showAccess(data.valid_until); return; }
      } else if (v.status === 401) {
        showPwError("Сессия не подтвердилась. Обновите страницу и войдите снова.");
        pwLoading(false);
        return;
      }
      // 403 -> доступ ещё не выдан, ждём и ретраим
    } catch {
      // сетевой сбой -> тоже подождём и ретраим
    }
    if (attempt < 3) await sleep(2000);
  }
  showPwError("Оплата обрабатывается. Обновите через минуту - доступ откроется. Если нет - напишите в поддержку.");
  els.btnRetry.hidden = false;
  pwLoading(false);
}

function showAccess(validUntil) {
  els.viewPassword.hidden = true;
  els.viewAccess.hidden = false;
  if (validUntil) {
    const d = new Date(validUntil);
    if (!isNaN(d.getTime())) {
      els.accessUntil.textContent = d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
    }
  }
  window.scrollTo(0, 0);
}

// --- слушатели ---
els.plans.addEventListener("change", (e) => {
  if (e.target.name === "plan" && PLANS[e.target.value]) {
    state.plan = e.target.value;
    writePlanToUrl();
    paintSelected();
  }
});
els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  submit(els.btnPay.dataset.method); // wayforpay
});
els.altLink.addEventListener("click", (e) => {
  e.preventDefault();
  if (els.altLink.classList.contains("disabled")) return;
  submit(els.altLink.dataset.method); // lava
});
els.email.addEventListener("input", () => showEmailError(""));
els.btnBack.addEventListener("click", goCheckout);

// слушатели экрана пароля
els.btnEnter.addEventListener("click", onEnter);
els.password.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onEnter(); } });
els.password2.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onEnter(); } });
els.password.addEventListener("input", validatePw);
els.password2.addEventListener("input", validatePw);
els.pwEye.addEventListener("click", () => {
  const masked = els.password.type === "password";
  els.password.type = masked ? "text" : "password";
  els.pwEye.textContent = masked ? "скрыть" : "показать";
});
els.btnRetry.addEventListener("click", async () => {
  showPwError("");
  els.btnRetry.hidden = true;
  if (!sb) return;
  const { data } = await sb.auth.getSession();
  if (data && data.session) await attachAndVerify(data.session.access_token);
  else showPwError("Сессия истекла. Обновите страницу и войдите снова.");
});

// TEST-TARIFF: тариф "test" доступен ТОЛЬКО через ?plan=test, в списке тарифов не показан.
// Прячем боевые карточки, показываем заметку. state.plan='test' уходит в create-checkout.
// Удалить после теста (этот блок + #test-note в index.html + строку test в create-checkout).
const TEST_PLAN = "test";
function applyTestPlanIfRequested() {
  if (new URLSearchParams(location.search).get("plan") !== TEST_PLAN) return false;
  state.plan = TEST_PLAN;
  els.plans.hidden = true;
  const note = document.getElementById("test-note");
  if (note) note.hidden = false;
  writePlanToUrl();
  return true;
}

// --- старт: ветвление чекаут / возврат после оплаты ---
const startParams = new URLSearchParams(location.search);
if (startParams.get("paid") === "1" && startParams.get("order")) {
  enterPaymentReturn(startParams.get("order"));
} else if (!applyTestPlanIfRequested()) {
  readPlanFromUrl();
  writePlanToUrl();
  paintSelected();
}
