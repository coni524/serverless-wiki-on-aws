/**
 * The signed-in password account's passkeys.
 *
 * Adding and removing answer with the list as it now stands, so the list is
 * replaced from the answer rather than fetched again.
 */
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api } from 'cdk-blocks';

import { createPasskey } from '@/features/auth/utils/webauthn';

export const passkeysKey: QueryKey = ['passkeys'];

export function usePasskeys(enabled: boolean) {
  return useQuery({
    queryKey: passkeysKey,
    queryFn: () => api.listPasskeys(),
    enabled,
  });
}

/** Ask the server for options, let the browser make the key, hand it back. */
export function useAddPasskey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const options = await api.startPasskeyRegistration();
      const credential = await createPasskey(options);
      return await api.completePasskeyRegistration(credential);
    },
    onSuccess: (passkeys) => queryClient.setQueryData(passkeysKey, passkeys),
  });
}

export function useDeletePasskey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (credentialId: string) => api.deletePasskey(credentialId),
    onSuccess: (passkeys) => queryClient.setQueryData(passkeysKey, passkeys),
  });
}
