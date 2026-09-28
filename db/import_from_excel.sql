-- =====================================================================
--  Bulk-load the full bridge list from the Excel template.
--
--  1. In Excel: File > Save As > "CSV UTF-8 (Comma delimited)" -> bridges.csv
--     (no need to delete the header or legend rows - they are filtered out)
--  2. From the folder containing bridges.csv:
--        psql -d bridge_registry -f path\to\import_from_excel.sql
--
--  Safe to re-run: existing bridge numbers are updated, new ones inserted.
--  Cell colours (closed / duplicate / new) are lost in CSV - set
--  record_status for those bridges afterwards in the app or with SQL.
-- =====================================================================
\set ON_ERROR_STOP on

BEGIN;

-- One text column per spreadsheet column A..T
CREATE TEMP TABLE import_stage (
    a text, region text, bridge_no text, bridge_name text, latitude text, longitude text,
    road_no text, road_name text, link_name text, chainage text, structure_type text, material text,
    spans text, length_m text, width_m text, financier text, constructed text, design_life text,
    cost text, condition text
) ON COMMIT DROP;

\copy import_stage FROM 'bridges.csv' WITH (FORMAT csv, ENCODING 'UTF8')

-- Helpers: tidy whitespace, safe numeric cast, capitalise first letter
CREATE FUNCTION pg_temp.norm(t text) RETURNS text IMMUTABLE LANGUAGE sql AS
$$ SELECT nullif(regexp_replace(btrim(t), '\s+', ' ', 'g'), '') $$;
CREATE FUNCTION pg_temp.num(t text) RETURNS numeric IMMUTABLE LANGUAGE plpgsql AS
$$ BEGIN RETURN nullif(replace(btrim(t), ',', ''), '')::numeric; EXCEPTION WHEN others THEN RETURN NULL; END $$;
CREATE FUNCTION pg_temp.cap(t text) RETURNS text IMMUTABLE LANGUAGE sql AS
$$ SELECT upper(left(pg_temp.norm(t), 1)) || substr(pg_temp.norm(t), 2) $$;

-- Keep only real bridge rows (header/legend/blank rows fail this test)
CREATE TEMP TABLE clean ON COMMIT DROP AS
SELECT DISTINCT ON (pg_temp.norm(bridge_no))
       split_part(pg_temp.norm(bridge_no), '-', 1)          AS region_code,
       upper(pg_temp.norm(region))                          AS region_name,
       pg_temp.norm(bridge_no)                              AS bridge_no,
       coalesce(pg_temp.norm(bridge_name), '(unnamed)')     AS bridge_name,
       pg_temp.num(latitude)                                AS latitude,
       pg_temp.num(longitude)                               AS longitude,
       upper(pg_temp.norm(road_no))                         AS road_no,
       pg_temp.norm(road_name)                              AS road_name,
       pg_temp.norm(link_name)                              AS link_name,
       pg_temp.num(chainage)                                AS chainage_km,
       pg_temp.cap(structure_type)                          AS structure_type,
       initcap(pg_temp.norm(material))                      AS material,
       pg_temp.num(spans)::smallint                         AS span_count,
       nullif(pg_temp.num(length_m), 0)                     AS length_m,
       nullif(pg_temp.num(width_m), 0)                      AS width_m,
       pg_temp.norm(financier)                              AS financier,
       substring(constructed FROM '(\d{4})')::smallint      AS construction_year,
       pg_temp.num(design_life)::smallint                   AS design_life_years,
       round(pg_temp.num(cost), 3)                          AS construction_cost_tsh_mio,
       initcap(pg_temp.norm(condition))                     AS overall_condition
FROM import_stage
WHERE pg_temp.norm(bridge_no) ~ '^\d{2}-\d{4}$'
ORDER BY pg_temp.norm(bridge_no);

-- Report bridge numbers that appear more than once in the sheet
SELECT pg_temp.norm(bridge_no) AS duplicate_bridge_no_in_sheet, count(*)
FROM import_stage
WHERE pg_temp.norm(bridge_no) ~ '^\d{2}-\d{4}$'
GROUP BY 1 HAVING count(*) > 1;

-- Add any lookup values that are not yet registered
INSERT INTO region (code, name)
SELECT DISTINCT ON (region_code) region_code, coalesce(region_name, 'REGION ' || region_code)
FROM clean ORDER BY region_code
ON CONFLICT DO NOTHING;

INSERT INTO road (road_no, road_name, road_class)
SELECT DISTINCT ON (road_no) road_no, coalesce(road_name, road_no),
       CASE WHEN road_no LIKE 'T%' THEN 'Trunk' ELSE 'Regional' END
FROM clean WHERE road_no IS NOT NULL ORDER BY road_no
ON CONFLICT DO NOTHING;

INSERT INTO structure_type (name)   SELECT DISTINCT structure_type    FROM clean WHERE structure_type    IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO material (name)         SELECT DISTINCT material          FROM clean WHERE material          IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO financier (name)        SELECT DISTINCT financier         FROM clean WHERE financier         IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO condition_rating (name) SELECT DISTINCT overall_condition FROM clean WHERE overall_condition IS NOT NULL ON CONFLICT DO NOTHING;

-- Rows without a road number cannot be loaded (road is mandatory)
SELECT bridge_no AS skipped_no_road_no, bridge_name FROM clean WHERE road_no IS NULL;

-- Out-of-range values are blanked rather than failing the whole import
INSERT INTO bridge (region_code, bridge_no, bridge_name, latitude, longitude, road_no, link_name,
                    chainage_km, structure_type, material, span_count, length_m, width_m, financier,
                    construction_year, design_life_years, construction_cost_tsh_mio, overall_condition)
SELECT region_code, bridge_no, bridge_name,
       CASE WHEN latitude  BETWEEN -12.5 AND -0.5 THEN latitude  END,
       CASE WHEN longitude BETWEEN  29.0 AND 41.0 THEN longitude END,
       road_no, link_name, chainage_km, structure_type, material,
       CASE WHEN span_count > 0 THEN span_count END, length_m, width_m, financier,
       CASE WHEN construction_year BETWEEN 1850 AND 2100 THEN construction_year END,
       CASE WHEN design_life_years > 0 THEN design_life_years END,
       construction_cost_tsh_mio, overall_condition
FROM clean
WHERE road_no IS NOT NULL
ON CONFLICT (bridge_no) WHERE NOT is_deleted AND record_status <> 'Duplicate'
DO UPDATE SET
    region_code = EXCLUDED.region_code, bridge_name = EXCLUDED.bridge_name,
    latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, road_no = EXCLUDED.road_no,
    link_name = EXCLUDED.link_name, chainage_km = EXCLUDED.chainage_km,
    structure_type = EXCLUDED.structure_type, material = EXCLUDED.material,
    span_count = EXCLUDED.span_count, length_m = EXCLUDED.length_m, width_m = EXCLUDED.width_m,
    financier = EXCLUDED.financier, construction_year = EXCLUDED.construction_year,
    design_life_years = EXCLUDED.design_life_years,
    construction_cost_tsh_mio = EXCLUDED.construction_cost_tsh_mio,
    overall_condition = EXCLUDED.overall_condition;

SELECT * FROM v_bridge_summary;

COMMIT;
