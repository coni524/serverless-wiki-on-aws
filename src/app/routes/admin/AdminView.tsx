import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import { useT } from '@/lib/i18n';
import { ErrorText } from '@/components/ui';
import type { Me } from '@/types/api';
import { followRoute, hrefAdmin, hrefHome, type AdminSection } from '@/lib/router';
import { AdminDefaults } from '@/app/routes/admin/Defaults';
import { RoleGroupDetail, RoleGroupList } from '@/app/routes/admin/RoleGroups';
import { UserGroupDetail, UserGroupList } from '@/app/routes/admin/UserGroups';
import { AdminUsers } from '@/app/routes/admin/Users';

/**
 * The management screens.
 *
 * Everything reachable from here needs global administrator, which the server
 * checks on every one of these calls. The check below is not the gate — it is
 * what keeps a non-administrator from being shown a screen made of failed
 * requests. The first administrator is seeded into DynamoDB by an operator; no
 * screen here can raise anyone's own permissions.
 *
 * The section navigation is the shell's left panel, so this component owns only
 * the heading, the breadcrumb, and the routed screen. The section names live in
 * the dictionary, keyed by the route's own segment, so the panel and the
 * breadcrumb read the same words from one place.
 */
export function AdminView({
  me,
  section,
  id,
}: {
  me: Me;
  section: AdminSection;
  id: string | null;
}) {
  const t = useT();

  if (!me.isGlobalAdmin) {
    return (
      <ContentLayout header={<Header variant="h1">{t.app.admin}</Header>}>
        <Container>
          <ErrorText>{t.admin.notGlobalAdmin}</ErrorText>
        </Container>
      </ContentLayout>
    );
  }

  const title = t.admin.sections[section];

  return (
    <ContentLayout
      breadcrumbs={
        <BreadcrumbGroup
          ariaLabel={t.admin.breadcrumbsLabel}
          items={[
            { text: t.admin.spacesCrumb, href: hrefHome() },
            { text: t.app.admin, href: hrefAdmin('users') },
            { text: title, href: hrefAdmin(section) },
          ]}
          onFollow={followRoute}
        />
      }
      // The screens below carry their own `Header`, one per table, so the layout
      // header would only repeat the breadcrumb's last crumb.
      disableOverlap
    >
      <Section section={section} id={id} />
    </ContentLayout>
  );
}

function Section({ section, id }: { section: AdminSection; id: string | null }) {
  switch (section) {
    case 'users':
      return <AdminUsers />;
    case 'user-groups':
      return id === null ? <UserGroupList /> : <UserGroupDetail key={id} userGroupId={id} />;
    case 'role-groups':
      return id === null ? <RoleGroupList /> : <RoleGroupDetail key={id} roleGroupId={id} />;
    case 'defaults':
      return <AdminDefaults />;
  }
}
