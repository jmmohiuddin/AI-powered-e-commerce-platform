-- Applied before every migration run. Idempotent by construction.
-- Mirrors infra/postgres/init/01-extensions.sql so that managed Postgres
-- (Neon, RDS, Supabase) reaches the same state as the local container.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'voltix_search') THEN
    CREATE TEXT SEARCH CONFIGURATION voltix_search (COPY = english);
    ALTER TEXT SEARCH CONFIGURATION voltix_search
      ALTER MAPPING FOR hword, hword_part, word
      WITH unaccent, english_stem;
  END IF;
END
$$;
