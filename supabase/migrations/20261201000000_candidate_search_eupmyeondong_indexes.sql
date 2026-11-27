-- TASK 3: Composite partial index for eupmyeondong_name-prioritized unlocated candidate lookup & keyset pagination
CREATE INDEX IF NOT EXISTS idx_prc_sigungu_emd_name_unlocated
  ON public.public_restroom_candidates (sigungu_code, eupmyeondong_name, id)
  WHERE coordinate_status = 'unlocated';

ANALYZE public.public_restroom_candidates;
