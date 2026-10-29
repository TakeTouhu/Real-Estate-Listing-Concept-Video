# API change summary — a Property's rename and deletion as conditional writes (ADR-0101)

No HTTP route, request or response changes: no route renames or deletes a
Property yet.

| Export | Change |
| --- | --- |
| `PropertyRepository` (`@app/domain`) | `update(property)` removed; `updateDetails(organizationId, id, change)` writes only the named fields while the Property is in the organization and not deleted, `null` otherwise; `markDeleted(organizationId, id)` writes the status alone, once, `false` otherwise |
| `PropertyDetailsChange` (`@app/domain`) | new: the fields a change may name (name, type, masked address, description) |
| `PropertyService.update` / `remove` (`@app/domain`) | a Property deleted since their read, or by another deletion first, is answered `NOT_FOUND` with no audit entry |
| `createPrismaPropertyRepositories(prisma)` (`@app/database`) | implements the two methods |
| `InMemoryPropertyRepository` (`@app/domain/testing`) | implements the two methods with the same conditions |
