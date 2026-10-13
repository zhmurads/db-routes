<!-- Сохранено 2026-10-13. План согласован, к реализации ещё не приступали. -->

# Android-приложение (APK) «Поезда по Германии» без сервера — отложенный план

Пользователь попросил сохранить этот план и вернуться к нему позже, по своему решению.

## Контекст
Пользователь хочет Android-приложение, которое я сам соберу в APK после доработки сайта. Сейчас сайт работает по цепочке «браузер → backend на Mac (Express + Redis) → Transitous + DB Timetables». Телефон до backend на Mac не достучится, а VPS сейчас недоступен: порты 22 и 443 молчат, оплачен был до 13.10.2026.

Решения пользователя:
- **без сервера**: приложение само ходит в Transitous и DB API, ключ DB зашит в APK (личное приложение, APK никому не раздаём);
- **уведомления и в фоне**: постоянный значок «Слежу за поездкой» (foreground service Android).

Состояние Mac: нет Java, Android SDK и Android Studio; есть Homebrew, свободно 347 ГБ.

Стек: **Capacitor 8.5** (`@capacitor/core|cli|android` 8.5.3) + плагины `@capacitor/geolocation` 8.2.3, `@capacitor/local-notifications` 8.3.1, `@capacitor/app` 8.1.2, `@capawesome-team/capacitor-android-foreground-service` 8.1.0 (все под MIT). Сайт продолжает работать, как сейчас, через backend.

## Шаг 0. Инструменты (с подтверждения пользователя, около 4–5 ГБ)
1. `brew install openjdk@21` и `brew install --cask android-commandlinetools`.
2. `sdkmanager "platform-tools" "platforms;android-<compileSdk>" "build-tools;<версия>"` — версии берутся из сгенерированного Capacitor-проекта.
3. Для эмулятора дополнительно: `"emulator" "system-images;android-<api>;google_apis;arm64-v8a"`.
4. **Лицензии Android SDK** (`sdkmanager --licenses`) — это согласие с условиями Google. Показать пользователю и принять только с его «да».

## Шаг 1. Общее ядро вместо backend-логики
Новый каталог `core/src/` с кодом, который сейчас лежит в `backend/src`:
- переносится без изменений: `normalize.ts`, `enrich.ts`, `eva.ts`, `irisCodes.ts`, `time.ts`, `dbtimetables.ts`;
- **зависимости внедряются**, а не импортируются напрямую:
  - `cached(key, ttl, load)` — в backend через Redis (`backend/src/cache.ts`), в приложении через память + localStorage;
  - бюджет запросов — в backend через Redis, в приложении через счётчик в памяти;
  - `fetch` — в приложении нативный (CapacitorHttp: без CORS, свой User-Agent);
  - справочник станций — передаётся данными, а не читается с диска;
- `core/src/service.ts` — функции `stations(q)`, `journeys(params)`, `refresh(id)`, `reverse(lat, lon)` с текущей логикой из `backend/src/routes.ts` (валидация, `berlinToUtc`, координаты, products → transitModes).

Изменения вокруг ядра:
- `backend/src/routes.ts` становится тонкой обёрткой над `core/service.ts`, поведение API не меняется.
- **Frontend `src/api.ts`** получает два транспорта:
  - `http` — сайт, как сейчас;
  - `local` — приложение, вызывает `core/service.ts` прямо в WebView.
  - Выбор транспорта на этапе сборки: `VITE_TARGET=app`.
  - Справочник станций (345 КБ) — отдельный чанк, грузится при первой сверке.
- Ключи DB и контакт для Transitous попадают в сборку приложения из `.env` (`VITE_…` только при `VITE_TARGET=app`). В git не попадают.

## Шаг 2. Capacitor-проект `android/`
- `capacitor.config.ts`:
  - appId `ua.zhmurads.dbroutes`, имя «Поезда DE», `webDir` = `frontend/dist`;
  - `CapacitorHttp.enabled: true`;
  - `android.appendUserAgent` = `db-routes-android/0.1 (<контакт>)` — по правилам Transitous.
- **Геолокация**: в `useMyLocation` под приложением использовать `@capacitor/geolocation` (разрешения в манифесте добавит плагин).
- **Уведомления**: `watch.ts` → `notify()` под приложением через `@capacitor/local-notifications`; на Android 13+ запросить разрешение `POST_NOTIFICATIONS`.
- **Фон**:
  - при «Следить» запустить foreground service (`@capawesome-team/capacitor-android-foreground-service`) с постоянным уведомлением «Слежу за поездкой: Berlin → München, 08:43»;
  - пока сервис работает, WebView не выгружается и цикл обновления раз в 60 с продолжается (`scheduleRefresh` уже обновляет отслеживаемую поездку на скрытой странице);
  - при «Не следить» или после прибытия по плану + 30 мин сервис остановить;
  - **риск**: WebView может заморозить таймеры в фоне. Проверить на эмуляторе (шаг 4). Если заморозит — опрос переносится в небольшой нативный `Handler` в `MainActivity`, который раз в 60 с вызывает JS-функцию `refreshWatched()`.
- Иконка и сплэш: сгенерировать из SVG 🚆 (`@capacitor/assets`).
- Тайлы OSM: в WebView проверить, что сервер тайлов отдаёт картинки. Если откажет из-за Referer, подставить Referer/UA через `tileLayer` или сменить источник тайлов.

## Шаг 3. Сборка APK
- `npm run build:app` → `npx cap sync android` → `./gradlew assembleRelease`.
- Подпись: `keytool -genkeypair` → `android/release.keystore`. Пароль хранится в Связке ключей macOS (`security add-generic-password`), а `android/keystore.properties` лежит в `.gitignore`. Один ключ на все версии, чтобы обновления ставились поверх.
- Результат: `db-routes-<версия>.apk` в `~/Downloads`.
- Скрипт `scripts/build-apk.sh` повторяет всю сборку одной командой.

## Шаг 4. Проверка
- **Эмулятор** (arm64, headless): `adb install`, запуск, скриншоты через `adb exec-out screencap`:
  - поиск Berlin Hbf → München Hbf, раскрытие, карта с тайлами, метки DB (сверка работает с телефона);
  - 📍: `adb emu geo fix 13.4132 52.5219` → маршрут от Alexanderplatz;
  - «Следить» → свернуть приложение (`adb shell input keyevent HOME`) → через 2–3 мин в `adb logcat` видно обновления, постоянное уведомление на месте. Подменённое изменение даёт уведомление (как в тесте сайта).
- **Сайт не сломан**: `./scripts/smoke.sh`, `node scripts/compare-db.mjs` (30 из 30).
- **На телефон**: APK отдать файлом (пользователь сам перешлёт его себе, например в Telegram, и разрешит установку из этого источника) либо `adb install` по USB, если пользователь включит отладку по USB.

## Что нужно от пользователя
1. «Да» на установку инструментов (около 4–5 ГБ) и на принятие лицензий Android SDK.
2. Способ доставки APK на телефон (файл или USB-отладка).
3. По желанию: продлить VPS. Для приложения он не нужен, но сайт снаружи без него недоступен.
