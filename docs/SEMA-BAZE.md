# MacroPilot – šema baze podataka

Baza je jedan SQLite fajl (`macropilot.db`) u folderu sa podacima. Koristi se Node-ov ugrađeni `node:sqlite`, sa WAL
režimom i stranim ključevima. Izvorna definicija je u [`src/server/db/schema.ts`](../src/server/db/schema.ts), a migracije se
primenjuju automatski pri pokretanju.

**Pravilo šifrovanja:** svaka kolona `payload` sadrži AES-256-GCM blob:
`[verzija 1B][nonce 12B][šifrovani tekst][tag 16B]`. Nešifrovano su samo ID-jevi, vremena, brojači i enumi. AAD
(dodatni autentifikovani podaci) vezuje blob za njegov red, pa se šifrovana vrednost ne može premestiti u drugi red.

```mermaid
erDiagram
    macros ||--o{ macro_versions : "ima verzije"
    macros ||--o{ facts : "sadrži činjenice"
    sources ||--o{ facts : "izvor činjenice"
    sources ||--o{ source_snapshots : "snimci izvora"
    accuracy_runs ||--o{ fact_checks : "rezultati"
    facts ||--o{ fact_checks : "provere"
    macros ||--o{ update_proposals : "predlozi izmena"
    accuracy_runs ||--o{ update_proposals : "nastali u proveri"

    macros {
        TEXT id PK
        INTEGER current_version
        TEXT created_at
        TEXT updated_at
        TEXT archived_at "soft delete"
        INTEGER is_favorite
        INTEGER use_count
        TEXT last_used_at
        TEXT verification "verified|unverified|outdated|conflict"
    }
    macro_versions {
        TEXT macro_id PK,FK
        INTEGER version PK
        TEXT created_at
        TEXT change_source "create|manual|import|revert|seed|accuracy_check|learning"
        TEXT content_hmac "otisak sadržaja (HMAC)"
        BLOB payload "šifrovano: sadržaj + beleška o izmeni"
    }
    facts {
        TEXT id PK
        TEXT macro_id FK
        INTEGER sort
        TEXT status "unchecked|verified|outdated|contradicted|unverifiable"
        TEXT last_checked_at
        TEXT source_id FK
        BLOB payload "šifrovano: ključ, tvrdnja, vrednost, URL, citat"
    }
    categories {
        TEXT id PK
        INTEGER sort
        TEXT created_at
        BLOB payload "šifrovano: naziv, boja"
    }
    sources {
        TEXT id PK
        TEXT type "intercom_help_center|web_page|google_doc|google_sheet|confluence_page|slack_canvas|manual"
        INTEGER enabled
        TEXT last_fetched_at
        TEXT last_status
        BLOB payload "šifrovano: naziv, URL, konfiguracija"
    }
    source_snapshots {
        TEXT id PK
        TEXT source_id FK
        TEXT fetched_at
        TEXT content_hmac
        BLOB payload "šifrovano: pasusi + otisci"
    }
    accuracy_runs {
        TEXT id PK
        TEXT trigger "schedule|manual|startup"
        TEXT started_at
        TEXT finished_at
        TEXT status
        TEXT stats "samo brojke"
    }
    fact_checks {
        TEXT id PK
        TEXT run_id FK
        TEXT fact_id FK
        TEXT verdict
        TEXT method "unchanged_source|deterministic|llm|manual"
        BLOB payload "šifrovano: dokaz, predlog"
    }
    update_proposals {
        TEXT id PK
        TEXT macro_id FK
        TEXT run_id FK
        INTEGER base_version
        TEXT status "pending|approved|rejected|auto_approved|superseded"
        TEXT severity "minor|major"
        BLOB payload "šifrovano: novi sadržaj, diff, razlozi, linkovi"
    }
```

## Tabele

### Biblioteka (Faza 1)

| Tabela | Svrha | Šifrovano (`payload`) |
|---|---|---|
| `macros` | Jedan red po makrou: trenutna verzija, omiljen, broj i vreme korišćenja, zbirni status provere, arhiviran | – (samo metapodaci) |
| `macro_versions` | Kompletna istorija sadržaja. Svaka izmena je nova verzija. Revert pravi novu verziju sa starim sadržajem | `{content: {title, body, categoryId, tags, intents, triggers, notes, shortcut}, changeNote}` |
| `facts` | Atomske činjenice makroa i njihov status | `{key, statement, value, sourceUrl, evidenceQuote}` |
| `categories` | Kategorije makroa | `{name, color}` |
| `settings` | Podešavanja (`app`) i tajne (`secret:anthropic_api_key`, privremeno `secret:pending_recovery_key`) | ceo JSON |
| `meta` | Verzija šeme, `key_check` (šifrovani kanarinac za proveru ključa), `recovery_wrapped` (glavni ključ šifrovan ključem za oporavak), `recovery_ack`, `seeded` | `key_check` je šifrovan. `recovery_wrapped` je šifrovan ključem za oporavak (scrypt + AES-GCM) |
| `embeddings` | Keš vektora po `(model, content_hmac)`, da se pri startu ništa ne računa ponovo | bajtovi vektora |
| `events` | Anonimna analitika: prikazano, izabrano, kopirano, bez poklapanja. **Nikad tekst poruke** | `{type, macroIds, rank, confidence, intents, editRatio, mode}` |
| `llm_usage` | Potrošnja tokena i trošak po mesecu (za limit budžeta) | – (samo brojke) |

### Provera tačnosti (Faza 3, tabele postoje od početka da se šema ne menja)

| Tabela | Svrha |
|---|---|
| `sources` | Povezani izvori istine: Help Center, stranice sajta, Google Docs/Sheets, Confluence, Slack canvas, ručno unete činjenice |
| `source_snapshots` | Poslednji snimci izvora podeljeni na pasuse sa HMAC otiscima. Nepromenjen pasus znači da proveru nije potrebno ponavljati |
| `accuracy_runs` | Svako pokretanje provere: zakazano, ručno ili nadoknada pri startu |
| `fact_checks` | Rezultat po činjenici: presuda, metod (nepromenjen izvor, deterministički, LLM, ručno) i dokaz |
| `update_proposals` | Predlozi izmena makroa (staro/novo, razlozi, linkovi) koji čekaju odobrenje |
| `jobs` | Raspored: `accuracy_check` sa intervalom od 48 h, `next_run_at`, `last_run_at` |

## AAD konvencije

| Tabela | AAD |
|---|---|
| categories | `categories:<id>` |
| macro_versions | `macro_versions:<macro_id>:<version>` |
| facts | `facts:<id>` |
| settings | `settings:<key>` |
| embeddings | `embeddings:<model>:<content_hmac>` |
| events | `events:<uid>` |
| sources / source_snapshots / fact_checks / update_proposals | `<tabela>:<id>` |
| meta key_check | `meta:key_check` |

## Zadržavanje podataka

- Poruke kupaca se **ne upisuju nikad**.
- `events` se brišu posle `privacy.analyticsRetentionDays` (podrazumevano 90), pri startu i na svakih 6 sati.
- Verzije makroa se čuvaju trajno, jer su istorija izmena. Trajno brisanje makroa briše i njegove verzije i činjenice
  (`ON DELETE CASCADE`).
- Šifrovani backup (`.mpbackup`) sadrži izvoz biblioteke i glavni ključ zaštićen ključem za oporavak.
