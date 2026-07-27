import type { ObjectStorage, SignedUrl } from "@app/domain";
import { signStorageToken } from "./signing";

export interface LocalObjectStorageOptions {
  /** HMAC secret used to sign storage tokens. Server-side only. */
  readonly secret: string;
  /** Base path that serves signed objects, e.g. "/api/storage". */
  readonly basePath?: string;
  readonly now?: () => Date;
}

/**
 * In-process object storage used for local development and tests. It implements
 * the same {@link ObjectStorage} contract as a real S3/Azure driver: keys are
 * opaque and organization-prefixed, and access is only granted through
 * short-lived, single-purpose signed URLs.
 *
 * A production S3/Azure adapter replaces this class without touching domain
 * code (see ADR-0008).
 */
export class LocalObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, Uint8Array>();
  private readonly secret: string;
  private readonly basePath: string;
  private readonly now: () => Date;

  constructor(options: LocalObjectStorageOptions) {
    this.secret = options.secret;
    this.basePath = options.basePath ?? "/api/storage";
    this.now = options.now ?? (() => new Date());
  }

  private signedUrl(key: string, purpose: "upload" | "download", ttlSeconds: number): SignedUrl {
    const expiresAtSeconds = Math.floor(this.now().getTime() / 1000) + ttlSeconds;
    const token = signStorageToken({ key, purpose, expiresAtSeconds }, this.secret);
    return {
      url: `${this.basePath}/${purpose}?token=${encodeURIComponent(token)}`,
      expiresAt: new Date(expiresAtSeconds * 1000),
    };
  }

  createSignedUploadUrl(key: string, ttlSeconds: number): Promise<SignedUrl> {
    return Promise.resolve(this.signedUrl(key, "upload", ttlSeconds));
  }

  createSignedDownloadUrl(key: string, ttlSeconds: number): Promise<SignedUrl> {
    return Promise.resolve(this.signedUrl(key, "download", ttlSeconds));
  }

  putObject(key: string, data: Uint8Array): Promise<void> {
    this.objects.set(key, Uint8Array.from(data));
    return Promise.resolve();
  }

  getObject(key: string): Promise<Uint8Array | null> {
    const value = this.objects.get(key);
    return Promise.resolve(value ? Uint8Array.from(value) : null);
  }

  deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }
}
