import { useState } from 'react';
import { api } from 'aws-blocks';
import { useQuery } from '@tanstack/react-query';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import TextFilter from '@cloudscape-design/components/text-filter';
import { useT } from '@/lib/i18n';
import { ErrorText, Loading } from '@/components/ui';
import { errMessage } from '@/utils/errors';
import type { Group } from '@/types/api';
import {
  attachedRoleGroupsQuery,
  membersQuery,
  noteAttachmentChanged,
  noteGroupsChanged,
  noteMembersChanged,
  refreshAdmin,
  roleGroupsQuery,
  userGroupsQuery,
} from '@/features/admin/api/admin-cache';
import {
  followRoute,
  hrefAdmin,
  hrefAdminRoleGroup,
  hrefAdminUserGroup,
  navigate,
} from '@/lib/router';
import {
  ActionError,
  ConfirmModal,
  CreateGroupModal,
  GroupBadges,
  LoadMore,
  useAction,
  useDirectory,
} from '@/features/admin/components/parts';

/**
 * User groups — the hop between a person and a role group.
 *
 * A group is worth nothing on its own: it carries permissions only through the
 * role groups attached to it. Both edges are edited on the detail screen below,
 * side by side, because "who is in it" and "what it confers" is the pair an
 * administrator has to see together to know what a change does.
 */
export function UserGroupList() {
  const t = useT();
  const { data, error, isPending, isFetching, refetch } = useQuery(userGroupsQuery());
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
            description={t.admin.userGroups.listDescription}
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
            {t.admin.sections['user-groups']}
          </Header>
        }
        items={data ?? []}
        trackBy={(group) => group.id}
        loading={isPending}
        loadingText={t.admin.userGroups.loading}
        columnDefinitions={[
          {
            id: 'name',
            header: t.admin.shared.name,
            isRowHeader: true,
            cell: (group) => (
              <SpaceBetween size="xs" direction="horizontal">
                <Link href={hrefAdminUserGroup(group.id)} onFollow={followRoute}>
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
            {t.admin.userGroups.empty}
          </Box>
        }
      />

      {creating && (
        <CreateGroupModal
          header={t.admin.userGroups.createHeader}
          nameLabel={t.admin.userGroups.nameLabel}
          onCreate={async (input) => {
            const { userGroupId } = await api.createUserGroup(input);
            noteGroupsChanged();
            navigate(hrefAdminUserGroup(userGroupId));
          }}
          onDismiss={() => setCreating(false)}
        />
      )}

      {deleting !== null && (
        <ConfirmModal
          header={t.admin.shared.deleteHeader(deleting.name)}
          action={action}
          onConfirm={() =>
            action.run(() => api.deleteUserGroup(deleting.id), () => {
              setDeleting(null);
              noteGroupsChanged();
            })
          }
          onDismiss={() => setDeleting(null)}
        >
          <Box>{t.admin.userGroups.deleteBody}</Box>
        </ConfirmModal>
      )}
    </SpaceBetween>
  );
}

/** One user group: its members, and the role groups attached to it. */
export function UserGroupDetail({ userGroupId }: { userGroupId: string }) {
  const t = useT();
  // Four entries rather than one fetch of four calls, because three of them are
  // shared: the two group listings are what the list screens read, and the
  // edges are what the role group's own screen shows from the other side. A
  // membership removed here therefore refetches the members and nothing else.
  const groups = useQuery(userGroupsQuery());
  const members = useQuery(membersQuery(userGroupId));
  const attached = useQuery(attachedRoleGroupsQuery(userGroupId));
  const roleGroups = useQuery(roleGroupsQuery());

  const action = useAction();
  const [addingMember, setAddingMember] = useState(false);
  const [addingRoleGroup, setAddingRoleGroup] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const error = groups.error ?? members.error ?? attached.error ?? roleGroups.error;
  if (error !== null) return <ErrorText>{errMessage(error)}</ErrorText>;

  const groupList = groups.data;
  const memberList = members.data;
  const attachedList = attached.data;
  const roleGroupList = roleGroups.data;
  if (
    groupList === undefined ||
    memberList === undefined ||
    attachedList === undefined ||
    roleGroupList === undefined
  ) {
    return <Loading label={t.admin.userGroups.loading} />;
  }

  const group = groupList.find((item) => item.id === userGroupId) ?? null;
  if (group === null) return <ErrorText>{t.admin.userGroups.notFound}</ErrorText>;

  // The role groups this group already reaches, resolved to their names. An id
  // with no match is an attachment whose role group was deleted; it is shown as
  // the bare id rather than hidden, because it is still an edge in the table.
  const attachedRoleGroups = attachedList.map(({ roleGroupId }) => ({
    roleGroupId,
    roleGroup: roleGroupList.find((item) => item.id === roleGroupId) ?? null,
  }));

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

      <Table
        variant="container"
        header={
          <Header
            variant="h2"
            counter={`(${memberList.length})`}
            description={t.admin.userGroups.membersDescription}
            actions={
              <Button variant="primary" onClick={() => setAddingMember(true)}>
                {t.admin.userGroups.addMember}
              </Button>
            }
          >
            {t.admin.userGroups.membersHeader}
          </Header>
        }
        items={memberList}
        trackBy={(member) => member.userId}
        columnDefinitions={[
          { id: 'email', header: t.admin.shared.email, cell: (m) => m.email, isRowHeader: true },
          {
            id: 'actions',
            header: '',
            width: 130,
            cell: (member) => (
              <Button
                variant="inline-link"
                onClick={() =>
                  action.run(() => api.removeUserFromUserGroup(userGroupId, member.userId), () =>
                    noteMembersChanged(userGroupId),
                  )
                }
              >
                {t.admin.userGroups.remove}
              </Button>
            ),
          },
        ]}
        empty={
          <Box textAlign="center" color="text-status-inactive" padding={{ vertical: 'l' }}>
            {t.admin.userGroups.membersEmpty}
          </Box>
        }
      />

      <Table
        variant="container"
        header={
          <Header
            variant="h2"
            counter={`(${attachedRoleGroups.length})`}
            description={t.admin.userGroups.roleGroupsDescription}
            actions={
              <Button variant="primary" onClick={() => setAddingRoleGroup(true)}>
                {t.admin.userGroups.attachHeader}
              </Button>
            }
          >
            {t.admin.sections['role-groups']}
          </Header>
        }
        items={attachedRoleGroups}
        trackBy={(row) => row.roleGroupId}
        columnDefinitions={[
          {
            id: 'name',
            header: t.admin.shared.name,
            isRowHeader: true,
            cell: (row) => (
              <SpaceBetween size="xs" direction="horizontal">
                <Link href={hrefAdminRoleGroup(row.roleGroupId)} onFollow={followRoute}>
                  {row.roleGroup?.name ?? row.roleGroupId}
                </Link>
                {row.roleGroup !== null && <GroupBadges group={row.roleGroup} />}
              </SpaceBetween>
            ),
          },
          {
            id: 'actions',
            header: '',
            width: 130,
            cell: (row) => (
              <Button
                variant="inline-link"
                onClick={() =>
                  action.run(
                    () => api.detachRoleGroupFromUserGroup(userGroupId, row.roleGroupId),
                    () => noteAttachmentChanged(userGroupId, row.roleGroupId),
                  )
                }
              >
                {t.admin.userGroups.remove}
              </Button>
            ),
          },
        ]}
        empty={
          <Box textAlign="center" color="text-status-inactive" padding={{ vertical: 'l' }}>
            {t.admin.userGroups.roleGroupsEmpty}
          </Box>
        }
      />

      {addingMember && (
        <AddMember
          userGroupId={userGroupId}
          memberIds={new Set(memberList.map((member) => member.userId))}
          onDismiss={() => setAddingMember(false)}
        />
      )}

      {addingRoleGroup && (
        <AttachRoleGroup
          userGroupId={userGroupId}
          candidates={roleGroupList.filter(
            (roleGroup) => !attachedList.some((item) => item.roleGroupId === roleGroup.id),
          )}
          onDismiss={() => setAddingRoleGroup(false)}
        />
      )}

      {deleting && (
        <ConfirmModal
          header={t.admin.shared.deleteHeader(group.name)}
          action={action}
          onConfirm={() =>
            action.run(() => api.deleteUserGroup(userGroupId), () => {
              noteGroupsChanged();
              navigate(hrefAdmin('user-groups'));
            })
          }
          onDismiss={() => setDeleting(false)}
        >
          <Box>{t.admin.userGroups.deleteDetailBody(memberList.length)}</Box>
        </ConfirmModal>
      )}
    </SpaceBetween>
  );
}

/**
 * Add one account to the group.
 *
 * The candidate list is the directory, filtered by the start of the address, and
 * paged the same way — an account that has never signed in is not there to pick,
 * because there is no `sub` yet for a membership to point at.
 */
function AddMember({
  userGroupId,
  memberIds,
  onDismiss,
}: {
  userGroupId: string;
  memberIds: Set<string>;
  onDismiss: () => void;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [prefix, setPrefix] = useState('');
  const directory = useDirectory(prefix);
  const action = useAction();

  return (
    <Modal visible header={t.admin.userGroups.addMember} onDismiss={onDismiss} size="large">
      <SpaceBetween size="m">
        <ActionError action={action} />
        {directory.error !== null && <ErrorText>{directory.error}</ErrorText>}
        <TextFilter
          filteringText={text}
          filteringPlaceholder={t.admin.shared.filterByEmail}
          filteringAriaLabel={t.admin.shared.filterByEmail}
          onChange={(e) => setText(e.detail.filteringText)}
          onDelayedChange={(e) => setPrefix(e.detail.filteringText.trim())}
        />
        <Table
          variant="embedded"
          items={directory.users}
          trackBy={(user) => user.userId}
          loading={directory.loading && directory.users.length === 0}
          loadingText={t.admin.shared.loadingUsers}
          columnDefinitions={[
            {
              id: 'email',
              header: t.admin.shared.email,
              cell: (user) => user.email,
              isRowHeader: true,
            },
            {
              id: 'actions',
              header: '',
              width: 130,
              cell: (user) =>
                memberIds.has(user.userId) ? (
                  <Box color="text-status-inactive">{t.admin.userGroups.alreadyMember}</Box>
                ) : (
                  <Button
                    variant="inline-link"
                    disabled={action.busy}
                    onClick={() =>
                      action.run(() => api.addUserToUserGroup(userGroupId, user.userId), () => {
                        noteMembersChanged(userGroupId);
                        onDismiss();
                      })
                    }
                  >
                    {t.common.add}
                  </Button>
                ),
            },
          ]}
          empty={
            <Box textAlign="center" color="text-status-inactive" padding={{ vertical: 'l' }}>
              {t.admin.userGroups.directoryEmpty}
            </Box>
          }
          footer={<LoadMore directory={directory} />}
        />
      </SpaceBetween>
    </Modal>
  );
}

/** Attach one role group. Only the ones not already attached are offered. */
function AttachRoleGroup({
  userGroupId,
  candidates,
  onDismiss,
}: {
  userGroupId: string;
  candidates: Group[];
  onDismiss: () => void;
}) {
  const t = useT();
  const action = useAction();

  return (
    <Modal visible header={t.admin.userGroups.attachHeader} onDismiss={onDismiss} size="large">
      <SpaceBetween size="m">
        <ActionError action={action} />
        <Table
          variant="embedded"
          items={candidates}
          trackBy={(roleGroup) => roleGroup.id}
          columnDefinitions={[
            {
              id: 'name',
              header: t.admin.shared.name,
              isRowHeader: true,
              cell: (roleGroup) => (
                <SpaceBetween size="xs" direction="horizontal">
                  <span>{roleGroup.name}</span>
                  <GroupBadges group={roleGroup} />
                </SpaceBetween>
              ),
            },
            {
              id: 'description',
              header: t.admin.shared.description,
              cell: (roleGroup) => roleGroup.description,
            },
            {
              id: 'actions',
              header: '',
              width: 130,
              cell: (roleGroup) => (
                <Button
                  variant="inline-link"
                  disabled={action.busy}
                  onClick={() =>
                    action.run(
                      () => api.attachRoleGroupToUserGroup(userGroupId, roleGroup.id),
                      () => {
                        noteAttachmentChanged(userGroupId, roleGroup.id);
                        onDismiss();
                      },
                    )
                  }
                >
                  {t.admin.userGroups.attach}
                </Button>
              ),
            },
          ]}
          empty={
            <Box textAlign="center" color="text-status-inactive" padding={{ vertical: 'l' }}>
              {t.admin.userGroups.attachEmpty}
            </Box>
          }
        />
      </SpaceBetween>
    </Modal>
  );
}
