-- Migration: 20261130000000_expand_official_coordinate_sources_wave2_supplement.sql
-- Purpose: TASK 2 Supplement — Allow verified Gyeongbuk (15143265) and KMTI Forest Trail (15125108)
--          official public restroom coordinate sources under facility_official + VERIFIED.

ALTER TABLE public.restrooms
  DROP CONSTRAINT IF EXISTS chk_restrooms_coordinate_source_values;

ALTER TABLE public.restrooms
  ADD CONSTRAINT chk_restrooms_coordinate_source_values
  CHECK (
    coordinate_source IS NULL
    OR coordinate_source IN (
      'gg_publtolt_15011425',
      'mois_address_nav_db',
      'mois_address_summary_db',
      'seoul_public_toilet_info',
      'seoul_metro_2026',
      'seoul_park_public_toilet',
      'incheon_district_public_toilet',
      'gyeonggi_city_public_toilet',
      'jeonbuk_public_toilet',
      'gwangju_public_toilet',
      'busan_district_public_toilet',
      'jeju_public_toilet',
      'daejeon_public_toilet',
      'ulsan_public_toilet',
      'chungbuk_public_toilet',
      'gyeongbuk_public_toilet',
      'knps_national_park_toilet',
      'kmti_forest_trail_toilet',
      'mois_bike_trail_toilet',
      'mof_beach_toilet',
      'kex_highway_rest_area_toilet',
      'kakao_geocode',
      'partner_kakao_js',
      'admin_manual',
      'public_csv_original',
      'other'
    )
  );

CREATE OR REPLACE FUNCTION public.is_restroom_coordinate_publicly_allowed(
  p_type text,
  p_coordinate_source text,
  p_coordinate_type text,
  p_coordinate_verification_status text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  select case
    when p_type = 'partner' then
      coalesce(p_coordinate_source, '') not in (
        'kakao_geocode',
        'mois_address_nav_db',
        'mois_address_summary_db'
      )
      and coalesce(p_coordinate_type, '') not in (
        'building_centroid',
        'main_entrance',
        'complex_centroid_mean',
        'geocoded'
      )
    when p_type = 'public' then
      coalesce(
        (
          -- Legacy protected Suwon 502 baseline (coordinate_type / status may be NULL)
          p_coordinate_source = 'gg_publtolt_15011425'
          and (p_coordinate_type is null or p_coordinate_type = 'facility_official')
          and (p_coordinate_verification_status is null or p_coordinate_verification_status = 'VERIFIED')
        )
        or (
          -- Approved official municipal, park, transit, beach, bike-trail, forest-trail, and rest-area datasets
          -- strictly require facility_official + VERIFIED
          p_coordinate_source in (
            'seoul_public_toilet_info',
            'seoul_metro_2026',
            'seoul_park_public_toilet',
            'incheon_district_public_toilet',
            'gyeonggi_city_public_toilet',
            'jeonbuk_public_toilet',
            'gwangju_public_toilet',
            'busan_district_public_toilet',
            'jeju_public_toilet',
            'daejeon_public_toilet',
            'ulsan_public_toilet',
            'chungbuk_public_toilet',
            'gyeongbuk_public_toilet',
            'knps_national_park_toilet',
            'kmti_forest_trail_toilet',
            'mois_bike_trail_toilet',
            'mof_beach_toilet',
            'kex_highway_rest_area_toilet',
            'admin_manual'
          )
          and p_coordinate_type = 'facility_official'
          and p_coordinate_verification_status = 'VERIFIED'
        ),
        false
      )
    else false
  end;
$function$;
