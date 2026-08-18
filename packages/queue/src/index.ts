/**
 * @app/queue — **empty by decision, not by omission** (ADR-0024).
 *
 * This package was scaffolded in Phase 0 for a job transport, and its original
 * description promised "job queue and worker plumbing (enqueue, heartbeat,
 * retry, dead-letter), implemented in Phase 4". Phase 4C-1a decided against all
 * of it: the `SceneGeneration` row is the durable queue, discovered by
 * `state = 'QUEUED'`, so there is nothing to enqueue and no delivery to
 * heartbeat.
 *
 * The package survives as a module boundary only. Do not fill it with a broker
 * client — Redis/BullMQ, SQS and Azure Service Bus were each evaluated and
 * rejected in ADR-0024, and introducing one is a decision that must supersede
 * that ADR rather than a gap to be closed here.
 */
export const PACKAGE_NAME = "@app/queue";
