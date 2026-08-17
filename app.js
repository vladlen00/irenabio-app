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
const CLAIM_ACCOUNT_URL = SUPABASE_URL + "/functions/v1/claim-account";     // ПЕРВЫЙ пароль по номеру заказа (нет auth-аккаунта)
const ATTACH_IDENTITY_URL = SUPABASE_URL + "/functions/v1/attach-web-identity";
const VERIFY_ACCESS_URL = SUPABASE_URL + "/functions/v1/verify-access-web";
const GET_HOME_URL = SUPABASE_URL + "/functions/v1/get-home";
const GET_DAY_URL = SUPABASE_URL + "/functions/v1/get-day";
const MARK_DAY_DONE_URL = SUPABASE_URL + "/functions/v1/mark-day-done";
const PROJECT_REF = "kjzxrpwqyyjcykwbqskn";
// Таймаут одной сетевой попытки. Объявлен здесь (а не в блоке sbFetch ниже), потому что
// его использует sbAuthFetch, который создаётся раньше по файлу.
// 8с: p95 сервера 185 мс (замер 25.07), запас сорокакратный. Весь цикл из 3 попыток
// с паузами 1с+2с укладывается в ~27с вместо 48с.
const SB_TIMEOUT_MS = 8000;

// ===================== МАРШРУТ ДО БЭКЕНДА =====================
// Зачем: у части подписчиц (РФ, РБ) прямой путь к supabase.co ложится, и ложится НЕ
// навсегда, а полосами. Замер с одного телефона 26.07: в 16:54 прямой путь мёртв, через
// минуту жив, при этом запасной маршрут отвечал в оба прогона (297-1670 мс). Поэтому
// маршрут не константа, а состояние: определяется, запоминается, умеет переключиться
// посреди сессии.
//
// Запасной маршрут - ОТДЕЛЬНЫЙ проект ir-sb-web (rewrite -> supabase.co), не та дверь,
// через которую ходят телеграм-мини-аппы: иначе авария или лимит на одном адресе положат
// сразу обе ветки. Проксируются только functions/v1 и auth/v1, остальное отдаёт 404.
// Origin запросов при этом НЕ меняется (браузер ставит туда адрес страницы), поэтому
// allow-list'ы edge-функций остаются довольны: проверено курлом на всех 14 функциях 26.07.
const SB_PROXY_BASE = "https://ir-sb-web.vercel.app/sb";
const ROUTE_KEY = "irenabio_route";
const ROUTE_TTL_MS = 24 * 60 * 60 * 1000;   // сутки, потом дешёвая перепроверка прямого пути
const ROUTE_PROBE_MS = 4000;                // первый заход без памяти: не ждём все 8 секунд
const ROUTE_RECHECK_MS = 2500;              // раз в сутки пробуем вернуться на прямой путь

// Память маршрута. Пишем ТОЛЬКО "proxy": отсутствие записи и есть "прямой путь".
function readRoute() {
  try {
    const j = JSON.parse(localStorage.getItem(ROUTE_KEY) || "null");
    if (!j || j.route !== "proxy") return null;
    const ts = j.ts || 0;
    return { route: "proxy", ts, reason: j.reason || "", stale: (Date.now() - ts) > ROUTE_TTL_MS };
  } catch (e) { return null; }
}
function writeRoute(reason) {
  try { localStorage.setItem(ROUTE_KEY, JSON.stringify({ route: "proxy", ts: Date.now(), reason: reason || "" })); } catch (e) {}
}
function clearRoute() { try { localStorage.removeItem(ROUTE_KEY); } catch (e) {} }

// Индикатор на время определения маршрута: проба занимает до 12 секунд (4 прямой плюс
// до 8 запасной), без надписи человек смотрит в пустой каркас. Пишем в тот же элемент,
// что и homeProgress. try/catch: на прогреве может быть вызвана до инициализации homeEls.
function routeProbeStatus(text) {
  try {
    if (!homeEls || !homeEls.loading) return;
    homeEls.loading.textContent = text;
  } catch (e) {}
}

// Одна попытка достучаться, со своим таймаутом и без повторов. Любой ОТВЕТ сервера
// (health отдаёт 401 без ключа) = путь живой; нам нужен факт ответа, а не тело.
// Отказ fetch = путь мёртвый, причём и таймаут, и мгновенный обрыв: в замере 26.07
// первая попытка падала за 1576 мс, то есть соединение рвут активно, а не тянут до конца.
async function routeAlive(base, timeoutMs) {
  const url = base + "/auth/v1/health?_=" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeoutMs);
  try { await fetch(url, { method: "GET", cache: "no-store", signal: ctrl.signal }); return true; }
  catch (e) { return false; }
  finally { clearTimeout(tm); }
}

let sbRoute = null;          // "direct" | "proxy" - решение на текущую загрузку страницы
let sbRoutePromise = null;   // чтобы не пробивать путь по разу на каждый запрос

// Запрос упал. Если он шёл ПО ПРОКСИ, память больше ничего не доказывает: она означает
// "прокси работал", а не "прокси навсегда". Стираем её и пробиваем оба пути заново.
// Без этого при аварии прокси человек заперт на нём до истечения суток - и заперт вместе
// со ВСЕМИ, кто переключился, потому что прокси у них общий: одна точка отказа меняется
// на другую, и худшую (у прямого пути хотя бы полосы, а тут глухие сутки).
// Одна лишняя проба дешевле суток без доступа, поэтому стираем даже на разовом обрыве.
function routeFailed(usedRoute) {
  if (usedRoute === "proxy") clearRoute();
  sbRoute = null;
}

// Решаем маршрут ДО отправки. Это принципиально: signUp и signInWithPassword повторять
// нельзя (см. комментарий у sbAuthFetch), а схема "отправить и переслать на другой
// маршрут" именно это и делает - оборванный запрос мог дойти до сервера.
// force=true (решаем заново после падения) ОБЯЗАН пробивать пути, а не отвечать из памяти:
// иначе получается залипание на мёртвом прокси.
async function ensureRoute(force) {
  if (sbRoute && !force) return sbRoute;
  if (sbRoutePromise && !force) return sbRoutePromise;
  sbRoutePromise = (async () => {
    const mem = readRoute();
    if (mem && !mem.stale && !force) return (sbRoute = "proxy");   // память свежая: проб нет
    routeProbeStatus("Проверяем доступ…");
    // Прямой путь пробуем ВСЕГДА, когда решаем заново. Если память была - проба дешёвая.
    if (await routeAlive(SUPABASE_URL, mem ? ROUTE_RECHECK_MS : ROUTE_PROBE_MS)) {
      clearRoute();
      return (sbRoute = "direct");
    }
    // прямой молчит -> проверяем запасной ПЕРЕД тем, как что-то на него посылать
    if (await routeAlive(SB_PROXY_BASE, SB_TIMEOUT_MS)) {
      writeRoute("direct_unreachable");
      return (sbRoute = "proxy");
    }
    // Молчат оба. Запоминать нечего, память СТИРАЕМ - чтобы не залипнуть на мёртвом прокси.
    // Запрос отдаст unreachable, человек увидит экран связи, следующая попытка пробьёт заново.
    clearRoute();
    return (sbRoute = "direct");
  })();
  try { return await sbRoutePromise; } finally { sbRoutePromise = null; }
}

// Подмена базы. SUPABASE_URL НЕ меняется: supabase-js держит сессию под ключом
// sb-<PROJECT_REF>-auth-token (см. hasStoredSession), он от хоста не зависит, поэтому
// смена маршрута не выкидывает из аккаунта.
function routeUrl(url) {
  const s = String(url);
  if (sbRoute !== "proxy") return s;
  return s.indexOf(SUPABASE_URL) === 0 ? SB_PROXY_BASE + s.slice(SUPABASE_URL.length) : s;
}
function routeInput(input) {
  if (typeof input === "string") return routeUrl(input);
  if (typeof URL !== "undefined" && input instanceof URL) return routeUrl(String(input));
  if (input && typeof input.url === "string") return new Request(routeUrl(input.url), input);
  return input;
}

// Ручной тумблер для поддержки, по образцу неприметного переключателя хранилища:
//   ?route=proxy  - принудительно запасной маршрут (запоминается на сутки)
//   ?route=direct - принудительно прямой (память стирается)
// На экране ничего не рисуем: это инструмент поддержки, а не настройка для подписчицы.
(function applyRouteOverride() {
  try {
    const p = new URLSearchParams(location.search).get("route");
    if (p === "proxy") { writeRoute("manual"); sbRoute = "proxy"; }
    else if (p === "direct") { clearRoute(); sbRoute = "direct"; }
  } catch (e) {}
})();

// Lava назад не редиректит -> сохраняем order_reference (=invoice.id) в localStorage при уходе на оплату,
// по возвращении мост "Я оплатил" скармливает его в существующий поток resolve-paid-order -> пароль.
const LAVA_RETURN_KEY = "irenabio_lava_return";
const LAVA_RETURN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // мост живёт 7 дней
// Обе платёжки уходят на оплату в ЭТОЙ вкладке. Stash пишет ТОЛЬКО Lava (у неё нет returnUrl -> возврат
// руками -> readLavaReturn -> showPayWait -> опрос). WFP чистит stash и возвращается сам по returnUrl.
function stashLavaReturn(order, email, method) {
  try { localStorage.setItem(LAVA_RETURN_KEY, JSON.stringify({ order, email, method: method || "lava", ts: Date.now() })); } catch {}
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
};

const els = {
  form: document.getElementById("checkout-form"),
  plans: document.getElementById("plans"),
  email: document.getElementById("email"),
  email2: document.getElementById("email2"),   // повтор почты, см. readCheckoutEmail
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
// global.fetch с таймаутом: supabase-js ходит в сеть своим fetch (мимо sbFetch), и без
// таймаута зависший refresh токена держит экран бесконечно. Только таймаут, БЕЗ повтора -
// повторять signUp/signInWithPassword нельзя.
// Маршрут выбираем ЗДЕСЬ и ДО отправки, поэтому пересылать ничего не нужно.
async function sbAuthFetch(input, init) {
  const used = await ensureRoute();
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), SB_TIMEOUT_MS);
  try {
    return await fetch(routeInput(input), Object.assign({}, init || {}, { signal: ctrl.signal }));
  } catch (e) {
    // Запрос НЕ пересылаем. Сбрасываем решение (а если падали ПО ПРОКСИ - и память),
    // чтобы СЛЕДУЮЩИЙ запрос, включая авто-обновление токена, пробил пути заново.
    routeFailed(used);
    throw e;
  } finally {
    clearTimeout(tm);
  }
}
const sb = (window.supabase && window.supabase.createClient)
  ? window.supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY, { global: { fetch: sbAuthFetch } })
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

// Почта на чекауте вводится ДВАЖДЫ. Возвращает нормализованный адрес или null (с показанной
// ошибкой). Вставку во второе поле НЕ запрещаем: кто копирует из первого, обычно копирует
// верный адрес, а запрет получили бы все.
function readCheckoutEmail() {
  const email = normalizeEmail(els.email.value);
  if (!emailValid(email)) { showEmailError(EMAIL_HINT); els.email.focus(); return null; }
  const again = normalizeEmail(els.email2 ? els.email2.value : "");
  if (!again) { showEmailError("Повторите почту во втором поле."); if (els.email2) els.email2.focus(); return null; }
  if (email !== again) { showEmailError("Адреса не совпадают - проверьте оба поля."); if (els.email2) els.email2.focus(); return null; }
  return email;
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
const NET_MSG = "Не удалось связаться с сервером. Проверьте интернет и попробуйте ещё раз.";

// ===================== СЕТЕВОЙ СЛОЙ: sbFetch =====================
// Единая обёртка над ВСЕМИ обращениями к Supabase. Логика перенесена из мини-аппов
// (Desktop/biohack/public/tg-auth.js): isConnectionReason + RETRY_DELAYS_MS.
// Зачем: доступность Supabase из РФ/РБ плавает. Раньше обрыв связи был неотличим от
// "подписки нет" -> платящая подписчица видела чекаут и могла заплатить второй раз.
//
// Состояния результата (СЕТЕВЫХ - три, как в задаче):
//   ok          - сервер ответил 2xx
//   denied      - сервер ответил 401/403: доступа реально нет, повтор не поможет
//   unreachable - вердикта НЕ было: таймаут, отказ fetch, DNS/TLS, 5xx
// Плюс четвёртая корзина, НЕ сетевая:
//   error       - сервер ответил, но это бизнес-ошибка (400 валидация, 429 лимит).
//                 Нужна, иначе 429 пришлось бы объявить либо denied (ложное "доступа
//                 нет"), либо unreachable (ложный экран связи) - оба варианта врут.
const SB_MAX_ATTEMPTS = 3;
const SB_RETRY_DELAYS_MS = [1000, 2000];   // паузы перед попытками 2 и 3 (как в tg-auth.js)

function sbSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Перенесено из tg-auth.js без изменений. "network_error" и любой "error_5xx" для
// человека одно и то же: сервер не дал вердикта, совет одинаковый.
function isConnectionReason(reason) {
  if (reason === "network_error") return true;
  // error_500 / error_502 / error_503 ... - сервер жив, но сломался.
  if (typeof reason === "string" && reason.indexOf("error_5") === 0) return true;
  return false;
}

// Одна попытка с таймаутом. Отдаёт {res, data} либо бросает строку-причину.
async function sbFetchOnce(url, options) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), SB_TIMEOUT_MS);
  try {
    const res = await fetch(url, Object.assign({}, options || {}, { signal: ctrl.signal }));
    if (res.status >= 500) throw "error_" + res.status;   // вердикта нет -> ретраибельно
    let data = {};
    try { data = await res.json(); } catch { data = {}; }
    return { res, data };
  } catch (e) {
    if (typeof e === "string") throw e;   // уже классифицировано выше
    throw "network_error";                // abort по таймауту, отказ fetch, DNS, TLS
  } finally {
    clearTimeout(tm);
  }
}

// Главная обёртка. Никогда не бросает - всегда возвращает объект с полем state.
// opts.retry=true разрешён ТОЛЬКО для чтения и идемпотентного (см. список в шапке коммита).
async function sbFetch(url, options, opts) {
  await ensureRoute();
  const attempts = (opts && opts.retry) ? SB_MAX_ATTEMPTS : 1;
  const onAttempt = opts && opts.onAttempt;
  let lastReason = "network_error";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (onAttempt) { try { onAttempt(attempt, attempts); } catch (e) {} }
    try {
      const r = await sbFetchOnce(routeUrl(url), options);
      if (r.res.ok) return { state: "ok", res: r.res, data: r.data, status: r.res.status };
      if (r.res.status === 401 || r.res.status === 403) {
        return { state: "denied", res: r.res, data: r.data, status: r.res.status };
      }
      return { state: "error", res: r.res, data: r.data, status: r.res.status };
    } catch (reason) {
      lastReason = reason;
      if (!isConnectionReason(reason)) return { state: "error", data: {}, status: 0, reason };
      if (attempt < attempts) await sbSleep(SB_RETRY_DELAYS_MS[attempt - 1]);
    }
  }
  console.warn("sbFetch unreachable:", url, lastReason);
  // Маршрут пересматриваем ВСЕГДА: следующие вызовы уйдут по живому пути.
  // А сам запрос повторяем на новом маршруте ТОЛЬКО если вызов уже объявлен идемпотентным
  // (opts.retry) и маршрут реально сменился. Ровно один раз: во вложенном вызове retry:false,
  // поэтому второй пересылки быть не может. Для неидемпотентных вызовов (создание оплаты)
  // пересылки нет ни в одном сценарии.
  const usedRoute = sbRoute;
  routeFailed(usedRoute);                     // память значит "работал", а не "навсегда"
  const routeAfter = await ensureRoute(true);
  if (routeAfter !== usedRoute && opts && opts.retry) {
    return sbFetch(url, options, { retry: false, onAttempt: onAttempt });
  }
  return { state: "unreachable", data: {}, status: 0, reason: lastReason };
}

// supabase-js на обрыве связи часто НЕ бросает, а ВОЗВРАЩАЕТ error (AuthRetryableFetchError,
// status 0/5xx). Без этой проверки обрыв на входе выглядел бы как "неверная почта или пароль" -
// то есть человека отправляли бы менять правильный пароль.
function isAuthNetworkError(err) {
  if (!err) return false;
  if (typeof err.status === "number" && err.status >= 500) return true;
  if (typeof err.status === "number" && err.status !== 0) return false;
  const n = String(err.name || "");
  const m = String(err.message || "");
  if (n.indexOf("AuthRetryableFetchError") === 0) return true;
  return /fetch|network|aborted|abort|timeout/i.test(m);
}

// Сессия supabase-js с той же классификацией. getSession обычно читает localStorage
// БЕЗ сети; в сеть он идёт только когда токен протух и нужен refresh - вот там и
// возможен обрыв. Отличаем "сессии нет" от "не смогли обновить".
//   ok          - сессия есть, token отдан
//   denied      - сохранённой сессии нет вовсе (человек не залогинен)
//   unreachable - сессия сохранена, но обновить её не вышло из-за связи
function hasStoredSession() {
  try { return !!localStorage.getItem("sb-" + PROJECT_REF + "-auth-token"); } catch (e) { return false; }
}
async function getSessionState(opts) {
  if (!sb) return { state: "denied", token: null };
  const stored = hasStoredSession();
  const attempts = (opts && opts.retry) ? SB_MAX_ATTEMPTS : 1;
  const onAttempt = opts && opts.onAttempt;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (onAttempt) { try { onAttempt(attempt, attempts); } catch (e) {} }
    try {
      const { data, error } = await sb.auth.getSession();
      const token = data && data.session ? data.session.access_token : null;
      if (token) return { state: "ok", token };
      // токена нет: либо человек не залогинен, либо refresh не дошёл до сервера
      if (!stored) return { state: "denied", token: null };
      if (error) {
        if (attempt < attempts) { await sbSleep(SB_RETRY_DELAYS_MS[attempt - 1]); continue; }
        return { state: "unreachable", token: null };
      }
      // сохранённый токен есть, ошибки нет, сессии нет -> она честно истекла
      return { state: "denied", token: null };
    } catch (e) {
      if (!stored) return { state: "denied", token: null };
      if (attempt < attempts) { await sbSleep(SB_RETRY_DELAYS_MS[attempt - 1]); continue; }
      return { state: "unreachable", token: null };
    }
  }
  return { state: "unreachable", token: null };
}

// Видимый статус на каркасе дома, пока идут попытки. Без него человек смотрит в пустой
// каркас до ~27 секунд и уходит раньше, чем отработает ретрай.
function homeProgress(attempt, total) {
  if (homeEls && homeEls.loading) {
    homeEls.loading.textContent = "Проверяем доступ, попытка " + attempt + " из " + total;
  }
}

// ===================== ЭКРАН «НЕ ПОЛУЧИЛОСЬ ПОДКЛЮЧИТЬСЯ» =====================
// Показывается там, где раньше молча уходили в чекаут или в общий catch.
// Кнопка «Повторить» вызывает то действие, которое не прошло.
let connRetryFn = null;
// Подсказка про VPN - ВТОРЫМ шагом: главный текст остаётся нейтральным, а совет
// появляется только после того, как «Повторить» уже не помогло. Флаг сбрасывается
// перезагрузкой страницы (по факту - удачным входом, дальше экран не показывается).
let connRetryUsed = false;
function showConnection(retryFn) {
  connRetryFn = typeof retryFn === "function" ? retryFn : null;
  hidePayFlowExtra();
  hideEntryViews();
  hideContentViews();
  if (siteHeader) siteHeader.hidden = false;
  if (siteFooter) siteFooter.hidden = false;
  els.viewCheckout.hidden = true;
  els.viewPassword.hidden = true;
  els.viewAccess.hidden = true;
  if (els.viewLavaReturn) els.viewLavaReturn.hidden = true;
  const btn = document.getElementById("conn-retry");
  if (btn) { btn.disabled = false; btn.textContent = "Повторить"; }
  // Контакты из единой константы SUPPORT, как на остальных экранах.
  const support = document.getElementById("conn-support");
  if (support) support.innerHTML = "Не проходит совсем? Напишите нам: " + supportContactsHtml();
  const vpn = document.getElementById("conn-vpn");
  if (vpn) vpn.hidden = !connRetryUsed;
  const v = document.getElementById("view-connection");
  if (v) v.hidden = false;
  window.scrollTo(0, 0);
}
function hideConnection() {
  const v = document.getElementById("view-connection");
  if (v) v.hidden = true;
}
(function wireConnection() {
  const btn = document.getElementById("conn-retry");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true; btn.textContent = "Пробуем...";
    connRetryUsed = true;   // следующий показ экрана уже с подсказкой про VPN
    const fn = connRetryFn;
    hideConnection();
    if (fn) await fn();
    else await routeHomeOrCheckout();
  });
})();

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
  // Экран подписки гасился ТОЛЬКО через hideContentViews, а его не зовут ни showStart,
  // ни showCheckout, ни showHomeShell, ни экраны оплаты. Из-за этого подписка оставалась
  // видимой ПОД ними и экраны накладывались друг на друга (поймано аудитом переходов).
  // Здесь - самая широкая точка: hidePayFlowExtra зовут все переходы входа и оплаты.
  const vsub = document.getElementById("view-subscription"); if (vsub) vsub.hidden = true;
  stopPayPoll();
}
// Базовое состояние экранов "колонки" (шапка/футер видны, контентные экраны скрыты).
function hideCoreViews() {
  hideEntryViews();
  // Шапку СКРЫВАЕМ: hideCoreViews обслуживает только экраны платёжного пути (валюта,
  // уход в платёжку, ожидание оплаты). Раньше она здесь показывалась, и шапка от старого
  // дизайна возвращалась ровно там, где её быть не должно.
  if (siteHeader) siteHeader.hidden = true;
  if (siteFooter) siteFooter.hidden = true;
  els.viewCheckout.hidden = true;
  if (els.viewHome) els.viewHome.hidden = true;
  els.viewPassword.hidden = true;
  els.viewAccess.hidden = true;
}

// --- экран 1 -> WFP: своя returnUrl -> редирект в ЭТОЙ вкладке, БЕЗ экрана 3 и новой вкладки.
// WFP вернётся по returnUrl -> ?paid=1&order= -> enterPaymentReturn (пароль). ---
async function goCheckoutSubmit() {
  clearErrors();
  const email = readCheckoutEmail();
  if (!email) return;
  state.method = "wayforpay";
  state.email = email;
  clearLavaReturn();   // WFP не использует stash; чистим, чтобы бут на возврате не ушёл в заглушку
  const btn = els.btnPay;
  if (btn) { btn.disabled = true; btn.textContent = "Открываем оплату..."; }
  // БЕЗ автоповтора: повтор создаст второй заказ. Повторяет человек кнопкой.
  const r = await sbFetch(CREATE_CHECKOUT_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, plan: state.plan, method: "wayforpay" }),
  });
  const data = r.data || {};
  if (r.state === "ok" && data.ok && data.invoiceUrl) { window.location.href = data.invoiceUrl; return; }
  if (r.state === "unreachable") showFormError(NET_MSG);
  else if (r.status === 429) showFormError(RATE_MSG);
  // Домен не принимает почту (проверка MX на сервере) - это почти всегда опечатка в домене.
  else if (data.error === "invalid_email_domain") showEmailError("Проверьте адрес: домен не принимает почту. Опечатка?");
  else if (r.status === 400 || data.error === "invalid_email") showEmailError(EMAIL_HINT);
  else showFormError("Не удалось открыть оплату. Попробуйте ещё раз.");
  if (btn) { btn.disabled = false; btn.textContent = "Оплатить"; }
}
// --- экран 1 -> ссылка "Оплатить в рублях": та же валидация, дальше экран 2 (выбор валюты) ---
function goLavaCurrency() {
  clearErrors();
  const email = readCheckoutEmail();
  if (!email) return;
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
// --- экран 3 (ТОЛЬКО Lava): предупреждение об уходе + адрес возврата ---
function showPayGo() {
  hideCoreViews(); hidePayFlowExtra();
  const e = document.getElementById("pay-go-error"); if (e) e.hidden = true;
  const b = document.getElementById("btn-pay-go"); if (b) { b.disabled = false; b.textContent = "Перейти к оплате"; }
  els.viewPayGo.hidden = false;
  window.scrollTo(0, 0);
}

// Клик "Перейти к оплате": создаём инвойс и уходим на Lava в ЭТОЙ ЖЕ вкладке (у Lava нет returnUrl).
// Навигация своей вкладки после await надёжна на iOS (в отличие от window.open) - белой вкладки нет,
// пре-фетч не нужен, инвойс создаётся только по реальному клику -> нет сирот. stash -> возврат руками.
async function onPayGo() {
  const btn = document.getElementById("btn-pay-go");
  const errEl = document.getElementById("pay-go-error");
  if (errEl) errEl.hidden = true;
  if (btn) { btn.disabled = true; btn.textContent = "Открываем оплату..."; }
  // БЕЗ автоповтора: повтор создаст второй инвойс. Повторяет человек кнопкой.
  const currency = state.lavaCurrency === "EUR" ? "EUR" : "RUB";
  const r = await sbFetch(CREATE_LAVA_INVOICE_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: state.email, plan: state.plan, currency }),
  });
  const data = r.data || {};
  if (r.state === "ok" && data.ok && data.paymentUrl && data.order_reference) {
    stashLavaReturn(data.order_reference, state.email, "lava");
    window.location.href = data.paymentUrl;   // та же вкладка -> Lava; возврат руками на адрес
    return;
  }
  // Lava строже нас по email (напр. отбивает несуществующий домен) -> возвращаем на экран 1 к полю почты.
  if (data.error === "invalid_email") {
    showCheckout();
    showEmailError("Проверьте адрес почты — платёжная система его не приняла. Пример: ваша@почта.com");
    return;
  }
  if (errEl) {
    errEl.textContent = r.state === "unreachable" ? NET_MSG
      : (r.status === 429 ? RATE_MSG : "Не удалось открыть оплату. Попробуйте ещё раз.");
    errEl.hidden = false;
  }
  if (btn) { btn.disabled = false; btn.textContent = "Перейти к оплате"; }
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
// resolve-paid-order - чтение, идемпотентно -> автоповтор разрешён.
// Экран ожидания и так опрашивает по кругу, поэтому обрыв тут молчит, как и раньше.
async function checkPaidOnce(order) {
  const r = await sbFetch(RESOLVE_ORDER_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderReference: order }),
  }, { retry: true });
  const data = r.data || {};
  if (r.state === "ok" && data.ok && data.email) return { email: data.email };
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
// pageshow: (а) уже на ожидании -> перезапуск опроса; (б) вернулись Назад из Lava (bfcache) на экран 3,
// а оплата уже начата (stash есть) -> сразу показываем ожидание+опрос (бонус к ручному возврату на адрес).
window.addEventListener("pageshow", () => {
  if (payWaitVisible()) { startPayPoll(); return; }
  if (readLavaReturn() && els.viewPayGo && !els.viewPayGo.hidden) showPayWait();
});

// ===================== ВОЗВРАТ ПОСЛЕ ОПЛАТЫ: ЭКРАН ПАРОЛЯ =====================
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function showPwError(msg) {
  els.pwError.textContent = msg || "";
  els.pwError.hidden = !msg;
  // Ссылка "Не помню пароль" живёт только вместе с ошибкой про существующий аккаунт,
  // её включает onEnter отдельно. Любая другая ошибка и любая очистка её гасят.
  const forgot = document.getElementById("pw-forgot");
  if (forgot) forgot.hidden = true;
}
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

  // Пояснение про письма показываем ТОЛЬКО заказам WayForPay: у них oref вида wfp_<ts>_<hex>,
  // у Lava - UUID инвойса, и там своя почта, чужой текст только запутает.
  const mail = document.getElementById("pw-mail-note");
  if (mail) mail.hidden = !(order && /^wfp_/i.test(order));

  // Кнопка "Скопировать номер": на телефоне выделять текст пальцем неудобно.
  // Обработчик вешаем ОДИН раз (флаг на элементе): экран пароля показывается повторно.
  const btn = document.getElementById("pw-order-copy");
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = "1";
    btn.addEventListener("click", async () => {
      const text = (val && val.textContent || "").trim();
      if (!text) return;
      try {
        // clipboard API живёт только на https и по жесту пользователя - клик подходит
        await navigator.clipboard.writeText(text);
      } catch {
        // фолбэк для старых webview: выделяем номер, дальше женщина копирует сама
        const r = document.createRange(); r.selectNodeContents(val);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      }
      const was = btn.textContent;
      btn.textContent = "Скопировано";
      setTimeout(() => { btn.textContent = was; }, 1600);
    });
  }
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
  // Состояния прошлых заходов не должны залипать: "Повторить" и ссылка "Не помню пароль"
  // показываются ТОЛЬКО после своей ошибки, а экран открывается повторно в той же вкладке.
  els.btnRetry.hidden = true;
  showPwError("");
  // Выход "На главную" живёт только в состоянии битой ссылки, см. ветку ошибки ниже.
  const pwOutReset = document.getElementById("pw-dead-end-out");
  if (pwOutReset) pwOutReset.hidden = true;

  if (!sb) {
    els.pwLoading.hidden = true;
    els.pwSuccess.hidden = true;
    els.pwResolveError.textContent = "Не удалось загрузить вход. Обновите страницу.";
    els.pwResolveError.hidden = false;
    if (pwOutReset) pwOutReset.hidden = false;   // формы нет -> нужен выход
    return;
  }
  {
    // чтение, идемпотентно -> автоповтор разрешён
    const r = await sbFetch(RESOLVE_ORDER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderReference: order }),
    }, { retry: true });
    if (r.state === "unreachable") {
      // связь не дала вердикта -> экран связи, кнопка «Повторить» вернёт сюда же
      els.pwLoading.hidden = true;
      showConnection(() => enterPaymentReturn(order));
      return;
    }
    const res = { ok: r.state === "ok", status: r.status };
    const data = r.data || {};
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
      // Тупик: до этого на экране был только текст ошибки, уйти было некуда.
      // Выход ведёт на СТАРТ, где есть и вход, и "оплатили, но ещё не заходили".
      const pwOut = document.getElementById("pw-dead-end-out");
      if (pwOut) pwOut.hidden = false;
    }
  }
}

// Выход из ЗАЛИПШЕГО возврата с оплаты. Адрес с ?paid=1&order= читается на КАЖДОМ заходе
// (startParams в конце файла) и показывает "Оплата прошла" со старым номером - без этого
// адрес нужно чистить, иначе перезагрузка вернёт тот же экран и женщина снова в ловушке.
// Убрать ?paid=1&order= из адреса, ничего больше не трогая. Зовётся и при успешном
// открытии доступа, и из кнопки "Это не мой заказ".
function stripPaidParams() {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has("paid") && !url.searchParams.has("order")) return;
    url.searchParams.delete("paid");
    url.searchParams.delete("order");
    history.replaceState(null, "", url);
  } catch {}
}

function leavePaymentReturn() {
  stripPaidParams();
  clearLavaReturn();
  state.order = null;
  state.email = null;
  state.lavaReturn = false;
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
  // Заказ живой, форма показана -> выхода на экране нет: женщина пришла задать пароль.
  const pwOut2 = document.getElementById("pw-dead-end-out");
  if (pwOut2) pwOut2.hidden = true;
  els.btnRetry.hidden = true;
  showPwError("");
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
      // Без этой ссылки женщина упиралась: пароля не помнит, а уйти в восстановление отсюда некуда.
      const forgot = document.getElementById("pw-forgot");
      if (forgot) forgot.hidden = false;
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
  // 1) привязка supabase-логина к оплатившему person.
  // БЕЗ автоповтора (создаёт связку). Нет связи -> экран связи, а не "не удалось открыть доступ".
  const a = await sbFetch(ATTACH_IDENTITY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + accessToken },
    body: JSON.stringify({ orderReference: state.order }),
  });
  if (a.state === "unreachable") {
    pwLoading(false);
    showConnection(() => attachAndVerify(accessToken));
    return;
  }
  if (a.state !== "ok") {
    showPwError("Не удалось открыть доступ. Нажмите «Повторить».");
    els.btnRetry.hidden = false;
    pwLoading(false);
    return;
  }
  // 2) проверка доступа: 3 попытки по ~2с. Этот цикл - ПРО ГОНКУ С ВЕБХУКОМ (подписка могла
  // ещё не активироваться), семантика сохранена. Сетевой слой добавлен сверху: считаем,
  // сколько попыток вообще НЕ получили ответа. Внутренний ретрай sbFetch здесь выключен -
  // цикл сам и есть повтор, иначе ожидание растянулось бы до нескольких минут.
  let unreachableCount = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const v = await sbFetch(VERIFY_ACCESS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + accessToken },
    });
    if (v.state === "ok") {
      const data = v.data || {};
      if (data.access) { clearLavaReturn(); await routeHomeOrCheckout(); return; }  // после оплаты/пароля -> РЕАЛЬНЫЙ ДОМ, не заглушка
    } else if (v.status === 401) {
      showPwError("Сессия не подтвердилась. Обновите страницу и войдите снова.");
      pwLoading(false);
      return;
    } else if (v.state === "unreachable") {
      unreachableCount++;
    }
    // 403 -> доступ ещё не выдан, ждём и ретраим (гонка с вебхуком)
    if (attempt < 3) await sleep(2000);
  }
  // Ни одна попытка не получила вердикта -> это связь, а не "оплата обрабатывается".
  if (unreachableCount === 3) {
    pwLoading(false);
    showConnection(() => attachAndVerify(accessToken));
    return;
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
  bind("checkout-back", () => checkoutBack());         // чекаут -> туда, откуда пришли
  bind("lavacur-back", () => showCheckout());          // экран 2 -> назад к тарифам
  bind("pay-go-back", () => showCheckout());           // экран 3 -> назад к тарифам (оплаты ещё не было)
  // Единственный выход с экрана пароля: чистит адрес (иначе перезагрузка вернёт сюда же) и ведёт
  // на старт. Покрывает оба случая - битую ссылку и чужой/старый заказ в адресе.
  bind("pw-dead-end-out", () => { leavePaymentReturn(); showStart(); });
  bind("pw-forgot-link", () => showResetPrefilled(state.email, state.order)); // "не помню пароль" -> восстановление с готовыми полями
  bind("btn-lava-pay", () => showPayGo());             // экран 2 -> экран 3
  bind("btn-pay-go", () => onPayGo());                 // экран 3 -> оплата в той же вкладке (Lava)
  bind("btn-paid-check", () => onPaidCheck());         // экран 4 -> ручная проверка
  bind("btn-pay-back", () => { clearLavaReturn(); showCheckout(); }); // экран 4 -> выход к тарифам (чистит stash)
  bind("start-paid-help", () => showClaim());          // старт: "оплатили, но ещё не заходили?" -> первый пароль по номеру заказа
  const curOpts = document.getElementById("cur-opts");
  if (curOpts) curOpts.addEventListener("change", (e) => {
    if (e.target.name === "lavacur") { state.lavaCurrency = e.target.value === "EUR" ? "EUR" : "RUB"; paintCur(); }
  });
}
els.email.addEventListener("input", () => showEmailError(""));
if (els.email2) els.email2.addEventListener("input", () => showEmailError(""));

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
  await resumeAttachFromSession();
});
// Достать сессию и продолжить выдачу доступа. Нет связи -> экран связи, кнопка «Повторить»
// возвращается СЮДА ЖЕ (а не в attachAndVerify с пустым токеном).
async function resumeAttachFromSession() {
  const s = await getSessionState({ retry: true });
  if (s.state === "ok") { await attachAndVerify(s.token); return; }
  if (s.state === "unreachable") { showConnection(resumeAttachFromSession); return; }
  showPwError("Сессия истекла. Обновите страницу и войдите снова.");
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
  hero: document.getElementById("home-hero"),
  progressTrack: document.getElementById("home-progress"),
  progressBar: document.getElementById("home-progress-bar"),
  progressEmpty: document.getElementById("home-progress-empty"),
  subUntil: document.getElementById("home-sub-until"),
  supportBtn: document.getElementById("home-support-btn"),
  supportContacts: document.getElementById("home-support-contacts"),
};

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// ===================== ОБЛОЖКИ СПРИНТОВ =====================
// В базе (sprints.cover_slug) лежит ТОЛЬКО слаг - ни пути, ни расширения, ни хоста.
// Путь собирается здесь, поэтому переезд картинок в Storage или на CDN не потребует
// правки данных. ?v= обязателен: Pages отдаёт статику с длинным кэшем, и без версии
// подменённая обложка до подписчиц просто не доедет.
// v2 (2026-08-16): перерисованы обе обложки antichaos под теми же именами. Счётчик
// ОДИН на все обложки - подмена одной картинки заставляет перекачать и остальные.
// Это осознанный размен: отдельная версия у каждого файла означала бы 14 констант.
// v3 (2026-08-17): ШЕСТЬ ПОСТЕРОВ от Ирены, разноцветные (было единой малиновой
// серией). Заменены ТОЛЬКО {slug}-poster.webp у sleep, antichaos, gut-body,
// woman-body, nutrition, glutes; широкие версии и лотос rejuvenation не тронуты.
// Исходники - лендскейпные КАРТОЧКИ (чёрное поле по краям, скруглённые углы, бейдж
// с глифом в правом верхнем углу), поэтому кроп в два шага: обрезка по содержимому,
// затем 3:4. nutrition центральный кроп резал по кругу тарелки, поэтому он вписан
// ЦЕЛИКОМ, фон добит размытой копией себя с растушёвкой кромки на 90px (плоская
// подложка не годится: на ней видны скруглённые углы карточки, плитка читается
// наклейкой).
// woman-body в библиотеке НЕ используется (ЖКТ и тело - один спринт): лежит как
// ассет под шапку дорожки «только тело».
// v4 (2026-08-17): antichaos переведён с вписывания на ТЕСНЫЙ кроп. Вписанный мозг
// был мелким, а сверху на него ложится ещё filter приглушения черновика - плитка
// читалась бледным пятном. Тесный кроп срезает лобную часть и края мозжечка, зато
// средняя яркость плитки под фильтром выросла с 0.007 до 0.012, а контраст заголовка
// под фильтром не пострадал (11.02 -> 10.89 при пороге AA 4.5).
// ⚠️ COVER_V ЖИВЁТ ВНУТРИ ЭТОГО ФАЙЛА, поэтому его бамп ТРЕБУЕТ бампа app.js?v= в
// index.html. Иначе браузер отдаст закэшированный бандл со старым COVER_V и старую
// картинку - счётчик обложек сам себя не доставит.
const COVER_V = 5;
// ICON_V здесь СОЗНАТЕЛЬНО НЕТ. Иконки плиток, медальон Подружки и аватар стоят
// статикой в index.html и версионируются прямо в src (`icons/…png?v=N`). Константа
// в JS их не касалась бы и стала бы вторым источником правды, который молча
// разъезжается с разметкой. Меняете картинку под тем же именем - правьте ?v= в
// index.html (там же, где счётчики бандла).
// Слаг приходит из БД и уезжает в CSS url(...) - пропускаем только безопасный набор.
// Кавычка или скобка в значении сломала бы правило, а то и подставила чужую картинку.
function coverUrl(slug, kind) {
  const s = String(slug == null ? "" : slug);
  if (!/^[a-z0-9-]{1,40}$/.test(s)) return null;
  return "covers/" + s + "-" + kind + ".webp?v=" + COVER_V;
}
// Затемнения из макета. На обложку ложится текст, и без подложки белый заголовок
// на светлой части картинки нечитаем. Картинки нарисованы объектом справа и тёмной
// левой третью - затемнение слева по ним не бьёт.
// Стоп .05 стоит на 78%, а не на 62% из макета: числа макета считались под другую,
// более тёмную слева картинку, на живых обложках (лотос, nutrition, gut-body) свет
// доходит левее и подзаголовок ложился на светлое. Правка Владлена 2026-08-16.
const COVER_SHADE_HOME = "linear-gradient(100deg, rgba(24,6,18,.82) 0%, rgba(24,6,18,.55) 34%, rgba(24,6,18,.05) 78%, transparent)";
const COVER_SHADE_DAY = "linear-gradient(to top, #0B080C 0%, rgba(11,8,12,.55) 40%, rgba(11,8,12,.15) 100%)";
// У экрана спринта затемнение СВОЁ (.listcover в макете): плотнее дневного, потому
// что под заголовком сразу идёт строка прогресса, а не воздух.
const COVER_SHADE_SPRINT = "linear-gradient(to top, #0B080C 0%, rgba(11,8,12,.6) 42%, rgba(11,8,12,.2) 100%)";
// Красим ВСЕГДА, и при отсутствии слага тоже: пустая строка снимает инлайн-стиль и
// возвращает градиент-заглушку из CSS. Без этого обложка прошлого экрана залипала бы
// на спринте, у которого своей картинки ещё нет.
function paintCover(el, slug, kind, shade) {
  if (!el) return;
  const url = coverUrl(slug, kind);
  el.style.backgroundImage = url ? (shade ? shade + ", " : "") + "url('" + url + "')" : "";
}
// Спринт, которому принадлежит день. get-day отдаёт day.sprint_id, а cover_slug уже
// лежит в homeData - отдельный запрос за обложкой не нужен.
function sprintById(id) {
  return homeSprints(homeData).find((s) => s.id === id) || null;
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
// Порог .long поднят с 18 до 26: базовый кегль героя вырос до 40px, и на нём
// заголовок в 20-25 знаков нормально ложится в две строки. Ронять до 30px имеет
// смысл только на действительно длинных именах дней, которых в базе хватает.
function setHeadline(el, text) {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("long", (text || "").length > 26);
}

// КУДА ВЕДЁТ НАЗАД С ЧЕКАУТА. null = пришли СНАРУЖИ (прямая ссылка, первый заход,
// маршрутизация при отсутствии доступа) - возвращать некуда, кнопки быть не должно.
// Значение ставят только те переходы, которые ведут на чекаут ИЗНУТРИ приложения.
// Внутренние возвраты на сам чекаут (с выбора валюты, с ожидания оплаты) его НЕ трогают.
let checkoutBackTo = null;
function checkoutBack() {
  const t = checkoutBackTo;
  checkoutBackTo = null;
  if (t === "subscription") { openSubscription(); return; }
  if (t === "login") { showLogin(); return; }
  showStart();
}

function showCheckout() {
  hideEntryViews();
  hidePayFlowExtra();
  // Шапка с плашкой "И" - от старого дизайна. На чекауте и дальше по платёжному пути
  // её нет: экран стал обычным экраном-задачей со своим заголовком и кнопкой назад,
  // как день, спринт и подписка. На экранах входа она остаётся - там это единственное,
  // что говорит новому человеку, куда он попал.
  if (siteHeader) siteHeader.hidden = true;
  if (siteFooter) siteFooter.hidden = true;
  const backBtn = document.getElementById("checkout-back");
  if (backBtn) backBtn.hidden = !checkoutBackTo;
  if (els.viewHome) els.viewHome.hidden = true;
  if (els.viewLavaReturn) els.viewLavaReturn.hidden = true;   // мост Lava не должен висеть под чекаутом
  els.viewPassword.hidden = true;
  els.viewAccess.hidden = true;
  clearLavaReturn();   // ушли на чекаут -> сбрасываем незавершённый Lava-возврат (ложный мост)
  els.viewCheckout.hidden = false;
  // существующая инициализация чекаута (ровно как было на старте) - оплатная ветка не тронута
  // Неизвестный тариф в адресе (в т.ч. старая ссылка ?plan=test) МОЛЧА игнорируется:
  // readPlanFromUrl подставляет значение, только если оно есть в PLANS, иначе остаётся
  // тариф по умолчанию. Женщина, открывшая разошедшуюся ссылку, видит обычный чекаут.
  readPlanFromUrl();
  writePlanToUrl();
  paintSelected();
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
  homeEls.loading.textContent = "Загрузка…";   // сброс счётчика попыток от прошлого захода
  homeEls.loading.hidden = false;
  homeEls.content.hidden = true;
}

// ===================== БИБЛИОТЕКА СПРИНТОВ =====================
// Ответ get-home бывает двух форм: старой (sprint + days) и новой (sprints[]).
// Сворачиваем обе к одному списку, чтобы остальной код о разнице не знал.
let currentSprintId = null;   // спринт, показанный на доме

function homeSprints(data) {
  if (!data) return [];
  if (Array.isArray(data.sprints) && data.sprints.length) return data.sprints;
  if (data.sprint) return [Object.assign({}, data.sprint, { days: data.days || [] })];
  return [];
}
// Текущий = идущий спринт. Если идущего нет (библиотека из одних архивных) -
// тот, в котором женщина остановилась на середине, иначе первый по порядку.
function pickCurrentSprint(sprints, completed) {
  // ЧЕРНОВИКИ ОТСЕИВАЕМ ПЕРВЫМ ДЕЛОМ. С 2026-08-17 get-home отдаёт и draft, а
  // фолбэк ниже возвращает sprints[0] - незалитый «Анти-хаос» с order_index=12
  // стоит в списке РАНЬШЕ всех залитых и стал бы «текущим» на доме, ведя женщину
  // в пустой спринт. Сейчас до фолбэка дело не доходит только потому, что active
  // существует; это везение, а не гарантия - активного может не оказаться.
  sprints = sprints.filter((s) => s.status !== "draft");
  const active = sprints.find((s) => s.status === "active");
  if (active) return active;
  let best = null, bestDone = -1;
  for (const s of sprints) {
    const days = s.days || [];
    const done = days.filter((d) => completed.has(d.id)).length;
    if (done > 0 && done < days.length && done > bestDone) { best = s; bestDone = done; }
  }
  return best || sprints[0] || null;
}

// Рендер дома из ответа get-home (реальные данные)
function renderHome(data) {
  homeData = data;   // сохраняем для экранов спринт/день и обновления прогресса
  navStack = [];     // дом - основание стека: пришли сюда, история пройдена
  const completed = new Set((data.progress && data.progress.completed_day_ids) || []);
  const sprint = pickCurrentSprint(homeSprints(data), completed);
  currentSprintId = sprint ? sprint.id : null;
  const days = sprint && Array.isArray(sprint.days) ? sprint.days.slice().sort((a, b) => a.day_number - b.day_number) : [];
  const completedVisible = days.filter((d) => completed.has(d.id)).length;
  const nextDay = days.find((d) => !completed.has(d.id)) || null;
  const sprintTitle = sprint ? sprint.title : "";

  // Обложка героя = широкая картинка ТЕКУЩЕГО спринта. Нет слага -> градиент.
  paintCover(homeEls.hero, sprint && sprint.cover_slug, "wide", COVER_SHADE_HOME);

  // --- верхняя адаптивная карточка ---
  // Кикер несёт номер дня ("СЕГОДНЯ · ДЕНЬ 6"), заголовок - имя дня БЕЗ префикса.
  // Заголовки в базе физически начинаются с "День N." - без dayShortTitle номер
  // печатался дважды. Тот же помощник уже работает в списке дней спринта.
  function heroHtml(day, kicker, cta) {
    const sub = (day.subtitle || "").trim();
    return '<div class="home-kicker">' + escapeHtml(kicker) + " · День " + day.day_number + "</div>" +
      '<div class="home-headline" id="home-hl"></div>' +
      (sub ? '<div class="home-subhead">' + escapeHtml(sub) + "</div>" : "") +
      '<div class="home-cta" data-day-id="' + escapeHtml(day.id) + '" role="button">' +
        '<span class="home-cta-ic"><i class="ti ti-player-play"></i></span>' +
        "<span>" + escapeHtml(cta) + "</span></div>";
  }

  if (!sprint || days.length === 0) {
    homeEls.herobox.innerHTML =
      '<div class="home-headline">Скоро здесь появятся дни</div>' +
      '<div class="home-subhead">Контент готовится. Загляните чуть позже.</div>';
  } else if (completedVisible === 0) {
    // НОВИЧОК
    homeEls.herobox.innerHTML = heroHtml(days[0], "Начинаем", "Начать");
    setHeadline(document.getElementById("home-hl"), dayShortTitle(days[0].title));
  } else if (nextDay) {
    // ВЕРНУВШИЙСЯ
    homeEls.herobox.innerHTML = heroHtml(nextDay, "Сегодня", "Продолжить");
    setHeadline(document.getElementById("home-hl"), dayShortTitle(nextDay.title));
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
  // Ноль пройденных -> полосы нет вовсе, вместо неё строка-статус. Math.max(2,…)
  // остаётся ТОЛЬКО для реального прогресса: один день из 28 - это 4%, но один день
  // из 90 дал бы 1% и полоса выглядела бы пустой, хотя дело сдвинулось.
  const started = completedVisible > 0;
  if (homeEls.progressTrack) homeEls.progressTrack.hidden = !started;
  if (homeEls.progressEmpty) homeEls.progressEmpty.hidden = started;
  if (started) {
    const pct = denom > 0 ? Math.max(2, Math.min(100, Math.round((completedVisible / denom) * 100))) : 100;
    homeEls.progressBar.style.width = pct + "%";
  }

  // --- статус подписки (карточка + подпись в меню отражают реальное состояние) ---
  // renderHome вызывается только при access=true -> состояние: active / grace / cancelled (не "истекла").
  const subGrace = data.status === "grace";
  const subCancelled = !!data.cancelled;
  const untilRu = data.valid_until ? fmtDateRu(data.valid_until) : "";
  homeEls.subUntil.textContent = untilRu ? ("до " + untilRu) : "";
  const subTitleEl = document.getElementById("home-sub-title");
  if (subTitleEl) subTitleEl.textContent = subGrace ? "Оплата не прошла" : (subCancelled ? "Автопродление отключено" : "Подписка активна");
  const hmenuUntil = document.getElementById("hmenu-sub-until");
  if (hmenuUntil) {
    hmenuUntil.textContent = subGrace
      ? ("оплата не прошла" + (untilRu ? ", продлите до " + untilRu : ""))
      : subCancelled
        ? ("автопродление отключено" + (untilRu ? ", до " + untilRu : ""))
        : ("активна" + (untilRu ? " до " + untilRu : ""));
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
// Членская карта + факты + что входит + отключение автопродления (роутинг по source).
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
  const s = await getSessionState({ retry: true });
  if (s.state === "unreachable") { if (loading) loading.hidden = true; showConnection(openSubscription); return; }
  if (s.state !== "ok") { routeHomeOrCheckout(); return; }   // сессия потерялась -> перемаршрутизируем
  // web-subscription - чтение, идемпотентно -> автоповтор разрешён
  const r = await sbFetch(WEB_SUB_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + s.token },
  }, { retry: true });
  const data = r.data || {};
  if (r.state === "ok" && data.ok && data.subscription) {
    renderSubscription(data.subscription);
    if (loading) loading.hidden = true;
    if (content) content.hidden = false;
    return;
  }
  if (loading) loading.hidden = true;
  // развели: нет связи -> отдельный экран; сервер ответил -> прежняя честная ошибка
  if (r.state === "unreachable") { showConnection(openSubscription); return; }
  if (errEl) { errEl.innerHTML = "Не удалось загрузить данные подписки. Обновите страницу или напишите нам " + supportEmailHtml() + "."; errEl.hidden = false; }
}

// Что даёт подписка. Порядок закреплён макетом, произвольно не менять.
const SUB_INCLUDES = ["тренировки и упражнения", "трекеры здоровья и цикла", "дневник самочувствия",
  "медитации", "дыхательные практики", "обучающие материалы", "ежедневные подкасты"];

const CUR_SIGN = { EUR: "\u20AC", UAH: "\u20B4", RUB: "\u20BD" };
function priceText(plan) {
  if (!plan || plan.amount == null) return "";
  const sign = CUR_SIGN[plan.currency] || plan.currency || "";
  return sign ? (plan.amount + " " + sign) : "";
}
// "1 месяц · 11 €". Сумма может быть неизвестна (у рублёвых заказов expected_amount
// пустой) - тогда печатаем только период. Ничего не выдумываем, это платёжный экран.
function planText(plan) {
  if (!plan) return "";
  const m = plan.months;
  const period = m === 1 ? "1 месяц" : m === 6 ? "6 месяцев" : m === 12 ? "12 месяцев" : (m ? m + " мес." : "");
  return [period, priceText(plan)].filter(Boolean).join(" \u00B7 ");
}
// "июня 2026" - именно родительный падеж: "Участница с июня 2026".
// Формат {month:"long"} без дня даёт ИМЕНИТЕЛЬНЫЙ ("июнь"), поэтому просим дату
// целиком и отрезаем число - так ICU отдаёт нужную форму на всех движках.
function fmtMonthYear(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })
          .replace(/^\d+\s+/, "").replace(/\s*г\.$/, "");
}
// "23 сентября" - для прозы. В самой карте даты остаются цифрами (23.09.2026):
// на карте это реквизит, в тексте - разговор.
function fmtDayMonth(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}
// "23 сентября 2026" - для подтверждения, там год важен.
function fmtDayMonthYear(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }).replace(/\s*г\.$/, "");
}
function daysLeft(iso) {
  const t = iso ? new Date(iso).getTime() : 0;
  if (!t) return null;
  return Math.max(0, Math.ceil((t - Date.now()) / 86400000));
}
function plurDaysLeft(n) {
  const a = n % 10, b = n % 100;
  const w = (a === 1 && b !== 11) ? "день" : (a >= 2 && a <= 4 && (b < 10 || b >= 20)) ? "дня" : "дней";
  return n + " " + w;
}
// Членская карта. Внутри ТОЛЬКО бренд, статус и срок - то, что бывает на настоящей
// карте. Строки без данных не печатаем: пустых подписей на карте быть не должно.
function memcardHtml(kind, chip, sub, rightLabel, rightValue) {
  const since = sub.started_at ? fmtMonthYear(sub.started_at) : "";
  return '<div class="memcard ' + kind + '">' +
    '<div class="mtop"><span class="mbrand">ИРЕНА БИО</span><span class="mchip">' + escapeHtml(chip) + '</span></div>' +
    '<div class="mname">Полный доступ</div>' +
    '<div class="mline">' +
      (since ? '<div><span>Участница с</span><b>' + escapeHtml(since) + '</b></div>' : '<div></div>') +
      (rightValue ? '<div class="right"><span>' + escapeHtml(rightLabel) + '</span><b>' + escapeHtml(rightValue) + '</b></div>' : '') +
    '</div></div>';
}
function inclHtml(title) {
  return '<div class="inclcard"><span class="incltitle">' + escapeHtml(title) + '</span><ul class="incl">' +
    SUB_INCLUDES.map(function (x) { return '<li>' + escapeHtml(x) + '</li>'; }).join("") + '</ul></div>';
}
function rowsHtml(rows) {
  const body = rows.filter(Boolean).map(function (r) {
    return '<div class="subrow"><span>' + escapeHtml(r[0]) + '</span><b' + (r[2] ? ' class="' + r[2] + '"' : '') +
      '>' + escapeHtml(r[1]) + '</b></div>';
  }).join("");
  return body ? '<div class="subrows">' + body + '</div>' : "";
}

function renderSubscription(sub) {
  const until = fmtDateDots(sub.valid_until);      // в карту, цифрами
  const untilWords = fmtDayMonth(sub.valid_until); // в текст, словами
  const untilFull = fmtDayMonthYear(sub.valid_until);
  const box = document.getElementById("sub-content");
  if (!box) return;

  // Доступ по ACCESS-CANON (active/grace + valid_until + 3д грейса). Нет доступа -> "закончилась".
  const SUB_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
  const subTs = sub.valid_until ? new Date(sub.valid_until).getTime() : 0;
  const hasAccess = (sub.status === "active" || sub.status === "grace") && subTs && (subTs + SUB_GRACE_MS > Date.now());
  const recurrent = (sub.source === "wayforpay" || sub.source === "lava");
  // ПРАВДА О ПРАВИЛЕ (только WayForPay): web-subscription отдаёт sub.regular - живой STATUS
  // либо последний известный кэш (stale). Правило может исчезнуть само: протухла карта, банк
  // отклонил, кто-то снял в кабинете. Тогда "Автопродление: Включено" было бы враньём.
  // Нет ни свежего ответа, ни кэша -> sub.regular = null -> ведём себя как раньше.
  const ruleState = sub.regular && sub.regular.status ? sub.regular.status : null;
  const ruleDead = ruleState !== null && ruleState !== "Active";
  const recurrentLive = recurrent && !(sub.source === "wayforpay" && ruleDead);
  const nextChargeWords = (recurrentLive && sub.regular && sub.regular.next_payment_at)
    ? fmtDayMonth(sub.regular.next_payment_at) : null;
  const left = daysLeft(sub.valid_until);
  const price = priceText(sub.plan);

  let html = "";
  let wireCancel = false, wireRenew = false;

  if (!hasAccess) {
    // Доступа уже нет. В макете этого состояния нет, но экран обязан не ломаться.
    html += memcardHtml("off", "ЗАКОНЧИЛАСЬ", sub, "Закончилась", until || "");
    html += '<p class="mnote">Доступ закрыт. Прогресс и отметки сохранены - вернутся сразу после оформления.</p>';
    html += '<button type="button" class="sub-primary" id="sub-renew">Оформить подписку</button>';
    html += inclHtml("Что откроется снова");
    wireRenew = true;
  } else if (sub.status === "grace") {
    // ОПЛАТА НЕ ПРОШЛА. Кнопка оплаты идёт СРАЗУ под картой: заплатить надо мочь,
    // не листая экран.
    html += memcardHtml("bad", "ОПЛАТА НЕ ПРОШЛА", sub, "Доступ ещё", left != null ? plurDaysLeft(left) : "");
    html += '<p class="mnote">Банк отклонил списание' + (untilWords ? " " + untilWords : "") +
            '. Обычно помогает повторить оплату - деньги спишутся один раз.</p>';
    html += '<button type="button" class="sub-primary" id="sub-renew">' +
            (price ? "Оплатить " + escapeHtml(price) : "Оплатить") + '</button>';
    html += rowsHtml([
      sub.plan ? ["Тариф", planText(sub.plan)] : null,
      ["Способ оплаты", "Банковская карта"]
    ]);
    html += inclHtml("Что входит");
    wireRenew = true;
  } else if (sub.cancelled) {
    // БЕЗ ПРОДЛЕНИЯ. Карта гаснет, главная кнопка - вернуть продление.
    html += memcardHtml("off", "БЕЗ ПРОДЛЕНИЯ", sub, "Доступ до", until || "");
    html += '<p class="mnote">Всё открыто до этой даты. Дальше списаний не будет и доступ закроется.</p>';
    html += '<button type="button" class="sub-primary" id="sub-renew">Включить продление</button>';
    html += rowsHtml([
      sub.plan ? ["Тариф", planText(sub.plan)] : null,
      ["Способ оплаты", "Банковская карта"],
      left != null ? ["Осталось", plurDaysLeft(left)] : null
    ]);
    html += inclHtml(untilWords ? "Что потеряешь после " + untilWords : "Что потеряешь");
    wireRenew = true;
  } else {
    // АКТИВНА.
    html += memcardHtml("ok", "АКТИВНА", sub, "Действует до", until || "");
    // Дата следующего списания - из САМОГО правила, если оно известно; иначе конец периода.
    const chargeWords = nextChargeWords || untilWords;
    html += '<p class="mnote">' +
      (recurrentLive
        ? (chargeWords ? (chargeWords + (price ? " спишется " + escapeHtml(price) : " продлится") + " за следующий период. Напомню за три дня.")
                 : "Продлевается автоматически.")
        : recurrent
          // Правило не действует: доступ до конца оплаченного периода, дальше тишина.
          ? ("Доступ открыт" + (untilWords ? " до " + untilWords : "") +
             ". Автопродление сейчас не действует - следующего списания не будет.")
          : (until ? "Доступ открыт до " + until + "." : "Доступ открыт.")) + '</p>';
    html += rowsHtml([
      sub.plan ? ["Тариф", planText(sub.plan)] : null,
      ["Способ оплаты", "Банковская карта"],
      recurrent ? ["Автопродление", recurrentLive ? "Включено" : "Не действует", recurrentLive ? "green" : null] : null
    ]);
    html += inclHtml("Что входит");
    // Кнопку отключения показываем, только когда есть что отключать.
    if (recurrentLive) {
      // Слово "отменить" не используем НИГДЕ: женщина читает "отменить подписку" и
      // думает, что теряет доступ сейчас же. Отключается именно автопродление, а
      // доступ остаётся до конца оплаченного периода - это и должно быть видно.
      html += '<button type="button" class="sub-ghost" id="sub-cancel-btn">Отключить автопродление</button>' +
        '<div class="sub-confirm" id="sub-confirm" hidden>' +
          '<div class="sub-confirm-grip"></div>' +
          '<b class="sub-confirm-title">Отключить автопродление?</b>' +
          '<p class="sub-confirm-text">Доступ останется' + (untilFull ? " до " + untilFull : "") +
            '. Списаний больше не будет, прогресс и отметки сохранятся. Текущая цена не закрепляется: ' +
            'при возврате подписка будет по действующему на тот момент тарифу.</p>' +
          '<button type="button" class="sub-primary" id="sub-confirm-no">Оставить подписку</button>' +
          '<button type="button" class="sub-quiet" id="sub-confirm-yes">Да, отключить</button>' +
        '</div>' +
        '<div class="sub-result" id="sub-cancel-result" hidden></div>';
      wireCancel = true;
    }
  }

  box.innerHTML = html;
  if (wireRenew) {
    const rb = document.getElementById("sub-renew");
    if (rb) rb.addEventListener("click", function () { hideContentViews(); checkoutBackTo = "subscription"; showCheckout(); });
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
    yes.disabled = true; if (no) no.disabled = true; yes.textContent = "Отключаем…";
    {
      const token = await getToken();
      if (!token) { routeHomeOrCheckout(); return; }
      const cancelUrl = sub.source === "lava" ? CANCEL_LAVA_URL : CANCEL_SUB_URL;
      // БЕЗ автоповтора: отключение автопродления - действие, повторять молча нельзя.
      const r = await sbFetch(cancelUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      });
      if (r.state === "unreachable") {
        yes.disabled = false; if (no) no.disabled = false; yes.textContent = "Да, отключить";
        if (result) {
          result.innerHTML = '<div class="sub-status-sub sub-status-warn">Нет связи - отключение не отправилось, лишнего не списано. Попробуйте ещё раз или чуть позже. Не помогает - напишите ' + supportContactsHtml() + ".</div>";
          result.hidden = false;
        }
        return;
      }
      const res = { ok: r.state === "ok" };
      const data = r.data || {};
      if (res.ok && data.ok) {
        // успех: cancelled / already_cancelled / no_active_recurrent
        const untilC = fmtDateDots(data.valid_until || sub.valid_until);
        if (confirmBox) confirmBox.hidden = true;
        if (btn) btn.hidden = true;
        if (result) {
          // Осторожно ТОЛЬКО при Lava verified:false (DELETE 204, но GET не подтвердил). Иначе уверенно.
          const cautious = data.verified === false;
          const body = cautious
            ? 'Доступ сохраняется' + (untilC ? " до " + untilC : "") + '. Если позже увидите списание - напишите в поддержку, вернём.'
            : 'Дальше списаний не будет, доступ сохраняется' + (untilC ? " до " + untilC : "") + '. Чтобы вернуться - оформите подписку заново.';
          result.innerHTML = '<div class="sub-status-title">' + "Автопродление отключено" + '</div>' +
            '<div class="sub-status-sub">' + body + '</div>';
          result.hidden = false;
        }
      } else {
        // ok:false (вкл. 502 rc≠4100/4102) -> честная ошибка + контакты, кнопка остаётся
        yes.disabled = false; if (no) no.disabled = false; yes.textContent = "Да, отключить";
        if (result) {
          result.innerHTML = '<div class="sub-status-sub sub-status-warn">Не получилось отключить - автопродление пока включено, лишнего не списано. Напишите в поддержку: ' + supportContactsHtml() + " - поможем.</div>";
          result.hidden = false;
        }
      }
    }
  });
}

// Тумблер темы УДАЛЁН (редизайн, шаг A): схема теперь одна - тёмная. Атрибут data-theme="dark"
// стоит статикой на <html>, светлых токенов в style.css больше нет, а ключ irena_theme='light'
// у переключавшихся ранее снимается одноразовой затиркой в <head>. Пункт меню #hmenu-theme
// убран из index.html - здесь ловить нечего.

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
  // Тест «Возраст тела»: плитки на доме нет, открывается меткой из текста дня.
  bodyage: { url: "https://vladlen00.github.io/bodyage/", v: "1" },
};

async function openMiniApp(appKey, tileEl) {
  const app = MINI_APPS[appKey];
  if (!app || !tileEl || tileEl.dataset.busy === "1") return;
  const sub = tileEl.querySelector(".t5s, .sheet-card-sub, .home-wide-sub");
  const subText = sub ? sub.textContent : "";
  const flash = (msg) => { if (sub) { sub.textContent = msg; setTimeout(() => { sub.textContent = subText; }, 3000); } };
  tileEl.dataset.busy = "1";
  tileEl.style.opacity = "0.55";
  try {
    const token = await getToken();
    if (!token) { routeHomeOrCheckout(); return; }   // сессия потерялась -> перемаршрутизируем
    // С автоповтором: в базу не пишет (только подписывает JWT), идемпотентно, и стоит
    // на пути к контенту. Экран связи здесь не показываем: плитка сообщает о сбое на
    // месте, человек остаётся на доме и ничего не теряет.
    const r = await sbFetch(MINT_APP_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    }, { retry: true });
    if (r.state === "unreachable") { flash("Нет связи, попробуйте ещё раз"); return; }
    const res = { ok: r.state === "ok" };
    const data = r.data || {};
    if (res.ok && data.ok && data.token) {
      const frag = "#irena_token=" + encodeURIComponent(data.token) +
                   "&exp=" + encodeURIComponent(data.expiresIn || 3600);
      const q = app.q ? "&" + app.q : "";   // напр. startapp=ai для biohack-экрана
      location.href = app.url + "?v=" + encodeURIComponent(app.v) + q + frag;  // уходим со страницы
      return;
    }
    // подписка не подтвердилась (редко: истекла между загрузкой дома и кликом) или сбой сервера
    flash("Не удалось открыть, обновите страницу");
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
  // Делегат висит на .home-body, а не на .home-tools: Подружка уехала из сетки
  // в широкую карточку и осталась бы без обработчика.
  const tools = document.querySelector(".home-body");
  if (tools) {
    tools.addEventListener("click", (e) => {
      const grouped = e.target.closest("[data-group]");
      if (grouped) { openSheetByGroup(grouped.getAttribute("data-group")); return; }
      const tile = e.target.closest("[data-app]");
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

// ===================== ССЫЛКИ-МЕТКИ ВНУТРИ ДНЯ =====================
// В текстах дней из канала остались кнопки вида "ОТКРЫТЬ ТРЕКЕР" и "ОТКРЫТЬ
// В ПРИЛОЖЕНИИ" со ссылками на t.me - для веб-подписчицы это тупик. Вместо них
// ставим обычную ссылку на свой же домен с меткой и ловим её здесь: женщина
// попадает туда же, куда ведёт плитка на доме, вместе с токеном доступа.
//
// Новый тип блока НЕ нужен: mdLite уже делает ссылку из [текст](https://...),
// база, content-admin, get-day и upload.mjs не меняются.
// Старый бандл метку не поймает и просто откроет дом - это не тупик.
const DAY_LINK_PREFIX = "https://app.irenabio.com/#/";
const DAY_LINK_ROUTES = {
  relax:     (el) => openMiniApp("relax", el),   // Студия: медитации, дыхание, плеер
  trainings: () => openSheetByGroup("trainings"),
  trackers:  () => openSheetByGroup("trackers"),
  bodyage:   (el) => openMiniApp("bodyage", el), // тест «Возраст тела», день 1 спринта «Омоложение изнутри»
};
document.addEventListener("click", (e) => {
  const a = e.target.closest('a[href^="' + DAY_LINK_PREFIX + '"]');
  if (!a) return;
  const key = a.getAttribute("href").slice(DAY_LINK_PREFIX.length).replace(/[/?#].*$/, "");
  const go = DAY_LINK_ROUTES[key];
  if (!go) return;   // незнакомая метка - пусть работает как обычная ссылка
  e.preventDefault();
  go(a);
});

// ===================== ЭКРАНЫ СТАРТ / ВХОД =====================
// Незалогиненного встречает СТАРТ (выбор: войти / оформить), а не сразу checkout.
function hideEntryViews() {
  const vs = document.getElementById("view-start"); if (vs) vs.hidden = true;
  const vl = document.getElementById("view-login"); if (vl) vl.hidden = true;
  const vr = document.getElementById("view-reset"); if (vr) vr.hidden = true;
  const vc = document.getElementById("view-claim"); if (vc) vc.hidden = true;
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
  const vr0 = document.getElementById("view-reset"); if (vr0) vr0.hidden = true;
  const vc0 = document.getElementById("view-claim"); if (vc0) vc0.hidden = true;
  const vs = document.getElementById("view-start"); if (vs) vs.hidden = false;
  window.scrollTo(0, 0);
}
function showLogin() {
  hidePayFlowExtra();
  if (siteHeader) siteHeader.hidden = false;
  if (siteFooter) siteFooter.hidden = false;
  const vs = document.getElementById("view-start"); if (vs) vs.hidden = true;
  els.viewCheckout.hidden = true;
  const vr0 = document.getElementById("view-reset"); if (vr0) vr0.hidden = true;
  const vc0 = document.getElementById("view-claim"); if (vc0) vc0.hidden = true;
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
    // Обрыв связи -> честно про связь. Иначе показали бы "неверный пароль" на верном пароле.
    if (isAuthNetworkError(error)) {
      showLoginError(NET_MSG);
      btn.disabled = false; btn.textContent = "Войти";
      return;
    }
    if (error || !data || !data.session) {
      // GoTrue не различает "нет аккаунта" и "неверный пароль". Развилка: первый раз после оплаты -> claim (НЕ платить снова!),
      // иначе оформить. Оба пути явные, чтобы уже оплативший не ушёл во вторую оплату.
      showLoginError(null, "Неверная почта или пароль. Первый раз после оплаты? <a href=\"#\" id=\"login-err-claim\" style=\"color:inherit;text-decoration:underline\">Создайте пароль</a>. Ещё нет подписки? <a href=\"#\" id=\"login-err-signup\" style=\"color:inherit;text-decoration:underline\">Оформить</a>.");
      const lc = document.getElementById("login-err-claim");
      if (lc) lc.addEventListener("click", (e) => { e.preventDefault(); showClaim(); });
      const l = document.getElementById("login-err-signup");
      if (l) l.addEventListener("click", (e) => { e.preventDefault(); checkoutBackTo = "login"; showCheckout(); });
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
  const vc0 = document.getElementById("view-claim"); if (vc0) vc0.hidden = true;
  const vr = document.getElementById("view-reset"); if (vr) vr.hidden = false;
  const hint = document.getElementById("reset-hint");
  if (hint) hint.innerHTML = "Номер заказа вы сохранили при оплате. Не сохранили? Напишите в поддержку " + supportTgHtml() + " - поможем.";
  showResetError("");
  const em = document.getElementById("reset-email"); if (em) em.focus();
  window.scrollTo(0, 0);
}
// Восстановление с уже подставленными почтой и номером заказа: оба значения есть на экране
// пароля, заставлять вводить их заново незачем. Фокус сразу в поле нового пароля.
function showResetPrefilled(email, order) {
  showReset();
  const em = document.getElementById("reset-email"); if (em && email) em.value = email;
  const or = document.getElementById("reset-order"); if (or && order) or.value = order;
  const pw = document.getElementById("reset-password"); if (pw) pw.focus();
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
  {
    // БЕЗ автоповтора: у функции лимит 5/мин, повтор сжёг бы его. Повторяет человек.
    const r = await sbFetch(RESET_PASSWORD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, orderReference: order, password }),
    });
    if (r.state === "unreachable") {
      showResetError(NET_MSG);
      btn.disabled = false; btn.textContent = "Сбросить пароль";
      return;
    }
    const res = { ok: r.state === "ok", status: r.status };
    const data = r.data || {};
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
  }
}

// ============ ПЕРВЫЙ ВХОД ПОСЛЕ ОПЛАТЫ: создать пароль по номеру заказа (auth-аккаунта ещё нет) ============
function showClaim() {
  hidePayFlowExtra();
  if (siteHeader) siteHeader.hidden = false;
  if (siteFooter) siteFooter.hidden = false;
  const vs = document.getElementById("view-start"); if (vs) vs.hidden = true;
  const vl = document.getElementById("view-login"); if (vl) vl.hidden = true;
  const vr = document.getElementById("view-reset"); if (vr) vr.hidden = true;
  els.viewCheckout.hidden = true;
  const vc = document.getElementById("view-claim"); if (vc) vc.hidden = false;
  const hint = document.getElementById("claim-hint");
  if (hint) hint.innerHTML = "Номер заказа - в чеке об оплате: он показан на экране сразу после оплаты и в письме от платёжной системы. Длинный код с дефисами, вида a1b2c3d4-e5f6-… . Не находите - напишите " + supportTgHtml() + ", откроем вручную.";
  showClaimError("");
  const em = document.getElementById("claim-email"); if (em) em.focus();
  window.scrollTo(0, 0);
}
function showClaimError(msg, html) {
  const el = document.getElementById("claim-error");
  if (!el) return;
  if (html) el.innerHTML = html; else el.textContent = msg || "";
  el.hidden = !(msg || html);
}
async function doClaim() {
  const btn = document.getElementById("btn-claim");
  const email = normalizeEmail(document.getElementById("claim-email").value);
  const order = (document.getElementById("claim-order").value || "").trim();
  const password = document.getElementById("claim-password").value || "";
  const password2 = document.getElementById("claim-password2").value || "";
  showClaimError("");
  if (!emailValid(email)) { showClaimError(EMAIL_HINT); document.getElementById("claim-email").focus(); return; }
  if (!order) { showClaimError("Введите номер заказа."); document.getElementById("claim-order").focus(); return; }
  if (password.length < 8) { showClaimError("Пароль минимум 8 символов."); document.getElementById("claim-password").focus(); return; }
  if (password !== password2) { showClaimError("Пароли не совпадают."); document.getElementById("claim-password2").focus(); return; }
  if (!sb) { showClaimError("Не удалось загрузить вход. Обновите страницу."); return; }
  btn.disabled = true; btn.textContent = "Проверяем...";
  {
    // БЕЗ автоповтора: создаёт аккаунт + лимит 5/мин. Повторяет человек.
    const r = await sbFetch(CLAIM_ACCOUNT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, orderReference: order, password }),
    });
    if (r.state === "unreachable") {
      showClaimError(NET_MSG);
      btn.disabled = false; btn.textContent = "Создать пароль и войти";
      return;
    }
    const res = { ok: r.state === "ok", status: r.status };
    const data = r.data || {};
    if (res.ok && data.ok) {
      // аккаунт создан на сервере -> входим тем же паролем -> в приложение
      btn.textContent = "Входим...";
      const inn = await sb.auth.signInWithPassword({ email, password });
      if (inn.data && inn.data.session) { await routeHomeOrCheckout(); return; }
      showClaimError(null, "Пароль создан. Войдите с ним.");
      setTimeout(showLogin, 1400);
      return;
    }
    if (data && data.reason === "already_registered") {
      // аккаунт уже есть -> обычный вход (там же "Забыли пароль?")
      showClaimError(null, "У вас уже есть аккаунт с этой почтой. <a href=\"#\" id=\"claim-to-login\" style=\"color:inherit;text-decoration:underline\">Войдите</a>, а если забыли пароль - восстановите его там.");
      const l = document.getElementById("claim-to-login");
      if (l) l.addEventListener("click", (e) => { e.preventDefault(); showLogin(); });
      btn.disabled = false; btn.textContent = "Создать пароль и войти";
      return;
    }
    if (data && data.reason === "no_active_subscription") {
      showClaimError(null, "По этому заказу нет активной подписки. Если срок вышел - оформите заново, или напишите " + supportTgHtml() + ".");
      btn.disabled = false; btn.textContent = "Создать пароль и войти";
      return;
    }
    if (res.status === 429) {
      showClaimError("Слишком много попыток. Подождите минуту и попробуйте снова.");
    } else {
      // анти-энумерация: единый текст на промах заказ/почта
      showClaimError(null, "Почта и номер заказа не совпали. Не сходится - напишите " + supportTgHtml() + ".");
    }
    btn.disabled = false; btn.textContent = "Создать пароль и войти";
  }
}
(function wireEntry() {
  const bind = (id, fn) => { const e = document.getElementById(id); if (e) e.addEventListener("click", fn); };
  bind("start-login", (e) => { e.preventDefault(); showLogin(); });
  bind("start-signup", (e) => { e.preventDefault(); checkoutBackTo = "start"; showCheckout(); });
  bind("btn-login", (e) => { e.preventDefault(); doLogin(); });
  bind("login-back", (e) => { e.preventDefault(); showStart(); });
  bind("login-to-signup", (e) => { e.preventDefault(); checkoutBackTo = "login"; showCheckout(); });
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
  bind("btn-claim", (e) => { e.preventDefault(); doClaim(); });
  bind("claim-back", (e) => { e.preventDefault(); showStart(); });
  const ceye = document.getElementById("claim-eye");
  const cpw = document.getElementById("claim-password");
  if (ceye && cpw) ceye.addEventListener("click", () => {
    const m = cpw.type === "password"; cpw.type = m ? "text" : "password"; ceye.textContent = m ? "скрыть" : "показать";
  });
  ["claim-email", "claim-order", "claim-password", "claim-password2"].forEach((id) => {
    const e = document.getElementById(id);
    if (e) e.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); doClaim(); } });
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
// opts.paidFallback - что делать, если доступа/сессии НЕТ, а в адресе висит ?paid=1&order=:
// вместо чекаута или старта отдаём женщину экрану пароля (её обычный путь после оплаты).
// Порядок принципиален: сначала проверяем доступ, и только потом читаем адрес.
async function routeHomeOrCheckout(opts) {
  const paidFallback = opts && typeof opts.paidFallback === "function" ? opts.paidFallback : null;
  const again = () => routeHomeOrCheckout(opts);
  const noAccess = () => { if (paidFallback) return paidFallback(); checkoutBackTo = null; showCheckout(); };
  const noSession = () => { if (paidFallback) return paidFallback(); if (readLavaReturn()) showPayWait(); else showStart(); };

  // Синхронный пик сохранённой сессии -> прячем чекаут сразу, без мигания.
  // Сессии НЕТ вообще -> человек не залогинен, это не сетевая ситуация -> старт.
  if (!sb || !hasStoredSession()) { noSession(); return; }

  showHomeShell(); // чекаут скрыт, показываем загрузку дома, пока проверяем доступ
  const s = await getSessionState({ retry: true, onAttempt: homeProgress });
  if (s.state === "unreachable") { showConnection(again); return; }
  // Сессия честно истекла. НЕ чекаут: у платящей женщины ключ в localStorage есть,
  // поэтому ранняя ветка showStart выше не сработала, и она упиралась в предложение
  // купить второй раз - без единой кнопки "Войти". Старт даёт обе двери сразу.
  if (s.state !== "ok") { noSession(); return; }

  // get-home - чтение, идемпотентно -> автоповтор разрешён
  const r = await sbFetch(GET_HOME_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + s.token },
  }, { retry: true, onAttempt: homeProgress });

  if (r.state === "ok") {
    const home = r.data || {};
    // Доступ открыт -> чистим ?paid=1&order= СРАЗУ. Иначе адрес живёт в истории и на каждом
    // заходе снова показывает "Оплата прошла, задайте пароль" залогиненной женщине.
    if (home.access) { stripPaidParams(); renderHome(home); return; }
    noAccess();       // сервер ответил и сказал: доступа нет
    return;
  }
  // ГЛАВНОЕ МЕСТО ЗАДАЧИ: вердикта не было -> НИКАКОГО чекаута.
  // Раньше тут стоял "безопасный дефолт: чекаут", и платящая подписчица при обрыве
  // видела экран оплаты и могла заплатить второй раз.
  if (r.state === "unreachable") { showConnection(again); return; }
  // sbFetch схлопывает 401 и 403 в одно "denied", а get-home их различает строго:
  //   403 - токен живой, вердикт "доступа нет" (no_account / no_subscription / expired) -> чекаут;
  //   401 - токен пуст или не принят GoTrue, то есть СЕССИЯ МЕРТВА -> нужна кнопка "Войти".
  // Без этого деления платящая женщина с протухшим токеном снова упирается в оплату:
  // getSessionState отдаёт "ok" (токен в хранилище есть), и ранняя развилка не срабатывает.
  if (r.state === "denied" && r.status === 403) { noAccess(); return; }
  if (r.state === "denied") { noSession(); return; }
  // Всё остальное - неожиданный 4xx, кривой ответ - это НЕ вердикт о подписке.
  // По правилу v57: нет вердикта - нет чекаута.
  showConnection(again);
}

// ===================== ЭКРАНЫ ДЕНЬ / СПРИНТ =====================
// Данные спринта/дней берём из ответа get-home (homeData). Контент дня -> get-day.
// Экраны дня по mockups.html: шапка (назад + кикер СПРИНТ·ДЕНЬ N + заголовок) + блоки по order_index + кнопка "пройдено".
let homeData = null;
let currentDayId = null;

// ===================== АВТОФОЛБЭК ХРАНИЛИЩА ЗВУКА =====================
// Гео-выбор хранилища в get-day идёт по cf-connecting-ip. При работе через прокси
// Cloudflare видит IP Vercel, а не телефон подписчицы -> россиянку может увести в
// MinIO Алматы, который у неё мёртв (замер 05.08: Timeweb 329мс OK, MinIO 8004мс FAIL).
// Лечим по факту: не загрузилось -> сами повторяем get-day с другим force_host.

const AUDIO_WATCHDOG_MS  = 4000;  // тишина дольше -> хост считаем мёртвым (живой отвечает за ~0.3с)
const AUDIO_SPINNER_MS   = 800;   // раньше не мигаем, позже тишина читается как "сломалось"
const AUDIO_FAST_FAIL_MS = 2000;  // отказ быстрее -> похоже на протухшую подпись, а не на мёртвый хост
const AUDIO_HOST_KEY     = "irenabio_audio_host";

// ===================== СКОРОСТЬ ВОСПРОИЗВЕДЕНИЯ =====================
// Записи по 10-15 минут, на 1.5 экономится треть времени. Ниже 1 не нужно, выше 2
// речь неразборчива.
// Ключ в localStorage, а НЕ в sessionStorage (в отличие от выбора хранилища): выбор
// обязан пережить и переход на следующий день, и возврат из мини-аппа - а возврат это
// полная перезагрузка страницы, потому что уход туда идёт через location.href.
const AUDIO_RATE_KEY = "irenabio_audio_rate";
const AUDIO_RATES = [1, 1.25, 1.5, 1.75, 2];
function readAudioRate() {
  try {
    const v = parseFloat(localStorage.getItem(AUDIO_RATE_KEY));
    return AUDIO_RATES.indexOf(v) >= 0 ? v : 1;   // мусор в ключе -> обычная скорость
  } catch (e) { return 1; }
}
function saveAudioRate(r) { try { localStorage.setItem(AUDIO_RATE_KEY, String(r)); } catch (e) {} }
function fmtRate(r) { return r + "x"; }

// sessionStorage, НЕ localStorage: женщина включает и выключает VPN, ездит. Прибитый
// навсегда хост однажды окажется мёртвым. Память значит "работал", а не "навсегда".
function rememberedAudioHost() {
  try { const v = sessionStorage.getItem(AUDIO_HOST_KEY); return (v === "timeweb" || v === "minio") ? v : null; }
  catch (e) { return null; }
}
function rememberAudioHost(h) {
  if (h !== "timeweb" && h !== "minio") return;
  try { sessionStorage.setItem(AUDIO_HOST_KEY, h); } catch (e) {}
}
// blockId -> {tried:Set, refreshed:Set}. Держит лестницу от качелей: больше двух хостов не бывает.
const audioTries = new Map();
function resetAudioTries() { audioTries.clear(); }

// ===================== ГЛОБАЛЬНЫЙ ПЛЕЕР (один <audio> над экранами + мини-плеер) =====================
// track = {dayId, blockId, title, url, host, duration}. Блок дня и мини-плеер управляют ОДНИМ аудио.
const player = (function () {
  let audio = null, track = null;
  // ЕДИНСТВЕННЫЙ источник правды по скорости: и плеер дня, и мини-плеер читают её
  // отсюда и сюда же пишут, поэтому расходиться им нечем.
  let rate = readAudioRate();
  let wdTimer = null, spinTimer = null, aliveSeen = false, srcAt = 0, failedOnce = false;
  let onFailure = null, onAlive = null;
  const g = (id) => document.getElementById(id);
  function fmt(x) { x = Math.max(0, Math.floor(Number(x) || 0)); const m = Math.floor(x / 60), s = x % 60; return m + ":" + String(s).padStart(2, "0"); }
  function playTrack(t) {
    if (!audio || !t || !t.url) return;
    if (track && track.blockId === t.blockId) { toggle(); return; }
    // Осознанный тап = свежий шанс: если лестница по этому блоку уже исчерпана,
    // а связь с тех пор починилась, повторное нажатие не должно сдаваться молча.
    audioTries.delete(t.blockId);
    track = t; audio.src = t.url; armWatchdog();
    // NotAllowedError - политика автоплея, а не отказ хранилища. Хостом это не считаем.
    audio.play().catch((e) => { if (e && e.name !== "NotAllowedError") failNow("play_rejected"); });
    show(); renderAll();
  }
  // preservesPitch ОБЯЗАТЕЛЕН. Без него голос Ирены на ускорении уезжает вверх и
  // становится мультяшным - это главная деталь, из-за которой такие кнопки выходят
  // плохо. Имён у свойства три: стандартное, вебкитовское (Safari) и старое мозилловское;
  // ставим все, лишние движок молча проигнорирует.
  // defaultPlaybackRate тоже обязателен: по спецификации при загрузке НОВОГО источника
  // playbackRate сбрасывается именно к нему, иначе скорость слетала бы на каждом подкасте.
  function applyRate() {
    if (!audio) return;
    try {
      audio.preservesPitch = true;
      audio.webkitPreservesPitch = true;
      audio.mozPreservesPitch = true;
      audio.defaultPlaybackRate = rate;
      audio.playbackRate = rate;
    } catch (e) {}
  }
  function cycleRate() {
    const i = AUDIO_RATES.indexOf(rate);
    rate = AUDIO_RATES[(i + 1) % AUDIO_RATES.length];
    saveAudioRate(rate);
    applyRate();
    renderAll();
  }
  function toggle() { if (!audio || !track) return; if (audio.paused) audio.play().catch(() => {}); else audio.pause(); }
  function seek(d) { if (!audio || !track) return; const dur = isFinite(audio.duration) ? audio.duration : (track.duration || 1e9); audio.currentTime = Math.max(0, Math.min(dur, audio.currentTime + d)); }
  function seekTo(ratio) { if (!audio || !track || !isFinite(audio.duration)) return; audio.currentTime = ratio * audio.duration; }
  function dismiss() { if (!audio) return; clearWatchdog(); audio.pause(); track = null; hide(); renderAll(); }
  function show() { const m = g("mini-player"); if (m) { m.hidden = false; document.body.classList.add("has-mini"); } }
  function hide() { const m = g("mini-player"); if (m) { m.hidden = true; document.body.classList.remove("has-mini"); } }
  function renderMini() {
    // Подпись скорости ставим ДО выхода по "трека нет": иначе после перезагрузки на
    // кнопке висело бы 1x при реально сохранённых 1.75 - панель скрыта, но состояние врёт.
    const rb = g("mp-rate"); if (rb && rb.textContent !== fmtRate(rate)) rb.textContent = fmtRate(rate);
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
      // Скорость общая, поэтому подпись обновляем на ВСЕХ карточках дня, а не только
      // на играющей. Сверка с текущим текстом - чтобы не дёргать DOM на каждом timeupdate.
      const rb = card.querySelector(".audio-rate");
      if (rb && rb.textContent !== fmtRate(rate)) rb.textContent = fmtRate(rate);
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
    armWatchdog();   // новый источник тоже может оказаться мёртвым - сторож нужен и здесь
    const once = () => { try { audio.currentTime = pos; } catch (e) {} if (wasPlaying) audio.play().catch(() => {}); audio.removeEventListener("loadedmetadata", once); };
    audio.addEventListener("loadedmetadata", once);
  }

  // ---- сторож тишины ----
  // Мёртвый хост НЕ бросает error, он молчит (замер: 8с без единого байта). Поэтому
  // отказ ловим не событием, а отсутствием признаков жизни. Любой байт сбрасывает сторож,
  // поэтому медленный-но-живой хост не пострадает и женщину с него не уведут.
  function setLoading(on) {
    const card = track && document.querySelector('#day-blocks .blk-audio[data-block-id="' + track.blockId + '"]');
    if (card) card.classList.toggle("loading", !!on);
    const mp = g("mini-player"); if (mp) mp.classList.toggle("loading", !!on);
  }
  function armWatchdog() {
    clearWatchdog();
    aliveSeen = false; failedOnce = false; srcAt = Date.now();
    spinTimer = setTimeout(() => { if (!aliveSeen) setLoading(true); }, AUDIO_SPINNER_MS);
    wdTimer = setTimeout(() => { if (!aliveSeen) failNow("silence"); }, AUDIO_WATCHDOG_MS);
  }
  function clearWatchdog() {
    if (wdTimer) clearTimeout(wdTimer);
    if (spinTimer) clearTimeout(spinTimer);
    wdTimer = null; spinTimer = null;
    setLoading(false);
  }
  function markAlive() {
    if (aliveSeen) return;
    aliveSeen = true; clearWatchdog();
    if (track && onAlive) onAlive({ blockId: track.blockId, host: track.host });
  }
  function failNow(reason) {
    if (!track || failedOnce) return;   // сторож и error могут прийти оба - лестницу запускаем один раз
    failedOnce = true;
    const elapsed = Date.now() - srcAt;
    clearWatchdog();
    const info = { dayId: track.dayId, blockId: track.blockId, host: track.host, reason: reason, elapsed: elapsed };
    if (onFailure) onFailure(info);
  }
  // оба хранилища мертвы: не оставляем вид "играет", когда не играет
  function failStop() { clearWatchdog(); if (audio) audio.pause(); renderAll(); }
  function setHandlers(h) { onFailure = h && h.onFailure; onAlive = h && h.onAlive; }
  function init() {
    audio = g("app-audio"); if (!audio) return;
    applyRate();   // сохранённая скорость действует с первой же секунды первого трека
    // Новый источник сбрасывает playbackRate к defaultPlaybackRate, а часть движков
    // забывает и preservesPitch - возвращаем оба на каждой загрузке.
    audio.addEventListener("loadedmetadata", applyRate);
    audio.addEventListener("play", applyRate);
    audio.addEventListener("play", renderAll);
    audio.addEventListener("pause", renderAll);
    audio.addEventListener("ended", renderAll);
    audio.addEventListener("loadedmetadata", renderAll);
    audio.addEventListener("timeupdate", renderDayBlock);
    // признаки жизни хранилища: любой из них снимает сторож
    ["progress", "loadedmetadata", "canplay", "playing", "timeupdate"].forEach((ev) => audio.addEventListener(ev, markAlive));
    // MEDIA_ERR_ABORTED (code 1) прилетает от НАШЕЙ же подмены src в swapCurrentUrl.
    // Считать это отказом хранилища значит запустить лестницу на себя же.
    audio.addEventListener("error", () => {
      if (audio.error && audio.error.code === 1) return;
      failNow("error");
    });
    const bind = (id, fn) => { const e = g(id); if (e) e.addEventListener("click", (ev) => { ev.preventDefault(); fn(); }); };
    bind("mp-play", toggle);
    bind("mp-back", () => seek(-15));
    bind("mp-fwd", () => seek(15));
    bind("mp-close", dismiss);
    bind("mp-rate", cycleRate);
    bind("mp-title", () => { if (track) navTo("day", track.dayId); });
    renderMini();   // подпись на кнопке скорости верна ещё до первого трека
  }
  init();
  return { playTrack, toggle, seek, seekTo, dismiss, renderAll, swapCurrentUrl, current: () => track, setHandlers, failStop,
           cycleRate, rate: () => rate };
})();

// Лестница фолбэка. Функции объявлены ниже по файлу (function declaration -> подняты).
player.setHandlers({ onFailure: onAudioFailure, onAlive: onAudioAlive });

// Токен для внутренних экранов. Сохранена прежняя сигнатура (null = токена нет),
// но теперь вызывающий может отличить "сессии нет" от "не смогли обновить" через
// getSessionState. getToken оставлен для мест, где различие не нужно.
async function getToken() {
  const s = await getSessionState({ retry: true });
  return s.state === "ok" ? s.token : null;
}
function hideContentViews() {
  els.viewHome.hidden = true;
  const vss = document.getElementById("view-sprints"); if (vss) vss.hidden = true;
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
        '<span class="audio-dur">' + durTxt + '</span>' +
        // Скорость стоит СПРАВА ОТ ТАЙМИНГОВ, а не в ряду управления: play и перемотка
        // важнее, их ряд трогать нельзя. Подпись проставит renderDayBlock.
        '<button type="button" class="audio-rate" aria-label="Скорость воспроизведения">1x</button>' +
        '</div>' +
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
    const title = card.getAttribute("data-title");
    const duration = Number(card.getAttribute("data-duration")) || 0;
    // url и host читаем из DOM В МОМЕНТ КЛИКА, а не при навешивании: автофолбэк
    // подменяет их прямо в атрибутах, и замороженное в замыкании значение играло бы мёртвое.
    const urlNow = () => card.getAttribute("data-url");
    const trackOf = () => ({ dayId: currentDayId, blockId: bid, title, url: urlNow(), host: card.getAttribute("data-host"), duration });
    const playBtn = card.querySelector(".audio-play");
    if (playBtn) playBtn.addEventListener("click", () => { if (urlNow()) player.playTrack(trackOf()); });
    card.querySelectorAll(".audio-seek").forEach((sb) => sb.addEventListener("click", () => {
      const d = Number(sb.getAttribute("data-seek")) || 0;
      const cur = player.current();
      if (cur && cur.blockId === bid) player.seek(d);
      else if (urlNow()) { player.playTrack(trackOf()); player.seek(d); }
    }));
    // Скорость меняется и когда карточка ещё не играет: женщина выставляет её заранее.
    const rateBtn = card.querySelector(".audio-rate");
    if (rateBtn) rateBtn.addEventListener("click", (e) => { e.stopPropagation(); player.cycleRate(); });
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
      // Женщина сама подтвердила выбор -> запоминаем на сессию. Счётчики попыток
      // сбрасываем, иначе исчерпанная лестница молча съест следующий отказ.
      rememberAudioHost(other);
      resetAudioTries();
      console.log("[audio] ручное переключение на " + other);
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
  // Шапка дня = широкая обложка ЕГО спринта. Слаг берём из homeData по day.sprint_id.
  const daySprint = sprintById(day.sprint_id);
  paintCover(document.getElementById("day-hero"), daySprint && daySprint.cover_slug, "wide", COVER_SHADE_DAY);
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

// ===================== ЛЕСТНИЦА ФОЛБЭКА ЗВУКА =====================
// Тихий перезапрос дня: НЕ трогает DOM и не показывает "загрузка". Намеренно не
// переиспользует openDay - тот чистит блоки и перерисовывает день, то есть мигает.
async function fetchDaySilently(dayId, forceHost) {
  const s = await getSessionState({ retry: true });
  if (s.state !== "ok") return null;
  const r = await sbFetch(GET_DAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + s.token },
    body: JSON.stringify({ day_id: dayId, force_host: forceHost }),
  }, { retry: true });   // get-day - чтение, идемпотентно
  const data = r.data || {};
  return (r.state === "ok" && data.access) ? data : null;
}

// Подменяем ссылки во ВСЕХ аудио-карточках дня, а не только в упавшей: следующий
// подкаст должен открыться с живого хранилища сразу, без ещё одного сторожа.
function patchDayAudio(data, dayId) {
  if (currentDayId !== dayId) return;   // женщина уже ушла на другой день
  const root = document.getElementById("day-blocks");
  if (!root) return;
  for (const b of (data.blocks || [])) {
    if (!b || !b.url || b.block_type !== "audio") continue;
    const card = root.querySelector('.blk-audio[data-block-id="' + b.id + '"]');
    if (!card) continue;
    card.setAttribute("data-url", b.url);
    card.setAttribute("data-host", b.host || "");
    // подсказку тоже: иначе ручное переключение после автоподмены уведёт не туда
    const hint = card.querySelector(".audio-hosthint");
    if (hint) hint.setAttribute("data-host", b.host || "");
  }
}

async function retryAudioWithHost(info, host) {
  const data = await fetchDaySilently(info.dayId, host);
  if (!data) return false;
  patchDayAudio(data, info.dayId);
  const blk = (data.blocks || []).find((b) => b && b.id === info.blockId);
  if (!blk || !blk.url) return false;
  // сохраняет позицию и play/pause и сам заводит сторож на новый источник
  player.swapCurrentUrl(info.blockId, blk.url, blk.host || host);
  return true;
}

function audioGiveUp(blockId) {
  player.failStop();
  const root = document.getElementById("day-blocks");
  const card = root && root.querySelector('.blk-audio[data-block-id="' + blockId + '"]');
  const hint = card && card.querySelector(".audio-hosthint");
  if (hint) { hint.classList.remove("busy"); hint.textContent = "Звук не загрузился. Проверьте связь или нажмите здесь."; }
}

function onAudioAlive(info) {
  console.log("[audio] играет с " + info.host);
  rememberAudioHost(info.host);
  audioTries.delete(info.blockId);
}

// Лестница: 1) как есть -> 2) то же хранилище со свежей ссылкой (только на быстрый
// отказ: presign живёт 3600с и протухает) -> 3) другое хранилище -> 4) сдаёмся.
async function onAudioFailure(info) {
  let st = audioTries.get(info.blockId);
  if (!st) { st = { tried: new Set(), refreshed: new Set() }; audioTries.set(info.blockId, st); }
  st.tried.add(info.host);

  const fastFail = (info.reason === "error" || info.reason === "play_rejected") && info.elapsed < AUDIO_FAST_FAIL_MS;
  if (fastFail && !st.refreshed.has(info.host)) {
    st.refreshed.add(info.host);
    console.log("[audio] быстрый отказ " + info.host + " за " + info.elapsed + "мс (" + info.reason + ") -> свежая ссылка того же хранилища");
    if (await retryAudioWithHost(info, info.host)) return;
  }

  const other = info.host === "timeweb" ? "minio" : "timeweb";
  if (st.tried.has(other)) {
    console.log("[audio] оба хранилища не отвечают, сдаёмся");
    audioGiveUp(info.blockId);
    return;
  }
  console.log("[audio] " + info.host + " не отвечает (" + info.reason + ", " + info.elapsed + "мс) -> переключаемся на " + other);
  if (!(await retryAudioWithHost(info, other))) {
    console.log("[audio] переключиться на " + other + " не удалось");
    audioGiveUp(info.blockId);
  }
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
  const s = await getSessionState({ retry: true });
  if (s.state === "unreachable") { loading.hidden = true; showConnection(() => openDay(dayId, forceHost)); return; }
  if (s.state !== "ok") { loading.hidden = true; errEl.textContent = "Сессия истекла. Обновите страницу."; errEl.hidden = false; return; }
  const body = { day_id: dayId };
  // Запомненное за сессию живое хранилище подставляем сами: иначе на каждом подкасте
  // придётся заново ждать сторож. Явный ручной выбор всегда сильнее памяти.
  const host = forceHost || rememberedAudioHost();
  if (host) body.force_host = host;
  // get-day - чтение, идемпотентно -> автоповтор разрешён
  const r = await sbFetch(GET_DAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + s.token },
    body: JSON.stringify(body),
  }, { retry: true });
  loading.hidden = true;
  // развели два случая: связи нет -> экран связи; сервер ответил "нет доступа" -> прежний текст
  if (r.state === "unreachable") { showConnection(() => openDay(dayId, forceHost)); return; }
  const data = r.data || {};
  if (r.state !== "ok" || !data.access) {
    errEl.innerHTML = "Не удалось открыть день. Обновите страницу или напишите нам " + supportEmailHtml() + ".";
    errEl.hidden = false; return;
  }
  renderDay(data);
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
  {
    // БЕЗ автоповтора (см. список в шапке). Таймаут теперь общий, 15с вместо прежних 12с:
    // висящий запрос не должен оставить ложную галочку навсегда.
    const r = await sbFetch(MARK_DAY_DONE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({ day_id: dayId }),
    });
    const res = { ok: r.state === "ok" };
    const data = r.data || {};
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
  }
}

// Имя дня для карточки списка спринта: срезаем префикс "День N." (номер уже в сером eyebrow).
// Без префикса возвращает title как есть; пустой результат -> фолбэк на оригинал.
function dayShortTitle(title) {
  const t = (title || "").trim();
  return t.replace(/^День\s*\d+\.?\s*/i, "").trim() || t;
}

// Экран спринта: список дней из homeData (доступные по publish_at уже отфильтрованы get-home).
function openSprint(sprintId) {
  const sprint = homeSprints(homeData).find((s) => s.id === sprintId) || null;
  if (!sprint) return;
  hideContentViews();
  document.getElementById("view-sprint").hidden = false;
  const days = (sprint.days || []).slice().sort((a, b) => a.day_number - b.day_number);
  const completed = new Set((homeData.progress && homeData.progress.completed_day_ids) || []);
  const completedVisible = days.filter((d) => completed.has(d.id)).length;
  const nextDay = days.find((d) => !completed.has(d.id)) || null;
  // Обложка спринта в шапке списка дней - широкая картинка ЭТОГО спринта.
  paintCover(document.getElementById("sprint-hero"), sprint.cover_slug, "wide", COVER_SHADE_SPRINT);
  document.getElementById("sprint-kicker").textContent = sprint.status === "active" ? "СПРИНТ" : "АРХИВ";
  setHeadline(document.getElementById("sprint-title"), sprint.title || "");
  document.getElementById("sprint-sub").textContent = "Авторская методика · проходите в своём темпе";
  const denom = sprint.estimated_days || days.length || 0;
  const tilde = sprint.status === "active" ? "~" : "";
  document.getElementById("sprint-badge").textContent = completedVisible + " из " + tilde + denom;
  // То же правило, что и на доме: при нуле пройденных полосы нет, есть строка-статус.
  const started = completedVisible > 0;
  const track = document.getElementById("sprint-progress");
  const empty = document.getElementById("sprint-progress-empty");
  if (track) track.hidden = !started;
  if (empty) empty.hidden = started;
  if (started) {
    const pct = denom > 0 ? Math.max(2, Math.min(100, Math.round(completedVisible / denom * 100))) : 100;
    document.getElementById("sprint-bar").style.width = pct + "%";
  }
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

function plurDays(n) {
  const t = n % 100, o = n % 10;
  if (t >= 11 && t <= 14) return n + " дней";
  if (o === 1) return n + " день";
  if (o >= 2 && o <= 4) return n + " дня";
  return n + " дней";
}

// Библиотека = полка постеров 2 в ряд, ОДИН хронологический список без деления на
// группы. Текущий спринт помечен плашкой "ТЫ ЗДЕСЬ", а не отдельной секцией.
// Обложка постера - covers/{slug}-poster.webp. Затемнение под текст рисует
// .poster::before, в background-image его дублировать не нужно. Нет слага ->
// остаётся заглушечный градиент из CSS.
// НЕЗАЛИТЫЕ (status === "draft") рисуются, но НЕ НАЖИМАЮТСЯ. Признак нажимаемости -
// сам атрибут data-sprint-id: делегированный обработчик ищет ".poster[data-sprint-id]",
// поэтому черновику достаточно его не выдавать, и трогать обработчик не нужно.
// role="button" и курсор тоже снимаем - иначе постер обещает действие, которого нет,
// а женщина попадала бы в пустой спринт и думала, что сломалось.
// .poster-empty черновику НЕ вешаем: там background-shorthand, который сбрасывает
// background-size/position и разваливает кадрирование обложки.
function posterHtml(s, isCurrent) {
  const days = s.days || [];
  const isSoon = s.status === "draft";
  const total = s.estimated_days || days.length || 0;
  const meta = isSoon || total <= 0 ? "скоро" : plurDays(total);
  const cover = coverUrl(s.cover_slug, "poster");
  const cls = "poster" + (isSoon ? " poster-soon" : days.length ? "" : " poster-empty");
  return '<div class="' + cls + '"' +
      (isSoon ? ' aria-disabled="true"' : ' data-sprint-id="' + escapeHtml(s.id) + '" role="button"') +
      (cover ? ' style="background-image: url(\'' + cover + '\')"' : "") + ">" +
    (isSoon ? '<span class="poster-badge poster-badge-soon">Скоро</span>'
            : isCurrent ? '<span class="poster-badge">Ты здесь</span>' : "") +
    '<div class="poster-info">' +
      "<b>" + escapeHtml(s.title || "") + "</b>" +
      "<span>" + escapeHtml(meta) + "</span>" +
    "</div></div>";
}

function openSprints() {
  const completed = new Set((homeData && homeData.progress && homeData.progress.completed_day_ids) || []);
  const all = homeSprints(homeData);
  const current = pickCurrentSprint(all, completed);
  // ХРОНОЛОГИЯ КАНАЛА: order_index растёт от самого раннего спринта к позднему, поэтому
  // сортируем ПО ВОЗРАСТАНИЮ. На выбор героя это не влияет: он берётся из
  // pickCurrentSprint по status === "active", order_index там не участвует.
  const shelf = all.slice().sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
  hideContentViews();
  document.getElementById("view-sprints").hidden = false;
  let html = "";
  for (const s of shelf) html += posterHtml(s, !!current && s.id === current.id);
  if (!html) html = '<p class="home-loading">Пока ни одного спринта.</p>';
  document.getElementById("sprints-list").innerHTML = html;
  window.scrollTo(0, 0);
}

// ===================== СТЕК ЭКРАНОВ =====================
// Возврат ведёт на ПРЕДЫДУЩИЙ экран, а не всегда на дом. Кадр = {view, arg}.
// Дом - основание: пустой стек значит "мы дома", отдельным кадром он не лежит.
// Новый экран стоит одной строки в NAV_VIEWS.
const NAV_VIEWS = {
  sprints: function () { openSprints(); },
  sprint:  function (id) { openSprint(id); },
  day:     function (id) { openDay(id); },
};
let navStack = [];
function navTo(view, arg) {
  const top = navStack[navStack.length - 1];
  // повторный переход на тот же экран (напр. тап по мини-плееру на своём же дне)
  // кадр не плодит, иначе "назад" вернёт туда же
  if (!top || top.view !== view || top.arg !== arg) navStack.push({ view: view, arg: arg });
  NAV_VIEWS[view](arg);
}
function navBack() {
  navStack.pop();
  const prev = navStack[navStack.length - 1];
  if (!prev) { backToHome(); return; }
  NAV_VIEWS[prev.view](prev.arg);
}

// Навигация: клики дома -> день/спринт, кнопки "назад", "пройдено" (делегирование + статичные кнопки).
(function wireNav() {
  const dayBack = document.getElementById("day-back");
  const sprintBack = document.getElementById("sprint-back");
  const sprintsBack = document.getElementById("sprints-back");
  const dayDone = document.getElementById("day-done");
  // Все три стрелки - один навык: шаг назад по стеку.
  if (dayBack) dayBack.addEventListener("click", navBack);
  if (sprintBack) sprintBack.addEventListener("click", navBack);
  if (sprintsBack) sprintsBack.addEventListener("click", navBack);
  if (dayDone) dayDone.addEventListener("click", markDone);
  document.addEventListener("click", (e) => {
    const cta = e.target.closest(".home-cta[data-day-id]");
    if (cta) { navTo("day", cta.getAttribute("data-day-id")); return; }
    const all = e.target.closest("#home-alldays");
    if (all) { navTo("sprint", currentSprintId); return; }
    const arch = e.target.closest(".t5-archive");
    if (arch) { navTo("sprints"); return; }
    const sc = e.target.closest(".poster[data-sprint-id]");
    if (sc) { navTo("sprint", sc.getAttribute("data-sprint-id")); return; }
    const sd = e.target.closest(".sprint-day[data-day-id]");
    if (sd && !sd.classList.contains("locked")) { navTo("day", sd.getAttribute("data-day-id")); return; }
  });
})();

// Прогрев маршрута: решение должно быть готово ДО того, как женщина нажмёт "Войти",
// иначе проба ляжет в критический путь входа. Здесь, а не выше по файлу, потому что
// индикатору нужен уже инициализированный homeEls.
ensureRoute();

// --- старт: ветвление возврат-после-оплаты / дом / чекаут ---
const startParams = new URLSearchParams(location.search);
if (startParams.get("paid") === "1" && startParams.get("order")) {
  // ?paid приходит по returnUrl WayForPay, НО адрес остаётся в истории и открывается снова.
  // Поэтому сначала спрашиваем про доступ, и только если его нет - показываем экран пароля.
  // Есть сессия -> обычный маршрут (дом + чистка адреса), а экран пароля идёт запасным путём.
  // Сессии нет -> она только что оплатила, пароль ещё не задан: сразу экран пароля, без лишнего круга.
  const order = startParams.get("order");
  if (sb && hasStoredSession()) routeHomeOrCheckout({ paidFallback: () => enterPaymentReturn(order) });
  else enterPaymentReturn(order);
} else {
  routeHomeOrCheckout();                           // дом / чекаут / (stash -> экран ожидания)
}
