import { hashPassword, randomId, randomToken, sha256Hex, verifyPassword } from "@app/shared";
import type { Clock, IdGenerator, PasswordHasher, TokenService } from "./ports";

export const systemClock: Clock = {
  now: () => new Date(),
};

export const randomIdGenerator: IdGenerator = {
  generate: (prefix: string) => randomId(prefix),
};

export const scryptPasswordHasher: PasswordHasher = {
  hash: (password: string) => hashPassword(password),
  verify: (password: string, hash: string) => verifyPassword(password, hash),
};

export const sha256TokenService: TokenService = {
  generate: () => randomToken(32),
  hash: (raw: string) => sha256Hex(raw),
};
