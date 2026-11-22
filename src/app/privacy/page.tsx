import { redirect } from "next/navigation";

export default function PrivacyRedirectPage() {
  redirect("/map?analyticsDetails=1");
}
