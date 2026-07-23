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
const RESET_PASSWORD_URL = SUPABASE_URL + "/functions/v1/reset-password";   // сброс пароля по номеру заказа
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
// newTab: true = попап открылся (WFP-вкладка вернётся по returnUrl -> заглушка);
//         false = ушли редиректом в ЭТОЙ вкладке (returnUrl вернёт сюда же -> сразу пароль).
function stashLavaReturn(order, email, method, newTab) {
  try { localStorage.setItem(LAVA_RETURN_KEY, JSON.stringify({ order, email, method: method || "lava", newTab: !!newTab, ts: Date.now() })); } catch {}
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
  email: "",
  lavaCurrency: "RUB", // RUB | EUR (экран 2)
  preparedInvoice: null, // {key,url,order,ts} - пре-фетч Lava-инвойса (reuse-by-key)
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
  viewLavaReturn: document.getElementById("view-lava-return"), // удалён из DOM -> null, использования под if()
  viewLavaCurrency: document.getElementById("view-lava-currency"),
  viewPayGo: document.getElementById("view-pay-go"),
  viewPayWait: document.getElementById("view-pay-wait"),
  viewPayTabReturn: document.getElementById("view-pay-tab-return"),
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

// ===================== НОВЫЙ ПОТОК ОПЛАТЫ (экраны 2/3/4 + заглушка вкладки + опрос) =====================
let payPollTimer = null, payPollStart = 0;
const PAY_POLL_INTERVAL_MS = 4000;
const PAY_POLL_MAX_MS = 15 * 60 * 1000;

// Спрятать экраны 2/3/4 + заглушку вкладки оплаты + остановить опрос.
function hidePayFlowExtra() {
  if (els.viewLavaCurrency) els.viewLavaCurrency.hidden = true;
  if (els.viewPayGo) els.viewPayGo.hidden = true;
  if (els.viewPayWait) els.viewPayWait.hidden = true;
  if (els.viewPayTabReturn) els.viewPayTabReturn.hidden = true;
  stopPayPoll();
}
// Базовое состояние экранов "колонки" (шапка/футер видны, контентные экраны скрыты).
function hideCoreViews() {
  hideEntryViews();
  if (siteHeader) siteHeader.hidden = false;
  if (siteFooter) siteFooter.hidden = false;
  els.viewCheckout.hidden = true;
  if (els.viewHome) els.viewHome.hidden = true;
  els.viewPassword.hidden = true;
  els.viewAccess.hidden = true;
}

// --- экран 1 -> WFP: своя returnUrl -> редирект в ЭТОЙ вкладке, БЕЗ экрана 3 и новой вкладки.
// WFP вернётся по returnUrl -> ?paid=1&order= -> enterPaymentReturn (пароль). ---
async function goCheckoutSubmit() {
  clearErrors();
  const email = normalizeEmail(els.email.value);
  if (!emailValid(email)) { showEmailError(EMAIL_HINT); els.email.focus(); return; }
  state.method = "wayforpay";
  state.email = email;
  clearLavaReturn();   // WFP не использует stash; чистим, чтобы бут на возврате не ушёл в заглушку
  const btn = els.btnPay;
  if (btn) { btn.disabled = true; btn.textContent = "Открываем оплату..."; }
  try {
    const res = await fetch(CREATE_CHECKOUT_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, plan: state.plan, method: "wayforpay" }),
    });
    let data = {}; try { data = await res.json(); } catch {}
    if (res.ok && data.ok && data.invoiceUrl) { window.location.href = data.invoiceUrl; return; }
    if (res.status === 429) showFormError(RATE_MSG);
    else if (res.status === 400 || data.error === "invalid_email") showEmailError(EMAIL_HINT);
    else showFormError("Не удалось открыть оплату. Попробуйте ещё раз.");
    if (btn) { btn.disabled = false; btn.textContent = "Оплатить"; }
  } catch {
    showFormError(NET_MSG);
    if (btn) { btn.disabled = false; btn.textContent = "Оплатить"; }
  }
}
// --- экран 1 -> ссылка "Оплатить в рублях": та же валидация, дальше экран 2 (выбор валюты) ---
function goLavaCurrency() {
  clearErrors();
  const email = normalizeEmail(els.email.value);
  if (!emailValid(email)) { showEmailError(EMAIL_HINT); els.email.focus(); return; }
  state.method = "lava";
  state.email = email;
  showLavaCurrency();
}
// .selected как JS-фолбэк к :has() для старых iOS WebView.
function paintCur() {
  const opts = document.getElementById("cur-opts");
  if (!opts) return;
  opts.querySelectorAll(".cur-opt").forEach((l) => { const i = l.querySelector("input"); l.classList.toggle("selected", i.checked); });
}
function showLavaCurrency() {
  hideCoreViews(); hidePayFlowExtra();
  const lp = document.getElementById("lavacur-plan");
  if (lp) lp.textContent = (PLANS[state.plan] || {}).label || "";
  const err = document.getElementById("lavacur-error"); if (err) err.hidden = true;
  paintCur();
  els.viewLavaCurrency.hidden = false;
  window.scrollTo(0, 0);
}
// --- экран 3 (ТОЛЬКО Lava): пре-фетч инвойса ДО клика, чтобы window.open получил готовый URL
// СИНХРОННО в жесте (иначе iOS молча не навигирует about:blank после await -> белая вкладка). ---
let lavaPrepToken = 0;
const PREP_TTL_MS = 10 * 60 * 1000;
function invoiceKey() { return state.email + "|" + state.plan + "|" + state.lavaCurrency; }

function showPayGo() {
  hideCoreViews(); hidePayFlowExtra();
  const e = document.getElementById("pay-go-error"); if (e) e.hidden = true;
  els.viewPayGo.hidden = false;
  window.scrollTo(0, 0);
  prepareLavaInvoice();   // готовим инвойс сразу; кнопка активна, когда URL готов
}

// Создаём инвойс заранее. REUSE-BY-KEY: тот же email|plan|currency в пределах TTL -> НЕ плодим
// новый инвойс, берём готовый. Новый только при смене ключа. guard-токен отбрасывает устаревший
// in-flight пре-фетч (ушли назад / сменили валюту).
async function prepareLavaInvoice() {
  const btn = document.getElementById("btn-pay-go");
  const errEl = document.getElementById("pay-go-error");
  if (errEl) errEl.hidden = true;
  const key = invoiceKey();
  const cached = state.preparedInvoice;
  if (cached && cached.key === key && cached.url && (Date.now() - cached.ts) < PREP_TTL_MS) {
    if (btn) { btn.disabled = false; btn.textContent = "Перейти к оплате"; }
    return;
  }
  const token = ++lavaPrepToken;
  if (btn) { btn.disabled = true; btn.textContent = "Готовим оплату..."; }
  try {
    const currency = state.lavaCurrency === "EUR" ? "EUR" : "RUB";
    const res = await fetch(CREATE_LAVA_INVOICE_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: state.email, plan: state.plan, currency }),
    });
    if (token !== lavaPrepToken) return;   // устаревший пре-фетч -> игнор
    let data = {}; try { data = await res.json(); } catch {}
    if (res.ok && data.ok && data.paymentUrl && data.order_reference) {
      state.preparedInvoice = { key, url: data.paymentUrl, order: data.order_reference, ts: Date.now() };
      if (btn) { btn.disabled = false; btn.textContent = "Перейти к оплате"; }
    } else {
      if (errEl) { errEl.textContent = res.status === 429 ? RATE_MSG : "Не удалось подготовить оплату. Нажмите «Повторить»."; errEl.hidden = false; }
      if (btn) { btn.disabled = false; btn.textContent = "Повторить"; }
    }
  } catch {
    if (token !== lavaPrepToken) return;
    if (errEl) { errEl.textContent = NET_MSG; errEl.hidden = false; }
    if (btn) { btn.disabled = false; btn.textContent = "Повторить"; }
  }
}

// Клик "Перейти к оплате". URL уже готов -> window.open(РЕАЛЬНЫЙ_URL) СИНХРОННО (надёжно на iOS).
// Не готов/устарел -> (пере)готовим, откроется следующим кликом. Попап заблокирован -> тихий фолбэк.
function onPayGo() {
  const cached = state.preparedInvoice;
  const key = invoiceKey();
  const ready = cached && cached.key === key && cached.url && (Date.now() - cached.ts) < PREP_TTL_MS;
  if (!ready) { prepareLavaInvoice(); return; }
  let win = null;
  try { win = window.open(cached.url, "_blank"); } catch { win = null; }
  const opened = !!win;
  stashLavaReturn(cached.order, state.email, "lava", opened);
  if (opened) { showPayWait(); return; }
  // попап заблокирован -> тихий фолбэк: та же вкладка (Lava вернётся руками -> showPayWait -> опрос)
  window.location.href = cached.url;
}

// --- экран 4: ожидание (автоопрос resolve-paid-order + ручная кнопка). Мины #2/#3 ---
function payWaitVisible() { return els.viewPayWait && !els.viewPayWait.hidden; }
function stopPayPoll() { if (payPollTimer) { clearInterval(payPollTimer); payPollTimer = null; } }
function startPayPoll() { stopPayPoll(); payPoll(); payPollTimer = setInterval(payPoll, PAY_POLL_INTERVAL_MS); }
function showPayWait() {
  hideCoreViews(); hidePayFlowExtra();
  const r = readLavaReturn();
  const note = document.getElementById("pay-wait-lava-note");
  if (note) note.hidden = !(r && r.method === "lava");
  const msg = document.getElementById("pay-wait-msg"); if (msg) msg.hidden = true;
  const btn = document.getElementById("btn-paid-check"); if (btn) { btn.disabled = false; btn.textContent = "Я оплатила"; }
  els.viewPayWait.hidden = false;
  window.scrollTo(0, 0);
  payPollStart = Date.now();
  startPayPoll();
}
async function checkPaidOnce(order) {
  try {
    const res = await fetch(RESOLVE_ORDER_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderReference: order }),
    });
    let data = {}; try { data = await res.json(); } catch {}
    if (res.ok && data.ok && data.email) return { email: data.email };
  } catch {}
  return null;
}
async function payPoll() {
  if (!payWaitVisible()) { stopPayPoll(); return; }
  const r = readLavaReturn();
  if (!r || !r.order) { stopPayPoll(); return; }
  if (Date.now() - payPollStart > PAY_POLL_MAX_MS) {   // мина #3: потолок -> дальше только вручную
    stopPayPoll();
    const msg = document.getElementById("pay-wait-msg");
    if (msg) { msg.innerHTML = "Оплата всё ещё не подтверждена. Нажмите «Я оплатила» ещё раз или напишите " + supportContactsHtml() + "."; msg.hidden = false; }
    return;
  }
  const found = await checkPaidOnce(r.order);
  if (found && payWaitVisible()) { stopPayPoll(); showPasswordForm(r.order, found.email, r.method === "lava"); }
}
async function onPaidCheck() {
  const btn = document.getElementById("btn-paid-check");
  const msg = document.getElementById("pay-wait-msg");
  const r = readLavaReturn();
  if (!r || !r.order) { showStart(); return; }
  if (msg) msg.hidden = true;
  if (btn) { btn.disabled = true; btn.textContent = "Проверяем..."; }
  const found = await checkPaidOnce(r.order);
  if (found) { showPasswordForm(r.order, found.email, r.method === "lava"); return; }
  if (msg) { msg.innerHTML = "Оплата ещё не подтвердилась. Если только что оплатили - подождите минуту. Долго не открывается - напишите " + supportContactsHtml() + "."; msg.hidden = false; }
  if (btn) { btn.disabled = false; btn.textContent = "Я оплатила"; }
  if (payWaitVisible() && Date.now() - payPollStart <= PAY_POLL_MAX_MS) startPayPoll();
}
// Мина #2: iOS усыпляет фон -> при возврате на вкладку перезапускаем опрос.
document.addEventListener("visibilitychange", () => { if (!document.hidden && payWaitVisible()) startPayPoll(); });
window.addEventListener("pageshow", () => { if (payWaitVisible()) startPayPoll(); });

// --- заглушка ВКЛАДКИ ОПЛАТЫ WFP (returnUrl -> ?paid=1&order= при newTab=true). Пароль не показываем. ---
function showPayTabReturn(order) {
  hideCoreViews(); hidePayFlowExtra();
  state.order = order || "";
  els.viewPayTabReturn.hidden = false;
  window.scrollTo(0, 0);
  setTimeout(() => { try { window.close(); } catch {} }, 600); // best-effort, не несущее
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
// Показать номер заказа крупно в блоке "оплата прошла" (для будущего восстановления пароля).
function fillPwOrder(order) {
  const box = document.getElementById("pw-order-box");
  const val = document.getElementById("pw-order");
  if (val) val.textContent = order || "";
  if (box) box.hidden = !order;
}

async function enterPaymentReturn(order) {
  state.order = order;
  hideEntryViews();
  hidePayFlowExtra();
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
      fillPwOrder(order);
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

// Экран пароля с уже известным email (resolve уже прошёл в опросе экрана 4 / onPaidCheck).
function showPasswordForm(order, email, isLava) {
  state.order = order;
  state.email = email;
  state.lavaReturn = !!isLava;
  hideEntryViews();
  hidePayFlowExtra();
  els.viewCheckout.hidden = true;
  if (els.viewLavaReturn) els.viewLavaReturn.hidden = true;
  els.viewPassword.hidden = false;
  els.pwLoading.hidden = true;
  els.pwResolveError.hidden = true;
  els.pwSuccess.hidden = false;
  els.pwForm.hidden = false;
  els.pwEmail.textContent = email;
  fillPwOrder(order);
  const hint = document.getElementById("pw-lava-hint");
  if (hint) hint.hidden = !isLava;
  window.scrollTo(0, 0);
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
  goCheckoutSubmit(); // экран 1 -> WFP -> экран 3
});
{
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("click", (e) => { e.preventDefault(); fn(e); }); };
  bind("to-lava-currency", goLavaCurrency);            // экран 1 -> экран 2 (валюта Lava)
  bind("lavacur-back", () => showCheckout());          // экран 2 -> назад к тарифам
  bind("btn-lava-pay", () => showPayGo());             // экран 2 -> экран 3
  bind("btn-pay-go", () => onPayGo());                 // экран 3 -> оплата (новая вкладка / тихий фолбэк)
  bind("btn-paid-check", () => onPaidCheck());         // экран 4 -> ручная проверка
  bind("btn-close-pay-tab", () => { try { window.close(); } catch {} }); // заглушка вкладки WFP
  bind("pay-tab-here", () => {                          // страховка: задать пароль в этой вкладке
    const ord = new URLSearchParams(location.search).get("order") || (readLavaReturn() || {}).order || state.order || "";
    enterPaymentReturn(ord);
  });
  const curOpts = document.getElementById("cur-opts");
  if (curOpts) curOpts.addEventListener("change", (e) => {
    if (e.target.name === "lavacur") { state.lavaCurrency = e.target.value === "EUR" ? "EUR" : "RUB"; paintCur(); }
  });
}
els.email.addEventListener("input", () => showEmailError(""));

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
// ДД.ММ.ГГГГ (экран управления подпиской). Пустая строка при кривой дате.
function fmtDateDots(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getDate()) + "." + p(d.getMonth() + 1) + "." + d.getFullYear();
}
// Адаптивный заголовок: длинный (>18 символов) -> мельче (23px) и переносится в 2 строки, БЕЗ многоточия.
function setHeadline(el, text) {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("long", (text || "").length > 18);
}

function showCheckout() {
  hideEntryViews();
  hidePayFlowExtra();
  if (siteHeader) siteHeader.hidden = false;
  if (siteFooter) siteFooter.hidden = false;
  if (els.viewHome) els.viewHome.hidden = true;
  if (els.viewLavaReturn) els.viewLavaReturn.hidden = true;   // мост Lava не должен висеть под чекаутом
  els.viewPassword.hidden = true;
  els.viewAccess.hidden = true;
  clearLavaReturn();   // ушли на чекаут -> сбрасываем незавершённый Lava-возврат (ложный мост)
  els.viewCheckout.hidden = false;
  // существующая инициализация чекаута (ровно как было на старте) - оплатная ветка не тронута
  if (!applyTestPlanIfRequested()) {
    readPlanFromUrl();
    writePlanToUrl();
    paintSelected();
  }
}
function showHomeShell() {
  hideEntryViews();
  hidePayFlowExtra();
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

// Меню профиля (кнопка топбара): подписка / поддержка / выход. Закрытие по клику вне + Esc.
(function wireProfileMenu() {
  const wrap = document.getElementById("home-menu");
  const btn = document.getElementById("home-menu-btn");
  const panel = document.getElementById("home-menu-panel");
  const support = document.getElementById("hmenu-support");
  const contacts = document.getElementById("hmenu-contacts");
  const signout = document.getElementById("hmenu-signout");
  if (!wrap || !btn || !panel) return;
  const open = () => { panel.hidden = false; btn.setAttribute("aria-expanded", "true"); };
  const close = () => { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  btn.addEventListener("click", (e) => { e.stopPropagation(); panel.hidden ? open() : close(); });
  if (support && contacts) support.addEventListener("click", (e) => {
    e.stopPropagation();
    if (contacts.hidden) { contacts.innerHTML = supportContactsHtml(); contacts.hidden = false; }
    else contacts.hidden = true;
  });
  if (signout) signout.addEventListener("click", async (e) => {
    e.stopPropagation();
    close();
    try { if (sb) await sb.auth.signOut(); } catch {}
    showStart();   // выход -> стартовый экран (Войти/Оформить); токен сессии снят signOut'ом
  });
  document.addEventListener("click", (e) => { if (!panel.hidden && !wrap.contains(e.target)) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) close(); });
})();

// ===================== ЭКРАН «УПРАВЛЕНИЕ ПОДПИСКОЙ» (веб) =====================
// Детали читаются read-only через web-subscription (боевой verify-access-web НЕ трогаем).
// Блок 1 статус, Блок 2 отмена (роутинг по source, инлайн-подтверждение), Блок 3 поддержка.
// ТГ-ветку не касается: экран открывается только в вебе (пункт меню профиля).
const WEB_SUB_URL = SUPABASE_URL + "/functions/v1/web-subscription";
const CANCEL_SUB_URL = SUPABASE_URL + "/functions/v1/cancel-subscription";        // WFP
const CANCEL_LAVA_URL = SUPABASE_URL + "/functions/v1/cancel-lava-subscription";  // Lava (тот же UX, эндпоинт по source)

(function wireSubscriptionScreen() {
  const menuItem = document.getElementById("hmenu-subscription");
  const homeCard = document.getElementById("home-sub-card");   // карточка «Подписка активна» внизу дома (role=button + шеврон)
  const back = document.getElementById("sub-back");
  const panel = document.getElementById("home-menu-panel");
  if (back) back.addEventListener("click", () => backToHome());
  if (menuItem) menuItem.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel) panel.hidden = true;   // закрыть меню профиля
    openSubscription();
  });
  if (homeCard) homeCard.addEventListener("click", () => openSubscription());
})();

async function openSubscription() {
  hideContentViews();
  const view = document.getElementById("view-subscription");
  if (view) view.hidden = false;
  window.scrollTo(0, 0);
  const loading = document.getElementById("sub-loading");
  const content = document.getElementById("sub-content");
  const errEl = document.getElementById("sub-error");
  const support = document.getElementById("sub-support");
  if (support) support.innerHTML = "Нужна помощь? Напишите нам: " + supportContactsHtml();
  if (loading) loading.hidden = false;
  if (content) content.hidden = true;
  if (errEl) errEl.hidden = true;
  try {
    const token = await getToken();
    if (!token) { routeHomeOrCheckout(); return; }   // сессия потерялась -> перемаршрутизируем
    const res = await fetch(WEB_SUB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok && data.subscription) {
      renderSubscription(data.subscription);
      if (loading) loading.hidden = true;
      if (content) content.hidden = false;
    } else {
      if (loading) loading.hidden = true;
      if (errEl) { errEl.innerHTML = "Не удалось загрузить данные подписки. Обновите страницу или напишите нам " + supportEmailHtml() + "."; errEl.hidden = false; }
    }
  } catch {
    if (loading) loading.hidden = true;
    if (errEl) { errEl.innerHTML = "Нет связи. Проверьте интернет и обновите страницу."; errEl.hidden = false; }
  }
}

function renderSubscription(sub) {
  const until = fmtDateDots(sub.valid_until);
  const statusEl = document.getElementById("sub-status");
  const actionsEl = document.getElementById("sub-actions");

  // --- Блок 1: статус ---
  let statusHtml = "";
  let showRenew = false;
  if (sub.status === "grace") {
    statusHtml = '<div class="sub-status-title sub-status-warn">Оплата не прошла</div>' +
                 '<div class="sub-status-sub">Доступ' + (until ? " до " + until : " активен") + '. Продлите, чтобы не потерять доступ.</div>';
    showRenew = true;
  } else if (sub.cancelled) {
    statusHtml = '<div class="sub-status-title">Автопродление отключено</div>' +
                 '<div class="sub-status-sub">Доступ' + (until ? " активен до " + until : " активен") + '. Чтобы вернуться, оформите подписку заново.</div>';
  } else {
    statusHtml = '<div class="sub-status-title sub-status-ok">Подписка активна</div>' +
                 '<div class="sub-status-sub">' + (until ? "Действует до " + until : "Активна") + '.</div>';
  }
  if (showRenew) statusHtml += '<button type="button" class="btn btn-primary sub-btn" id="sub-renew">Продлить</button>';
  if (statusEl) statusEl.innerHTML = statusHtml;
  const renewBtn = document.getElementById("sub-renew");
  if (renewBtn) renewBtn.addEventListener("click", () => { hideContentViews(); showCheckout(); });

  // --- Блок 2: отмена автопродления (единый UX для WFP и Lava; эндпоинт роутится по source в wireCancelFlow) ---
  let actionsHtml = "";
  let wireCancel = false;
  if ((sub.source === "wayforpay" || sub.source === "lava") && !sub.cancelled && sub.status !== "grace") {
    actionsHtml =
      '<div class="sub-actions-title">Автопродление</div>' +
      '<div class="sub-status-sub">Подписка продлевается автоматически. Можно отключить - доступ останется до конца оплаченного периода.</div>' +
      '<button type="button" class="btn btn-ghost sub-btn sub-danger" id="sub-cancel-btn">Отменить подписку</button>' +
      '<div class="sub-confirm" id="sub-confirm" hidden>' +
        '<div class="sub-confirm-text">Точно отменить? Доступ останется' + (until ? " до " + until : "") + ', дальше продления не будет. Чтобы вернуться позже, оформите подписку заново.</div>' +
        '<div class="sub-confirm-row">' +
          '<button type="button" class="btn btn-ghost sub-btn" id="sub-confirm-no">Оставить</button>' +
          '<button type="button" class="btn btn-primary sub-btn sub-danger-solid" id="sub-confirm-yes">Да, отменить</button>' +
        '</div>' +
      '</div>' +
      '<div class="sub-result" id="sub-cancel-result" hidden></div>';
    wireCancel = true;
  }
  // manual / уже отменённая / grace -> блока действий нет
  if (actionsEl) {
    actionsEl.innerHTML = actionsHtml;
    actionsEl.hidden = !actionsHtml;
  }
  if (wireCancel) wireCancelFlow(sub);
}

function wireCancelFlow(sub) {
  const btn = document.getElementById("sub-cancel-btn");
  const confirmBox = document.getElementById("sub-confirm");
  const no = document.getElementById("sub-confirm-no");
  const yes = document.getElementById("sub-confirm-yes");
  const result = document.getElementById("sub-cancel-result");
  if (btn) btn.addEventListener("click", () => { if (confirmBox) confirmBox.hidden = false; btn.hidden = true; });
  if (no) no.addEventListener("click", () => { if (confirmBox) confirmBox.hidden = true; if (btn) btn.hidden = false; });
  if (yes) yes.addEventListener("click", async () => {
    yes.disabled = true; if (no) no.disabled = true; yes.textContent = "Отменяем…";
    try {
      const token = await getToken();
      if (!token) { routeHomeOrCheckout(); return; }
      const cancelUrl = sub.source === "lava" ? CANCEL_LAVA_URL : CANCEL_SUB_URL;
      const res = await fetch(cancelUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        // успех: cancelled / already_cancelled / no_active_recurrent
        const until = fmtDateDots(data.valid_until || sub.valid_until);
        if (confirmBox) confirmBox.hidden = true;
        if (btn) btn.hidden = true;
        if (result) {
          result.innerHTML = '<div class="sub-status-title">Автопродление отключено</div>' +
            '<div class="sub-status-sub">Доступ' + (until ? " активен до " + until : " сохраняется") + '. Чтобы вернуться, оформите подписку заново.</div>';
          result.hidden = false;
        }
      } else {
        // ok:false (вкл. 502 rc≠4100/4102) -> честная ошибка + контакты, кнопка остаётся
        yes.disabled = false; if (no) no.disabled = false; yes.textContent = "Да, отменить";
        if (result) {
          result.innerHTML = '<div class="sub-status-sub sub-status-warn">Не удалось отменить. Напишите в поддержку: ' + supportContactsHtml() + " - поможем.</div>";
          result.hidden = false;
        }
      }
    } catch {
      yes.disabled = false; if (no) no.disabled = false; yes.textContent = "Да, отменить";
      if (result) {
        result.innerHTML = '<div class="sub-status-sub sub-status-warn">Нет связи. Проверьте интернет и попробуйте ещё раз. Не помогает - напишите ' + supportContactsHtml() + ".</div>";
        result.hidden = false;
      }
    }
  });
}

// Тумблер темы в меню профиля. Дефолт светлый; тёмная включается вручную и запоминается в
// localStorage (тот же ключ, что читает pre-render скрипт в <head>). Меняет только data-theme
// на <html> -> CSS-токены переопределяются, ТГ-мини-аппы и прочее не затрагиваются.
(function wireThemeToggle() {
  const KEY = "irena_theme";
  const item = document.getElementById("hmenu-theme");
  const label = document.getElementById("hmenu-theme-label");
  const ic = document.getElementById("hmenu-theme-ic");
  const isDark = () => document.documentElement.getAttribute("data-theme") === "dark";
  function reflect() {
    const dark = isDark();
    if (label) label.textContent = dark ? "Светлая тема" : "Тёмная тема";
    if (ic) ic.className = "ti " + (dark ? "ti-sun" : "ti-moon");
  }
  reflect();
  if (item) item.addEventListener("click", (e) => {
    e.stopPropagation();
    const dark = !isDark();
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    try { localStorage.setItem(KEY, dark ? "dark" : "light"); } catch {}
    reflect();
  });
})();

// ===================== ПЛИТКИ: мини-аппы (пилот - Тренировки/workout) =====================
// Клик по плитке -> mint-app-token (сервер проверяет веб-подписку) -> открыть мини-апп на его
// СОБСТВЕННОМ домене с токеном во фрагменте #. Плитку видит только залогиненный с подпиской
// (дом показывается лишь после verify-access-web), поэтому mint обычно успешен.
const MINT_APP_TOKEN_URL = SUPABASE_URL + "/functions/v1/mint-app-token";
// ?v= - кэш-бост для веб-открытия, бампать при обновлении самого мини-аппа.
const MINI_APPS = {
  workout: { url: "https://vladlen00.github.io/workout/", v: "4" },
  glutes: { url: "https://vladlen00.github.io/glutes/", v: "2" },
  // biohack-трекер - один апп, экран выбирается через ?startapp= (читается App.js из search).
  podruzhka: { url: "https://biohack-tracker-blond.vercel.app/", v: "1", q: "startapp=ai" },
  zdorovie: { url: "https://biohack-tracker-blond.vercel.app/", v: "1", q: "startapp=checkin" },
  cycle: { url: "https://vladlen00.github.io/cycle/", v: "2" },
  relax: { url: "https://vladlen00.github.io/studio/", v: "8" },
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
  const vr = document.getElementById("view-reset"); if (vr) vr.hidden = true;
}
function showStart() {
  hidePayFlowExtra();
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
  hidePayFlowExtra();
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
      showLoginError(null, "Неверная почта или пароль. Если аккаунта ещё нет - <a href=\"#\" id=\"login-err-signup\" style=\"color:inherit;text-decoration:underline\">оформите подписку</a>.");
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

// ===================== ВОССТАНОВЛЕНИЕ ПАРОЛЯ по номеру заказа (без писем) =====================
function showReset() {
  hidePayFlowExtra();
  if (siteHeader) siteHeader.hidden = false;
  if (siteFooter) siteFooter.hidden = false;
  const vs = document.getElementById("view-start"); if (vs) vs.hidden = true;
  const vl = document.getElementById("view-login"); if (vl) vl.hidden = true;
  els.viewCheckout.hidden = true;
  const vr = document.getElementById("view-reset"); if (vr) vr.hidden = false;
  const hint = document.getElementById("reset-hint");
  if (hint) hint.innerHTML = "Номер заказа вы сохранили при оплате. Не сохранили? Напишите в поддержку " + supportTgHtml() + " - поможем.";
  showResetError("");
  const em = document.getElementById("reset-email"); if (em) em.focus();
  window.scrollTo(0, 0);
}
function showResetError(msg, html) {
  const el = document.getElementById("reset-error");
  if (!el) return;
  if (html) el.innerHTML = html; else el.textContent = msg || "";
  el.hidden = !(msg || html);
}
async function doReset() {
  const btn = document.getElementById("btn-reset");
  const email = normalizeEmail(document.getElementById("reset-email").value);
  const order = (document.getElementById("reset-order").value || "").trim();
  const password = document.getElementById("reset-password").value || "";
  const password2 = document.getElementById("reset-password2").value || "";
  showResetError("");
  if (!emailValid(email)) { showResetError(EMAIL_HINT); document.getElementById("reset-email").focus(); return; }
  if (!order) { showResetError("Введите номер заказа."); document.getElementById("reset-order").focus(); return; }
  if (password.length < 8) { showResetError("Пароль минимум 8 символов."); document.getElementById("reset-password").focus(); return; }
  if (password !== password2) { showResetError("Пароли не совпадают."); document.getElementById("reset-password2").focus(); return; }
  if (!sb) { showResetError("Не удалось загрузить вход. Обновите страницу."); return; }
  btn.disabled = true; btn.textContent = "Проверяем...";
  try {
    const res = await fetch(RESET_PASSWORD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, orderReference: order, password }),
    });
    let data = {}; try { data = await res.json(); } catch { data = {}; }
    if (res.ok && data.ok) {
      // пароль сменён на сервере -> входим им же -> в приложение
      btn.textContent = "Входим...";
      const inn = await sb.auth.signInWithPassword({ email, password });
      if (inn.data && inn.data.session) { await routeHomeOrCheckout(); return; }
      // редкий случай: пароль сменён, авто-вход не удался -> отправляем на вход
      showResetError(null, "Пароль обновлён. Войдите с новым паролем.");
      setTimeout(showLogin, 1400);
      return;
    }
    if (res.status === 429) {
      showResetError("Слишком много попыток. Подождите минуту и попробуйте снова.");
    } else {
      // анти-энумерация: единый текст на ЛЮБОЙ промах (неверный email/заказ/не оплачен/нет логина)
      showResetError(null, "Почта и номер заказа не совпали. Не сходится - напишите в поддержку " + supportTgHtml() + ".");
    }
    btn.disabled = false; btn.textContent = "Сбросить пароль";
  } catch {
    showResetError(NET_MSG);
    btn.disabled = false; btn.textContent = "Сбросить пароль";
  }
}
(function wireEntry() {
  const bind = (id, fn) => { const e = document.getElementById(id); if (e) e.addEventListener("click", fn); };
  bind("start-login", (e) => { e.preventDefault(); showLogin(); });
  bind("start-signup", (e) => { e.preventDefault(); showCheckout(); });
  bind("btn-login", (e) => { e.preventDefault(); doLogin(); });
  bind("login-back", (e) => { e.preventDefault(); showStart(); });
  bind("login-to-signup", (e) => { e.preventDefault(); showCheckout(); });
  bind("login-to-reset", (e) => { e.preventDefault(); showReset(); });
  bind("btn-reset", (e) => { e.preventDefault(); doReset(); });
  bind("reset-back", (e) => { e.preventDefault(); showLogin(); });
  const reye = document.getElementById("reset-eye");
  const rpw = document.getElementById("reset-password");
  if (reye && rpw) reye.addEventListener("click", () => {
    const m = rpw.type === "password"; rpw.type = m ? "text" : "password"; reye.textContent = m ? "скрыть" : "показать";
  });
  ["reset-email", "reset-order", "reset-password", "reset-password2"].forEach((id) => {
    const e = document.getElementById(id);
    if (e) e.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); doReset(); } });
  });
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
  if (!sb || !hasStored) { if (readLavaReturn()) showPayWait(); else showStart(); return; }

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
  const vsub = document.getElementById("view-subscription"); if (vsub) vsub.hidden = true;
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
    case "pdf": {
      const url = b.url ? escapeHtml(b.url) : "";
      if (!url) return "";
      const label = escapeHtml(b.title || "Скачать памятку");
      const cap = b.content_text ? '<div class="blk-pdf-cap">' + mdLite(b.content_text) + '</div>' : "";
      return '<div class="card blk-pdf"><a class="blk-pdf-link" href="' + url + '" target="_blank" rel="noopener">' +
        '<i class="ti ti-file-type-pdf"></i><span>' + label + '</span></a>' + cap + '</div>';
    }
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
  // "читать дальше" - сворачиваем только реально длинный текст
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

// Открыть день: get-day -> рендер блоков. forceHost (timeweb|minio) - ручное переключение хранилища.
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
  const errEl = document.getElementById("day-error");
  errEl.hidden = true;                       // ретрай прячет прошлую ошибку
  // ОПТИМИСТИЧНО: галочка сразу (done + disabled -> повторные тапы в полёте отсечены).
  setDoneState(btn, true);
  // ОТКАТ при любой неудаче: галочку снять, честно сказать. Ложный зелёный не оставляем:
  // homeData мутируется ТОЛЬКО после подтверждения сервером (ниже), поэтому за пределами
  // этой кнопки оптимизм никуда не протекает (список спринта рисуется из homeData).
  const rollback = () => {
    setDoneState(btn, false);
    errEl.innerHTML = "Не сохранилось - проверьте интернет и нажмите ещё раз. Не помогает - напишите нам " + supportEmailHtml() + ".";
    errEl.hidden = false;
  };
  const token = await getToken();
  if (!token) { rollback(); return; }
  try {
    // таймаут: висящий запрос не должен оставить ложную галочку навсегда
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(MARK_DAY_DONE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({ day_id: dayId }),
      signal: ctrl.signal,
    });
    clearTimeout(tm);
    let data = {}; try { data = await res.json(); } catch { data = {}; }
    if (res.ok && data.ok) {
      // подтверждено сервером - фиксируем прогресс (галочка уже стоит)
      if (homeData) {
        homeData.progress = homeData.progress || { completed_day_ids: [], completed_count: 0 };
        const s = new Set(homeData.progress.completed_day_ids || []);
        s.add(dayId);
        homeData.progress.completed_day_ids = Array.from(s);
        homeData.progress.completed_count = s.size;
      }
    } else {
      rollback();
    }
  } catch {
    rollback();
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
    const icon = done ? "ti-check" : (isNext ? "ti-player-play" : "ti-circle-dot");
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
  // ?paid приходит только по returnUrl WayForPay. Разводим по stash.newTab (мина #4):
  //  newTab=true  -> это ВКЛАДКА ОПЛАТЫ (попап) -> заглушка "вернитесь на предыдущую".
  //  newTab=false -> это ИСХОДНАЯ вкладка (тихий фолбэк) -> сразу экран пароля.
  //  нет stash    -> ведём как newTab=false (человек хотя бы попадёт на пароль).
  const st = readLavaReturn();
  if (st && st.newTab === true) showPayTabReturn(startParams.get("order"));
  else enterPaymentReturn(startParams.get("order"));
} else {
  routeHomeOrCheckout();                           // дом / чекаут / (stash -> экран ожидания)
}
