// irenabio-app SMOKE TEST (шаг 1а).
// Цель: доказать, что фронт говорит с Supabase Auth. Не пользовательский поток.
// Будет удалён и заменён реальным чекаутом Варианта А на шаге 1б.

const SUPABASE_URL = "https://kjzxrpwqyyjcykwbqskn.supabase.co";
// Публичный publishable-ключ. Безопасен для фронта. service_role на клиент не кладём.
const SUPABASE_KEY = "sb_publishable_pOloEHMZ5QjMhnbfhygqmA_CQPSP1hU";
// Запасной вариант (legacy anon JWT), если CDN-версия не понимает publishable-формат:
// const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqenhycHdxeXlqY3lrd2Jxc2tuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MDg1NjUsImV4cCI6MjA5MDI4NDU2NX0.oQxkb6DGFBkmHH3w0SBkrDvGWw6nUOgN8sZt3M0FOgA";

const client = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const logEl = document.getElementById("log");

function stamp() {
  const d = new Date();
  return d.toLocaleTimeString();
}

function log(line, cls) {
  const span = cls ? `<span class="${cls}">${line}</span>` : line;
  logEl.innerHTML = `[${stamp()}] ${span}\n` + logEl.innerHTML;
}

function readInputs() {
  return {
    email: document.getElementById("email").value.trim(),
    password: document.getElementById("password").value,
  };
}

function describeSession(session) {
  if (!session) return "сессии нет";
  return `сессия есть, user.id=${session.user.id}`;
}

function reportError(err) {
  // Сетевые сбои у аудитории в заблокированных регионах лечит VPN.
  const msg = String(err && err.message ? err.message : err);
  const looksNetwork = /fetch|network|failed to fetch/i.test(msg);
  log(`ОШИБКА: ${msg}`, "err");
  if (looksNetwork) {
    log("Похоже на сетевую ошибку. Включите VPN и попробуйте снова.", "err");
  }
}

document.getElementById("btn-signup").addEventListener("click", async () => {
  const { email, password } = readInputs();
  log(`signUp: ${email} ...`);
  try {
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) return reportError(error);
    log(`signUp OK. ${describeSession(data.session)}`, "ok");
  } catch (err) {
    reportError(err);
  }
});

document.getElementById("btn-signin").addEventListener("click", async () => {
  const { email, password } = readInputs();
  log(`signInWithPassword: ${email} ...`);
  try {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) return reportError(error);
    log(`signIn OK. ${describeSession(data.session)}`, "ok");
  } catch (err) {
    reportError(err);
  }
});

document.getElementById("btn-session").addEventListener("click", async () => {
  log("getSession ...");
  try {
    const { data, error } = await client.auth.getSession();
    if (error) return reportError(error);
    log(`getSession: ${describeSession(data.session)}`, "ok");
  } catch (err) {
    reportError(err);
  }
});

document.getElementById("btn-signout").addEventListener("click", async () => {
  log("signOut ...");
  try {
    const { error } = await client.auth.signOut();
    if (error) return reportError(error);
    log("signOut OK. сессия очищена.", "ok");
  } catch (err) {
    reportError(err);
  }
});

log("клиент Supabase инициализирован. готов к проверке.");
