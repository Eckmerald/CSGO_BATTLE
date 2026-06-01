# CASEX Backend — API Documentation

Node.js + Express + PostgreSQL (Prisma) + Redis + Socket.IO

---

## Быстрый старт

```bash
# 1. Установить зависимости
npm install

# 2. Настроить переменные окружения
cp .env.example .env
# Заполнить .env

# 3. Запустить базу данных
docker-compose -f docker/docker-compose.yml up postgres redis -d

# 4. Применить миграции и сгенерировать клиент
npx prisma migrate dev --name init
npx prisma generate

# 5. Запустить в режиме разработки
npm run dev
```

---

## Структура проекта

```
casex-backend/
├── src/
│   ├── index.js                     # Точка входа, Express + Socket.IO
│   ├── config/
│   │   └── redis.js                 # Redis клиент
│   ├── common/
│   │   ├── middleware/
│   │   │   ├── auth.js              # JWT проверка
│   │   │   ├── rateLimiter.js       # Rate limiting
│   │   │   └── errorHandler.js      # Глобальный обработчик ошибок
│   │   └── utils/
│   │       └── logger.js            # Winston логгер
│   └── modules/
│       ├── auth/           auth.routes.js       # Steam + JWT
│       ├── users/          users.routes.js      # Профиль, бонусы
│       ├── cases/          cases.routes.js      # Каталог, открытие, Provably Fair
│       ├── battles/        battles.routes.js    # CRUD батлов
│       │                   battles.socket.js    # WebSocket логика
│       ├── upgrade/        upgrade.routes.js    # Апгрейд скинов
│       ├── inventory/      inventory.routes.js  # Инвентарь, продажа
│       ├── payments/       payments.routes.js   # Депозит, вывод
│       ├── promo/          promo.routes.js      # Промокоды
│       ├── notifications/  chat.socket.js       # Чат
│       └── admin/          admin.routes.js      # Панель администратора
├── prisma/
│   └── schema.prisma                # Схема БД (11 таблиц)
├── docker/
│   └── docker-compose.yml
└── .env.example
```

---

## REST API Reference

### Auth — `/api/auth`

| Метод | Путь | Описание | Доступ |
|-------|------|----------|--------|
| GET | `/steam` | Редирект на Steam OpenID | Public |
| GET | `/steam/return` | Callback от Steam → выдаёт JWT cookies | Public |
| POST | `/refresh` | Обновить access token по refresh cookie | Public |
| POST | `/logout` | Выход, отзыв сессии | Private |
| GET | `/me` | Данные текущего пользователя | Private |

---

### Users — `/api/users`

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/profile` | Профиль + статистика |
| POST | `/daily-bonus` | Забрать ежедневный бонус (+50 RUB) |
| GET | `/referrals` | Список рефералов и заработок |
| GET | `/:steamId` | Публичный профиль по Steam ID |

---

### Cases — `/api/cases`

| Метод | Путь | Тело / Параметры | Описание |
|-------|------|------------------|----------|
| GET | `/` | `?category&sort&search` | Каталог кейсов |
| GET | `/:slug` | — | Кейс + все предметы + serverSeedHash |
| POST | `/:caseId/open` | `{ clientSeed, quantity }` | **Открыть кейс** — Provably Fair |
| GET | `/verify/:resultId` | — | Верификация честности броска |

**Пример открытия:**
```json
POST /api/cases/{caseId}/open
Authorization: Cookie access_token=...

{
  "clientSeed": "my-custom-seed",
  "quantity": 1
}

Response:
{
  "results": [{
    "inventoryId": "uuid",
    "item": { "name": "AK-47 | Redline", "marketPrice": 1200, "rarity": "red" },
    "serverSeed": "revealed-seed",
    "roll": 0.4521
  }]
}
```

---

### Battles — `/api/battles`

| Метод | Путь | Тело | Описание |
|-------|------|------|----------|
| GET | `/` | `?mode&status&limit` | Список активных батлов |
| GET | `/:id` | — | Детали батла |
| POST | `/` | `{ mode, caseIds[], gameMode }` | Создать батл |
| POST | `/:id/join` | `{ inviteCode? }` | Войти в батл |

**Режимы:** `1v1`, `2v2`, `1v1v1`, `1v1v1v1`, `ffa`  
**Игровые режимы:** `normal` (больше сумма — победа), `crazy` (меньше — победа)

---

### Upgrade — `/api/upgrade`

| Метод | Путь | Тело | Описание |
|-------|------|------|----------|
| POST | `/` | `{ inventoryItemId, targetItemId, clientSeed? }` | Апгрейд скина |

Формула: `chance = (цена_исходного / цена_целевого) × 0.9`

---

### Inventory — `/api/inventory`

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/` | Инвентарь пользователя |
| POST | `/:id/sell` | Продать предмет |
| POST | `/sell-all` | Продать весь инвентарь |

---

### Payments — `/api/payments`

| Метод | Путь | Тело | Описание |
|-------|------|------|----------|
| POST | `/deposit/init` | `{ amount, method }` | Инициировать пополнение |
| POST | `/deposit/webhook` | (от шлюза) | Вебхук подтверждения |
| POST | `/withdraw` | `{ method, amount?, itemId?, tradeUrl? }` | Запрос вывода |
| GET | `/history` | `?type&limit&offset` | История транзакций |

**Методы пополнения:** `card`, `sbp`, `yoomoney`, `qiwi`, `crypto`  
**Методы вывода:** `steam`, `card`, `crypto`, `yoomoney`

---

### Promo — `/api/promo`

| Метод | Путь | Тело | Описание |
|-------|------|------|----------|
| POST | `/apply` | `{ code, depositAmount }` | Применить промокод |

---

### Admin — `/api/admin` *(требует роль admin)*

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/dashboard` | Выручка, онлайн, статистика |
| GET | `/users` | Поиск пользователей |
| POST | `/users/:id/ban` | Забанить пользователя |
| POST | `/users/:id/credit` | Начислить баланс |
| GET | `/withdrawals` | Список выводов |
| POST | `/withdrawals/:id/approve` | Одобрить вывод |
| POST | `/cases` | Создать кейс |
| POST | `/promo` | Создать промокод |

---

## WebSocket Events

**Подключение:** `ws://api/battles` и `ws://api/chat`

### Battle namespace (`/battles`)

| Событие | Направление | Данные |
|---------|-------------|--------|
| `battle:watch` | Client→Server | `{ battleId }` |
| `battle:created` | Server→All | `battle` |
| `battle:player_joined` | Server→All | `{ battleId, userId }` |
| `battle:countdown` | Server→All | `{ battleId }` |
| `battle:started` | Server→All | `{ battleId }` |
| `battle:round_result` | Server→All | `{ battleId, round, results[] }` |
| `battle:finished` | Server→All | `{ battleId, winnerId, playerTotals }` |

### Chat namespace (`/chat`)

| Событие | Направление | Данные |
|---------|-------------|--------|
| `chat:send` | Client→Server | `{ text }` |
| `chat:message` | Server→All | `{ userId, username, text, timestamp }` |
| `chat:history` | Server→Client | `message[]` |

### Global namespace

| Событие | Данные | Описание |
|---------|--------|----------|
| `live_feed` | `{ username, avatar, item, caseId }` | Крупный выигрыш |

---

## База данных (PostgreSQL + Prisma)

**11 таблиц:** `users`, `user_sessions`, `cases`, `items`, `case_items`,
`case_open_results`, `battles`, `battle_players`, `battle_case_results`,
`battle_cases`, `user_inventory`, `transactions`, `withdrawals`,
`promo_codes`, `promo_code_uses`, `daily_bonuses`

Все транзакции с балансом выполняются через `prisma.$transaction()` для ACID-гарантий.

---

## Provably Fair

Алгоритм верификации для открытий кейсов и апгрейдов:

```
1. Сервер генерирует server_seed (случайные 32 байта)
2. Клиент получает SHA-256 хэш server_seed (до открытия)
3. Клиент может задать свой client_seed
4. roll = HMAC-SHA256(server_seed, "client_seed:nonce") → [0,1)
5. roll выбирает предмет по таблице вероятностей
6. После открытия — server_seed раскрывается
7. Любой может верифицировать: GET /api/cases/verify/:resultId
```

---

## Безопасность

- JWT в httpOnly cookies (не доступны JS)
- Rate limiting: 200 req/15min (глобально), 10 req/min (чувствительные эндпоинты)
- Helmet.js — защитные HTTP-заголовки
- Подпись вебхуков платёжных шлюзов (HMAC-SHA256)
- Все изменения баланса — атомарные DB-транзакции
- Банировка аккаунтов + логирование всех операций
