# scripts/

Strumenti operativi per il plugin `opencode-claude-code-plugin`.

## Indice

- [Import sessioni Claude Code in OpenCode](#import-sessioni-claude-code-in-opencode)
  - [Avvio](#avvio)
  - [REPL interattivo (comandi)](#repl-interattivo-comandi)
  - [Esempi di uso](#esempi-di-uso)
  - [Campi mostrati nella lista](#campi-mostrati-nella-lista)
  - [Flag CLI](#flag-cli)
  - [Collocamento automatico del progetto](#collocamento-automatico-del-progetto)
  - [Cosa viene preservato / cosa viene perso](#cosa-viene-preservato--cosa-viene-perso)
  - [Requisiti](#requisiti)
  - [Troubleshooting](#troubleshooting)
- [Note di progetto - fix vision](#note-di-progetto---fix-vision)

---

## Import sessioni Claude Code in OpenCode

Script: `import_claude_to_opencode.py`

Importa nel database di OpenCode le sessioni `.jsonl` generate dalla CLI di
Claude Code (cartella `~/.claude/projects/`), cosi' che la cronologia sia
navigabile dalla UI di OpenCode.

### Avvio

```bash
python scripts/import_claude_to_opencode.py               # REPL interattivo
python scripts/import_claude_to_opencode.py openbao       # REPL con filtro iniziale
python scripts/import_claude_to_opencode.py --dir dmm     # pre-filtra per cwd path
python scripts/import_claude_to_opencode.py --limit 50    # cambia page size (default 20)
```

L'avvio indicizza tutte le sessioni disponibili (ordinate per ultima attivita'
utente, piu' recenti in cima), stampa le prime `--limit` righe ed entra nel
REPL.

### REPL interattivo (comandi)

Al prompt `>` si possono digitare:

| Input | Effetto |
|-------|---------|
| `openbao` (keyword libera) | Filtra la lista per keyword (cerca in titolo, primo prompt, `cwd`) |
| `openbao \| 50` | Filtra e imposta il page size a 50 |
| `1` | Importa la sessione all'indice 1 della lista mostrata |
| `1 3 5` | Importa piu' sessioni |
| `1-5` | Range |
| `all` | Importa tutte le sessioni attualmente mostrate |
| `last 30` | Mostra le prime 30 della lista corrente |
| `clear` | Rimuove il filtro e torna alla lista completa |
| `help` | Stampa l'elenco dei comandi |
| `q` / `exit` | Esce |

Dopo un import la lista filtrata rimane attiva: si puo' fare subito un'altra
ricerca senza ripartire da zero.

### Esempi di uso

**1. Trovare e importare per titolo custom.**
Le chat rinominate dalla UI di Claude Code salvano un `customTitle` nel
`.jsonl`. Lo script lo riconosce e lo marca con un `*`.

```
> test saluto

1 match(es) for 'test saluto'.
  [  1]* 2026-04-17 11:35  T=  1  ...New folder   test saluto

> 1
Importing [1] 8b9e371d-*.jsonl  (test saluto)
  OK: session ses_... -> C:\...\New folder
```

**2. Import in batch delle ultime 10 sessioni di un progetto specifico.**

```bash
python scripts/import_claude_to_opencode.py --dir dmm-installations --limit 10
```

Poi al prompt: `all`.

**3. Batch mode non interattivo (legacy):**

```bash
python scripts/import_claude_to_opencode.py openbao --limit 5 --batch
```

Stampa, chiede una volta la selezione con il vecchio prompt (`1 3`, `all`, `q`)
e esce.

### Campi mostrati nella lista

```
  [  N]<marker> YYYY-MM-DD HH:MM  T=<turns>  <cwd>   <title>
```

| Campo | Significato |
|-------|-------------|
| `N` | Indice usato per selezionare nei comandi |
| `marker` | `*` se la chat ha un `customTitle` impostato dalla UI di Claude Code; spazio altrimenti |
| `YYYY-MM-DD HH:MM` | Timestamp dell'ultimo messaggio utente (last activity) |
| `T=<turns>` | Numero di turni user (escludendo i tool_result) |
| `cwd` | Working directory originale (troncato se lungo) |
| `title` | `customTitle` se presente, altrimenti primo prompt (troncato) |

Ordine default: per ultimo messaggio utente, decrescente.

### Flag CLI

| Flag | Default | Descrizione |
|------|---------|-------------|
| `query` (pos.) | - | Keyword iniziale, entra nel REPL gia' filtrato |
| `--dir <substr>` | - | Pre-filtra per substring in `cwd` prima di indicizzare |
| `--limit <N>` | `20` | Page size nel REPL |
| `--batch` | `false` | Modalita' non interattiva (un solo ciclo) |
| `--model opus\|sonnet\|haiku` | auto-detect | Forza il `modelID` |
| `--project-id <id>` | auto-match | Forza project_id target |
| `--db <path>` | `~/.local/share/opencode/opencode.db` | Path del DB OpenCode |

### Collocamento automatico del progetto

1. Legge il primo `cwd` dal `.jsonl`.
2. Cerca `project.worktree == cwd` in OpenCode. Se esiste, usa quel progetto.
3. Altrimenti fallback al progetto `global` (worktree `/`).
4. `session.directory` resta comunque il `cwd` originale, quindi la session
   compare sotto la cartella corretta nella UI di OpenCode.

Override: `--project-id <id>`.

### Cosa viene preservato / cosa viene perso

Preservato:

- Titolo custom (`customTitle`) quando presente
- Prompt utente e testi/reasoning assistant
- Tool call con `input` + `output` (match via `tool_use_id`)
- Token per turno (massimo tra gli eventi assistant del turno, che sono
  cumulativi come nel runtime del plugin — evita doppi conteggi)
- Ordine cronologico

Perso:

- Immagini e allegati binari
- Sub-agent chain (`isSidechain: true`)
- Signature crypt dei thinking block
- Snapshot git reale (placeholder `000...000`)

### Requisiti

- Python 3 (stdlib `sqlite3`, nessuna dipendenza esterna)
- OpenCode chiuso durante l'import (WAL SQLite)

### Troubleshooting

| Sintomo | Causa | Azione |
|---------|-------|--------|
| `OpenCode DB not found` | Path DB errato | Passare `--db <path>` |
| `database is locked` | OpenCode in esecuzione | Chiudere OpenCode |
| Nessun match dopo una keyword | Filtro troppo stretto | `clear`, o keyword piu' generica |
| Il titolo importato non e' quello che vedo in Claude UI | Solo i rename fatti dalla UI di Claude Code creano `customTitle` nel `.jsonl`. I titoli generati solo nel cloud di Claude app non sono disponibili localmente | Rinominare la chat da Claude Code, poi reimportare |

---

## Note di progetto - fix vision

La gestione immagini richiede due modifiche concomitanti:

1. `src/message-builder.ts`: conversione `part.type === "file" | "image"` in
   blocco Anthropic `{type: "image", source: {type: "base64", media_type, data}}`.
2. `opencode.json`: sui modelli abilitati alla vision aggiungere
   `"attachment": true` e
   `"modalities": { "input": ["text", "image"], "output": ["text"] }`.

Senza il secondo punto, OpenCode filtra i file part prima della chiamata al
plugin, sostituendoli con il placeholder `[Image #N]` nel testo.

Modelli compatibili con vision (API Anthropic): Haiku 4.5, Sonnet 4.6, Opus 4.7.
Formati immagine supportati: `image/png`, `image/jpeg`, `image/gif`, `image/webp`.
