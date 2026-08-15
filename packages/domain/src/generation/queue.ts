/**
 * The boundary through which a generation attempt is handed to asynchronous
 * execution.
 *
 * Domain-owned on purpose: the orchestration service depends on this interface,
 * not on `@app/queue`, so the queue technology is a Phase 4C decision that
 * cannot leak into domain code. `@app/queue` stays a placeholder until then.
 */

/**
 * The **entire** payload for one scene-generation job.
 *
 * A `generationId` and nothing else. This is not minimalism for its own sake —
 * every other fact the worker needs (project, asset, prompt, provider, tenant)
 * is already persisted on the row the id points at, and putting any of it on the
 * wire would duplicate authority and risk the queue carrying a stale or, worse,
 * a sensitive copy. In particular the payload never carries an API key, provider
 * credentials, a compiled prompt, a temporary URL, a prediction id, or an
 * organization secret.
 *
 * A direct consequence, deferred to Phase 4C by decision (ADR-0017): a worker
 * holding only this id cannot load the row through the tenant-facing repository,
 * whose every method requires an `organizationId`. Resolving that needs a
 * trusted, system-scoped lookup — it is **not** solved by widening this payload.
 */
export interface SceneGenerationJob {
  readonly generationId: string;
}

/**
 * Enqueue a scene-generation job for asynchronous execution.
 *
 * The port is deliberately one method. There is no ack, no delay, no priority,
 * and no dequeue here: this milestone only needs to hand a durable row's id to
 * the queue, and inventing the rest before Phase 4C has a worker would be
 * speculative surface. A rejected promise means the job was **not** accepted;
 * the caller keeps the persisted row in `QUEUED` and does not audit it as
 * started (see `GenerationService.startScene`).
 */
export interface SceneGenerationQueue {
  enqueue(job: SceneGenerationJob): Promise<void>;
}
