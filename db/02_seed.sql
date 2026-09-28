-- =====================================================================
--  Lookup values + the sample rows from "List of Bridges - Format.xlsx"
--  Values are cleaned (trimmed, consistent capitalisation, typos fixed).
--  Run:  psql -d bridge_registry -f 02_seed.sql
-- =====================================================================

INSERT INTO region (code, name) VALUES
    ('12', 'MOROGORO')
ON CONFLICT DO NOTHING;

INSERT INTO road (road_no, road_name, road_class) VALUES
    ('T001', 'TANZAM HIGHWAY',                     'Trunk'),
    ('T016', 'Mikumi - Mahenge/Lupiro - Londo',    'Trunk')
ON CONFLICT DO NOTHING;

INSERT INTO structure_type (name, sort_order) VALUES
    ('Beam bridge', 10), ('T-Beam bridge', 11), ('Girder bridge', 12), ('Slab bridge', 13),
    ('Composite bridge', 14), ('Half-Through Truss bridge', 15), ('Bailey bridge', 16),
    ('Mabey bridge', 17), ('Box culvert', 30), ('Pipe culvert', 31), ('Arch culvert', 32)
ON CONFLICT DO NOTHING;

INSERT INTO material (name, sort_order) VALUES
    ('Steel', 1), ('Concrete', 2), ('Composite', 3), ('Timber', 4)
ON CONFLICT DO NOTHING;

INSERT INTO financier (name) VALUES
    ('GoT'), ('World Bank'), ('DANIDA'), ('NORWAY'), ('SDC')
ON CONFLICT DO NOTHING;

INSERT INTO condition_rating (name, sort_order) VALUES
    ('Good', 1), ('Fair', 2), ('Poor', 3)
ON CONFLICT DO NOTHING;

-- Sample bridges (rows 4-16 of the template)
INSERT INTO bridge (region_code, bridge_no, bridge_name, road_no, link_name, chainage_km,
                    structure_type, material, span_count, length_m, width_m, financier,
                    construction_year, design_life_years, construction_cost_tsh_mio, overall_condition)
VALUES
 ('12','12-0001','Ngerengere','T001','Ngerengere - Mikese', 0.000,'T-Beam bridge','Concrete',3,45.4,10.1,'World Bank',2004,100,1950.000,'Good'),
 ('12','12-0002','Maseyu I',  'T001','Ngerengere - Mikese', 2.601,'Pipe culvert','Steel',2, 2.4,23.0,'World Bank',1972, 25,   3.224,'Fair'),
 ('12','12-0701','Maseyu IA', 'T001','Ngerengere - Mikese', 5.406,'Pipe culvert','Steel',1, 3.0,24.0,'World Bank',1972, 25,   3.150,'Fair'),
 ('12','12-0003','Maseyu II', 'T001','Ngerengere - Mikese', 6.200,'Pipe culvert','Steel',1, 2.5,26.4,'World Bank',1972, 25,   2.250,'Fair'),
 ('12','12-0704','Maseyu V',  'T001','Ngerengere - Mikese',13.650,'Box culvert','Concrete',2, 3.0,15.5,'DANIDA',2004, 50,  30.000,'Good'),
 ('12','12-0027','Kibaoni',   'T001','Sangasanga - Melela',11.522,'Beam bridge','Concrete',1,10.3, 9.1,'World Bank',1972,100, 114.527,'Good'),
 ('12','12-0028','Melela I',  'T001','Melela - Doma',       2.708,'Slab bridge','Concrete',1, 4.0,10.3,'World Bank',1972,100,  14.670,'Good'),
 ('12','12-0048','Mgoda I',   'T001','Doma - Mikumi',      15.755,'Composite bridge','Steel',1,18.5,10.45,'NORWAY',1995,100, 495.000,'Good'),
 ('12','12-0151','Ruhembe I', 'T016','Mikumi - Kidatu',     0.197,'Half-Through Truss bridge','Steel',1,24.8,7.5,'GoT',1957,100,35.000,'Fair'),
 ('12','12-0154','Jeshini',   'T016','Mikumi - Kidatu',     4.766,'Arch culvert','Steel',1, 4.1, 8.0,'GoT',1957, 25,   5.166,'Fair'),
 ('12','12-0155','Ruhembe II','T016','Mikumi - Kidatu',     6.000,'Girder bridge','Steel',1,21.5, 4.29,'GoT',1957,100,  25.800,'Good'),
 ('12','12-0834','Iragua I',  'T016','Iragua - Mtimbira',   0.700,'Mabey bridge','Steel',1,24.0, 4.25,'GoT',2009,100, 135.000,'Good'),
 ('12','12-0619','Mafinji',   'T016','Iragua - Mtimbira',  10.154,'Bailey bridge','Steel',1,24.4, 3.3,'SDC',1989, 25,  45.000,'Poor')
ON CONFLICT DO NOTHING;
