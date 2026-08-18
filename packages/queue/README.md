# @app/queue

**Empty by decision, not by omission** (ADR-0024).

Scaffolded in Phase 0 for a job transport. Phase 4C-1a decided against one: the
`SceneGeneration` row is the durable queue, discovered by `state = 'QUEUED'`, so
there is nothing to enqueue and no delivery to heartbeat.

Module boundary only. Do not fill this with a broker client — Redis/BullMQ, SQS
and Azure Service Bus were each evaluated and rejected in ADR-0024, and adding
one must supersede that decision rather than close a gap.
