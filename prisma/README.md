# prisma

The Prisma schema and migrations now live with the database package:

- Schema: `packages/database/prisma/schema.prisma`
- Migrations: `packages/database/prisma/migrations/`

Generate the client and apply migrations from that package:

```bash
pnpm --filter @app/database run db:generate
pnpm --filter @app/database run db:migrate        # deploy committed migrations
pnpm --filter @app/database run db:migrate:dev     # create a new dev migration
```

`prisma generate` also runs automatically on `pnpm install`.
