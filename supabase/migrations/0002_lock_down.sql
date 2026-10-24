-- Lock the tables away from Supabase's Data API.
--
-- Supabase publishes every table in the public schema over its Data API (PostgREST / GraphQL), answering as
-- the roles anon and authenticated, which by default get every right on every new table. Their key (the
-- anon / publishable key) is public by design, so without this anyone could read the logins' password hashes
-- or the customers, or write themselves a session. Factory Stock never uses the Data API: the app, the copy
-- script and the nightly backup all connect as the postgres role, which owns the tables and is not held back
-- by row level security.
--
-- 1. Row level security on, on every table in public, with no policies: anon and authenticated see no row
--    and can change none, even if a right is granted again by mistake.
-- 2. Their rights taken away, now and for anything made later in public (by the role that runs the
--    migrations). Only where those roles exist: a plain Postgres or PGlite (tests, the office PC) has none.
--
-- Also turn the Data API off in the dashboard (HANDOVER-CLOUD.md, section 9).

DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END
$$;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END
$$;
