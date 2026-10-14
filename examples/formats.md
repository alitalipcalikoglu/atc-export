# CSV and NDJSON output

## CSV

RFC 4180: a header row with the source's `columns`, CRLF line ends, UTF-8. A cell is quoted when it contains `,` `"` CR or LF or has leading/trailing spaces; quotes are doubled.

```
id,email,name,status
u1,ada@example.com,"Lovelace, Ada",active
u2,bob@example.com,"Bob ""the builder""",active
```

**Formula-injection guard.** A spreadsheet treats a cell starting with `=`, `+`, `-` or `@` as a formula. Every string cell that starts with one of those (also after leading spaces), or with a tab or CR, gets a `'` prefix:

```
u3,eve@example.com,'=HYPERLINK("http://evil","click"),active
```

Control characters other than tab, CR and LF are removed before the check, so `"\u0001=1+1"` is written as `'=1+1`. Numbers and booleans are written as they are: `-5` from a numeric field is data. A string `"-5"` is still a string and gets the prefix.

Arrays and objects (tags, environments, meta) become one JSON cell: `"[""promo"",""q4""]"`. Missing values are empty cells.

## NDJSON

One JSON object per line (`\n`), with the same keys as the CSV columns but nested values kept as JSON. Not guarded: NDJSON is read by programs, not spreadsheets.

```
{"seq":1,"id":"e1","at":"2026-10-01T08:00:00.000Z","source":"atc-auth","action":"atc-auth.login","outcome":"failure","actorType":"user","actorId":"u1","meta":{"reason":"bad_password"}}
```

## Empty exports

A CSV export with no rows is a file with only the header. An NDJSON export with no rows succeeds with `progress.rows: 0` and no file; `download` answers `409 NO_FILE`.

## Limits

`EXPORT_MAX_ROWS` (100 000) and `EXPORT_MAX_BYTES` (20 MiB) stop an export with `TOO_MANY_ROWS` / `TOO_LARGE`; nothing partial is stored. Narrow the filters instead of raising the limits past atc-media's `MAX_UPLOAD_BYTES`.
