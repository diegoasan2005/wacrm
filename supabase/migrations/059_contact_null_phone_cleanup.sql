-- ============================================================
-- 059_contact_null_phone_cleanup
--
-- One-time data cleanup for a CSV-import artifact.
--
-- Spreadsheets exported from other systems write the four letters
-- "NULL" into empty cells, and the contact importer stored that
-- text verbatim — contacts ended up with phone = 'NULL', which the
-- WhatsApp integrations treat as a real number and the appointment
-- dialog treats as "has a phone".
--
-- `contacts.phone` is NOT NULL (022): the app's representation of
-- "no phone" is the EMPTY STRING — the partial unique index
-- (account_id, phone_normalized WHERE phone_normalized <> '')
-- explicitly lets many phone-less contacts coexist in one account.
-- So the sentinel text on phone is replaced with '' rather than
-- NULL. The remaining columns are nullable and go to real NULL.
-- phone_normalized is GENERATED from phone (022), so it follows
-- automatically (to '').
--
-- Idempotent — safe to run multiple times.
-- ============================================================

UPDATE contacts SET phone = ''
WHERE phone IS NOT NULL AND upper(btrim(phone)) = 'NULL';

UPDATE contacts SET name = NULL
WHERE name IS NOT NULL AND upper(btrim(name)) = 'NULL';

UPDATE contacts SET last_name = NULL
WHERE last_name IS NOT NULL AND upper(btrim(last_name)) = 'NULL';

UPDATE contacts SET identification = NULL
WHERE identification IS NOT NULL AND upper(btrim(identification)) = 'NULL';

UPDATE contacts SET email = NULL
WHERE email IS NOT NULL AND upper(btrim(email)) = 'NULL';

UPDATE contacts SET company = NULL
WHERE company IS NOT NULL AND upper(btrim(company)) = 'NULL';
