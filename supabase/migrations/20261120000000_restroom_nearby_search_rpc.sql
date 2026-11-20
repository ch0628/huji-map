-- ============================================================================
-- Migration: 20261120000000_restroom_nearby_search_rpc.sql
-- Description: Server-side center + 400m radius distance-sorted restroom search RPC
-- Notes:
--   - Uses existing idx_restrooms_coords B-tree index on (latitude, longitude)
--   - No PostGIS required; no RLS policy modifications
--   - Enforces publication_status='published', approved partner business,
--     and partner_restroom_discovery feature flag BEFORE distance sort & LIMIT
-- ============================================================================

create or replace function public.list_nearby_public_restrooms(
  p_center_lat double precision,
  p_center_lng double precision,
  p_radius_m integer default 400,
  p_type text default 'all',
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  id uuid,
  type text,
  name text,
  road_address text,
  address_detail text,
  latitude double precision,
  longitude double precision,
  access_method text,
  gender_type text,
  wheelchair_accessible boolean,
  baby_changing_available boolean,
  sanitary_products_available boolean,
  last_verified_at timestamptz,
  business_id uuid,
  distance_meters double precision,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_radius_m double precision;
  v_limit integer;
  v_offset integer;
  v_lat_delta double precision;
  v_lng_delta double precision;
  v_south double precision;
  v_north double precision;
  v_west double precision;
  v_east double precision;
  v_partner_enabled boolean := false;
begin
  if p_center_lat is null
     or p_center_lng is null
     or p_center_lat = 'NaN'::double precision
     or p_center_lng = 'NaN'::double precision
     or not (p_center_lat >= -90.0 and p_center_lat <= 90.0)
     or not (p_center_lng >= -180.0 and p_center_lng <= 180.0) then
    raise exception 'Invalid center coordinates' using errcode = '22023';
  end if;

  if p_type is null or p_type not in ('all', 'public', 'partner') then
    raise exception 'Invalid restroom type filter' using errcode = '22023';
  end if;

  if p_radius_m is null or p_radius_m < 1 or p_radius_m > 400 then
    raise exception 'Invalid radius_m (must be between 1 and 400)' using errcode = '22023';
  end if;

  v_radius_m := p_radius_m::double precision;
  v_limit := greatest(1, least(coalesce(p_limit, 100), 100));
  v_offset := greatest(0, coalesce(p_offset, 0));

  if p_type in ('all', 'partner') then
    select coalesce(
      (
        select f.enabled
        from public.feature_flags f
        where f.key = 'partner_restroom_discovery'
        limit 1
      ),
      false
    )
    into v_partner_enabled;
  end if;

  if p_type = 'partner' and not v_partner_enabled then
    return;
  end if;

  -- Bounding box pre-filter enclosing the radius (+5m buffer for floating-point safety)
  -- Leverages idx_restrooms_coords on (latitude, longitude)
  v_lat_delta := (v_radius_m + 5.0) / 111194.9266;
  v_lng_delta := (v_radius_m + 5.0) / (
    111194.9266 * greatest(0.01::double precision, cos(radians(p_center_lat)))
  );

  v_south := greatest(-90.0::double precision, p_center_lat - v_lat_delta);
  v_north := least(90.0::double precision, p_center_lat + v_lat_delta);
  v_west := greatest(-180.0::double precision, p_center_lng - v_lng_delta);
  v_east := least(180.0::double precision, p_center_lng + v_lng_delta);

  return query
  with bbox_candidates as (
    select
      r.id,
      r.type,
      r.name,
      r.road_address,
      r.address_detail,
      r.latitude,
      r.longitude,
      r.access_method,
      r.gender_type,
      r.wheelchair_accessible,
      r.baby_changing_available,
      r.sanitary_products_available,
      r.last_verified_at,
      r.business_id,
      (
        6371000.0 * 2.0 * asin(
          least(
            1.0::double precision,
            sqrt(
              power(sin(radians(r.latitude - p_center_lat) / 2.0), 2)
              + cos(radians(p_center_lat)) * cos(radians(r.latitude))
                * power(sin(radians(r.longitude - p_center_lng) / 2.0), 2)
            )
          )
        )
      ) as calc_distance_m
    from public.restrooms r
    where r.publication_status = 'published'
      and r.latitude is not null
      and r.longitude is not null
      and r.latitude >= v_south
      and r.latitude <= v_north
      and r.longitude >= v_west
      and r.longitude <= v_east
      and (
        (p_type in ('all', 'public') and r.type = 'public')
        or (
          v_partner_enabled
          and p_type in ('all', 'partner')
          and r.type = 'partner'
          and r.business_id is not null
          and public.is_partner_business_approved(r.business_id)
        )
      )
  ),
  eligible as (
    select
      c.*,
      count(*) over() as matched_total
    from bbox_candidates c
    where c.calc_distance_m <= v_radius_m
  )
  select
    e.id,
    e.type,
    e.name,
    e.road_address,
    e.address_detail,
    e.latitude,
    e.longitude,
    e.access_method,
    e.gender_type,
    e.wheelchair_accessible,
    e.baby_changing_available,
    e.sanitary_products_available,
    e.last_verified_at,
    e.business_id,
    e.calc_distance_m as distance_meters,
    e.matched_total as total_count
  from eligible e
  order by e.calc_distance_m asc, e.id asc
  limit v_limit
  offset v_offset;
end;
$$;

revoke all on function public.list_nearby_public_restrooms(
  double precision,
  double precision,
  integer,
  text,
  integer,
  integer
) from public;

grant execute on function public.list_nearby_public_restrooms(
  double precision,
  double precision,
  integer,
  text,
  integer,
  integer
) to anon, authenticated, service_role;
