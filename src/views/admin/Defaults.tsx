import { useState } from 'react';
import { api } from 'aws-blocks';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useT } from '../../i18n';
import { ErrorText, Loading, useAsync, type Group } from '../../lib';
import { ActionError, useAction } from './parts';

/**
 * The user group every account joins on its first sign-in.
 *
 * Unset by default, and that is the safe state: with no default, a new account
 * reaches nothing until someone puts it in a group. Setting it turns "has signed
 * in" into a permission source, which is how a Wiki-wide readable space is
 * expressed — and why the server refuses to point it at a group that confers
 * global administrator.
 *
 * The change is not retroactive. Accounts that signed in before it was set are
 * not joined afterwards, so an existing population still has to be added by
 * hand on the user-group screen.
 */
export function AdminDefaults() {
  const t = useT();
  const { data, error, loading, reload } = useAsync(async () => {
    const [defaults, userGroups] = await Promise.all([api.getDefaults(), api.listUserGroups()]);
    return { defaults, userGroups };
  }, []);

  if (loading) return <Loading label={t.admin.defaults.loading} />;
  if (error !== null) return <ErrorText>{error}</ErrorText>;
  if (data === null) return null;

  return (
    <DefaultsForm
      key={`${data.defaults.defaultUserGroupId ?? ''}:${data.defaults.version}`}
      current={data.defaults}
      userGroups={data.userGroups}
      onSaved={reload}
    />
  );
}

function DefaultsForm({
  current,
  userGroups,
  onSaved,
}: {
  current: { defaultUserGroupId: string | null; version: number };
  userGroups: Group[];
  onSaved: () => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState(current.defaultUserGroupId ?? '');
  const action = useAction();

  /** The option that stands for "no default group at all". */
  const none = { value: '', label: t.common.notSet };
  // System groups are left out of the picker: `ug_admins` is one, and pointing
  // the default at it would make every new account an administrator. The server
  // refuses that too — this only keeps the choice off the screen.
  const options = [none, ...userGroups.filter((g) => !g.system).map((g) => ({ value: g.id, label: g.name }))];
  const selectedOption = options.find((option) => option.value === selected) ?? none;
  const changed = selected !== (current.defaultUserGroupId ?? '');

  return (
    <Container
      header={
        <Header
          variant="h2"
          description={t.admin.defaults.description}
        >
          {t.admin.defaults.header}
        </Header>
      }
      footer={
        <Box float="right">
          <Button
            variant="primary"
            loading={action.busy}
            disabled={!changed}
            onClick={() =>
              action.run(
                () => api.setDefaults(selected === '' ? null : selected, current.version),
                onSaved,
              )
            }
          >
            {t.common.save}
          </Button>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <FormField
          label={t.admin.defaults.fieldLabel}
          description={t.admin.defaults.fieldDescription}
        >
          <Select
            selectedOption={selectedOption}
            options={options}
            filteringType="auto"
            onChange={(e) => setSelected(e.detail.selectedOption.value ?? '')}
          />
        </FormField>

        <Box color="text-body-secondary">{t.admin.defaults.note}</Box>

        <ActionError action={action} />
      </SpaceBetween>
    </Container>
  );
}
