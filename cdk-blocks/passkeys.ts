/**
 * Passkeys for password accounts: registration, listing and removal.
 *
 * The pool requires MFA, and counts a passkey unlocked with the device's
 * fingerprint, face or PIN as satisfying it (`index.cdk.ts`). A passkey sign-in
 * is therefore complete on its own, with nothing to switch per user: Cognito
 * keeps a per-user passkey-MFA setting, but a sign-in with a user-verified
 * passkey goes through whether it is on or off.
 *
 * Every change needs a recent sign-in (the block's `freshAgeSeconds`). A
 * passkey is a way in that outlives the session it was added from, so a
 * session that was left open, or taken, must not be enough to add one here.
 * The auth block's own sign-in API offers the same actions without that
 * condition, which is why `index.ts` refuses them there.
 */
import { ApiError, type BlocksContext } from '@aws-cdk-blocks/core';

import { auth, passkeyOrigin } from './resources.js';

/** One registered passkey, as the account screen lists it. */
export type PasskeySummary = {
  credentialId: string;
  friendlyName: string | null;
  createdAt: string | null;
};

/** Whether this deployment offers passkeys at all (see `resources.ts`). */
export const PASSKEYS_ENABLED = passkeyOrigin !== undefined;

function requirePasskeysEnabled(): void {
  if (!PASSKEYS_ENABLED) {
    throw new ApiError('Passkeys are not enabled on this deployment', 409, {
      name: 'PasskeysNotEnabledException',
    });
  }
}

/**
 * The signed-in password account, signed in recently enough to change its
 * passkeys.
 *
 * Asked of the password block alone, which holds only password accounts'
 * sessions: a federated account's session lives in the `sso` block, so it is
 * refused here as signed out. Its sign-in, and any passkey it uses, belong to
 * its identity provider.
 */
async function requirePasskeyOwner(context: BlocksContext) {
  requirePasskeysEnabled();
  return await auth.requireAuth(context, { fresh: true });
}

function summarise(list: Awaited<ReturnType<typeof auth.listPasskeys>>): PasskeySummary[] {
  return list.map((passkey) => ({
    credentialId: passkey.credentialId,
    friendlyName: passkey.friendlyName ?? null,
    createdAt: passkey.createdAt ?? null,
  }));
}

export async function listPasskeys(context: BlocksContext): Promise<PasskeySummary[]> {
  requirePasskeysEnabled();
  await auth.requireAuth(context);
  return summarise(await auth.listPasskeys(context));
}

export async function startPasskeyRegistration(context: BlocksContext): Promise<string> {
  await requirePasskeyOwner(context);
  const { credentialCreationOptions } = await auth.startPasskeyRegistration(context);
  return credentialCreationOptions;
}

export async function completePasskeyRegistration(
  context: BlocksContext,
  credential: string,
): Promise<PasskeySummary[]> {
  if (typeof credential !== 'string' || credential === '') {
    throw new ApiError('A credential is required', 400, { name: 'InvalidParameterException' });
  }
  await requirePasskeyOwner(context);
  await auth.completePasskeyRegistration(context, credential);
  return summarise(await auth.listPasskeys(context));
}

export async function deletePasskey(
  context: BlocksContext,
  credentialId: string,
): Promise<PasskeySummary[]> {
  if (typeof credentialId !== 'string' || credentialId === '') {
    throw new ApiError('A credential id is required', 400, { name: 'InvalidParameterException' });
  }
  await requirePasskeyOwner(context);
  await auth.deletePasskey(context, credentialId);
  return summarise(await auth.listPasskeys(context));
}
