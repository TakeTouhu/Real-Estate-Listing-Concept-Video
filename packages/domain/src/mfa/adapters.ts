import { keyFingerprint, openAesGcm, sealAesGcm, secureRandomBytes } from "@app/shared";
import type { MfaRandom, MfaSecretCipher } from "./ports";

/**
 * AES-256-GCM under `MFA_SECRET_KEY` (64 hex characters). A sealed secret is
 * `<key id>.<payload>` and is bound to its user, so it opens for no other user
 * and, after a key change, says which key sealed it.
 */
export function createMfaSecretCipher(keyHex: string): MfaSecretCipher {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error("MFA_SECRET_KEY must be 64 hex characters");
  const key = Buffer.from(keyHex, "hex");
  const keyId = keyFingerprint(key);
  return {
    seal: (secret, userId) => `${keyId}.${sealAesGcm(key, secret, userId)}`,
    open(sealed, userId) {
      const dot = sealed.indexOf(".");
      if (sealed.slice(0, dot) !== keyId) throw new Error("MFA secret was sealed under another key");
      return openAesGcm(key, sealed.slice(dot + 1), userId);
    },
  };
}

export const systemMfaRandom: MfaRandom = {
  bytes: (count) => secureRandomBytes(count),
};
