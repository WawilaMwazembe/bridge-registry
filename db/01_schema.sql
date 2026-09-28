-- =====================================================================
--  Bridge Register - PostgreSQL schema
--  Mirrors the "List of Bridges - Format.xlsx" template and adds what is
--  needed for offline tablet capture + sync (UUID keys, version numbers,
--  a global change sequence, soft deletes and a full audit trail).
--
--  Run:  psql -d bridge_registry -f 01_schema.sql
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), crypt()

-- ---------------------------------------------------------------------
--  Reference (lookup) tables - maintained by administrators, sent to
--  tablets on every sync so dropdowns work offline.
-- ---------------------------------------------------------------------
CREATE TABLE region (
    code        text PRIMARY KEY CHECK (code ~ '^\d{2}$'),   -- prefix of the bridge no., e.g. 12 = MOROGORO
    name        text NOT NULL UNIQUE
);

CREATE TABLE road (
    road_no     text PRIMARY KEY,                             -- e.g. T001
    road_name   text NOT NULL,
    road_class  text NOT NULL CHECK (road_class IN ('Trunk', 'Regional'))
);

-- Text primary keys keep values human readable in the bridge table and on
-- the tablet; ON UPDATE CASCADE lets an admin fix spelling in one place.
CREATE TABLE structure_type   (name text PRIMARY KEY, sort_order int NOT NULL DEFAULT 100);
CREATE TABLE material         (name text PRIMARY KEY, sort_order int NOT NULL DEFAULT 100);
CREATE TABLE financier        (name text PRIMARY KEY, sort_order int NOT NULL DEFAULT 100);
CREATE TABLE condition_rating (name text PRIMARY KEY, sort_order int NOT NULL DEFAULT 100);

-- ---------------------------------------------------------------------
--  Users and device tokens
-- ---------------------------------------------------------------------
CREATE TABLE app_user (
    id            serial PRIMARY KEY,
    username      text NOT NULL UNIQUE,
    full_name     text NOT NULL,
    password_hash text NOT NULL,                              -- bcrypt via pgcrypto crypt()
    role          text NOT NULL CHECK (role IN ('viewer', 'inspector', 'admin')),
    region_code   text REFERENCES region (code),              -- NULL = all regions
    active        boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_token (
    token_hash    text PRIMARY KEY,                           -- sha256 of the bearer token
    user_id       int NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    device_label  text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION create_user(p_username text, p_full_name text, p_password text,
                                       p_role text, p_region text DEFAULT NULL)
RETURNS int LANGUAGE sql AS $$
    INSERT INTO app_user (username, full_name, password_hash, role, region_code)
    VALUES (lower(p_username), p_full_name, crypt(p_password, gen_salt('bf', 10)), p_role, p_region)
    RETURNING id;
$$;

CREATE OR REPLACE FUNCTION set_password(p_username text, p_password text)
RETURNS void LANGUAGE sql AS $$
    UPDATE app_user SET password_hash = crypt(p_password, gen_salt('bf', 10))
    WHERE username = lower(p_username);
$$;

-- ---------------------------------------------------------------------
--  Bridges (one row per bridge / culvert in the template)
-- ---------------------------------------------------------------------
CREATE SEQUENCE sync_seq;   -- global change counter; tablets pull "everything after N"

CREATE TABLE bridge (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- generated on the tablet for offline inserts

    -- Template columns ------------------------------------------------
    region_code               text NOT NULL REFERENCES region (code),
    bridge_no                 text NOT NULL,                                -- BRIDGE NO.  e.g. 12-0001
    bridge_name               text NOT NULL,                                -- BRIDGE NAME
    latitude                  numeric(9,6) CHECK (latitude  BETWEEN -12.5 AND -0.5),  -- Tanzania bounds
    longitude                 numeric(9,6) CHECK (longitude BETWEEN  29.0 AND 41.0),
    road_no                   text NOT NULL REFERENCES road (road_no) ON UPDATE CASCADE,  -- ROAD NO. (+ ROAD NAME via road)
    link_name                 text,                                         -- LINK NAME
    chainage_km               numeric(9,3) CHECK (chainage_km >= 0),        -- CHAINAGE FROM START OF LINK
    structure_type            text REFERENCES structure_type (name) ON UPDATE CASCADE,
    material                  text REFERENCES material (name) ON UPDATE CASCADE,
    span_count                smallint CHECK (span_count > 0),              -- BRIDGE SPAN NO.
    length_m                  numeric(8,2) CHECK (length_m > 0),            -- BRIDGE LENGTH (M)
    width_m                   numeric(6,2) CHECK (width_m > 0),             -- WIDTH (M)
    financier                 text REFERENCES financier (name) ON UPDATE CASCADE,
    construction_year         smallint CHECK (construction_year BETWEEN 1850 AND 2100),  -- DATE OF CONSTRUCTION
    design_life_years         smallint CHECK (design_life_years > 0),
    construction_cost_tsh_mio numeric(14,3) CHECK (construction_cost_tsh_mio >= 0),
    overall_condition         text REFERENCES condition_rating (name) ON UPDATE CASCADE,

    -- Template legend + checking workflow -----------------------------
    record_status             text NOT NULL DEFAULT 'Active'
                              CHECK (record_status IN ('Active', 'New', 'Closed/Demolished', 'Duplicate')),
    remarks                   text,
    last_inspected_on         date,
    verified_by               int REFERENCES app_user (id),
    verified_at               timestamptz,

    -- Sync / audit metadata (set by trigger - clients never write these) -
    version                   int NOT NULL DEFAULT 1,
    server_seq                bigint NOT NULL,
    is_deleted                boolean NOT NULL DEFAULT false,
    created_at                timestamptz NOT NULL DEFAULT now(),
    created_by                int REFERENCES app_user (id),
    updated_at                timestamptz NOT NULL DEFAULT now(),
    updated_by                int REFERENCES app_user (id),
    updated_on_device         text
);

-- A bridge number may exist only once among live records.
CREATE UNIQUE INDEX bridge_no_uq ON bridge (bridge_no)
    WHERE NOT is_deleted AND record_status <> 'Duplicate';
CREATE INDEX bridge_server_seq_ix ON bridge (server_seq);
CREATE INDEX bridge_road_ix       ON bridge (road_no, link_name, chainage_km);
CREATE INDEX bridge_region_ix     ON bridge (region_code);

-- Every change is kept, so any edit from any tablet can be traced/rolled back.
CREATE TABLE bridge_history (
    history_id  bigserial PRIMARY KEY,
    bridge_id   uuid NOT NULL,
    version     int NOT NULL,
    operation   text NOT NULL,
    changed_at  timestamptz NOT NULL DEFAULT now(),
    changed_by  int,
    row_data    jsonb NOT NULL
);
CREATE INDEX bridge_history_bridge_ix ON bridge_history (bridge_id, version);

-- ---------------------------------------------------------------------
--  Triggers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bridge_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    meta_cols constant text[] := ARRAY['version','server_seq','created_at','created_by','updated_at',
                                       'updated_by','updated_on_device','verified_by','verified_at'];
BEGIN
    -- Serialise writers so server_seq order == commit order. Without this a
    -- tablet could pull seq 11 before seq 10 commits and miss row 10 forever.
    PERFORM pg_advisory_xact_lock(hashtext('bridge_sync'));

    NEW.server_seq := nextval('sync_seq');
    NEW.updated_at := now();
    NEW.updated_by := nullif(current_setting('app.user_id', true), '')::int;

    IF TG_OP = 'INSERT' THEN
        NEW.version    := 1;
        NEW.created_at := now();
        NEW.created_by := NEW.updated_by;
    ELSE
        NEW.version    := OLD.version + 1;
        NEW.created_at := OLD.created_at;
        NEW.created_by := OLD.created_by;
        -- Any data change after verification sends the bridge back for checking.
        IF NEW.verified_at IS NOT DISTINCT FROM OLD.verified_at
           AND (to_jsonb(NEW) - meta_cols) <> (to_jsonb(OLD) - meta_cols) THEN
            NEW.verified_by := NULL;
            NEW.verified_at := NULL;
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER bridge_before_write
    BEFORE INSERT OR UPDATE ON bridge
    FOR EACH ROW EXECUTE FUNCTION bridge_before_write();

CREATE OR REPLACE FUNCTION bridge_after_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO bridge_history (bridge_id, version, operation, changed_by, row_data)
    VALUES (NEW.id, NEW.version, TG_OP, NEW.updated_by, to_jsonb(NEW));
    RETURN NULL;
END $$;

CREATE TRIGGER bridge_after_write
    AFTER INSERT OR UPDATE ON bridge
    FOR EACH ROW EXECUTE FUNCTION bridge_after_write();

-- Hard deletes would never reach the tablets; force soft deletes instead.
CREATE OR REPLACE FUNCTION bridge_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Do not DELETE bridges - set is_deleted = true (or record_status) so the change syncs to tablets';
END $$;

CREATE TRIGGER bridge_no_delete
    BEFORE DELETE ON bridge
    FOR EACH ROW EXECUTE FUNCTION bridge_no_delete();

-- ---------------------------------------------------------------------
--  Reporting views
-- ---------------------------------------------------------------------
-- The bridge list in the same column order as the Excel template.
-- Closed/demolished and duplicate bridges are omitted, as per the legend.
CREATE OR REPLACE VIEW v_bridge_list AS
SELECT rg.name                      AS "REGION",
       b.bridge_no                  AS "BRIDGE NO.",
       b.bridge_name                AS "BRIDGE NAME",
       b.latitude                   AS "LATITUDE",
       b.longitude                  AS "LONGITUDE",
       b.road_no                    AS "ROAD NO.",
       r.road_name                  AS "ROAD NAME",
       b.link_name                  AS "LINK NAME",
       b.chainage_km                AS "CHAINAGE FROM START OF LINK",
       b.structure_type             AS "STRUCTURE TYPE",
       b.material                   AS "MATERIAL",
       b.span_count                 AS "BRIDGE SPAN NO.",
       b.length_m                   AS "BRIDGE LENGTH (M)",
       b.width_m                    AS "WIDTH (M)",
       b.financier                  AS "FINANCIER",
       b.construction_year          AS "DATE OF CONSTRUCTION",
       b.design_life_years          AS "DESIGN LIFE (YEARS)",
       b.construction_cost_tsh_mio  AS "CONSTRUCTION COST (TSHS. MIO)",
       b.overall_condition          AS "OVERALL CONDITION",
       b.record_status              AS "RECORD STATUS",
       b.verified_at IS NOT NULL    AS "VERIFIED"
FROM bridge b
JOIN region rg ON rg.code = b.region_code
JOIN road   r  ON r.road_no = b.road_no
WHERE NOT b.is_deleted
  AND b.record_status IN ('Active', 'New')
ORDER BY rg.name, b.road_no, b.link_name, b.chainage_km;

-- Equivalent of the TRUNK / REGIONAL / TOTAL box under the template legend.
CREATE OR REPLACE VIEW v_bridge_summary AS
SELECT rg.name AS region,
       count(*) FILTER (WHERE r.road_class = 'Trunk')    AS trunk_road,
       count(*) FILTER (WHERE r.road_class = 'Regional') AS regional_road,
       count(*)                                          AS total,
       count(*) FILTER (WHERE b.verified_at IS NOT NULL) AS verified
FROM bridge b
JOIN region rg ON rg.code = b.region_code
JOIN road   r  ON r.road_no = b.road_no
WHERE NOT b.is_deleted
  AND b.record_status IN ('Active', 'New')
GROUP BY rg.name
ORDER BY rg.name;
