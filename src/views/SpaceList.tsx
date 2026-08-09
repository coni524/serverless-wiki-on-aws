import { useState } from 'react';
import { api } from 'aws-blocks';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Link from '@cloudscape-design/components/link';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useT } from '../i18n';
import { ErrorText, Loading, errMessage, isTypedKey, useAsync, type Me, type Space } from '../lib';
import { hrefSpace, navigate } from '../router';

/** The landing view: the spaces the signed-in user can read. */
export function SpaceList({ me }: { me: Me }) {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.mySpaces(), []);
  const [creating, setCreating] = useState(false);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          actions={
            <SpaceBetween size="xs" direction="horizontal">
              <Button iconName="refresh" ariaLabel={t.space.reload} onClick={reload} />
              {me.isGlobalAdmin && (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  {t.space.createSpace}
                </Button>
              )}
            </SpaceBetween>
          }
        >
          {t.space.listHeading}
        </Header>
      }
    >
      <SpaceBetween size="m">
        {loading && <Loading />}
        {error !== null && <ErrorText>{error}</ErrorText>}

        {data !== null && (
          <Cards
            items={data}
            trackBy={(space) => space.spaceId}
            cardDefinition={{
              header: (space) => <SpaceLink space={space} />,
              sections: [
                {
                  id: 'permission',
                  content: (space) => <Badge>{space.permission}</Badge>,
                },
                {
                  id: 'description',
                  content: (space) =>
                    space.description !== '' ? (
                      <Box color="text-body-secondary">{space.description}</Box>
                    ) : null,
                },
              ],
            }}
            cardsPerRow={[{ cards: 1 }, { minWidth: 700, cards: 2 }]}
            empty={
              <Box textAlign="center" color="text-status-inactive" padding={{ vertical: 'l' }}>
                {t.space.noSpaces(me.isGlobalAdmin)}
              </Box>
            }
          />
        )}
      </SpaceBetween>

      {creating && <CreateSpace onDismiss={() => setCreating(false)} />}
    </ContentLayout>
  );
}

function SpaceLink({ space }: { space: Space }) {
  const href = hrefSpace(space.spaceId);
  return (
    <Link
      href={href}
      fontSize="heading-m"
      onFollow={(e) => {
        e.preventDefault();
        navigate(href);
      }}
    >
      {space.name}
    </Link>
  );
}

function CreateSpace({ onDismiss }: { onDismiss: () => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { spaceId } = await api.createSpace({
        name: name.trim(),
        description: description.trim(),
      });
      navigate(hrefSpace(spaceId));
    } catch (e) {
      setError(errMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      visible
      header={t.space.createSpace}
      onDismiss={onDismiss}
      footer={
        <Box float="right">
          <SpaceBetween size="xs" direction="horizontal">
            <Button disabled={busy} onClick={onDismiss}>
              {t.common.cancel}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={name.trim() === ''}
              onClick={() => void create()}
            >
              {t.common.create}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <Form errorText={error ?? undefined}>
        <SpaceBetween size="m">
          <FormField label={t.space.spaceName}>
            <Input
              value={name}
              autoFocus
              onChange={(e) => setName(e.detail.value)}
              onKeyDown={(e) => {
                // `isTypedKey` keeps the Enter that confirms a Japanese
                // conversion from creating the space mid-word.
                if (!isTypedKey(e.detail)) return;
                if (e.detail.key === 'Enter' && name.trim() !== '' && !busy) void create();
              }}
            />
          </FormField>
          <FormField label={t.space.description} description={t.space.optional}>
            <Input value={description} onChange={(e) => setDescription(e.detail.value)} />
          </FormField>
        </SpaceBetween>
      </Form>
    </Modal>
  );
}
