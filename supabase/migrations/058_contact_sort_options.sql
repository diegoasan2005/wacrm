-- ============================================================
-- 058_contact_sort_options
--
-- Sortable columns on the Contacts list.
--
-- The plain (no tag filter) contact list orders client-side via
-- PostgREST `.order()`, so no DB change is needed there. The tag
-- filter path, though, pages through the `filter_contacts_by_tags`
-- RPC (migration 025), whose ORDER BY was hardcoded to
-- created_at DESC — sorting client-side would only sort the visible
-- 25-row page and lie about the total order.
--
-- This replaces the function with two optional parameters —
-- p_sort_column / p_sort_dir — whitelist-mapped through CASE so no
-- identifier is ever interpolated. Defaults keep the old
-- created_at-DESC behavior, so existing callers are unaffected.
-- NULLs sort last in both directions; id is the pagination
-- tiebreaker.
--
-- The parameter list changes, so the new signature is granted
-- explicitly and the old 4-arg function is dropped.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags(
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0,
  p_sort_column TEXT DEFAULT 'created_at',
  p_sort_dir TEXT DEFAULT 'desc'
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    -- Distinct contacts having ANY of the selected tags (OR),
    -- narrowed by the same name/phone/email search as the list.
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    JOIN contact_tags ct ON ct.contact_id = c.id
    WHERE ct.tag_id = ANY(p_tag_ids)
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
  ),
  page AS (
    -- count(*) OVER() is evaluated before LIMIT, so it is the full
    -- match total regardless of the page being returned. The sort
    -- key is whitelisted via CASE (no dynamic identifiers) and cast
    -- to text so one CASE type covers every column — ISO timestamps
    -- sort chronologically as text. NULLS LAST in both directions.
    SELECT m.id, count(*) OVER() AS total_count
    FROM matched m
    JOIN contacts c ON c.id = m.id
    ORDER BY
      CASE WHEN p_sort_dir = 'asc' THEN
        CASE p_sort_column
          WHEN 'name' THEN c.name
          WHEN 'last_name' THEN c.last_name
          WHEN 'identification' THEN c.identification
          WHEN 'phone' THEN c.phone
          WHEN 'email' THEN c.email
          WHEN 'company' THEN c.company
          WHEN 'created_at' THEN c.created_at::text
        END
      END ASC NULLS LAST,
      CASE WHEN p_sort_dir = 'desc' THEN
        CASE p_sort_column
          WHEN 'name' THEN c.name
          WHEN 'last_name' THEN c.last_name
          WHEN 'identification' THEN c.identification
          WHEN 'phone' THEN c.phone
          WHEN 'email' THEN c.email
          WHEN 'company' THEN c.company
          WHEN 'created_at' THEN c.created_at::text
        END
      END DESC NULLS LAST,
      c.id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY
    CASE WHEN p_sort_dir = 'asc' THEN
      CASE p_sort_column
        WHEN 'name' THEN c.name
        WHEN 'last_name' THEN c.last_name
        WHEN 'identification' THEN c.identification
        WHEN 'phone' THEN c.phone
        WHEN 'email' THEN c.email
        WHEN 'company' THEN c.company
        WHEN 'created_at' THEN c.created_at::text
      END
    END ASC NULLS LAST,
    CASE WHEN p_sort_dir = 'desc' THEN
      CASE p_sort_column
        WHEN 'name' THEN c.name
        WHEN 'last_name' THEN c.last_name
        WHEN 'identification' THEN c.identification
        WHEN 'phone' THEN c.phone
        WHEN 'email' THEN c.email
        WHEN 'company' THEN c.company
        WHEN 'created_at' THEN c.created_at::text
      END
    END DESC NULLS LAST,
    c.id;
$$;

-- New 6-arg signature: re-apply ownership and grants.
ALTER FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, TEXT, TEXT)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, TEXT, TEXT)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, TEXT, TEXT)
  TO authenticated;

-- The old 4-arg signature is superseded (CREATE OR REPLACE with a
-- different signature leaves the old function in place).
DROP FUNCTION IF EXISTS public.filter_contacts_by_tags(UUID[], TEXT, INT, INT);
