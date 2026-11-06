import React from "react";
import Header from "./Header";

interface AppShellProps {
  children: React.ReactNode;
  headerTitle?: string;
  showNavigation?: boolean;
}

export default function AppShell({
  children,
  headerTitle,
}: AppShellProps) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-white shadow-sm dark:bg-slate-900">
      <Header title={headerTitle} />
      <main className="flex flex-1 flex-col p-4">{children}</main>
    </div>
  );
}

