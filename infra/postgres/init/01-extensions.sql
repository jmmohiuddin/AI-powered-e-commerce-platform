-- Extensions required by Voltix Commerce.
-- Run automatically on first container boot; mirrored by migration 0000 so that
-- managed Postgres (Neon/RDS) gets the same setup.

-- UUIDv7 generation happens in the application layer (time-ordered, index friendly),
-- but pgcrypto gives us gen_random_uuid() as a database-side fallback.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Vector similarity for semantic product search + recommendations.
CREATE EXTENSION IF NOT EXISTS vector;

-- Trigram indexes power typo-tolerant SKU / model-number lookup
-- ("iphon 15 pro" -> "iPhone 15 Pro"), which plain tsvector search misses.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Removes accents so "Xiaomi Redmi Nôte" matches "Xiaomi Redmi Note".
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Query performance telemetry consumed by the ops dashboard.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Custom text search configuration: unaccent -> english stemmer.
-- Applied to product search vectors in packages/db.
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
