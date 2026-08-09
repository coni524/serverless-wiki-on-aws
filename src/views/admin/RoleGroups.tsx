import { useState } from 'react';
import { api } from 'aws-blocks';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import Modal from '@cloudscape-design/components/modal';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import { useT, type Messages } from '../../i18n';
import {
  ErrorText,
  Loading,
  useAsync,
  type AdminSpace,
  type GrantLevel,
  type Group,
} from '../../lib';
import { followRoute, hrefAdmin, hrefAdminRoleGroup, hrefAdminUserGroup, navigate } from '../../router';
import { ActionError, ConfirmModal, CreateGroupModal, GroupBadges, useAction } from './parts';

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
  const { data, error, loading, reload } = useAsync(() => api.listRoleGroups(), []);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Group | null>(null);
  const action = useAction();

  return (
    <SpaceBetween size="m">
      <ActionError action={action} />
      {error !== null && <ErrorText>{error}</ErrorText>}

      <Table
        variant="container"
        header={
          <Header
            variant="h2"
            counter={data === null ? undefined : `(${data.length})`}
            description={t.admin.roleGroups.listDescription}
            actions={
              <SpaceBetween size="xs" direction="horizontal">
                <Button iconName="refresh" ariaLabel={t.admin.shared.reload} onClick={reload} />
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
        loading={loading}
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
              reload();
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
  const { data, error, loading, reload } = useAsync(async () => {
    const [roleGroups, grants, spaces, attachedTo, userGroups] = await Promise.all([
      api.listRoleGroups(),
      api.listRoleGroupGrants(roleGroupId),
      api.listSpaces(),
      api.listRoleGroupUserGroups(roleGroupId),
      api.listUserGroups(),
    ]);
    return {
      group: roleGroups.find((item) => item.id === roleGroupId) ?? null,
      grants,
      spaces,
      attachedTo,
      userGroups,
    };
  }, [roleGroupId]);

  const action = useAction();
  const [granting, setGranting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (loading) return <Loading label={t.admin.roleGroups.loading} />;
  if (error !== null) return <ErrorText>{error}</ErrorText>;
  if (data === null) return null;
  if (data.group === null) return <ErrorText>{t.admin.roleGroups.notFound}</ErrorText>;

  const group = data.group;
  const rows = data.grants.map((grant) => ({
    ...grant,
    space: data.spaces.find((item) => item.spaceId === grant.spaceId) ?? null,
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
            <Button iconName="refresh" ariaLabel={t.admin.shared.reload} onClick={reload} />
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
                  action.run(
                    () => api.grantSpaceToRoleGroup(row.spaceId, roleGroupId, next),
                    reload,
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
                  action.run(
                    () => api.revokeSpaceFromRoleGroup(row.spaceId, roleGroupId),
                    reload,
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

      <Table
        variant="container"
        header={
          <Header
            variant="h2"
            counter={`(${data.attachedTo.length})`}
            description={t.admin.roleGroups.attachedDescription}
          >
            {t.admin.roleGroups.attachedHeader}
          </Header>
        }
        items={data.attachedTo}
        trackBy={(row) => row.userGroupId}
        columnDefinitions={[
          {
            id: 'name',
            header: t.admin.shared.name,
            isRowHeader: true,
            cell: (row) => (
              <Link href={hrefAdminUserGroup(row.userGroupId)} onFollow={followRoute}>
                {data.userGroups.find((item) => item.id === row.userGroupId)?.name ?? row.userGroupId}
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
          spaces={data.spaces.filter(
            (space) => !data.grants.some((grant) => grant.spaceId === space.spaceId),
          )}
          onDone={reload}
          onDismiss={() => setGranting(false)}
        />
      )}

      {deleting && (
        <ConfirmModal
          header={t.admin.shared.deleteHeader(group.name)}
          action={action}
          onConfirm={() =>
            action.run(() => api.deleteRoleGroup(roleGroupId), () =>
              navigate(hrefAdmin('role-groups')),
            )
          }
          onDismiss={() => setDeleting(false)}
        >
          <Box>
            {t.admin.roleGroups.deleteDetailBody(data.grants.length, data.attachedTo.length)}
          </Box>
        </ConfirmModal>
      )}
    </SpaceBetween>
  );
}

/** Grant one space to this role group, at a chosen level. */
function GrantSpace({
  roleGroupId,
  spaces,
  onDone,
  onDismiss,
}: {
  roleGroupId: string;
  spaces: AdminSpace[];
  onDone: () => void;
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
                    onDone();
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
