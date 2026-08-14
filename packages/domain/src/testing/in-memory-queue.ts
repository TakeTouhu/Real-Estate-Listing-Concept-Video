import type { SceneGenerationJob, SceneGenerationQueue } from "../generation/queue";

/**
 * A recording queue double for service tests.
 *
 * It records what was enqueued so a test can assert both the count and the exact
 * payload shape, and it can be armed to fail the next enqueue so the
 * enqueue-failure path is exercised against a real rejection rather than a
 * mocked one. Deliberately test-only: it is not a production queue and lives in
 * the `testing` module for that reason.
 */
export class RecordingSceneGenerationQueue implements SceneGenerationQueue {
  private readonly enqueued: SceneGenerationJob[] = [];
  private failure: Error | null = null;

  /** Arm the queue to reject the **next** enqueue with `error`, once. */
  failNext(error: Error = new Error("queue unavailable")): void {
    this.failure = error;
  }

  enqueue(job: SceneGenerationJob): Promise<void> {
    if (this.failure) {
      const error = this.failure;
      this.failure = null;
      return Promise.reject(error);
    }
    // Store a copy so a later mutation of the argument cannot rewrite history.
    this.enqueued.push({ ...job });
    return Promise.resolve();
  }

  /** Every job accepted so far, in order. */
  jobs(): readonly SceneGenerationJob[] {
    return [...this.enqueued];
  }

  /** How many jobs were accepted. */
  get count(): number {
    return this.enqueued.length;
  }
}
