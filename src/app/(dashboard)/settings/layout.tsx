import { SettingsSubNav } from "./settings-subnav";

/**
 * /settings layout — Profile + Users sub-nav (UX5 / #79).
 *
 * The sub-nav is a tablist; `id="settings-panel"` on the content region
 * ties aria-controls from each tab to a single landmark (matching the
 * setup-subnav pattern).
 */
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your profile and organization members.
        </p>
      </div>
      <SettingsSubNav />
      <div id="settings-panel" role="tabpanel">
        {children}
      </div>
    </div>
  );
}
