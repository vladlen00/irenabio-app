// irenabio-app: экран чекаута.
// WayForPay (основная кнопка): create-checkout -> {ok:true, invoiceUrl} -> редирект
//   на страницу оплаты WayForPay. person создаётся внутри create-checkout на сервере,
//   поэтому отдельный register-person для этого пути не нужен.
// Lava (ссылка "другой способ"): пока заглушка register-person -> экран "аккаунт создан".
// supabase-js не нужен: всё обычным fetch.

const CREATE_CHECKOUT_URL = "https://kjzxrpwqyyjcykwbqskn.supabase.co/functions/v1/create-checkout";
const REGISTER_URL = "https://kjzxrpwqyyjcykwbqskn.supabase.co/functions/v1/register-person";

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
};

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

// --- старт ---
readPlanFromUrl();
writePlanToUrl();
paintSelected();
