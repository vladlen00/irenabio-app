// irenabio-app: экран чекаута (шаг 1б, часть 2а).
// Вариант А: выбор тарифа -> email -> register-person (person создаётся тихо) -> заглушка оплаты.
// Реальной оплаты пока НЕТ. supabase-js не нужен: register-person дёргаем обычным fetch.

const REGISTER_URL = "https://kjzxrpwqyyjcykwbqskn.supabase.co/functions/v1/register-person";

const PLANS = {
  "1m":  { months: 1,  eur: 11, label: "1 месяц" },
  "6m":  { months: 6,  eur: 55, label: "6 месяцев" },
  "12m": { months: 12, eur: 99, label: "12 месяцев" },
};

// Состояние. plan и method переживут шаг оплаты (plan дублируем в URL).
const state = {
  plan: "6m",
  method: "wayforpay", // wayforpay | lava - на след. шаге определит экран оплаты
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

// --- индикатор загрузки на кнопке ---
function setLoading(on) {
  els.btnPay.disabled = on;
  els.altLink.classList.toggle("disabled", on);
  els.btnPay.textContent = on ? "Создаём аккаунт..." : "Оформить подписку";
}

// --- основной поток: создать person, затем заглушка оплаты ---
async function submit(method) {
  clearErrors();
  state.method = method;

  const email = normalizeEmail(els.email.value);
  if (!emailValid(email)) {
    showEmailError("Проверьте адрес почты. Пример: ваша@почта.com");
    els.email.focus();
    return;
  }

  setLoading(true);
  try {
    const res = await fetch(REGISTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    if (res.status === 429) {
      showFormError("Слишком много попыток. Подождите минуту и попробуйте снова.");
      return;
    }

    let data = {};
    try { data = await res.json(); } catch { data = {}; }

    if (res.ok && data.ok) {
      goPending(email);
      return;
    }
    if (res.status === 400 || data.error === "invalid_email") {
      showEmailError("Проверьте адрес почты. Пример: ваша@почта.com");
      return;
    }
    showFormError("Что-то пошло не так. Попробуйте ещё раз через минуту.");
  } catch (err) {
    // Сетевой сбой у аудитории в заблокированных регионах лечит VPN.
    showFormError("Не получилось связаться с сервером. Включите VPN и попробуйте снова.");
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
