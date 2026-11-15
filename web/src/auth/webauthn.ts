// Passkeys. The server sends the options for navigator.credentials as JSON,
// with every binary field written as base64url; the browser wants
// ArrayBuffers and answers with ArrayBuffers. These functions convert both
// ways, so callers pass the server's options in and post the result back.

type Json = Record<string, unknown>;

export function fromBase64Url(text: string): ArrayBuffer {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function toBase64Url(buf: ArrayBuffer | null | undefined): string {
  if (!buf) return "";
  let bin = "";
  for (const byte of new Uint8Array(buf)) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Whether this browser can make or use passkeys at all. */
export const passkeysSupported = () =>
  typeof window !== "undefined" && "PublicKeyCredential" in window && !!navigator.credentials;

const descriptors = (list: unknown) =>
  ((list as { id: string }[] | undefined) ?? []).map((c) => ({
    ...c,
    id: fromBase64Url(c.id),
  })) as PublicKeyCredentialDescriptor[];

/**
 * Makes a passkey on this device from the options of
 * POST /auth/passkeys/register/start. Returns the body for .../register/finish.
 */
export async function createPasskey(options: { publicKey: Json }): Promise<Json> {
  const pk = options.publicKey;
  const user = pk.user as Json;
  const publicKey = {
    ...pk,
    challenge: fromBase64Url(pk.challenge as string),
    user: { ...user, id: fromBase64Url(user.id as string) },
    excludeCredentials: descriptors(pk.excludeCredentials),
  } as unknown as PublicKeyCredentialCreationOptions;
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error("no passkey was made");
  const res = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: toBase64Url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      attestationObject: toBase64Url(res.attestationObject),
      clientDataJSON: toBase64Url(res.clientDataJSON),
      transports: typeof res.getTransports === "function" ? res.getTransports() : undefined,
    },
  };
}

/**
 * Asks for a passkey with the options of POST /auth/passkeys/login/start.
 * Returns the body for .../login/finish.
 */
export async function getPasskey(options: { publicKey: Json }): Promise<Json> {
  const pk = options.publicKey;
  const publicKey = {
    ...pk,
    challenge: fromBase64Url(pk.challenge as string),
    allowCredentials: descriptors(pk.allowCredentials),
  } as unknown as PublicKeyCredentialRequestOptions;
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error("no passkey was chosen");
  const res = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: toBase64Url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      authenticatorData: toBase64Url(res.authenticatorData),
      clientDataJSON: toBase64Url(res.clientDataJSON),
      signature: toBase64Url(res.signature),
      userHandle: toBase64Url(res.userHandle),
    },
  };
}

/** True when the person closed the browser's passkey sheet: not an error worth showing. */
export const passkeyCanceled = (err: unknown) =>
  err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError");
