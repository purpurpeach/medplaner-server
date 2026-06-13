-- ══════════════════════════════════════════════════
--  МедПланер — База данных Supabase
--  Выполните этот SQL в Supabase → SQL Editor
-- ══════════════════════════════════════════════════

-- Таблица пользователей
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- Telegram user ID
  telegram_id BIGINT UNIQUE,        -- Telegram chat ID для сообщений
  name TEXT,
  profile JSONB DEFAULT '{}',       -- Результаты онбординга (хронотип и т.д.)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Таблица расписаний
CREATE TABLE IF NOT EXISTS schedules (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  schedule_data JSONB DEFAULT '{}', -- { "0": [...], "1": [...], ... }
  categories JSONB DEFAULT '[]',    -- Категории пользователя
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Таблица OAuth токенов (gmail, yandex, gcal, todoist)
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id SERIAL PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,           -- 'gmail', 'yandex', 'gcal', 'todoist'
  tokens TEXT NOT NULL,             -- JSON строка с токенами (зашифрована)
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

-- Таблица дневных логов (для вечерней планёрки)
CREATE TABLE IF NOT EXISTS daily_logs (
  id SERIAL PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  energy INTEGER,                   -- 1-5
  focus INTEGER,                    -- 1-5
  what_easy TEXT,
  what_hard TEXT,
  win_of_day TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, date)
);

-- Таблица кэша писем (чтобы не сканировать повторно)
CREATE TABLE IF NOT EXISTS mail_cache (
  id SERIAL PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  mail_id TEXT NOT NULL,
  source TEXT NOT NULL,             -- 'gmail', 'yandex'
  subject TEXT,
  from_addr TEXT,
  mail_date TIMESTAMPTZ,
  category TEXT,                    -- 'patient', 'conference', 'travel', 'other'
  has_event BOOLEAN DEFAULT FALSE,
  event_data JSONB,
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, source, mail_id)
);

-- ── Row Level Security ───────────────────────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_cache ENABLE ROW LEVEL SECURITY;

-- Только сервис с service_key может читать/писать (фронтенд не имеет прямого доступа)
-- RLS политики для service role (обходит RLS автоматически)

-- ── Индексы для производительности ─────────────────────
CREATE INDEX IF NOT EXISTS idx_daily_logs_user_date ON daily_logs(user_id, date);
CREATE INDEX IF NOT EXISTS idx_mail_cache_user ON mail_cache(user_id, processed_at DESC);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id, provider);
