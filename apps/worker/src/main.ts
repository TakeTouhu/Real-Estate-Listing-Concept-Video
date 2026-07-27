import { bootstrapWorker } from "./bootstrap";

bootstrapWorker()
  .then((result) => {
    if (!result.ready) process.exit(1);
  })
  .catch((error) => {
    console.error("worker bootstrap failed", error);
    process.exit(1);
  });
