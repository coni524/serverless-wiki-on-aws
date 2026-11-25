/**
 * The passkey dialog, opened from the account menu.
 *
 * Offered to password accounts only: a federated account signs in at its
 * identity provider, and any passkey it uses is registered there.
 */
import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';

import { ErrorText, Loading } from '@/components/ui';
import { useLocale, useT } from '@/lib/i18n';
import { errMessage, errName } from '@/utils/errors';
import { useAddPasskey, useDeletePasskey, usePasskeys } from '@/features/auth/api/passkeys';
import { isAlreadyRegistered, isCancelled, passkeysSupported } from '@/features/auth/utils/webauthn';

/** What the auth block answers when the sign-in is older than its fresh window. */
const REAUTH_REQUIRED = 'ReauthenticationRequiredException';

type Notice = { type: 'success' | 'info' | 'error'; text: string };

export function PasskeysModal({ onDismiss }: { onDismiss: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const passkeys = usePasskeys(true);
  const add = useAddPasskey();
  const remove = useDeletePasskey();
  const [notice, setNotice] = useState<Notice | null>(null);
  const supported = passkeysSupported();

  const explain = (error: unknown): Notice => {
    if (isAlreadyRegistered(error)) return { type: 'info', text: t.app.passkeyAlreadyHere };
    if (isCancelled(error)) return { type: 'info', text: t.app.passkeyCancelled };
    if (errName(error) === REAUTH_REQUIRED) return { type: 'error', text: t.app.passkeyReauth };
    return { type: 'error', text: t.app.passkeyFailed(errMessage(error)) };
  };

  const onAdd = () => {
    setNotice(null);
    add.mutate(undefined, {
      onSuccess: () => setNotice({ type: 'success', text: t.app.passkeyAdded }),
      onError: (error) => setNotice(explain(error)),
    });
  };

  const onDelete = (credentialId: string) => {
    setNotice(null);
    remove.mutate(credentialId, {
      onSuccess: () => setNotice({ type: 'success', text: t.app.passkeyDeleted }),
      onError: (error) => setNotice(explain(error)),
    });
  };

  const busy = add.isPending || remove.isPending;
  const formatDate = (iso: string) => new Date(iso).toLocaleDateString(locale);

  return (
    <Modal
      visible
      header={t.app.passkeys}
      onDismiss={onDismiss}
      footer={
        <Box float="right">
          <Button onClick={onDismiss}>{t.common.close}</Button>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <Box>{t.app.passkeysIntro}</Box>
        <Box color="text-body-secondary">{t.app.passkeysClientsNote}</Box>

        {notice !== null && (
          <Alert type={notice.type} dismissible onDismiss={() => setNotice(null)}>
            {notice.text}
          </Alert>
        )}

        {passkeys.isPending ? (
          <Loading />
        ) : passkeys.isError ? (
          <ErrorText>{errMessage(passkeys.error)}</ErrorText>
        ) : passkeys.data.length === 0 ? (
          <Box color="text-status-inactive">{t.app.passkeysEmpty}</Box>
        ) : (
          <SpaceBetween size="xs">
            {passkeys.data.map((passkey) => (
              <SpaceBetween key={passkey.credentialId} direction="horizontal" size="s" alignItems="center">
                <Box variant="strong">{passkey.friendlyName ?? t.app.passkeyUnnamed}</Box>
                {passkey.createdAt !== null && (
                  <Box color="text-body-secondary">{t.app.passkeyCreatedAt(formatDate(passkey.createdAt))}</Box>
                )}
                <Button variant="inline-link" disabled={busy} onClick={() => onDelete(passkey.credentialId)}>
                  {t.common.delete}
                </Button>
              </SpaceBetween>
            ))}
          </SpaceBetween>
        )}

        {supported ? (
          <Button variant="primary" loading={add.isPending} disabled={busy} onClick={onAdd}>
            {t.app.passkeyAdd}
          </Button>
        ) : (
          <Alert type="warning">{t.app.passkeyUnsupported}</Alert>
        )}
      </SpaceBetween>
    </Modal>
  );
}
