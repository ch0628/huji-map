import { redirect } from "next/navigation";

export default function PrivacySettingsRedirectPage() {
  redirect("/map?analyticsSettings=1");
}
