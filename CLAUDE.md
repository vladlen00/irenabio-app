# irenabio-app — статус проекта (контент-платформа app.irenabio.com)

Фронт контент-платформы «Женский биохакинг с Иреной Пол». Чистый vanilla JS (без сборки),
экраны — секции `#view-*`, переключаются `hidden`. Хостинг: **GitHub Pages** (repo `vladlen00/irenabio-app`,
ветка `main`, CNAME `app.irenabio.com`). Supabase project: `kjzxrpwqyyjcykwbqskn`.

## Деплой
- `git push origin main` → GitHub Pages публикует за ~1 мин.
- **ВСЕГДА бампать `?v=N`** у `app.js`/`style.css` в `index.html` (иначе кэш).
  Счётчики РАЗНЫЕ и бампаются независимо. Сейчас **app.js?v=65, style.css?v=45**.
- Проверка живости: `curl https://app.irenabio.com/?cb=RND | grep -oE 'app.js\?v=[0-9]+'`.

## ТЕМА: только тёмная (редизайн, шаг A — 2026-08-15)
Светлой темы БОЛЬШЕ НЕТ. Блок `:root[data-theme="dark"]` удалён, значения перенесены в `:root`,
тумблер `#hmenu-theme` и `wireThemeToggle` вырезаны. `data-theme="dark"` стоит статикой на `<html>`
плюс дублируется скриптом в `<head>`; там же одноразовая затирка `irena_theme === 'light'`.
- **Палитра меняется ТОЛЬКО в `:root`** (style.css, первые ~75 строк). Хардкод цвета вне токенов —
  ошибка, вся вёрстка ходит через `var(--…)`.
- Два токена под текст на заливке: `--on-accent` (#fff) — на БРЕНДОВОМ ГРАДИЕНТЕ;
  `--ink-on-accent` (#140A10) — на СПЛОШНОЙ светлой заливке (`--accent`, `--success`),
  где белый давал контраст ~2:1. Не путать.
- Дымок плиток: `.t5::before/::after` (blur 20px) + блик по верхней грани; пара цветов
  задаётся переменными `--smoke-a/--smoke-b/--smoke-ic` на каждой плитке.
- Шрифты: заголовки Playfair Display 500, интерфейс Onest (у обоих есть кириллица). Manrope убран.
  Tabler-webfont остался.

## ПОРЯДОК СПРИНТОВ В БИБЛИОТЕКЕ
`sprints.order_index` = хронология канала, ШАГ 10 (сон 10, ягодицы 20, омоложение 30), чтобы
вставлять спринты в середину одним UPDATE. `openSprints` сортирует по ВОЗРАСТАНИЮ.
**Герой на доме к order_index отношения не имеет** — `pickCurrentSprint` и legacy-ветка
`get-home` берут спринт по `status === "active"`. Не связывать эти две вещи.

## ГОТОВО на проде (?v=19, проверено вживую)
- **Экраны:** старт (Войти/Оформить) → форма входа (`signInWithPassword`) / чекаут; ДОМ (get-home) →
  СПРИНТ (список дней) → ДЕНЬ (блоки по order_index). Навигация сшита; после оплаты/логина ведёт на ДОМ
  (не на старую заглушку `view-access`).
- **Edge-функции:** `get-day` (авторизация-копия get-home, ACCESS-CANON active/grace+3д; вход `{day_id, force_host?}`;
  publish_at<=now; блоки по order_index; presign audio/image), `mark-day-done` (INSERT day_progress ON CONFLICT).
- **Звук ИГРАЕТ на MinIO** (Польша/UA/мир — подтверждено Владленом вживую). presign SigV4 (aws4fetch),
  гео-сплит `is_ru_ip(cf-connecting-ip)`: РФ→Timeweb, иначе→MinIO; `force_host` переключает; TTL 3600; Range/iOS.
- **Плеер:** перемотка −15/+15 в карточке дня И в мини-плеере; **глобальный мини-плеер** (один `<audio id="app-audio">`
  вне секций, singleton `player` в app.js) — управление с любого экрана, аудио переживает переходы,
  пауза везде = один элемент; крестик × закрывает (пауза+сброс+скрытие, тап-таргет 44px).
- **Ключ MinIO** лежит в service_role-таблице `public.app_config` (RLS deny-all), т.к. Edge Secrets из среды агента
  недоступны (нет CLI/PAT/дашборда/MCP-инструмента). `get-day` читает env→app_config.

## Форматирование контентных текстов (с ?v=21, 2026-07-03)
- `mdLite()` в app.js: пустая строка = абзац `<p>`, одиночный `\n` = `<br>`, `**жирный**`,
  `[текст](http/https)` → `<a target="_blank" rel="noopener">`. Работает ПОВЕРХ escapeHtml (XSS нет).
  Применяется ГЛОБАЛЬНО: text/task-блоки + подпись картинки, все дни вкл. старые.
  КОПИЯ mdLite живёт в ir-ops/upload.html (предпросмотр) - менять СИНХРОННО.
- Видео-блок без title больше не дублирует «Тренировка дня» (кикер остаётся, title только если задан).
- Мягкое удаление дней: `days.archived_at` (миграция days_archived_at_soft_delete);
  get-home фильтрует `archived_at=is.null`, get-day отвечает 404 на архивный день.
  Управление - content-admin (archive_day/restore_day) из формы ir-ops/upload.html.

## Контракт get-day (фронт уже потребляет)
audio/image-блок: `{order_index, block_type, title, content_text, duration_seconds, url(presigned), host('timeweb'|'minio')}`;
video: `content_url` (Kinescope id/url); text/task: `content_text`. Нет ключа хранилища → отдаёт `content_url` путь (плеер не падает).

## ХВОСТЫ — приоритеты новой сессии (по порядку)
1. **TIMEWEB-КЛЮЧ МЁРТВ** (HEAD 403 InvalidAccessKeyId, старый TN475UO7 пересоздан) → **РФ-ветка звука НЕ работает**
   (сейчас РФ фоллбэком идёт на MinIO, работает под VPN). ПРИОРИТЕТ №1 (РФ = половина аудитории, Teleg у них отвалился).
   ✅ СДЕЛАНО 2026-07-01: новый S3-ключ (access `LJ1S0CORYBN9HUVTNLRT`) залит файл `sprints/test/day1.m4a` в Timeweb
   (HEAD 8042151 audio/mp4), `TIMEWEB_ACCESS_KEY`/`TIMEWEB_SECRET_KEY` впаяны в `app_config` (напрямую через MCP
   execute_sql, secret-load не понадобился). **РФ-звук ПОДТВЕРЖДЁН ВЖИВУЮ на 2 провайдерах:** Настя (Timeweb ✅ / MinIO ❌),
   Алинчик (оба ✅ без VPN) — валидирует гео-сплит: россиян гоним на Timeweb. Звук ГОТОВ для обеих аудиторий.
2. **Перенести MinIO-ключ** из `app_config` в штатные **Edge Function Secrets** перед публичным запуском
   (нужен `supabase secrets set` от Владлена или PAT). get-day уже читает env первым — просто перестанет брать из таблицы.
3. **Временные edge-функции ОБЕЗВРЕЖЕНЫ 410** 2026-07-01 (`geo-probe, ru-loader, storage-probe, storage-list, presign,
   secret-load, audio-probe` — все отдают 410, attack surface убран). `probe.html` удалён из irenabio-site (404).
   ОСТАЛОСЬ (hard-delete slug'ов, нужен CLI/PAT у Владлена): `supabase functions delete <slug> --project-ref
   kjzxrpwqyyjcykwbqskn` для тех же 7 (MCP не умеет delete). ru-loader — дормантный загрузчик ru_ip_ranges: для месячного
   обновления редеплоить функциональную версию (см. memory biohack_geo_split_audio), можно НЕ удалять.
   УРОК: рендерящийся HTML нельзя отдавать с edge на `*.supabase.co` (gateway переписывает text/html→text/plain+nosniff,
   анти-XSS); HTML-страницы — только с GitHub Pages/Fastly. application/json проходит.
4. **Ротация ключей отложена** решением Владлена — текущие как есть (Timeweb пересоздать — исключение, т.к. мёртв).

## РАЗВЯЗКА АВТОРИЗАЦИИ МИНИ-АППОВ (веб-подписчик заходит в мини-аппы) — СДЕЛАНО частично
Механизм «две двери»: mint-app-token (edge, веб-сессия Supabase -> проверка веб-подписки через
общий `_shared/web-access.ts` -> короткий JWT того же формата, что verify-access, TTL 15м, метка src:web)
-> хаб открывает мини-апп на ЕГО домене с токеном во фрагменте `#irena_token` -> «Дверь 2» в мини-аппе
(`consumeWebToken()` безусловно в начале checkAccess, принять+вычистить URL, ПЕРЕД проверкой initData).
Телеграм-ветка (initData -> Дверь 1) и 870 НЕ тронуты (Дверь 2 инертна в ТГ: нет irena_token в хэше).
- ГОТОВО: Тренировки (шторка workout=Женское тело + glutes=Биохакинг ягодиц), Подружка (biohack ?startapp=ai),
  Трекеры (шторка Здоровье=biohack чекины + Цикл=cycle). Кнопка «← В приложение» веб-онли во всех 4.
- Дверь 2 добавлена: workout, glutes (инлайн index.html), biohack (public/tg-auth.js), cycle (auth.js).
- ОСТАЛОСЬ: Расслабление (~9 медитаций/дыхание + Студия на t.me-ссылках, нужен веб-подход); Справочники
  (аппы ещё нет); Все спринты (внутренний экран хаба). Техдолг: закоммитить edge-функции в repo biohack-tracker
  (untracked); смигрировать verify-access-web на общий `_shared/web-access.ts` (убрать дубль правила доступа).

## ДЫРА (ФИКС ПОСЛЕ РАЗВЯЗКИ, НЕ ЗАБЫТЬ): t.me-ссылки ВНУТРИ мини-аппов
Внутри мини-аппов зашиты ссылки на телеграм-контент (`t.me/...`):
- трекер biohack «рекомендация на сегодня -> послушать подкаст» -> ведёт в ТГ;
- тренировки Женское тело «послушать подкаст к тренировке» (`podcastUrl`, `PODCAST_INDEX_URL`) -> ведёт в ТГ;
- возможно есть ещё места (нужна разведка ВСЕХ t.me во всех аппах).
ПОЧЕМУ ДЫРА на вебе: (1) неудобно — веб-юзер не ходит в Телеграм, выкидывает из потока; (2) доступ может НЕ
совпасть — оплата на платформе != доступ в ТГ (разные платёжки/базы), веб-подписчик кликает подкаст -> попадает
в ТГ -> там не пускает (не платил в телеграме) -> ТУПИК.
ФИКС (системный, ПОСЛЕ развязки): разведка всех t.me-ссылок -> по каждой решить: перенаправить ВНУТРЬ (контент
есть на платформе -> открыть в нашем плеере), либо залить+перенаправить (если только в ТГ), либо скрыть на вебе.
ОТКРЫТЫЙ ВОПРОС: подкасты к тренировкам / рекомендации трекера — это тот же контент, что в днях спринтов, или
отдельная библиотека? НЕ делать сейчас, но это дыра для веб-подписчиков.

## НЕ ТРОГАТЬ
- Оплатную ветку (create-checkout / wayforpay-webhook / lava-webhook / resolve-paid-order / attach-web-identity /
  verify-access-web) — она рабочая, боевая.
- Telegram-ветку и ~870 платящих (verify-access).

## Тест-контент / доступы
- Спринт `92e61be4` «Биохакинг ягодиц», дни `027fa6c9`(2 блока: audio+text)/`083c7a6d`(4)/`ecf0fb2b`(2).
- Аудио: `pervaya_trenirovka.m4a` (8042151 б, 9:19) в MinIO `audio` ключ `sprints/test/day1.m4a`.
- Вход: у diastazzz@gmail.com логин снят (нужен set-password по ссылке `?paid=1&order=manual_...`); тест-аккаунты для
  автопроверки создавать через GoTrue signup + person/identity/apply_manual_grant, ПОСЛЕ теста удалять.
- Детали инфраструктуры/гео-сплита — в auto-memory (MEMORY.md): biohack_day_screen_deploy, biohack_geo_split_audio,
  biohack_audio_hosting_test.
