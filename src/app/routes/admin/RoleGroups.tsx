import { useState } from 'react';
import { api } from 'aws-blocks';
import { useQuery } from '@tanstack/react-query';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Link from '@cloudscape-design/components/link';
import Modal from '@cloudscape-design/components/modal';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import { useT, type Messages } from '@/lib/i18n';
import { ErrorText, Loading } from '@/components/ui';
import { errMessage } from '@/utils/errors';
import type { AdminSpace, GrantLevel, Group } from '@/types/api';
import {
  adminSpacesQuery,
  attachedUserGroupsQuery,
  grantsQuery,
  noteGrantsChanged,
  noteGroupsChanged,
  refreshAdmin,
  roleGroupMembersQuery,
  roleGroupsQuery,
  userGroupsQuery,
} from '@/features/admin/api/admin-cache';
import { useAuthProviders } from '@/features/auth/api/providers';
import { followRoute, hrefAdmin, hrefAdminRoleGroup, hrefAdminUserGroup, navigate } from '@/lib/router';
import { ActionError, ConfirmModal, CreateGroupModal, GroupBadges, useAction } from '@/features/admin/components/parts';

/**
 * Role groups — the hop that actually holds permission.
 *
 * A role group names a set of spaces and the level held on each. People never
 * appear here: they arrive through the user groups attached to it, which is why
 * this screen shows those attachments read-only and points at the other screen
 * to change them. One edge, edited in one place.
 */

/**
 * The three levels, in order, as the picker offers them. The level itself is
 * the label — `read`, `write` and `admin` are the API's own words and are not
 * translated — and only the description under it comes from the dictionary.
 */
const LEVELS: GrantLevel[] = ['read', 'write', 'admin'];

type PermissionOption = { value: GrantLevel; label: string; description: string };

const permissionOptions = (t: Messages): PermissionOption[] =>
  LEVELS.map((value) => ({ value, label: value, description: t.admin.roleGroups.level(value) }));

const optionFor = (options: PermissionOption[], permission: GrantLevel) =>
  options.find((option) => option.value === permission) ?? options[0];

export function RoleGroupList() {
  const t = useT();
  const { data, error, isPending, isFetching, refetch } = useQuery(roleGroupsQuery());
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Group | null>(null);
  const action = useAction();

  return (
    <SpaceBetween size="m">
      <ActionError action={action} />
      {error !== null && <ErrorText>{errMessage(error)}</ErrorText>}

      <Table
        variant="container"
        header={
          <Header
            variant="h2"
            counter={data === undefined ? undefined : `(${data.length})`}
            description={t.admin.roleGroups.listDescription}
            actions={
              <SpaceBetween size="xs" direction="horizontal">
                <Button
                  iconName="refresh"
                  ariaLabel={t.admin.shared.reload}
                  loading={isFetching}
                  onClick={() => void refetch()}
                />
                <Button variant="primary" onClick={() => setCreating(true)}>
                  {t.common.create}
                </Button>
              </SpaceBetween>
            }
          >
            {t.admin.sections['role-groups']}
          </Header>
        }
        items={data ?? []}
        trackBy={(group) => group.id}
        loading={isPending}
        loadingText={t.admin.roleGroups.loading}
        columnDefinitions={[
          {
            id: 'name',
            header: t.admin.shared.name,
            isRowHeader: true,
            cell: (group) => (
              <SpaceBetween size="xs" direction="horizontal">
                <Link href={hrefAdminRoleGroup(group.id)} onFollow={followRoute}>
                  {group.name}
                </Link>
                <GroupBadges group={group} />
              </SpaceBetween>
            ),
          },
          {
            id: 'description',
            header: t.admin.shared.description,
            cell: (group) => group.description,
          },
          {
            id: 'actions',
            header: '',
            width: 130,
            cell: (group) => (
              <Button
                variant="inline-link"
                disabled={group.system}
                onClick={() => setDeleting(group)}
              >
                {t.common.delete}
              </Button>
            ),
          },
        ]}
        empty={
          <Box textAlign="center" color="text-status-inactive" padding={{ vertical: 'l' }}>
            {t.admin.roleGroups.empty}
          </Box>
        }
      />

      {creating && (
        <CreateGroupModal
          header={t.admin.roleGroups.createHeader}
          nameLabel={t.admin.roleGroups.nameLabel}
          onCreate={async (input) => {
            const { roleGroupId } = await api.createRoleGroup(input);
            noteGroupsChanged();
            navigate(hrefAdminRoleGroup(roleGroupId));
          }}
          onDismiss={() => setCreating(false)}
        />
      )}

      {deleting !== null && (
        <ConfirmModal
          header={t.admin.shared.deleteHeader(deleting.name)}
          action={action}
          onConfirm={() =>
            action.run(() => api.deleteRoleGroup(deleting.id), () => {
              setDeleting(null);
              noteGroupsChanged();
            })
          }
          onDismiss={() => setDeleting(null)}
        >
          <Box>{t.admin.roleGroups.deleteBody}</Box>
        </ConfirmModal>
      )}
    </SpaceBetween>
  );
}

/** One role group: the spaces it grants, and the user groups it reaches. */
export function RoleGroupDetail({ roleGroupId }: { roleGroupId: string }) {
  const t = useT();
  // Five entries, four of them shared with the other management screens: the
  // two group listings, every space, and the attachment edge this screen shows
  // from the role group's side. Changing a grant refetches the grants alone.
  const roleGroups = useQuery(roleGroupsQuery());
  const grants = useQuery(grantsQuery(roleGroupId));
  const spaces = useQuery(adminSpacesQuery());
  const attachedTo = useQuery(attachedUserGroupsQuery(roleGroupId));
  const userGroups = useQuery(userGroupsQuery());
  const directMembers = useQuery(roleGroupMembersQuery(roleGroupId));

  const action = useAction();
  const [granting, setGranting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const error =
    roleGroups.error ??
    grants.error ??
    spaces.error ??
    attachedTo.error ??
    userGroups.error ??
    directMembers.error;
  if (error !== null) return <ErrorText>{errMessage(error)}</ErrorText>;

  const roleGroupList = roleGroups.data;
  const grantList = grants.data;
  const spaceList = spaces.data;
  const attachedList = attachedTo.data;
  const userGroupList = userGroups.data;
  const directMemberList = directMembers.data;
  if (
    roleGroupList === undefined ||
    grantList === undefined ||
    spaceList === undefined ||
    attachedList === undefined ||
    userGroupList === undefined ||
    directMemberList === undefined
  ) {
    return <Loading label={t.admin.roleGroups.loading} />;
  }

  const group = roleGroupList.find((item) => item.id === roleGroupId) ?? null;
  if (group === null) return <ErrorText>{t.admin.roleGroups.notFound}</ErrorText>;

  const rows = grantList.map((grant) => ({
    ...grant,
    space: spaceList.find((item) => item.spaceId === grant.spaceId) ?? null,
  }));
  // Built once so the picker's selected option is the very object the dropdown
  // holds, rather than an equal one built a second time per row.
  const levels = permissionOptions(t);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={group.description}
        actions={
          <SpaceBetween size="xs" direction="horizontal">
            <Button
              iconName="refresh"
              ariaLabel={t.admin.shared.reload}
              onClick={refreshAdmin}
            />
            <Button disabled={group.system} onClick={() => setDeleting(true)}>
              {t.common.delete}
            </Button>
          </SpaceBetween>
        }
      >
        <SpaceBetween size="xs" direction="horizontal">
          <span>{group.name}</span>
          <GroupBadges group={group} />
        </SpaceBetween>
      </Header>

      <ActionError action={action} />

      {group.global && (
        <Box color="text-body-secondary">{t.admin.roleGroups.globalNote}</Box>
      )}

      <Table
        variant="container"
        header={
          <Header
            variant="h2"
            counter={`(${rows.length})`}
            description={t.admin.roleGroups.grantsDescription}
            actions={
              <Button variant="primary" onClick={() => setGranting(true)}>
                {t.admin.roleGroups.addSpace}
              </Button>
            }
          >
            {t.admin.roleGroups.grantsHeader}
          </Header>
        }
        items={rows}
        trackBy={(row) => row.spaceId}
        columnDefinitions={[
          {
            id: 'space',
            header: t.admin.roleGroups.space,
            isRowHeader: true,
            cell: (row) => row.space?.name ?? row.spaceId,
          },
          {
            id: 'permission',
            header: t.admin.roleGroups.permission,
            width: 240,
            cell: (row) => (
              <Select
                selectedOption={optionFor(levels, row.permission)}
                options={levels}
                disabled={action.busy}
                expandToViewport
                ariaLabel={t.admin.roleGroups.permissionFor(row.space?.name ?? row.spaceId)}
                onChange={(e) => {
                  const next = e.detail.selectedOption.value as GrantLevel;
                  if (next === row.permission) return;
                  // Re-granting the same pair overwrites the level, so changing
                  // the picker is the whole edit — there is no separate update.
                  action.run(() => api.grantSpaceToRoleGroup(row.spaceId, roleGroupId, next), () =>
                    noteGrantsChanged(roleGroupId),
                  );
                }}
              />
            ),
          },
          {
            id: 'actions',
            header: '',
            width: 130,
            cell: (row) => (
              <Button
                variant="inline-link"
                disabled={action.busy}
                onClick={() =>
                  action.run(() => api.revokeSpaceFromRoleGroup(row.spaceId, roleGroupId), () =>
                    noteGrantsChanged(roleGroupId),
                  )
                }
              >
                {t.admin.roleGroups.revoke}
              </Button>
            ),
          },
        ]}
        empty={
          <Box textAlign="center" color="text-status-inactive" padding={{ vertical: 'l' }}>
            {t.admin.roleGroups.grantsEmpty}
          </Box>
        }
      />

      <IdpGroupMapping group={group} />

      <Table
        variant="container"
        header={
          <Header
            variant="h2"
            counter={`(${directMemberList.length})`}
            description={t.admin.roleGroups.membersDescription}
          >
            {t.admin.roleGroups.membersHeader}
          </Header>
        }
        items={directMemberList}
        trackBy={(row) => row.userId}
        columnDefinitions={[
          {
            id: 'email',
            header: t.admin.shared.email,
            isRowHeader: true,
            cell: (row) => row.email,
          },
          {
            id: 'userId',
            header: t.admin.users.userId,
            cell: (row) => (
              <Box fontSize="body-s" color="text-body-secondary">
                {row.userId}
              </Box>
            ),
          },
        ]}
        empty={
          <Box textAlign="center" color="text-status-inactive" padding={{ vertical: 'l' }}>
            {t.admin.roleGroups.membersEmpty}
          </Box>
        }
      />

      <Table
        variant="container"
        header={
          <Header
            variant="h2"
            counter={`(${attachedList.length})`}
            description={t.admin.roleGroups.attachedDescription}
          >
            {t.admin.roleGroups.attachedHeader}
          </Header>
        }
        items={attachedList}
        trackBy={(row) => row.userGroupId}
        columnDefinitions={[
          {
            id: 'name',
            header: t.admin.shared.name,
            isRowHeader: true,
            cell: (row) => (
              <Link href={hrefAdminUserGroup(row.userGroupId)} onFollow={followRoute}>
                {userGroupList.find((item) => item.id === row.userGroupId)?.name ?? row.userGroupId}
              </Link>
            ),
          },
        ]}
        empty={
          <Box textAlign="center" color="text-status-inactive" padding={{ vertical: 'l' }}>
            {t.admin.roleGroups.attachedEmpty}
          </Box>
        }
      />

      {granting && (
        <GrantSpace
          roleGroupId={roleGroupId}
          spaces={spaceList.filter(
            (space) => !grantList.some((grant) => grant.spaceId === space.spaceId),
          )}
          onDismiss={() => setGranting(false)}
        />
      )}

      {deleting && (
        <ConfirmModal
          header={t.admin.shared.deleteHeader(group.name)}
          action={action}
          onConfirm={() =>
            action.run(() => api.deleteRoleGroup(roleGroupId), () => {
              noteGroupsChanged();
              navigate(hrefAdmin('role-groups'));
            })
          }
          onDismiss={() => setDeleting(false)}
        >
          <Box>
            {t.admin.roleGroups.deleteDetailBody(grantList.length, attachedList.length)}
          </Box>
        </ConfirmModal>
      )}
    </SpaceBetween>
  );
}

/**
 * Which external IdP groups reach this role group.
 *
 * The whole mapping between the identity providers' groups and what people may
 * do here is this list, repeated across role groups. It is edited beside the
 * permissions it hands out, rather than on a settings screen of its own, so
 * that the answer to "who gets this" sits next to "what this is". Each row
 * names its provider: two IdPs may both know a group by one name, and only the
 * named one is trusted for it.
 *
 * The global administrator role group is refused by the server, and the field
 * is not offered for it here either — the refusal and the absence say the same
 * thing, and being told after typing would be worse than not being asked.
 */
function IdpGroupMapping({ group }: { group: Group }) {
  const t = useT();
  const providers = useAuthProviders();
  const [draft, setDraft] = useState<{ provider: string; group: string }[] | null>(null);
  const action = useAction();

  const initial = group.idpGroups;
  const rows = draft ?? initial;
  const known = providers.data?.providers ?? [];
  const options = [
    ...known.map((provider) => ({ value: provider.name, label: provider.label })),
    // A stored provider the deployment no longer offers (SSO off, or renamed)
    // must stay visible and re-saveable rather than vanish from the picker.
    ...[...new Set(rows.map((row) => row.provider))]
      .filter((name) => name !== '' && !known.some((provider) => provider.name === name))
      .map((name) => ({ value: name, label: name })),
  ];
  const complete = rows.every((row) => row.provider !== '' && row.group.trim() !== '');
  const dirty =
    draft !== null &&
    JSON.stringify(draft.map((row) => [row.provider, row.group.trim()])) !==
      JSON.stringify(initial.map((row) => [row.provider, row.group.trim()]));

  if (group.global) {
    return (
      <Container header={<Header variant="h2">{t.admin.roleGroups.idpGroupHeader}</Header>}>
        <Box color="text-body-secondary">{t.admin.roleGroups.idpGroupGlobalNote}</Box>
      </Container>
    );
  }

  const setRow = (index: number, row: { provider: string; group: string }) =>
    setDraft(rows.map((current, i) => (i === index ? row : current)));

  return (
    <Container
      header={
        <Header variant="h2" description={t.admin.roleGroups.idpGroupDescription}>
          {t.admin.roleGroups.idpGroupHeader}
        </Header>
      }
    >
      <SpaceBetween size="s">
        {rows.map((row, index) => (
          <SpaceBetween key={index} size="xs" direction="horizontal">
            <Select
              selectedOption={
                options.find((option) => option.value === row.provider) ??
                (row.provider === '' ? null : { value: row.provider, label: row.provider })
              }
              options={options}
              placeholder={t.admin.roleGroups.idpGroupProviderPlaceholder}
              disabled={action.busy}
              onChange={(e) =>
                setRow(index, { ...row, provider: e.detail.selectedOption.value ?? '' })
              }
            />
            <Input
              value={row.group}
              placeholder={t.admin.roleGroups.idpGroupPlaceholder}
              disabled={action.busy}
              onChange={(e) => setRow(index, { ...row, group: e.detail.value })}
            />
            <Button
              disabled={action.busy}
              onClick={() => setDraft(rows.filter((_, i) => i !== index))}
            >
              {t.admin.roleGroups.idpGroupRemove}
            </Button>
          </SpaceBetween>
        ))}
        <SpaceBetween size="xs" direction="horizontal">
          <Button
            disabled={action.busy}
            onClick={() => setDraft([...rows, { provider: known[0]?.name ?? '', group: '' }])}
          >
            {t.admin.roleGroups.idpGroupAdd}
          </Button>
          <Button
            variant="primary"
            disabled={!dirty || !complete || action.busy}
            loading={action.busy}
            onClick={() =>
              action.run(
                () =>
                  api.setRoleGroupIdpGroups(
                    group.id,
                    rows.map((row) => ({ provider: row.provider, group: row.group.trim() })),
                    group.version,
                  ),
                () => {
                  setDraft(null);
                  noteGroupsChanged();
                },
              )
            }
          >
            {t.admin.roleGroups.idpGroupSave}
          </Button>
        </SpaceBetween>
        {rows.length === 0 && (
          <Box color="text-status-inactive">{t.admin.roleGroups.idpGroupUnset}</Box>
        )}
        <ActionError action={action} />
      </SpaceBetween>
    </Container>
  );
}

/** Grant one space to this role group, at a chosen level. */
function GrantSpace({
  roleGroupId,
  spaces,
  onDismiss,
}: {
  roleGroupId: string;
  spaces: AdminSpace[];
  onDismiss: () => void;
}) {
  const t = useT();
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [permission, setPermission] = useState<GrantLevel>('read');
  const action = useAction();

  const spaceOptions = spaces.map((space) => ({ value: space.spaceId, label: space.name }));
  const selectedSpace = spaceOptions.find((option) => option.value === spaceId) ?? null;
  const levels = permissionOptions(t);

  return (
    <Modal
      visible
      header={t.admin.roleGroups.addSpace}
      onDismiss={onDismiss}
      footer={
        <Box float="right">
          <SpaceBetween size="xs" direction="horizontal">
            <Button disabled={action.busy} onClick={onDismiss}>
              {t.common.cancel}
            </Button>
            <Button
              variant="primary"
              loading={action.busy}
              disabled={spaceId === null}
              onClick={() =>
                action.run(
                  () => api.grantSpaceToRoleGroup(spaceId ?? '', roleGroupId, permission),
                  () => {
                    noteGrantsChanged(roleGroupId);
                    onDismiss();
                  },
                )
              }
            >
              {t.common.add}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <FormField label={t.admin.roleGroups.space}>
          <Select
            selectedOption={selectedSpace}
            options={spaceOptions}
            placeholder={t.admin.roleGroups.spacePlaceholder}
            empty={t.admin.roleGroups.spaceEmpty}
            filteringType="auto"
            expandToViewport
            onChange={(e) => setSpaceId(e.detail.selectedOption.value ?? null)}
          />
        </FormField>
        <FormField label={t.admin.roleGroups.permission}>
          <Select
            selectedOption={optionFor(levels, permission)}
            options={levels}
            expandToViewport
            onChange={(e) => setPermission(e.detail.selectedOption.value as GrantLevel)}
          />
        </FormField>
        <ActionError action={action} />
      </SpaceBetween>
    </Modal>
  );
}
