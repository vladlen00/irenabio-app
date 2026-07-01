# irenabio-app — статус проекта (контент-платформа app.irenabio.com)

Фронт контент-платформы «Женский биохакинг с Иреной Пол». Чистый vanilla JS (без сборки),
экраны — секции `#view-*`, переключаются `hidden`. Хостинг: **GitHub Pages** (repo `vladlen00/irenabio-app`,
ветка `main`, CNAME `app.irenabio.com`). Supabase project: `kjzxrpwqyyjcykwbqskn`.

## Деплой
- `git push origin main` → GitHub Pages публикует за ~1 мин.
- **ВСЕГДА бампать `?v=N`** у `app.js`/`style.css` в `index.html` (иначе кэш). Сейчас **?v=20**.
- Проверка живости: `curl https://app.irenabio.com/?cb=RND | grep -oE 'app.js\?v=[0-9]+'`.

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

## Контракт get-day (фронт уже потребляет)
audio/image-блок: `{order_index, block_type, title, content_text, duration_seconds, url(presigned), host('timeweb'|'minio')}`;
video: `content_url` (Kinescope id/url); text/task: `content_text`. Нет ключа хранилища → отдаёт `content_url` путь (плеер не падает).

## ХВОСТЫ — приоритеты новой сессии (по порядку)
1. **TIMEWEB-КЛЮЧ МЁРТВ** (HEAD 403 InvalidAccessKeyId, старый TN475UO7 пересоздан) → **РФ-ветка звука НЕ работает**
   (сейчас РФ фоллбэком идёт на MinIO, работает под VPN). ПРИОРИТЕТ №1 (РФ = половина аудитории, Teleg у них отвалился).
   Владлен пересоздаёт S3-ключ в timeweb.cloud (бакет `irenabio-audio`, регион `ru-1`) → положить в файл
   `C:\Users\damia\Downloads\tw_keys.txt` → залить `pervaya_trenirovka.m4a` в Timeweb под ключом `sprints/test/day1.m4a`
   (Content-Type audio/mp4) → загрузить `TIMEWEB_ACCESS_KEY`/`TIMEWEB_SECRET_KEY` в `app_config`
   (редеплой temp-функции `secret-load`, она сейчас обезврежена 410) → проверить РФ-тестером (Алинчик 92.36.21.101 /
   Ольга 46.8.148.254 / Наталья).
2. **Перенести MinIO-ключ** из `app_config` в штатные **Edge Function Secrets** перед публичным запуском
   (нужен `supabase secrets set` от Владлена или PAT). get-day уже читает env первым — просто перестанет брать из таблицы.
3. **Удалить временные edge-функции** после проверки РФ-звука: `geo-probe, ru-loader, storage-probe, storage-list,
   presign, secret-load, audio-probe` (`supabase functions delete <slug> --project-ref kjzxrpwqyyjcykwbqskn`).
   ВНИМАНИЕ: edge `audio-probe` ЗАБРАКОВАНА — Supabase gateway принудительно переписывает `text/html` -> `text/plain`
   +nosniff на домене `*.supabase.co` (анти-XSS), браузер показывает сырой код. HTML с edge на supabase.co НЕ рендерится.
   **РАБОЧАЯ проба звука для РФ-тестеров: статическая страница `irenabio.com/probe.html`** (repo `vladlen00/irenabio-site`,
   GitHub Pages -> text/html рендерится; presigned Timeweb+MinIO вшиты, TTL 7д -> аудио тянется НАПРЯМУЮ с хостов, без
   обращения к supabase.co, который в РФ может быть недоступен). Одна страница = оба плеера. Проверено headless-Chromium:
   contentType text/html, 2 audio loadedmetadata (dur 559с). Удалить probe.html + edge audio-probe после подтверждения.
4. **Ротация ключей отложена** решением Владлена — текущие как есть (Timeweb пересоздать — исключение, т.к. мёртв).

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
