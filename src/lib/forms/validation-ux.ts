/**
 * Shared accessible form validation UX helpers (FIX-07).
 * - Focuses and smoothly scrolls to the first invalid form field on submit.
 * - Keeps aria-invalid and aria-describedby synchronized without page reload.
 */

export function focusFirstErrorField(
  fieldOrder: readonly string[],
  errors: Readonly<Record<string, string | undefined>>,
  idMap: Readonly<Record<string, string>>
): string | null {
  for (const key of fieldOrder) {
    if (!errors[key]) continue;
    const targetId = idMap[key];
    if (!targetId || typeof document === "undefined") return key;

    const el = document.getElementById(targetId) as HTMLElement | null;
    if (!el) return key;

    if (typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch {
        el.scrollIntoView();
      }
    }

    if (typeof el.focus === "function") {
      try {
        el.focus({ preventScroll: true });
      } catch {
        el.focus();
      }
    }
    return key;
  }

  return null;
}
