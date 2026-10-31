-- Tidy the links between tables and let the database check its own data:
--
-- 1. Every column that holds another table's id is a real foreign key, so it can never point at a row that
--    is gone: a van line's rule, an item's or a van's place on the floor, the login that made a movement.
--    Deleting the rule / area / login sets the id to none (NULL), as the app already does by hand.
--    An id that points at nothing today is set to none first — it already showed as none.
--    (allocation_log keeps plain ids on purpose: it is history, and outlives the rows it names.)
-- 2. Every fixed list of words (van status, movement type, line state…) and every 0/1 flag is checked.
--    A check that some existing row breaks is not added (a NOTICE names it), so this never fails on old
--    data and never stops a later save of an old row.
-- 3. Indexes on the foreign keys that had none (a PO's lines were found by reading every PO line).
--
-- Nothing else changes: no column is renamed or retyped, so the app's SQL is the same.
-- Safe to run again (src/db.js migrate() may, on a local database made before it kept a list).

-- ── 1. Foreign keys ──
UPDATE van_lines SET rule_id = NULL WHERE rule_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rules r WHERE r.id = van_lines.rule_id);
UPDATE items SET area_id = NULL WHERE area_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM floor_areas a WHERE a.id = items.area_id);
UPDATE vans SET area_id = NULL WHERE area_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM floor_areas a WHERE a.id = vans.area_id);
UPDATE movements SET user_id = NULL WHERE user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = movements.user_id);

DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('van_lines', 'van_lines_rule_id_fkey', 'rule_id', 'rules'),
    ('items', 'items_area_id_fkey', 'area_id', 'floor_areas'),
    ('vans', 'vans_area_id_fkey', 'area_id', 'floor_areas'),
    ('movements', 'movements_user_id_fkey', 'user_id', 'users')
  ) AS t(tbl, name, col, ref) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.name) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(id) ON DELETE SET NULL', c.tbl, c.name, c.col, c.ref);
    END IF;
  END LOOP;
END
$$;

-- ── 2. Checks ──
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('vans', 'vans_status_check', $x$status IN ('planned', 'in_production', 'completed', 'cancelled')$x$),
    ('items', 'items_kind_check', $x$kind IN ('stock', 'per-van')$x$),
    ('items', 'items_trade_check', $x$trade IN ('', 'electrician', 'builder', 'cladding', 'plumber', 'finisher')$x$),
    ('reminders', 'reminders_trade_check', $x$trade IN ('', 'electrician', 'builder', 'cladding', 'plumber', 'finisher')$x$),
    ('users', 'users_trade_check', $x$trade IN ('', 'electrician', 'builder', 'cladding', 'plumber', 'finisher')$x$),
    ('movements', 'movements_type_check', $x$type IN ('receive', 'issue', 'adjust', 'return', 'count')$x$),
    ('purchase_orders', 'purchase_orders_status_check', $x$status IN ('open', 'closed')$x$),
    ('van_lines', 'van_lines_state_check', $x$state IN ('', 'customer', 'tbd', 'not_ordered')$x$),
    ('van_lines', 'van_lines_source_check', $x$source IN ('rule', 'manual', 'plan')$x$),
    ('floor_areas', 'floor_areas_kind_check',
      $x$kind IN ('building', 'bay', 'yard', 'gate_in', 'gate_out', 'office', 'storage', 'work', 'wall')$x$),
    ('items', 'items_flags_check', $x$active IN (0, 1) AND placeholder IN (0, 1)$x$),
    ('rules', 'rules_active_check', $x$active IN (0, 1)$x$),
    ('vans', 'vans_reviewed_check', $x$reviewed IN (0, 1)$x$),
    ('van_lines', 'van_lines_urgent_check', $x$urgent IN (0, 1)$x$),
    ('purchase_orders', 'purchase_orders_needs_check_check', $x$needs_check IN (0, 1)$x$),
    ('movements', 'movements_ack_check', $x$ack IN (0, 1)$x$),
    ('allocation_log', 'allocation_log_ack_check', $x$ack IN (0, 1)$x$),
    ('reminders', 'reminders_done_check', $x$done IN (0, 1)$x$),
    ('users', 'users_flags_check', $x$active IN (0, 1) AND must_change IN (0, 1)$x$),
    ('suppliers', 'suppliers_lead_check', $x$lead_confirmed IN (0, 1) AND lead_days >= 0$x$)
  ) AS t(tbl, name, expr) LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.name);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s) NOT VALID', c.tbl, c.name, c.expr);
    BEGIN
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', c.tbl, c.name);
    EXCEPTION WHEN check_violation THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', c.tbl, c.name);
      RAISE NOTICE 'Check % not added: some rows in % do not pass it', c.name, c.tbl;
    END;
  END LOOP;
END
$$;

-- ── 3. Indexes ──
CREATE INDEX IF NOT EXISTS ix_po_lines_po ON po_lines(po_id);
CREATE INDEX IF NOT EXISTS ix_items_area ON items(area_id);
CREATE INDEX IF NOT EXISTS ix_vans_area ON vans(area_id);
CREATE INDEX IF NOT EXISTS ix_lines_rule ON van_lines(rule_id);
CREATE INDEX IF NOT EXISTS ix_moves_user ON movements(user_id);
CREATE INDEX IF NOT EXISTS ix_alog_van ON allocation_log(van_id);
