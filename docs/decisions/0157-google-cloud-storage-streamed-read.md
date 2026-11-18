# ADR-0157 — Google Cloud Storage: the streamed read

Status: Accepted (RD-3b, 2026-11-18). The second part of the third milestone
of production readiness, part 1, which the product owner approved on
2026-11-16 (`/mnt/project-files/cto/production-readiness-proposal.md`). It
adds the port's streamed read to the Google Cloud Storage adapter ADR-0156
wrote, which makes the adapter an `ObjectStorage`. Nothing constructs it
yet.

Builds on: ADR-0115 (the port's streamed read, and that a read holds nothing
open once it is read or cancelled), ADR-0156 (the adapter, its client, how
absence is proved, how a question is limited and how a refusal is named).

## Context

`readObject(key, range)` answers an object's bytes, or one range of them, as
a stream the caller reads to its end or cancels, with the object's size. Its
one caller is the signed download route, which serves a customer's video and
lets a player seek. The shared folder's tests are its contract: absent,
unsatisfiable, ranges, an object read in chunks, closed early, an object
written again while it is read, a read cut short, a failed read naming
nothing, an empty object, and keys refused.

Four investigations, each alone, measured gaxios's streams against
stand-ins, the emulator, Google's documentation and the repository, and a
fifth checked what they found against each other. The results are in
`/mnt/project-files/cto/rd-3/rd-3b-measured.json`. What decides this record:

- gaxios hands a media answer over as node-fetch's Node.js stream.
  node-fetch checks neither `Content-Length` nor `Content-Range`: an answer
  saying 100 bytes that sent 200 in one packet ended cleanly with none, and
  a chunked answer ends cleanly with whatever it carried.
- By default the request asks for a compressed answer and decodes one: a
  stand-in's answer of the first 100 bytes of a gzip-encoded body was
  decoded into 76,112 bytes with no error.
- gaxios's `timeout` keeps running once the headers are in: given 1 second,
  a body that took 2.5 failed at 1.02.
- Destroying the answer let its connection go in every state after the
  headers. Aborting it did nothing once the whole answer had arrived, and
  ending its iterator did nothing while a read of it waited.
- On the emulator, a read pinned to a generation answers `404` once that
  generation is overwritten or deleted, in a bucket without versioning; with
  versioning, the old generation is still read. A generation of `0`, or an
  empty one, pins nothing.
- Google documents that an object overwritten between ranged reads can
  corrupt what is read (`docs.cloud.google.com/storage/docs/consistency`),
  that a download in several requests sends the object's generation with
  each (`.../sliced-object-downloads`), and that an object stored with
  `Content-Encoding: gzip` is served decoded and whole, its range ignored,
  to a request that does not accept gzip (`.../transcoding`).

## Decision 1 — The size first, then that generation's bytes

A read asks twice:

1. `GET
   /storage/v1/b/{bucket}/o/{key}?fields=size,generation,contentEncoding`,
   with the question limit (Decision 4). A `404` is proved by the list
   ADR-0156 Decision 2 asks: the object is absent, or the bucket is missing.
   The size and the generation are read as Cloud Storage writes them,
   decimal strings; the generation is kept as written, never as a number,
   since it can pass 2^53, and `0` is refused.
2. `GET /storage/v1/b/{bucket}/o/{key}?alt=media&generation={generation}`,
   with `Range: bytes={first}-{last}`.

The range is resolved against the size by the port's own
`resolveObjectByteRange`, so a range of the last bytes is sent as the bytes
it names. A range that holds none of the object's bytes, and an object of
none, ask nothing more, as Google's Go client asks nothing for an object of
no bytes. A read of the whole object asks for the range of all of it, so
every read is one kind of request.

The second request is made before the read returns. So the bytes read are
those of the generation whose size was read even when the key is written
again before the first of them is taken, as the shared folder's contract
holds, and a store that refuses them is a thrown error, which the route
answers `500`, not a response that breaks partway. That costs a request for
every read, the `HEAD` the route answers among them, which lets it go at
once: on the emulator, over sixteen runs, between 1,946 and 66,481 bytes of
a 64 MiB object had reached the process on its one connection when it did,
the size's answer included.

The answer is asked for as stored: `accept-encoding: identity`, and gaxios
told not to decode (`compress: false`, passed through to node-fetch).

## Decision 2 — The answer taken

An answer is taken when it is `206` with `Content-Range: bytes
{first}-{last}/{size}` exactly, or `200` to a range of the whole object;
says, if it says them, as many bytes as asked, no encoding but `identity`,
and the generation asked (`x-goog-generation`). `Content-Length` and
`x-goog-generation` are checked, not required: no page of the JSON API
promises them, and Google's own Go client reads an answer whose length it is
not told.

An object whose metadata names an encoding is refused before its bytes are
asked for: Google serves it decoded and whole, so its size counts other
bytes than those served.

Any other answer is destroyed at once, so its connection is not held, and:

| Answer | What the read does |
| --- | --- |
| `404` | asks the list: the object is absent, or the bucket is missing; when the key is still listed it was written again between the two requests, `STORAGE_OBJECT_CHANGED` |
| any other `2xx`, or `416` | `STORAGE_UNEXPECTED_ANSWER`: a generation's bytes never change, so a range of them that held cannot stop holding |
| any other status | its code, as ADR-0156 Decision 4 names it |

A read is not asked again after a change: nothing is (ADR-0156). Its caller
is told, by a code.

## Decision 3 — The stream

The bytes are a web `ReadableStream` written by hand, with a high-water mark
of 0, which takes one read of the answer, all it holds then, for each read
of the stream, and none before the first. Node.js's own `Readable.toWeb`
took 130,943 bytes before the first read; a stream written this way took
none.

- **It counts.** It ends once it has handed over exactly the bytes asked
  for, whether or not the answer has ended, so an answer that goes on past
  them holds nothing. An answer that ends short of them, or brings a chunk
  past them, ends the stream with `STORAGE_UNEXPECTED_ANSWER`, and a
  transport failure with its own one-word code; nothing of the failure,
  which can name the request's address, is kept.
- **It lets go.** The answer is destroyed when the last byte is handed over,
  on cancel and on failure. A read to its end still keeps its connection for
  the next request: on the emulator it did 24 times of 24, for objects of 10
  bytes, 200,000 bytes and 3 MiB. After a cancel, what the release ends is
  not reported: the reader has gone.
- **What bounds it.** A chunk is what the answer holds when it is read, up
  to 130,943 bytes measured. Below the stream, about 256 KiB is taken from
  the connection before the reader asks, and the operating system holds
  more: of a 64 MiB answer the stand-in had sent between 3,866,624 and
  5,570,560 bytes, over six runs, when the reader, having read two chunks,
  stopped. TCP's flow control holds the rest until the reader asks.

The plan named an `AbortController` for cancel. None is used: the read
returns only after the headers, when destroying the answer lets its
connection go in every state and an abort does not, and nothing cancels a
read before then, since the route gives `readObject` no signal. So only
gaxios's own limit aborts a request, as ADR-0156 reads an abort.

## Decision 4 — How long it waits

The size is a question that moves no object's bytes: it is given
`GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS`, gaxios's own 3-second setting, as
ADR-0156 Decision 3 gives a list.

The bytes are given no limit, as a whole object's read is not. gaxios's
`timeout` would end a long video partway. A limit on the headers alone would
be a deadline written in the repository's code, which the product owner's
rule puts to them first and the scheduler guard refuses; a limit an HTTP
agent of the adapter's own keeps, on an idle connection, was measured to
work, but such an agent bypasses gaxios's choice of proxy, which RD-3c
decides. So:

- a store that answers the size but never the headers of the bytes holds the
  download's request;
- once the headers are in, a store that stalls holds the stream until the
  client leaves, when the route lets it go: measured with Next.js 15.5.22's
  own pipe and a stream written this way, a client that left after 1,099,634
  bytes had the stream cancelled and its connection let go.

Both are recorded as open (`docs/decisions/TODO.md`).

## Decision 5 — Where it stands

This amends ADR-0156 Decision 7.

- `createGoogleCloudStorage` returns an `ObjectStorage`;
  `GoogleCloudStorageObjects`, the port without `readObject`, is removed.
- Nothing in either application constructs it, and it sends no credential;
  the test that holds this is unchanged, but for its comment.
- `GoogleCloudStorageError` gains `STORAGE_OBJECT_CHANGED`, and
  `STORAGE_UNEXPECTED_ANSWER` also names an answer that is not the bytes
  asked for.

## What the emulator cannot show

What Google answers is not measured: whether a generation overwritten in a
bucket without versioning answers `404`; whether an answer already streaming
is cut when its object is overwritten or deleted, which the emulator streams
to its end; whether `fields` trims the size's answer, which the emulator
ignores; whether a range's answer says its length; and anything over TLS.
The stream ends with a code if an answer is cut, and nothing read relies on
the rest. They are checks for the first deployment
(`docs/decisions/TODO.md`).

## What was measured

On this machine, against the emulator built from v1.56.1's source and
against stand-ins on `127.0.0.1`:

- The emulator suite, 15 tests, 7 of them new: the shared folder's
  streamed-read contract but the two that need a failing store; absent; the
  whole object, a range, the last bytes and a range past the end, with the
  size; unsatisfiable, asking nothing; an object of 3 MiB read across the
  transport's chunks; a reader that stops early, its connection let go; an
  object written again after the read began, read as it was; an empty
  object, asking nothing. The suite's escaped keys, refused keys and missing
  bucket now read too.
- The stand-in suite, 39 tests, 14 of them new: the two requests, once each,
  pinned and ranged as above; a whole object answered `200`, a range
  answered `200` refused, one from the first byte among them; nothing asked
  past the size when no byte is; absence before the size and before the
  bytes, and a key written again between them; the sizes, generations and
  encodings refused before the bytes; each answer refused, by its code
  alone; a short and a long answer ending the stream; a store that hangs up
  partway ending it with `ECONNRESET`, keeping nothing, its connection
  closed; nothing read from the answer before the first read of the stream,
  and one read of it for each; a reader that stops, its connection closed
  with at most 5,570,560 of 67,108,864 bytes sent over six runs; a stream
  ended at its range's last byte, and its connection let go, while the
  answer goes on; a chunk past the range ending the stream, the rest let go;
  a refused answer of 64 MiB let go likewise; the size given 3.0 seconds;
  the bytes given more than 3.5. The read is added to the tests of keys,
  statuses, a missing bucket and a store that hangs up.
- Both suites pass with `HTTPS_PROXY` naming a proxy that is not there.

## Consequences

- No production behaviour changes: nothing constructs the adapter, the route
  is unchanged, and no migration is added.
- A read that finds its object costs two requests against the bucket, the
  size and the bytes, and three when the bytes' request answers `404` and
  the list follows. An absent object or a missing bucket costs two, the size
  and the list; a range or an object that holds no bytes costs one, the size
  alone. A read needs `storage.objects.get` and, after a `404`,
  `storage.objects.list`.
- RD-3c wires the adapter into the web app (ADR-0158).
- Nothing is activated: no timer, loop or schedule, no paid call, no
  production credential, no deploy, no Google account.
