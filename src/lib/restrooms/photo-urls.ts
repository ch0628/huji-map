import { createAdminClient, isServiceRoleConfigured } from "@/lib/supabase/server";
import { RESTROOM_PHOTO_BUCKET } from "./photo-validation";

/**
 * Generates short-lived signed read URLs for private restroom photos.
 * Safely returns an empty map when service_role or Storage is unavailable (e.g., mocked tests).
 */
export async function createSignedPhotoReadUrlMap(
  storagePaths: readonly (string | null | undefined)[],
  expiresInSeconds = 3600
): Promise<Map<string, string>> {
  const urlMap = new Map<string, string>();
  const uniquePaths = Array.from(
    new Set(
      storagePaths.filter(
        (p): p is string => typeof p === "string" && p.trim().length > 0
      )
    )
  );

  if (uniquePaths.length === 0 || !isServiceRoleConfigured()) {
    return urlMap;
  }

  try {
    const adminClient = createAdminClient();
    const storageApi = adminClient.storage?.from(RESTROOM_PHOTO_BUCKET) as any;
    if (!storageApi) return urlMap;

    if (typeof storageApi.createSignedUrls === "function") {
      const { data, error } = await storageApi.createSignedUrls(
        uniquePaths,
        expiresInSeconds
      );
      if (!error && Array.isArray(data)) {
        for (const item of data) {
          if (item?.path && item?.signedUrl && !item.error) {
            urlMap.set(item.path, item.signedUrl);
          }
        }
      }
      return urlMap;
    }

    if (typeof storageApi.createSignedUrl === "function") {
      await Promise.all(
        uniquePaths.map(async (p) => {
          const { data, error } = await storageApi.createSignedUrl(
            p,
            expiresInSeconds
          );
          if (!error && data?.signedUrl) {
            urlMap.set(p, data.signedUrl);
          }
        })
      );
    }
  } catch {
    // Non-fatal fallback: callers safely fall back to null image_url
  }

  return urlMap;
}
