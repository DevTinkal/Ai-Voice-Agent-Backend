# Single knowledge source (filesystem)

Place your large company knowledge dump here:

```text
backend/knowledge/company.txt
```

Or set:

```text
KNOWLEDGE_SOURCE_PATH=/absolute/or/relative/path/to/file.txt
```

On server start the backend:

1. Hashes the file (SHA-256)
2. Re-indexes into Mongo chunks **only if the hash changed**
3. Gemini Live retrieves relevant snippets via `searchKnowledge` — the full file is never put in `systemInstruction`

`company.txt` is gitignored when large. Keep this README and `.gitkeep`.
