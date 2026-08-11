import SideNavigation from '@cloudscape-design/components/side-navigation';
import { useT } from '@/lib/i18n';
import { ADMIN_SECTIONS, followRoute, hrefAdmin, hrefHome, type AdminSection } from '@/lib/router';

/**
 * The left panel while the management screens are open.
 *
 * It takes the same slot the page tree takes when a space is open:
 * the shell has one navigation panel, and what goes in it follows the route.
 * The header link leads back out to the Wiki, which is the only way out of the
 * management area that does not go through the browser's back button.
 */
export function AdminNavigation({ section }: { section: AdminSection }) {
  const t = useT();
  return (
    <SideNavigation
      header={{ text: t.app.admin, href: hrefAdmin(ADMIN_SECTIONS[0]) }}
      activeHref={hrefAdmin(section)}
      onFollow={followRoute}
      items={[
        ...ADMIN_SECTIONS.map((item) => ({
          type: 'link' as const,
          text: t.admin.sections[item],
          href: hrefAdmin(item),
        })),
        { type: 'divider' as const },
        { type: 'link' as const, text: t.app.backToSpaces, href: hrefHome() },
      ]}
    />
  );
}
