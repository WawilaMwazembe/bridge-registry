-- =====================================================================
--  Export the current bridges and lookup values as INSERT statements.
--  User accounts, password hashes and sessions are deliberately left out,
--  so the output is safe to commit to a repository.
--
--  psql -d bridge_registry -tA -f db/export_data.sql -o db/04_current_data.sql
--
--  Load into a fresh database after 01_schema.sql (02_seed.sql is optional;
--  rows that already exist are skipped):
--  psql -d bridge_registry -f db/04_current_data.sql
-- =====================================================================
SELECT '-- Bridge Register data export, ' || to_char(now(), 'YYYY-MM-DD HH24:MI') || ' (no user accounts)';
SELECT 'BEGIN;';

SELECT format('INSERT INTO region (code, name) VALUES (%L, %L) ON CONFLICT DO NOTHING;', code, name)
FROM region ORDER BY code;

SELECT format('INSERT INTO road (road_no, road_name, road_class) VALUES (%L, %L, %L) ON CONFLICT DO NOTHING;',
              road_no, road_name, road_class)
FROM road ORDER BY road_no;

SELECT format('INSERT INTO %I (name, sort_order) VALUES (%L, %s) ON CONFLICT DO NOTHING;', t, name, sort_order)
FROM (SELECT 'structure_type' AS t, name, sort_order FROM structure_type
      UNION ALL SELECT 'material', name, sort_order FROM material
      UNION ALL SELECT 'financier', name, sort_order FROM financier
      UNION ALL SELECT 'condition_rating', name, sort_order FROM condition_rating) lookups
ORDER BY t, sort_order, name;

SELECT format('INSERT INTO bridge (id, region_code, bridge_no, bridge_name, latitude, longitude, road_no, link_name, '
           || 'chainage_km, structure_type, material, span_count, length_m, width_m, financier, construction_year, '
           || 'design_life_years, construction_cost_tsh_mio, overall_condition, record_status, remarks, '
           || 'last_inspected_on, is_deleted) VALUES (%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, '
           || '%L, %L, %L, %L, %L, %L, %L, %L) ON CONFLICT DO NOTHING;',
              id, region_code, bridge_no, bridge_name, latitude, longitude, road_no, link_name,
              chainage_km, structure_type, material, span_count, length_m, width_m, financier, construction_year,
              design_life_years, construction_cost_tsh_mio, overall_condition, record_status, remarks,
              last_inspected_on, is_deleted)
FROM bridge
ORDER BY region_code, road_no, link_name, chainage_km;

SELECT 'COMMIT;';
