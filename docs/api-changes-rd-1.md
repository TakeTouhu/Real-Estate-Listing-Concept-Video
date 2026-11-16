# API Changes — RD-1

The web app's adapters are chosen in one place (ADR-0150). **No migration,
no new route and no page.**

## HTTP

No change. Every route and page answers as before, with the same adapters
from the same environment.

## Internal API

### Added: `apps/web/src/lib/adapters.ts`

| Export | Shape |
| --- | --- |
| `WebAdapterChoice` | the adapter of each port: `storage` (`"shared-folder"` or `"memory"`), `malwareScanner` (`"passthrough"`), `email` (`"outbox"` or `"none"`), `imageAnalysis` (`"deterministic"`), `promptModeration` (`"offline"`) |
| `chooseWebAdapters(env)` | the choice, from the environment alone; builds nothing |
| `WebAdapters` | the choice, and per port a function that builds the adapter when first called and keeps it: `storage`, `malwareScanner`, `images`, `imageAnalysis`, `promptModerator`; `email` opens the outbox for each message, or answers `null` when no email is configured |
| `createWebAdapters(env)` | the adapters `env` chooses; every development adapter refuses production by the configured or the ambient `NODE_ENV` |
| `getWebAdapters()` | the web app's one set, from its configured environment |

### Removed: `apps/web/src/lib/property.ts`

| Export | Replaced by |
| --- | --- |
| `createObjectStorage(env)` | `createWebAdapters(env).storage()` |
