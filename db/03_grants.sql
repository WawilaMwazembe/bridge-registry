-- =====================================================================
--  Least-privilege login used by the API server.
--  First, as a superuser:   CREATE ROLE bridge_api LOGIN PASSWORD 'choose-a-strong-one';
--  Then:                    psql -d bridge_registry -f 03_grants.sql
-- =====================================================================
GRANT USAGE ON SCHEMA public TO bridge_api;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO bridge_api;
GRANT INSERT, UPDATE         ON bridge         TO bridge_api;
GRANT INSERT                 ON bridge_history TO bridge_api;
GRANT INSERT, DELETE         ON api_token      TO bridge_api;
GRANT USAGE ON SEQUENCE sync_seq, bridge_history_history_id_seq TO bridge_api;

-- Admin screen in the app: manage lookups and user accounts
GRANT INSERT, UPDATE, DELETE ON region, road, structure_type, material, financier, condition_rating TO bridge_api;
GRANT INSERT, UPDATE         ON app_user TO bridge_api;
GRANT USAGE ON SEQUENCE app_user_id_seq TO bridge_api;
