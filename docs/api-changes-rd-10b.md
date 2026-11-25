# API Changes — RD-10b

Every redirect a route handler sends now names a path, never an address
built from `request.url` (ADR-0175 Decision 7, which RD-10b builds; the
ADR itself is unchanged). **An HTTP change, with no migration, no
dependency and no new setting.** No status code changes: every one of
these redirects was a `303 See Other` and still is.

## Why

A production server builds `request.url` on its own bind address, not
on the `Host` the client sent. RD-10a's CI job `web-image` measured it
on the image as committed: its logout probe printed `303` with
`Location: http://0.0.0.0:3000/login`, the bind address, not the `Host`
it was asked on. Since RD-9e every page sends `form-action 'self'`, so a
browser refuses to follow such a redirect after a form post, and behind
a proxy it would name an address no customer can reach.

## HTTP

The `Location` of each redirect below is now a path on this site, with
the same query and fragment as before, written the same way
(`URLSearchParams`, so a space is `+`):

```text
before  Location: http://0.0.0.0:3000/login?error=Sign+in+failed
after   Location: /login?error=Sign+in+failed
```

A browser resolves a relative `Location` against the address it asked
(RFC 9110, section 10.2.2), so it stays on whatever host it used. The
status, the cookies each answer sets or deletes, and every other header
are as before. `request.url` is still read for a query
(`new URL(request.url).searchParams`) in four route files and in
`apps/web/src/lib/request.ts`; nothing else in a route file reads it.

Every route that redirects, each `POST` (the `GET` of `/api/properties`
answers JSON and does not redirect), each `303` before and after:

| Route | Where it sends the browser |
| --- | --- |
| `/api/auth/login` | `/login?error=…`, or the sign-in's next page |
| `/api/auth/logout` | `/login` |
| `/api/auth/mfa` | `/login/mfa?error=…`, `/login?error=…`, `/`, or the next page |
| `/api/auth/register` | `/login?error=…`, or `/verify-email` with any notice |
| `/api/auth/reset-password/request` | `/reset-password?notice=…` |
| `/api/auth/reset-password` | `/reset-password?notice=…` |
| `/api/auth/verify-email/resend` | `/login`, `/`, the next page, or `/verify-email?notice=…` |
| `/api/auth/verify-email` | `/verify-email?notice=…` |
| `/api/invitations/accept` | `/login`, `/?joined=…`, or `/accept-invitation?error=…` |
| `/api/invitations/dismiss` | `/` |
| `/api/organizations` | `/login`, `/`, or `/?error=…` |
| `/api/organizations/{o}/mfa-requirement` | `/login`, `/`, or `/?error=…` |
| `/api/organizations/{o}/groups` | `/login`, or the groups page with its code |
| `/api/organizations/{o}/groups/{g}/rename` | the same |
| `/api/organizations/{o}/groups/{g}/delete` | the same |
| `/api/organizations/{o}/groups/{g}/members` | the same |
| `/api/organizations/{o}/groups/{g}/members/{u}/remove` | the same |
| `/api/organizations/{o}/groups/{g}/permissions/grant` | the same |
| `/api/organizations/{o}/groups/{g}/permissions/revoke` | the same |
| `/api/organizations/{o}/invitations` | `/login`, or the members page with its code |
| `/api/organizations/{o}/invitations/{i}/cancel` | the same |
| `/api/organizations/{o}/members/{u}/role` | the same |
| `/api/organizations/{o}/members/{u}/remove` | the same |
| `/api/organizations/{o}/members/{u}/permissions/grant` | `/login`, the member's permissions page with its code, or the members page |
| `/api/organizations/{o}/members/{u}/permissions/revoke` | the same |
| `/api/organizations/{o}/properties/{p}/assignment` | `/login`, or the Property page with its code |
| `/api/organizations/{o}/unit-purchases` | `/login`, the buy page with `error`, or the Units page with `purchased=1` |
| `/api/properties` | `/login`, `/?error=…`, or the new Property's page |
| `/api/video-projects/{v}/generations` | `/login`, the start page with `error`, or the project page with `started=1` |
| `/api/video-projects/{v}/download` | `/login`, the project page with `download` and `retry`, or the signed link |

The one absolute `Location` left is the download route's signed link
when the storage adapter signs one on its own address (Cloud Storage):
that is the store's address, from the adapter, never one built from the
request, and is sent as before if it is an `https:` address; any other
scheme is now refused, and no adapter signs one. A link the local
adapter signs is a path (`/api/storage/download?token=…`) and was
already sent as one. Only the download route calls
`seeOtherToSignedLink`, and the guard test holds that.

Pages are unchanged: their `redirect()` (`next/navigation`, 23 calls in
15 pages) already named paths, and Next.js sends them as given (`GET /`
signed out answers `307`, `Location: /login`, measured on the
production build).

## Code

- `apps/web/src/lib/redirect.ts`: `seeOther(path)` answers `303` with the
  path as `Location`, through `new NextResponse`, so the answer's cookies
  can still be set or deleted (`NextResponse.redirect` throws on a
  relative address). It throws unless the path starts with exactly one
  `/`, its second character is neither `/` nor `\`, and it holds no
  control character (a browser drops a tab or line break before it
  reads). The path is then parsed as a browser resolves it, so
  dot-segments are removed and anything beyond ASCII is
  percent-encoded, and what is sent must still start with one `/` and
  hold only printable ASCII but `\`: `/a/..//x` and `/a/../\x` are
  refused. `pathWithQuery(path, query)` writes a query as
  `URL.searchParams.set` did, with the same checks.
  `seeOtherToSignedLink(link)` is the download route's: a path, or an
  `https:` address.
- `redirectWithError(path, message)` and the page builders
  (`groupsPage`, `membersPage`, `memberPermissionsPage`, `propertyPage`,
  `verifyEmailPage`, `resetPasswordPage`, `acceptInvitationPage`,
  `joinedPage`) no longer take the request's address and return a path.
- `tests/api/relative-redirect-coverage.test.ts` holds that no source
  file of the web app but the helper calls `redirect` on anything, names
  a `Location` header or a `301` to `308`, or reads `request.url` but
  for its query; that a route file names its handler's request
  `request`; and that only the download route calls
  `seeOtherToSignedLink`. It strips comments as TypeScript reads the
  file, so a `//` in a string hides nothing after it.
- CI's `web-image` job asks the image to sign out with `Host:
  app.rd10.test` and requires `303`, `Location: /login` and the
  session cookie deleted; `tests/container-images.test.ts` holds those
  lines.
