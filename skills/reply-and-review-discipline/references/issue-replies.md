# Issue Reply Specimens

The rules are in `SKILL.md` (Replies to Issue Reporters); this page carries the full specimens the rules were written against.

## Cause visible in the report: diagnosis, then steps

A diagnostics-only bug report whose log already showed the cause three times over: a stray backtick at the end of the server address, a refused connection on the port, and no API key. The first reply still opened with a `## Questions` list of three; none of the answers would have changed the diagnosis. The rewrite:

`````markdown
## What the report shows

**The server address ends in a stray backtick**, so every request goes to an address that does not exist:

```
server.url = "http://localhost:4000`"      <- the ` after 4000
GET http://localhost:4000`/v1/models
connect ECONNREFUSED 127.0.0.1:4000        <- nothing answered on port 4000
server.apiKey = (unset)                    <- no key configured
```

- **Nothing is listening on port 4000.** The connection was refused before any request went out, so the server is not running, or runs on another port.
- **No API key is set.** A server started with one rejects every request without it.

## What to do

1. **Remove the backtick** from `server.url` in `config.json`.
2. **Start the server**, then confirm it answers: `curl http://localhost:4000/health`.
3. **Set `server.apiKey`** in the same file if the server requires one.

If it still fails after these steps, run the tool with `--verbose` and paste the log lines after `GET`.
`````

## Cause not in the report: questions first

A diagnostics-only bug report whose log ended mid-request, so nothing in it said what failed. The first reply opened with three paragraphs on hidden server entries, tombstones, and silent refreshes. The rewrite:

`````markdown
## Questions

1. **What went wrong?** One or two sentences, or a screenshot.
2. **Is `https://<host>/@<user>` an API server?** If yes, does it need an API key?
3. **Can you paste the log lines after the last request?** Run the tool with `--verbose` and copy everything after the line starting with `GET`.

Number 3 would help the most. The rest of this comment explains why, if you are curious.

## What the report shows

**The report was sent before anything failed.** The last log line is the tool asking your server for its model list. No answer had arrived yet:

```
GET https://<host>/@<user>/v1/models    <- last line, still waiting
```

- **The server you removed** pointed at `https://<host>/`. The tool remembers that and keeps its models out of the picker. That is expected, not an error.
- **The server you added** is at `https://<host>/@<user>` with no API key.

**A guess, to save a round trip:** a URL with `/@username` in it and no API key usually is not an API server.

<details>
<summary>Technical details</summary>

- **Hidden server:** `server hidden: removed by the user` means the `servers` entry was removed. The host cannot unregister a server once shown, so the tool keeps a tombstone and answers with an empty model list. Docs: [Lifecycle: renames, removals, hidden servers](...).
- **Where the log stops:** `GET .../v1/models` is the first discovery request. The log buffer holds 50 lines and no error was recorded, so the report was built inside this request's 30 second timeout.

</details>
`````

The details block exists because the buffer size and the timeout explain why the log stops where it does; nothing in part one depends on it.

## The reporter's language first, then English

Both halves are complete replies under the rules above, each with its own details block when the reply has one, a rule between them:

`````markdown
## Ce que le rapport montre
...
## Que faire
1. ...

<details>
<summary>Détails techniques</summary>
...
</details>

---

## What the report shows
...
## What to do
1. ...

<details>
<summary>Technical details</summary>
...
</details>
`````
