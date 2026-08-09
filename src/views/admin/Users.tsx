import { useState } from 'react';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import TextFilter from '@cloudscape-design/components/text-filter';
import { useT } from '../../i18n';
import { ErrorText } from '../../lib';
import { LoadMore, useDirectory } from './parts';

/**
 * The account directory.
 *
 * Read-only on purpose. Nothing about an account is editable from the Wiki:
 * Cognito owns the accounts, and what a person may reach is decided by the
 * groups they are in, which the user-group screen edits. This screen answers
 * one question — is this address known to the Wiki yet — and that question has
 * to be answerable, because a membership can only point at an account that has
 * signed in at least once.
 */
export function AdminUsers() {
  const t = useT();
  const [text, setText] = useState('');
  const [prefix, setPrefix] = useState('');
  const directory = useDirectory(prefix);

  return (
    <SpaceBetween size="m">
      {directory.error !== null && <ErrorText>{directory.error}</ErrorText>}

      <Table
        variant="container"
        header={
          <Header
            variant="h2"
            counter={directory.cursor === null ? `(${directory.users.length})` : undefined}
            description={t.admin.users.description}
            actions={
              <Button
                iconName="refresh"
                ariaLabel={t.admin.shared.reload}
                onClick={directory.reload}
              />
            }
          >
            {t.admin.sections.users}
          </Header>
        }
        filter={
          <TextFilter
            filteringText={text}
            filteringPlaceholder={t.admin.shared.filterByEmail}
            filteringAriaLabel={t.admin.shared.filterByEmail}
            onChange={(e) => setText(e.detail.filteringText)}
            // Delayed, not immediate: the filter is a server-side prefix query,
            // so a request per keystroke would bill a read per keystroke.
            onDelayedChange={(e) => setPrefix(e.detail.filteringText.trim())}
          />
        }
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
            id: 'userId',
            header: t.admin.users.userId,
            cell: (user) => <Box fontSize="body-s" color="text-body-secondary">{user.userId}</Box>,
          },
        ]}
        empty={
          <Box textAlign="center" color="text-status-inactive" padding={{ vertical: 'l' }}>
            {prefix === '' ? t.admin.users.empty : t.admin.users.emptyFiltered(prefix)}
          </Box>
        }
        footer={<LoadMore directory={directory} />}
      />

      <Container header={<Header variant="h2">{t.admin.users.grantingHeader}</Header>}>
        <Box>{t.admin.users.grantingBody}</Box>
      </Container>
    </SpaceBetween>
  );
}
