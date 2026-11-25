/**
 * The browser's half of adding a passkey.
 *
 * The server hands over the creation options as JSON, the browser makes the
 * key pair, and the result goes back as JSON. WebAuthn speaks binary
 * (`ArrayBuffer`) for the challenge, the user id and every part of the
 * response, so both directions convert base64url. Browsers that have the
 * Level 3 helpers (`parseCreationOptionsFromJSON`, `toJSON`) do that
 * themselves; the rest get the same conversion by hand.
 *
 * The auth block's sign-in form runs the other ceremony, signing in with a
 * passkey, on its own; it keeps its helper internal, which is why adding one
 * has its own here.
 */

/** Whether this browser can make a passkey at all. */
export function passkeysSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator.credentials?.create === 'function'
  );
}

/** This device already holds a passkey for the account (the server's exclude list matched). */
export function isAlreadyRegistered(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'InvalidStateError';
}

/** The reader dismissed the browser's prompt, or it timed out. */
export function isCancelled(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError');
}

type CreationOptionsJson = {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials?: { id: string; type: string; transports?: string[] }[];
  [key: string]: unknown;
};

type JsonCapable = {
  parseCreationOptionsFromJSON?: (json: unknown) => PublicKeyCredentialCreationOptions;
};

/**
 * Create a passkey from the server's options and return the credential as the
 * JSON the server expects.
 */
export async function createPasskey(optionsJson: string): Promise<string> {
  const json = JSON.parse(optionsJson) as CreationOptionsJson;
  const helpers = window.PublicKeyCredential as unknown as JsonCapable;
  const publicKey =
    typeof helpers.parseCreationOptionsFromJSON === 'function'
      ? helpers.parseCreationOptionsFromJSON(json)
      : fromJson(json);
  const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (credential === null) throw new DOMException('No credential was created', 'NotAllowedError');
  const toJSON = (credential as PublicKeyCredential & { toJSON?: () => unknown }).toJSON;
  return JSON.stringify(typeof toJSON === 'function' ? toJSON.call(credential) : toJson(credential));
}

function fromJson(json: CreationOptionsJson): PublicKeyCredentialCreationOptions {
  return {
    ...(json as unknown as PublicKeyCredentialCreationOptions),
    challenge: decode(json.challenge),
    user: { ...json.user, id: decode(json.user.id) },
    excludeCredentials: json.excludeCredentials?.map((entry) => ({
      ...entry,
      type: 'public-key' as const,
      id: decode(entry.id),
      transports: entry.transports as AuthenticatorTransport[] | undefined,
    })),
  };
}

function toJson(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: encode(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: encode(response.clientDataJSON),
      attestationObject: encode(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
  };
}

function decode(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function encode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
