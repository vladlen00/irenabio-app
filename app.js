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
const CREATE_LAVA_INVOICE_URL = SUPABASE_URL + "/functions/v1/create-lava-invoice";
const RESOLVE_ORDER_URL = SUPABASE_URL + "/functions/v1/resolve-paid-order";
const ATTACH_IDENTITY_URL = SUPABASE_URL + "/functions/v1/attach-web-identity";
const VERIFY_ACCESS_URL = SUPABASE_URL + "/functions/v1/verify-access-web";
const GET_HOME_URL = SUPABASE_URL + "/functions/v1/get-home";
const GET_DAY_URL = SUPABASE_URL + "/functions/v1/get-day";
const MARK_DAY_DONE_URL = SUPABASE_URL + "/functions/v1/mark-day-done";
const PROJECT_REF = "kjzxrpwqyyjcykwbqskn";

// Lava назад не редиректит -> сохраняем order_reference (=invoice.id) в localStorage при уходе на оплату,
// по возвращении мост "Я оплатил" скармливает его в существующий поток resolve-paid-order -> пароль.
const LAVA_RETURN_KEY = "irenabio_lava_return";
const LAVA_RETURN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // мост живёт 7 дней
function stashLavaReturn(order, email) {
  try { localStorage.setItem(LAVA_RETURN_KEY, JSON.stringify({ order, email, ts: Date.now() })); } catch {}
}
function readLavaReturn() {
  try {
    const j = JSON.parse(localStorage.getItem(LAVA_RETURN_KEY) || "null");
    if (!j || !j.order || (Date.now() - (j.ts || 0)) > LAVA_RETURN_TTL_MS) return null;
    return j;
  } catch { return null; }
}
function clearLavaReturn() { try { localStorage.removeItem(LAVA_RETURN_KEY); } catch {} }

// Контакты поддержки - ЕДИНЫЙ источник. Переиспользовать на будущих экранах
// (оплата не прошла, продление, вопросы по подписке). Меняешь тут - меняется везде.
const SUPPORT = {
  email: "support@irenabio.com",
  tg: "biohack_support", // https://t.me/biohack_support
};
// Кликабельные контакты поддержки (HTML, вставлять через innerHTML).
// color:inherit - чтобы ссылки совпадали с цветом окружающего текста (в т.ч. красной ошибки).
// Отдельные хелперы под email/telegram - чтобы вставлять кастомный текст между ними.
const SUPPORT_LINK_STYLE = 'style="color:inherit;text-decoration:underline"';
function supportEmailHtml() {
  return '<a href="mailto:' + SUPPORT.email + '" ' + SUPPORT_LINK_STYLE + '>' + SUPPORT.email + '</a>';
}
function supportTgHtml() {
  return '<a href="https://t.me/' + SUPPORT.tg + '" target="_blank" rel="noopener" ' + SUPPORT_LINK_STYLE + '>@' + SUPPORT.tg + '</a>';
}
// Оба контакта через "или" - для общих экранов.
function supportContactsHtml() {
  return supportEmailHtml() + ' или ' + supportTgHtml();
}

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
  viewCheckout: document.getElementById("view-checkout"),
  viewHome: document.getElementById("view-home"),
  viewLavaReturn: document.getElementById("view-lava-return"),
  // экран пароля после оплаты
  viewPassword: document.getElementById("view-password"),
  viewAccess: document.getElementById("view-access"),
  pwForm: document.getElementById("pw-form"),
  pwEmail: document.getElementById("pw-email"),
  password: document.getElementById("password"),
  password2: document.getElementById("password2"),
  pwEye: document.getElementById("pw-eye"),
  pwError: document.getElementById("pw-error"),
  pwLoading: document.getElementById("pw-loading"),
  pwSuccess: document.getElementById("pw-success"),
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

// --- мост после оплаты Lava (Lava назад не редиректит; siteHeader/hideEntryViews заданы ниже,
//     функция вызывается только в рантайме после полного парса скрипта) ---
function showLavaReturn() {
  const r = readLavaReturn();
  hideEntryViews();
  if (siteHeader) siteHeader.hidden = false;
  if (siteFooter) siteFooter.hidden = false;
  els.viewCheckout.hidden = true;
  if (els.viewHome) els.viewHome.hidden = true;
  els.viewPassword.hidden = true;
  const em = document.getElementById("lava-return-email");
  if (em) em.textContent = r ? r.email : "";
  const msg = document.getElementById("lava-return-msg");
  if (msg) msg.hidden = true;
  els.viewLavaReturn.hidden = false;
  window.scrollTo(0, 0);
}

// --- индикатор загрузки на кнопке (защита от двойных кликов/заказов) ---
function setLoading(on, label) {
  els.btnPay.disabled = on;
  ["pay-lava-eur", "pay-lava-rub"].forEach((id) => { const b = document.getElementById(id); if (b) b.disabled = on; });
  els.btnPay.textContent = on ? (label || "Загрузка...") : "Оформить подписку";
}

// --- общий вход: валидация почты, затем ветка способа оплаты ---
async function submit(method, currency) {
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
    await payLava(email, currency === "RUB" ? "RUB" : "EUR");
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

// --- Lava: создаём инвойс через наш create-lava-invoice и уводим на оплату (app.lava.top).
//     order_reference (=invoice.id) сохраняем в localStorage для моста возврата (Lava назад не редиректит). ---
async function payLava(email, currency) {
  setLoading(true, "Открываем оплату...");
  try {
    const res = await fetch(CREATE_LAVA_INVOICE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, plan: state.plan, currency }),
    });

    let data = {};
    try { data = await res.json(); } catch { data = {}; }

    if (res.ok && data.ok && data.paymentUrl && data.order_reference) {
      stashLavaReturn(data.order_reference, email);   // мост после возврата
      window.location.href = data.paymentUrl;
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
  hideEntryViews();
  els.viewCheckout.hidden = true;
  if (els.viewLavaReturn) els.viewLavaReturn.hidden = true;
  els.viewPassword.hidden = false;
  window.scrollTo(0, 0);

  // Стартовое НЕЙТРАЛЬНОЕ состояние: ни галки/успеха, ни ошибки, пока resolve не решит.
  // Галку "Оплата прошла" показываем ТОЛЬКО после успешного resolve (иначе битая ссылка врёт успехом).
  els.pwLoading.hidden = false;
  els.pwSuccess.hidden = true;
  els.pwForm.hidden = true;
  els.pwResolveError.hidden = true;

  if (!sb) {
    els.pwLoading.hidden = true;
    els.pwSuccess.hidden = true;
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
    els.pwLoading.hidden = true;
    if (res.ok && data.ok && data.email) {
      // Заказ найден -> ТОЛЬКО теперь показываем "Оплата прошла" + форму пароля.
      state.email = data.email;
      els.pwEmail.textContent = data.email;
      els.pwSuccess.hidden = false;
      els.pwForm.hidden = false;
      els.pwResolveError.hidden = true;
    } else {
      // Битая/мусорная/устаревшая ссылка -> без галки и без "Оплата прошла", честная ошибка.
      els.pwSuccess.hidden = true;
      els.pwResolveError.innerHTML = "Ссылка недействительна или устарела. Если вы оплачивали и доступ не открылся - напишите нам на почту " + supportEmailHtml() + " или для более быстрого ответа в телеграм " + supportTgHtml() + ", проверим и поможем.";
      els.pwResolveError.hidden = false;
    }
  } catch {
    els.pwLoading.hidden = true;
    els.pwSuccess.hidden = true;
    els.pwResolveError.textContent = "Не получилось проверить оплату. Включите VPN и обновите страницу.";
    els.pwResolveError.hidden = false;
  }
}

// Экран пароля с уже известным email (Lava-мост: resolve уже прошёл в lavaEnteredClick).
function showPasswordForm(order, email, isLava) {
  state.order = order;
  state.email = email;
  state.lavaReturn = !!isLava;
  hideEntryViews();
  els.viewCheckout.hidden = true;
  if (els.viewLavaReturn) els.viewLavaReturn.hidden = true;
  els.viewPassword.hidden = false;
  els.pwLoading.hidden = true;
  els.pwResolveError.hidden = true;
  els.pwSuccess.hidden = false;
  els.pwForm.hidden = false;
  els.pwEmail.textContent = email;
  const hint = document.getElementById("pw-lava-hint");
  if (hint) hint.hidden = !isLava;
  window.scrollTo(0, 0);
}

// Мост Lava: "Я оплатил" -> resolve-paid-order по stash-заказу. Обработан -> экран пароля;
// ещё не обработан -> остаёмся на мосте с мягким сообщением (кнопка тут же для повтора).
async function lavaEnteredClick() {
  const r = readLavaReturn();
  if (!r) { showStart(); return; }
  const msg = document.getElementById("lava-return-msg");
  const btn = document.getElementById("btn-lava-entered");
  if (msg) msg.hidden = true;
  if (btn) { btn.disabled = true; btn.textContent = "Проверяем оплату..."; }
  try {
    const res = await fetch(RESOLVE_ORDER_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderReference: r.order }),
    });
    let data = {};
    try { data = await res.json(); } catch { data = {}; }
    if (res.ok && data.ok && data.email) {
      showPasswordForm(r.order, data.email, true);
      return;
    }
    if (msg) {
      msg.innerHTML = "Оплата ещё обрабатывается. Если только что оплатили на Lava - подождите минуту и нажмите ещё раз. Долго не открывается - напишите " + supportContactsHtml() + ".";
      msg.hidden = false;
    }
  } catch {
    if (msg) { msg.textContent = "Не получилось проверить оплату. Включите VPN и попробуйте снова."; msg.hidden = false; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Я оплатил, войти"; }
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
        if (data.access) { clearLavaReturn(); await routeHomeOrCheckout(); return; }  // после оплаты/пароля -> РЕАЛЬНЫЙ ДОМ, не заглушка
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
["pay-lava-eur", "pay-lava-rub"].forEach((id) => {
  const b = document.getElementById(id);
  if (b) b.addEventListener("click", (e) => { e.preventDefault(); submit("lava", b.dataset.currency); });
});
els.email.addEventListener("input", () => showEmailError(""));
// мост после оплаты Lava
{
  const be = document.getElementById("btn-lava-entered");
  if (be) be.addEventListener("click", lavaEnteredClick);
  const bb = document.getElementById("btn-lava-back");
  if (bb) bb.addEventListener("click", () => { clearLavaReturn(); showCheckout(); });
}

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

// ===================== ДОМ (контент-платформа) + РОУТИНГ =====================
// Развилка ДОБАВЛЕНА перед чекаутом. Оплатная ветка (чекаут/пароль/возврат) НЕ изменена.
const siteHeader = document.querySelector(".site-header");
const siteFooter = document.querySelector(".site-footer");
const homeEls = {
  loading: document.getElementById("home-loading"),
  content: document.getElementById("home-content"),
  herobox: document.getElementById("home-herobox"),
  sprintTitle: document.getElementById("home-sprint-title"),
  sprintBadge: document.getElementById("home-sprint-badge"),
  progressBar: document.getElementById("home-progress-bar"),
  subUntil: document.getElementById("home-sub-until"),
  supportBtn: document.getElementById("home-support-btn"),
  supportContacts: document.getElementById("home-support-contacts"),
};

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function fmtDateRu(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}
// Адаптивный заголовок: длинный (>18 символов) -> мельче (23px) и переносится в 2 строки, БЕЗ многоточия.
function setHeadline(el, text) {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("long", (text || "").length > 18);
}

function showCheckout() {
  hideEntryViews();
  if (siteHeader) siteHeader.hidden = false;
  if (siteFooter) siteFooter.hidden = false;
  if (els.viewHome) els.viewHome.hidden = true;
  if (els.viewLavaReturn) els.viewLavaReturn.hidden = true;   // мост Lava не должен висеть под чекаутом
  els.viewPassword.hidden = true;
  els.viewAccess.hidden = true;
  clearLavaReturn();   // ушли на чекаут -> сбрасываем незавершённый Lava-возврат (ложный мост)
  els.viewCheckout.hidden = false;
  // существующая инициализация чекаута (ровно как было на старте) — оплатная ветка не тронута
  if (!applyTestPlanIfRequested()) {
    readPlanFromUrl();
    writePlanToUrl();
    paintSelected();
  }
}
function showHomeShell() {
  hideEntryViews();
  if (siteHeader) siteHeader.hidden = true;
  if (siteFooter) siteFooter.hidden = true;
  els.viewCheckout.hidden = true;
  if (els.viewLavaReturn) els.viewLavaReturn.hidden = true;
  els.viewPassword.hidden = true;   // приходим из платёжного возврата -> прячем экран пароля
  els.viewAccess.hidden = true;     // старая заглушка "Доступ открыт" больше не показывается
  els.viewHome.hidden = false;
  homeEls.loading.hidden = false;
  homeEls.content.hidden = true;
}

// Рендер дома из ответа get-home (реальные данные)
function renderHome(data) {
  homeData = data;   // сохраняем для экранов спринт/день и обновления прогресса
  const sprint = data.sprint || null;
  const days = Array.isArray(data.days) ? data.days.slice().sort((a, b) => a.day_number - b.day_number) : [];
  const completed = new Set((data.progress && data.progress.completed_day_ids) || []);
  const completedVisible = days.filter((d) => completed.has(d.id)).length;
  const nextDay = days.find((d) => !completed.has(d.id)) || null;
  const sprintTitle = sprint ? sprint.title : "";

  // --- верхняя адаптивная карточка ---
  if (!sprint || days.length === 0) {
    homeEls.herobox.innerHTML =
      '<div class="home-headline">Скоро здесь появятся дни</div>' +
      '<div class="home-subhead">Контент готовится. Загляните чуть позже.</div>';
  } else if (completedVisible === 0) {
    // НОВИЧОК
    homeEls.herobox.innerHTML =
      '<div class="home-kicker">Начинаем</div>' +
      '<div class="home-headline" id="home-hl"></div>' +
      '<div class="home-cta" data-day-id="' + escapeHtml(days[0].id) + '">' +
        '<span class="home-cta-ic"><i class="ti ti-player-play"></i></span><span>Начать</span></div>';
    setHeadline(document.getElementById("home-hl"), days[0].title);
  } else if (nextDay) {
    // ВЕРНУВШИЙСЯ
    homeEls.herobox.innerHTML =
      '<div class="home-kicker">Сегодня</div>' +
      '<div class="home-headline" id="home-hl"></div>' +
      '<div class="home-cta" data-day-id="' + escapeHtml(nextDay.id) + '">' +
        '<span class="home-cta-ic"><i class="ti ti-player-play"></i></span><span>Продолжить</span></div>';
    setHeadline(document.getElementById("home-hl"), nextDay.title);
  } else {
    // все доступные дни пройдены
    homeEls.herobox.innerHTML =
      '<div class="home-kicker">СПРИНТ: ' + escapeHtml(sprintTitle) + '</div>' +
      '<div class="home-headline">Вы прошли все доступные дни</div>' +
      '<div class="home-subhead">Новые дни появятся по мере выхода. Возвращайтесь.</div>';
  }

  // --- карточка спринта ---
  homeEls.sprintTitle.textContent = sprintTitle;
  const denom = sprint && sprint.estimated_days ? sprint.estimated_days : (days.length || 0);
  const tilde = sprint && sprint.status === "active" ? "~" : "";   // идёт -> "~N", archived -> точное
  homeEls.sprintBadge.textContent = completedVisible + " из " + tilde + denom;
  const pct = denom > 0 ? Math.max(2, Math.min(100, Math.round((completedVisible / denom) * 100))) : 2;
  homeEls.progressBar.style.width = pct + "%";

  // --- статус подписки ---
  homeEls.subUntil.textContent = data.valid_until ? ("до " + fmtDateRu(data.valid_until)) : "";
  const hmenuUntil = document.getElementById("hmenu-sub-until");
  if (hmenuUntil) {
    let subText = "активна";
    if (data.valid_until) {
      const active = new Date(data.valid_until).getTime() >= Date.now();
      subText = active
        ? ("активна до " + fmtDateRu(data.valid_until))
        : ("истекла " + fmtDateRu(data.valid_until) + ", продлите");
    }
    hmenuUntil.textContent = subText;
  }

  homeEls.loading.hidden = true;
  homeEls.content.hidden = false;
  window.scrollTo(0, 0);
}

// Поддержка: раскрыть контакты (единый источник SUPPORT, как в ошибке битой ссылки)
if (homeEls.supportBtn) {
  homeEls.supportBtn.addEventListener("click", () => {
    if (homeEls.supportContacts.hidden) {
      homeEls.supportContacts.innerHTML = "Напишите нам: " + supportContactsHtml();
      homeEls.supportContacts.hidden = false;
    } else {
      homeEls.supportContacts.hidden = true;
    }
  });
}

// ===================== ПЛИТКИ: мини-аппы (пилот - Тренировки/workout) =====================
// Клик по плитке -> mint-app-token (сервер проверяет веб-подписку) -> открыть мини-апп на его
// СОБСТВЕННОМ домене с токеном во фрагменте #. Плитку видит только залогиненный с подпиской
// (дом показывается лишь после verify-access-web), поэтому mint обычно успешен.
const MINT_APP_TOKEN_URL = SUPABASE_URL + "/functions/v1/mint-app-token";
// ?v= - кэш-бост для веб-открытия, бампать при обновлении самого мини-аппа.
const MINI_APPS = {
  workout: { url: "https://vladlen00.github.io/workout/", v: "3" },
  glutes: { url: "https://vladlen00.github.io/glutes/", v: "1" },
  // biohack-трекер - один апп, экран выбирается через ?startapp= (читается App.js из search).
  podruzhka: { url: "https://biohack-tracker-blond.vercel.app/", v: "1", q: "startapp=ai" },
  zdorovie: { url: "https://biohack-tracker-blond.vercel.app/", v: "1", q: "startapp=checkin" },
  cycle: { url: "https://vladlen00.github.io/cycle/", v: "2" },
};

async function openMiniApp(appKey, tileEl) {
  const app = MINI_APPS[appKey];
  if (!app || !tileEl || tileEl.dataset.busy === "1") return;
  const sub = tileEl.querySelector(".t5s, .sheet-card-sub");
  const subText = sub ? sub.textContent : "";
  const flash = (msg) => { if (sub) { sub.textContent = msg; setTimeout(() => { sub.textContent = subText; }, 3000); } };
  tileEl.dataset.busy = "1";
  tileEl.style.opacity = "0.55";
  try {
    const token = await getToken();
    if (!token) { routeHomeOrCheckout(); return; }   // сессия потерялась -> перемаршрутизируем
    const res = await fetch(MINT_APP_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok && data.token) {
      const frag = "#irena_token=" + encodeURIComponent(data.token) +
                   "&exp=" + encodeURIComponent(data.expiresIn || 3600);
      const q = app.q ? "&" + app.q : "";   // напр. startapp=ai для biohack-экрана
      location.href = app.url + "?v=" + encodeURIComponent(app.v) + q + frag;  // уходим со страницы
      return;
    }
    // подписка не подтвердилась (редко: истекла между загрузкой дома и кликом) или сбой сервера
    flash("Не удалось открыть, обновите страницу");
  } catch {
    flash("Нет связи, проверьте интернет");
  } finally {
    tileEl.dataset.busy = "0";
    tileEl.style.opacity = "";
  }
}

// Шторки выбора. Плитка с data-group открывает свою шторку; карточки в ней (data-app) минтят
// токен и открывают нужный апп. Плитки с прямым data-app (напр. Подружка) открывают сразу.
const GROUP_SHEETS = { trainings: "trainings-sheet", trackers: "trackers-sheet" };
function openSheetByGroup(group) {
  const id = GROUP_SHEETS[group]; if (!id) return;
  const el = document.getElementById(id); if (el) el.hidden = false;
}

(function wireMiniAppTiles() {
  const tools = document.querySelector(".home-tools");
  if (tools) {
    tools.addEventListener("click", (e) => {
      const grouped = e.target.closest(".t5[data-group]");
      if (grouped) { openSheetByGroup(grouped.getAttribute("data-group")); return; }
      const tile = e.target.closest(".t5[data-app]");
      if (tile) openMiniApp(tile.getAttribute("data-app"), tile);
    });
  }
  // Делегирование на всех шторках: закрытие по фону/крестику, открытие мини-аппа по карточке.
  document.querySelectorAll(".sheet").forEach((sheet) => {
    sheet.addEventListener("click", (e) => {
      if (e.target.closest("[data-sheet-close]")) { sheet.hidden = true; return; }
      const card = e.target.closest(".sheet-card[data-app]");
      if (card) openMiniApp(card.getAttribute("data-app"), card);  // успех -> уходим; ошибка -> flash в карточке
    });
  });
})();

// ===================== ЭКРАНЫ СТАРТ / ВХОД =====================
// Незалогиненного встречает СТАРТ (выбор: войти / оформить), а не сразу checkout.
function hideEntryViews() {
  const vs = document.getElementById("view-start"); if (vs) vs.hidden = true;
  const vl = document.getElementById("view-login"); if (vl) vl.hidden = true;
}
function showStart() {
  if (siteHeader) siteHeader.hidden = false;
  if (siteFooter) siteFooter.hidden = false;
  els.viewHome.hidden = true;
  els.viewCheckout.hidden = true;
  if (els.viewLavaReturn) els.viewLavaReturn.hidden = true;
  els.viewPassword.hidden = true;
  els.viewAccess.hidden = true;
  const vl = document.getElementById("view-login"); if (vl) vl.hidden = true;
  const vs = document.getElementById("view-start"); if (vs) vs.hidden = false;
  window.scrollTo(0, 0);
}
function showLogin() {
  if (siteHeader) siteHeader.hidden = false;
  if (siteFooter) siteFooter.hidden = false;
  const vs = document.getElementById("view-start"); if (vs) vs.hidden = true;
  els.viewCheckout.hidden = true;
  const vl = document.getElementById("view-login"); if (vl) vl.hidden = false;
  showLoginError("");
  const em = document.getElementById("login-email"); if (em) em.focus();
  window.scrollTo(0, 0);
}
function showLoginError(msg, html) {
  const el = document.getElementById("login-error");
  if (!el) return;
  if (html) el.innerHTML = html; else el.textContent = msg || "";
  el.hidden = !(msg || html);
}
async function doLogin() {
  const btn = document.getElementById("btn-login");
  const email = normalizeEmail(document.getElementById("login-email").value);
  const password = document.getElementById("login-password").value || "";
  showLoginError("");
  if (!emailValid(email)) { showLoginError(EMAIL_HINT); document.getElementById("login-email").focus(); return; }
  if (password.length < 1) { showLoginError("Введите пароль."); document.getElementById("login-password").focus(); return; }
  if (!sb) { showLoginError("Не удалось загрузить вход. Обновите страницу."); return; }
  btn.disabled = true; btn.textContent = "Входим...";
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error || !data || !data.session) {
      // GoTrue не различает "нет аккаунта" и "неверный пароль" (защита от перебора) -> общий текст + путь на оформление
      showLoginError(null, "Неверная почта или пароль. Если аккаунта ещё нет — <a href=\"#\" id=\"login-err-signup\" style=\"color:inherit;text-decoration:underline\">оформите подписку</a>.");
      const l = document.getElementById("login-err-signup");
      if (l) l.addEventListener("click", (e) => { e.preventDefault(); showCheckout(); });
      btn.disabled = false; btn.textContent = "Войти";
      return;
    }
    // сессия есть -> общий роутинг: активная подписка -> ДОМ; нет -> чекаут (продление)
    await routeHomeOrCheckout();
  } catch {
    showLoginError(NET_MSG);
    btn.disabled = false; btn.textContent = "Войти";
  }
}
(function wireEntry() {
  const bind = (id, fn) => { const e = document.getElementById(id); if (e) e.addEventListener("click", fn); };
  bind("start-login", (e) => { e.preventDefault(); showLogin(); });
  bind("start-signup", (e) => { e.preventDefault(); showCheckout(); });
  bind("btn-login", (e) => { e.preventDefault(); doLogin(); });
  bind("login-back", (e) => { e.preventDefault(); showStart(); });
  bind("login-to-signup", (e) => { e.preventDefault(); showCheckout(); });
  const eye = document.getElementById("login-eye");
  const pw = document.getElementById("login-password");
  if (eye && pw) eye.addEventListener("click", () => {
    const masked = pw.type === "password";
    pw.type = masked ? "text" : "password";
    eye.textContent = masked ? "скрыть" : "показать";
  });
  const em = document.getElementById("login-email");
  if (pw) pw.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); doLogin(); } });
  if (em) em.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); doLogin(); } });
})();

// Роутинг: сессия -> get-home -> ДОМ или ЧЕКАУТ. Нет сессии -> СТАРТ (выбор войти/оформить).
async function routeHomeOrCheckout() {
  // Синхронный пик сохранённой сессии -> прячем чекаут сразу, без мигания. Нет токена -> чекаут мгновенно.
  let hasStored = false;
  try { hasStored = !!localStorage.getItem("sb-" + PROJECT_REF + "-auth-token"); } catch (e) {}
  if (!sb || !hasStored) { if (readLavaReturn()) showLavaReturn(); else showStart(); return; }

  showHomeShell(); // чекаут скрыт, показываем загрузку дома, пока проверяем доступ
  try {
    const { data } = await sb.auth.getSession();
    const token = data && data.session ? data.session.access_token : null;
    if (token) {
      const res = await fetch(GET_HOME_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      });
      if (res.ok) {
        let home = {};
        try { home = await res.json(); } catch (e) { home = {}; }
        if (home && home.access) { renderHome(home); return; }
      }
      // 403/любой не-ok -> подписки нет или кончилась -> чекаут (пусть оформит/продлит)
    }
  } catch (e) {
    // сетевой сбой / битая сессия -> безопасный дефолт: чекаут
  }
  showCheckout();
}

// ===================== ЭКРАНЫ ДЕНЬ / СПРИНТ =====================
// Данные спринта/дней берём из ответа get-home (homeData). Контент дня -> get-day.
// Экраны дня по mockups.html: шапка (назад + кикер СПРИНТ·ДЕНЬ N + заголовок) + блоки по order_index + кнопка "пройдено".
let homeData = null;
let currentDayId = null;

// ===================== ГЛОБАЛЬНЫЙ ПЛЕЕР (один <audio> над экранами + мини-плеер) =====================
// track = {dayId, blockId, title, url, host, duration}. Блок дня и мини-плеер управляют ОДНИМ аудио.
const player = (function () {
  let audio = null, track = null;
  const g = (id) => document.getElementById(id);
  function fmt(x) { x = Math.max(0, Math.floor(Number(x) || 0)); const m = Math.floor(x / 60), s = x % 60; return m + ":" + String(s).padStart(2, "0"); }
  function playTrack(t) {
    if (!audio || !t || !t.url) return;
    if (track && track.blockId === t.blockId) { toggle(); return; }
    track = t; audio.src = t.url; audio.play().catch(() => {}); show(); renderAll();
  }
  function toggle() { if (!audio || !track) return; if (audio.paused) audio.play().catch(() => {}); else audio.pause(); }
  function seek(d) { if (!audio || !track) return; const dur = isFinite(audio.duration) ? audio.duration : (track.duration || 1e9); audio.currentTime = Math.max(0, Math.min(dur, audio.currentTime + d)); }
  function seekTo(ratio) { if (!audio || !track || !isFinite(audio.duration)) return; audio.currentTime = ratio * audio.duration; }
  function dismiss() { if (!audio) return; audio.pause(); track = null; hide(); renderAll(); }
  function show() { const m = g("mini-player"); if (m) { m.hidden = false; document.body.classList.add("has-mini"); } }
  function hide() { const m = g("mini-player"); if (m) { m.hidden = true; document.body.classList.remove("has-mini"); } }
  function renderMini() {
    if (!track) { hide(); return; }
    const tt = g("mp-title-text"); if (tt) tt.textContent = track.title || "Аудио";
    const pb = g("mp-play"); const pi = pb && pb.querySelector("i"); if (pi) pi.className = audio.paused ? "ti ti-player-play" : "ti ti-player-pause";
  }
  function renderDayBlock() {
    document.querySelectorAll("#day-blocks .blk-audio").forEach((card) => {
      const isCur = track && card.getAttribute("data-block-id") === track.blockId;
      const icon = card.querySelector(".audio-play i");
      const fill = card.querySelector(".audio-bar-fill");
      const cur = card.querySelector(".audio-cur");
      const dur = card.querySelector(".audio-dur");
      if (isCur) {
        if (icon) icon.className = audio.paused ? "ti ti-player-play" : "ti ti-player-pause";
        if (isFinite(audio.duration)) { if (fill) fill.style.width = (audio.currentTime / audio.duration * 100) + "%"; if (cur) cur.textContent = fmt(audio.currentTime); if (dur) dur.textContent = fmt(audio.duration); }
      } else {
        if (icon) icon.className = "ti ti-player-play";
        if (fill) fill.style.width = "0%";
        if (cur) cur.textContent = "0:00";
      }
    });
  }
  function renderAll() { renderMini(); renderDayBlock(); }
  // force_host: подмена источника текущего трека с сохранением позиции (host сменился)
  function swapCurrentUrl(blockId, newUrl, newHost) {
    if (!audio || !track || track.blockId !== blockId || !newUrl || audio.src === newUrl) return;
    const pos = audio.currentTime, wasPlaying = !audio.paused;
    track.url = newUrl; track.host = newHost; audio.src = newUrl;
    const once = () => { try { audio.currentTime = pos; } catch (e) {} if (wasPlaying) audio.play().catch(() => {}); audio.removeEventListener("loadedmetadata", once); };
    audio.addEventListener("loadedmetadata", once);
  }
  function init() {
    audio = g("app-audio"); if (!audio) return;
    audio.addEventListener("play", renderAll);
    audio.addEventListener("pause", renderAll);
    audio.addEventListener("ended", renderAll);
    audio.addEventListener("loadedmetadata", renderAll);
    audio.addEventListener("timeupdate", renderDayBlock);
    const bind = (id, fn) => { const e = g(id); if (e) e.addEventListener("click", (ev) => { ev.preventDefault(); fn(); }); };
    bind("mp-play", toggle);
    bind("mp-back", () => seek(-15));
    bind("mp-fwd", () => seek(15));
    bind("mp-close", dismiss);
    bind("mp-title", () => { if (track) openDay(track.dayId); });
  }
  init();
  return { playTrack, toggle, seek, seekTo, dismiss, renderAll, swapCurrentUrl, current: () => track };
})();

async function getToken() {
  if (!sb) return null;
  try { const { data } = await sb.auth.getSession(); return data && data.session ? data.session.access_token : null; }
  catch { return null; }
}
function hideContentViews() {
  els.viewHome.hidden = true;
  const vs = document.getElementById("view-sprint"); if (vs) vs.hidden = true;
  const vd = document.getElementById("view-day"); if (vd) vd.hidden = true;
}
function backToHome() {
  hideContentViews();
  if (homeData) renderHome(homeData);   // перерисовка -> прогресс обновится после "пройдено"
  els.viewHome.hidden = false;
  window.scrollTo(0, 0);
}

// --- утилиты рендера блоков ---
function fmtDur(sec) { sec = Math.max(0, Math.floor(Number(sec) || 0)); const m = Math.floor(sec / 60), s = sec % 60; return m + ":" + String(s).padStart(2, "0"); }
// Мини-разметка контентных текстов: пустая строка = абзац, **жирный**, [текст](http/https-ссылка).
// Работает ПОВЕРХ escapeHtml - HTML из БД никогда не исполняется; url уже экранирован (кавычки -> &quot;).
function mdLite(s) {
  const esc = escapeHtml(s).replace(/\r\n?/g, "\n");
  const inline = (t) => t
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return esc.split(/\n{2,}/).map((p) => "<p>" + inline(p).replace(/\n/g, "<br>") + "</p>").join("");
}

function renderBlock(b) {
  switch (b.block_type) {
    case "audio": {
      const url = b.url ? escapeHtml(b.url) : "";
      const host = escapeHtml(b.host || "");
      const title = escapeHtml(b.title || "Подкаст дня");
      const durTxt = b.duration_seconds ? fmtDur(b.duration_seconds) : "0:00";
      // Контроллер (без своего <audio>): играет ОДИН глобальный app-audio через player.
      return '<div class="card blk-audio" data-block-id="' + escapeHtml(b.id) + '" data-url="' + url + '" data-host="' + host + '" data-title="' + title + '" data-duration="' + (b.duration_seconds || 0) + '">' +
        '<div class="audio-title">' + title + '</div>' +
        '<div class="audio-progress-row"><span class="audio-cur">0:00</span>' +
        '<div class="audio-bar"><div class="audio-bar-fill"></div></div>' +
        '<span class="audio-dur">' + durTxt + '</span></div>' +
        '<div class="audio-controls">' +
        '<button type="button" class="audio-seek" data-seek="-15" aria-label="Назад 15 секунд">−15</button>' +
        '<button type="button" class="audio-play" aria-label="Слушать"><i class="ti ti-player-play"></i></button>' +
        '<button type="button" class="audio-seek" data-seek="15" aria-label="Вперёд 15 секунд">+15</button>' +
        '</div>' +
        '<div class="audio-hosthint" data-host="' + host + '">Звук не грузится? Нажмите здесь</div>' +
        '</div>';
    }
    case "text":
      return '<div class="blk-text"><div class="blk-text-body">' + mdLite(b.content_text || "") + '</div>' +
        '<button type="button" class="blk-text-more" hidden>Читать дальше</button></div>';
    case "image": {
      const url = b.url ? escapeHtml(b.url) : "";
      const cap = b.content_text ? '<div class="blk-image-cap">' + mdLite(b.content_text) + '</div>' : "";
      return '<div class="card blk-image">' + (url ? '<img src="' + url + '" alt="' + escapeHtml(b.title || "") + '" loading="lazy">' : "") + cap + '</div>';
    }
    case "video": {
      const raw = b.content_url || "";
      const src = /^https?:\/\//.test(raw) ? raw : ("https://kinescope.io/embed/" + encodeURIComponent(raw));
      const title = b.title ? '<div class="blk-video-title">' + escapeHtml(b.title) + '</div>' : "";
      return '<div class="card blk-video"><div class="blk-video-frame">' +
        '<iframe src="' + escapeHtml(src) + '" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>' +
        '<div class="blk-video-cap"><div class="blk-video-kick">Тренировка дня</div>' + title + '</div></div>';
    }
    case "task":
      return '<div class="blk-task"><div class="blk-task-h"><i class="ti ti-pin"></i><span>ЗАДАНИЕ ДНЯ</span></div>' +
        (b.title ? '<div class="blk-task-title">' + escapeHtml(b.title) + '</div>' : "") +
        '<div class="blk-task-text">' + mdLite(b.content_text || "") + '</div></div>';
    default:
      return "";
  }
}

// Оживляем блоки: аудиоплеер (play/пауза/прогресс/перемотка), строка force_host, "читать дальше".
function wireBlocks(root) {
  root.querySelectorAll(".blk-audio").forEach((card) => {
    const bid = card.getAttribute("data-block-id");
    const url = card.getAttribute("data-url");
    const host = card.getAttribute("data-host");
    const title = card.getAttribute("data-title");
    const duration = Number(card.getAttribute("data-duration")) || 0;
    const trackOf = () => ({ dayId: currentDayId, blockId: bid, title, url, host, duration });
    const playBtn = card.querySelector(".audio-play");
    if (playBtn) playBtn.addEventListener("click", () => { if (url) player.playTrack(trackOf()); });
    card.querySelectorAll(".audio-seek").forEach((sb) => sb.addEventListener("click", () => {
      const d = Number(sb.getAttribute("data-seek")) || 0;
      const cur = player.current();
      if (cur && cur.blockId === bid) player.seek(d);
      else if (url) { player.playTrack(trackOf()); player.seek(d); }
    }));
    const bar = card.querySelector(".audio-bar");
    if (bar) bar.addEventListener("click", (e) => {
      const cur = player.current();
      if (!(cur && cur.blockId === bid)) return;
      const r = bar.getBoundingClientRect();
      player.seekTo(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
    });
    // force_host: неприметное ручное переключение хранилища (без слов про хостинги)
    const hint = card.querySelector(".audio-hosthint");
    if (hint) hint.addEventListener("click", () => {
      if (hint.classList.contains("busy")) return;
      const used = hint.getAttribute("data-host");
      const other = used === "timeweb" ? "minio" : "timeweb";
      hint.classList.add("busy");
      hint.textContent = "Переключаем, попробуйте ещё раз…";
      openDay(currentDayId, other);
    });
  });
  // "читать дальше" — сворачиваем только реально длинный текст
  root.querySelectorAll(".blk-text").forEach((wrap) => {
    const body = wrap.querySelector(".blk-text-body");
    const more = wrap.querySelector(".blk-text-more");
    requestAnimationFrame(() => {
      const linePx = parseFloat(getComputedStyle(body).lineHeight) || 22;
      if (body.scrollHeight > linePx * 7.5) {
        body.classList.add("clamped");
        more.hidden = false;
        more.addEventListener("click", () => {
          const clamped = body.classList.toggle("clamped");
          more.textContent = clamped ? "Читать дальше" : "Свернуть";
        });
      }
    });
  });
  player.renderAll();   // отразить живое состояние глоб. аудио на перерисованных блоках
}

function setDoneState(btn, done) {
  if (done) { btn.classList.add("done"); btn.disabled = true; btn.innerHTML = '<i class="ti ti-check"></i> День пройден'; }
  else { btn.classList.remove("done"); btn.disabled = false; btn.innerHTML = '<i class="ti ti-circle-check"></i> Отметить день пройденным'; }
}

function renderDay(data) {
  const day = data.day || {};
  document.getElementById("day-kicker").textContent = ((day.sprint_title || "") + " · ДЕНЬ " + (day.day_number || "")).toUpperCase();
  setHeadline(document.getElementById("day-title"), day.title || "");
  const blocksEl = document.getElementById("day-blocks");
  const blocks = (data.blocks || []).slice().sort((a, b) => a.order_index - b.order_index);
  blocksEl.innerHTML = blocks.map(renderBlock).join("");
  wireBlocks(blocksEl);
  // force_host: текущий трек из этого дня и сменилось хранилище -> подменить источник, сохранив позицию
  const curTrk = player.current();
  if (curTrk && curTrk.dayId === day.id) {
    const el = blocksEl.querySelector('.blk-audio[data-block-id="' + curTrk.blockId + '"]');
    if (el && el.getAttribute("data-host") !== curTrk.host) player.swapCurrentUrl(curTrk.blockId, el.getAttribute("data-url"), el.getAttribute("data-host"));
  }
  const doneBtn = document.getElementById("day-done");
  const completed = new Set((homeData && homeData.progress && homeData.progress.completed_day_ids) || []);
  doneBtn.hidden = false;
  setDoneState(doneBtn, completed.has(day.id));
}

// Открыть день: get-day -> рендер блоков. forceHost (timeweb|minio) — ручное переключение хранилища.
async function openDay(dayId, forceHost) {
  currentDayId = dayId;
  hideContentViews();
  document.getElementById("view-day").hidden = false;
  const loading = document.getElementById("day-loading");
  const blocksEl = document.getElementById("day-blocks");
  const doneBtn = document.getElementById("day-done");
  const errEl = document.getElementById("day-error");
  loading.hidden = false; blocksEl.innerHTML = ""; doneBtn.hidden = true; errEl.hidden = true;
  if (!forceHost) window.scrollTo(0, 0);
  const token = await getToken();
  if (!token) { loading.hidden = true; errEl.textContent = "Сессия истекла. Обновите страницу."; errEl.hidden = false; return; }
  try {
    const body = { day_id: dayId };
    if (forceHost) body.force_host = forceHost;
    const res = await fetch(GET_DAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify(body),
    });
    let data = {}; try { data = await res.json(); } catch { data = {}; }
    loading.hidden = true;
    if (!res.ok || !data.access) {
      errEl.innerHTML = "Не удалось открыть день. Обновите страницу или напишите нам " + supportEmailHtml() + ".";
      errEl.hidden = false; return;
    }
    renderDay(data);
  } catch {
    loading.hidden = true;
    errEl.textContent = "Не получилось загрузить. Включите VPN и обновите страницу.";
    errEl.hidden = false;
  }
}

async function markDone() {
  const btn = document.getElementById("day-done");
  if (btn.classList.contains("done") || btn.disabled) return;
  const dayId = currentDayId; if (!dayId) return;
  btn.disabled = true; btn.innerHTML = '<i class="ti ti-circle-check"></i> Отмечаем…';
  const token = await getToken();
  if (!token) { setDoneState(btn, false); return; }
  try {
    const res = await fetch(MARK_DAY_DONE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({ day_id: dayId }),
    });
    let data = {}; try { data = await res.json(); } catch { data = {}; }
    if (res.ok && data.ok) {
      setDoneState(btn, true);
      if (homeData) {
        homeData.progress = homeData.progress || { completed_day_ids: [], completed_count: 0 };
        const s = new Set(homeData.progress.completed_day_ids || []);
        s.add(dayId);
        homeData.progress.completed_day_ids = Array.from(s);
        homeData.progress.completed_count = s.size;
      }
    } else {
      setDoneState(btn, false);
    }
  } catch {
    setDoneState(btn, false);
  }
}

// Имя дня для карточки списка спринта: срезаем префикс "День N." (номер уже в сером eyebrow).
// Без префикса возвращает title как есть; пустой результат -> фолбэк на оригинал.
function dayShortTitle(title) {
  const t = (title || "").trim();
  return t.replace(/^День\s*\d+\.?\s*/i, "").trim() || t;
}

// Экран спринта: список дней из homeData (доступные по publish_at уже отфильтрованы get-home).
function openSprint() {
  if (!homeData || !homeData.sprint) return;
  hideContentViews();
  document.getElementById("view-sprint").hidden = false;
  const sprint = homeData.sprint;
  const days = (homeData.days || []).slice().sort((a, b) => a.day_number - b.day_number);
  const completed = new Set((homeData.progress && homeData.progress.completed_day_ids) || []);
  const completedVisible = days.filter((d) => completed.has(d.id)).length;
  const nextDay = days.find((d) => !completed.has(d.id)) || null;
  document.getElementById("sprint-kicker").textContent = "СПРИНТ";
  setHeadline(document.getElementById("sprint-title"), sprint.title || "");
  document.getElementById("sprint-sub").textContent = "Авторская методика · проходите в своём темпе";
  const denom = sprint.estimated_days || days.length || 0;
  const tilde = sprint.status === "active" ? "~" : "";
  document.getElementById("sprint-badge").textContent = completedVisible + " из " + tilde + denom;
  const pct = denom > 0 ? Math.max(2, Math.min(100, Math.round(completedVisible / denom * 100))) : 2;
  document.getElementById("sprint-bar").style.width = pct + "%";
  let html = "";
  days.forEach((d) => {
    const done = completed.has(d.id);
    const isNext = nextDay && d.id === nextDay.id;
    const cls = "sprint-day" + (done ? " done-day" : "") + (isNext ? " next" : "");
    const icon = done ? "ti-check" : (isNext ? "ti-player-play" : "ti-circle");
    const badge = done ? "Пройден" : (isNext ? "Продолжить" : "");
    html += '<div class="' + cls + '" data-day-id="' + escapeHtml(d.id) + '">' +
      '<div class="sprint-day-ic"><i class="ti ' + icon + '"></i></div>' +
      '<div class="sprint-day-main"><div class="sprint-day-num">День ' + d.day_number + '</div>' +
      '<div class="sprint-day-title">' + escapeHtml(dayShortTitle(d.title)) + '</div>' +
      (d.subtitle && d.subtitle.trim() ? '<div class="sprint-day-sub">' + escapeHtml(d.subtitle.trim()) + '</div>' : '') +
      '</div>' +
      (badge ? '<div class="sprint-day-badge">' + badge + '</div>' : "") +
      '</div>';
  });
  document.getElementById("sprint-days").innerHTML = html;
  window.scrollTo(0, 0);
}

// Навигация: клики дома -> день/спринт, кнопки "назад", "пройдено" (делегирование + статичные кнопки).
(function wireNav() {
  const dayBack = document.getElementById("day-back");
  const sprintBack = document.getElementById("sprint-back");
  const dayDone = document.getElementById("day-done");
  if (dayBack) dayBack.addEventListener("click", backToHome);
  if (sprintBack) sprintBack.addEventListener("click", backToHome);
  if (dayDone) dayDone.addEventListener("click", markDone);
  document.addEventListener("click", (e) => {
    const cta = e.target.closest(".home-cta[data-day-id]");
    if (cta) { openDay(cta.getAttribute("data-day-id")); return; }
    const all = e.target.closest("#home-alldays");
    if (all) { openSprint(); return; }
    const sd = e.target.closest(".sprint-day[data-day-id]");
    if (sd && !sd.classList.contains("locked")) { openDay(sd.getAttribute("data-day-id")); return; }
  });
})();

// --- старт: ветвление возврат-после-оплаты / дом / чекаут ---
const startParams = new URLSearchParams(location.search);
if (startParams.get("paid") === "1" && startParams.get("order")) {
  enterPaymentReturn(startParams.get("order"));   // оплатный возврат — без изменений
} else {
  routeHomeOrCheckout();                           // НОВОЕ: дом ИЛИ чекаут
}
