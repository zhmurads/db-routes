# db-routes: поезда по Германии в реальном времени

Личный сайт для поиска ж/д маршрутов по Германии: опоздания, отмены, смены путей, пересадки, промежуточные остановки. Билетов и цен нет.

## Откуда данные

Данные берутся из **[Transitous](https://transitous.org/)**: это открытый некоммерческий сервис на движке MOTIS 2, работает на открытых данных Германии (DELFI + GTFS-RT).

Изначально планировался свой [db-rest](https://github.com/derhuerst/db-rest), но с мая 2026 DB отклоняет запросы db-vendo-client по TLS-отпечатку (`OPS_BLOCKED`) с любых IP, включая домашние. Подробности в [db-vendo-client#46](https://github.com/public-transport/db-vendo-client/issues/46) и [db-rest#78](https://github.com/derhuerst/db-rest/issues/78). Проверено 2026-10-12: все три профиля (`db`, `dbnav`, `dbweb`) заблокированы.

**Условия Transitous** ([transitous.org/api](https://transitous.org/api/)):
- проект некоммерческий, с открытым кодом;
- нагрузка небольшая;
- в User-Agent есть контакт (переменная `TRANSITOUS_CONTACT` в `.env`);
- на странице есть видимая ссылка на [источники данных](https://transitous.org/sources/), она стоит в подвале.

## Данные DB (Timetables API) и уведомления

**Сверка с табло DB.** Когда маршрут раскрыт, backend сверяет поезда DB (ICE/IC/EC, RE/RB, S-Bahn) с официальным [DB Timetables API](https://developers.deutschebahn.com/db-api-marketplace/apis/product/timetables). Это данные вокзальных табло, и они точнее и быстрее потока Transitous.
- С табло берутся фактическое время, путь, отмена и сообщения DB: причины задержек, качество и нарушения движения. Сообщения переведены на русский, коды лежат в `backend/src/irisCodes.ts`.
- Такие данные помечены в интерфейсе красной меткой **DB**.
- Автобусы, трамваи, U-Bahn и иностранные поезда без данных на табло остаются на Transitous.
- Как ищется поезд (`backend/src/enrich.ts`):
  1. остановка из Transitous → ближайшая станция DB по координатам (`backend/data/db-stations.json`, собран из npm `db-stations` скриптом `scripts/build-stations.mjs`);
  2. к ней добавляются связанные номера EVA (`meta` из `/station`; например, у Berlin Hbf табло разнесено по уровням);
  3. в `plan` за нужный час ищется поезд с тем же плановым временем — по номеру, а если номера нет, то по категории;
  4. по `id` берутся изменения из `fchg`.
- Ключ: зарегистрироваться на DB API Marketplace, создать приложение, подписать его на Timetables (план Free), затем заполнить `DB_CLIENT_ID` (Client ID) и `DB_API_KEY` (Client Secret) в `.env`. Без ключа сверка выключена.
- Лимит плана Free — 60 запросов в минуту. Backend тратит не больше `DB_TT_BUDGET_PER_MIN` (50). Кэш: план 6 ч, изменения 30 с, связанные станции 30 дней. При исчерпанном лимите показываются данные Transitous.
- Проверка сверки: `node scripts/compare-db.mjs` показывает для текущих поездов данные Transitous и данные с табло DB рядом.

**Уведомления.** Кнопка «🔔 Следить» в раскрытом маршруте включает системные уведомления браузера. Поводы:
- задержка изменилась на 2 мин и больше;
- сменился путь;
- поезд или остановку отменили;
- пересадка стала короче 4 мин или на неё уже не успеть;
- появилось новое сообщение.

Отслеживаемая поездка обновляется раз в минуту, в том числе на вкладке в фоне. Отслеживание переживает перезагрузку страницы (localStorage). Уведомления приходят, только пока вкладка открыта и компьютер не спит.

## Архитектура

```
браузер → caddy :8443 (HTTPS) → backend :8080 (Express + статика фронта) → api.transitous.org
                                     └─ redis (кэш станций и маршрутов, счётчики rate limit)
```

- **backend/**: Node 22 + Express + TypeScript. Тонкий прокси, у которого:
  - единый формат ответа `{ok, data, updatedAt}` / `{ok:false, error:{code, message}}`;
  - кэш в Redis: станции 24 ч, поиск 30 с, обновление маршрута 15 с;
  - rate limit с одного IP: `RATE_LIMIT_PER_MIN` в минуту, автодополнение вдвое больше.
- **frontend/**: Vite + vanilla TS, одна страница на русском, адаптив под телефон. Собирается внутри Docker-образа backend'а.
- **Карта**: Leaflet с тайлами OpenStreetMap, появляется в раскрытом маршруте.
  - Линии сегментов идут по реальной геометрии путей из MOTIS. Backend отдаёт её только в `/api/journeys/refresh`, поэтому поиск остаётся лёгким.
  - Цвета по виду транспорта, пешие переходы пунктиром, отменённые сегменты красным пунктиром. При наведении видны станции, время и пути.
  - Leaflet вынесен в отдельный чанк и грузится при первом раскрытии маршрута.
  - Тайлы берутся с `tile.openstreetmap.org` по их [правилам](https://operations.osmfoundation.org/policies/tiles/): нужны атрибуция и Referer (поэтому `Referrer-Policy: strict-origin-when-cross-origin`), подходит для небольшой нагрузки. Для высокой нагрузки понадобится свой или коммерческий источник тайлов.
- Наружу открыт только Caddy, на `127.0.0.1`. Backend и Redis портов не публикуют.

### API backend

| Метод | Что делает |
|---|---|
| `GET /api/stations?q=` | автодополнение станций |
| `GET /api/journeys?from&to&via&when&mode=dep\|arr&products&transferTime&cursor` | поиск маршрутов. `when` = `YYYY-MM-DDTHH:mm` по Берлину. `products` ⊂ `ice,ic,regional,sbahn,city`. `cursor` = `earlierRef`/`laterRef` из предыдущего ответа, остальные параметры повторяются без изменений |
| `GET /api/journeys/refresh?id=` | пересборка одного маршрута по его `id` с актуальными данными и геометрией сегментов (`legs[].geometry`: Google polyline, precision 6) |
| `GET /api/health` | `{ok, redis}` |

## Запуск

```bash
cp .env.example .env              # заполнить TRANSITOUS_CONTACT
docker compose up -d --build
open https://localhost:8443
```

**Сертификат.** Caddy выпускает сертификат для `localhost` своим внутренним CA. Чтобы браузер ему доверял, один раз добавьте корневой сертификат в Связку ключей (понадобится пароль macOS):

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ./caddy-root.crt
rm caddy-root.crt
```

Без этого шага браузер покажет предупреждение, и его можно принять вручную.

**Разработка фронта** при запущенном стеке: `cd frontend && npm i && npm run dev` поднимает http://localhost:5173, а `/api` проксируется в стек.

**Проверка API:** `./scripts/smoke.sh`.

## Обновление

```bash
git pull                                    # если код менялся
docker compose pull redis caddy             # свежие базовые образы
docker compose up -d --build --pull always  # пересобрать backend на свежем node:22-alpine
docker image prune -f
```

## Конфиг (`.env`)

| Переменная | По умолчанию | |
|---|---|---|
| `HTTPS_PORT` | `8443` | порт на `127.0.0.1` |
| `SITE_ADDRESS` | `localhost` | адрес сайта для Caddy |
| `TRANSITOUS_CONTACT` | — | e-mail или URL для User-Agent (требование Transitous) |
| `UPSTREAM_LANGUAGE` | `de` | язык текстов предупреждений (`de`/`en`) |
| `RATE_LIMIT_PER_MIN` | `60` | лимит `/api` с одного IP |
| `REDIS_MAXMEMORY` | `64mb` | потолок памяти Redis (LRU) |

`.env` в git не попадает.

## Переезд на VPS (на будущее)

1. Направить A-запись домена на VPS.
2. На VPS уже работает общий Caddy (`/srv/caddy`), поэтому сервис `caddy` из этого compose не нужен:
   - backend подключить к внешней сети `web`;
   - в общий Caddyfile добавить `домен { reverse_proxy db-routes-backend-1:8080 }`;
   - сертификат Let's Encrypt выпустится автоматически.
3. Rate limit на Mac видит один IP (шлюз Docker Desktop). За общим Caddy на VPS лимит будет считаться по реальным IP клиентов.
4. Перед переездом проверить с VPS: `curl -A test https://api.transitous.org/api/v1/geocode?text=Berlin`.

## Ограничения данных

- Realtime приходит из открытых фидов. Для дальних поездов DB он есть почти всегда. Для автобусов, части региональных поездов и иностранных перевозчиков бывает только расписание: такие варианты помечены «по расписанию».
- Тексты предупреждений приходят на немецком или английском, русского у источника нет.
- Цен и билетов нет: так задумано.
