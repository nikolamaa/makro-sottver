# MacroPilot

**Pametni asistent za makro poruke za agente korisničke podrške u Intercomu (iGaming / Stake.com).**

Nalepiš poruku kupca i MacroPilot za nekoliko milisekundi:

1. analizira nameru, raspoloženje, hitnost, sva pitanja, ključne podatke (iznos, kripto, tx hash, VIP rank …) i
   signale problematičnog kockanja,
2. preporuči 1–3 najbolja makroa sa procentom pouzdanosti i objašnjenjem,
3. prilagodi izabrani makro: ime, promenljive, ton prema raspoloženju, više pitanja odjednom, jasno označena prazna
   mesta `[ENTER ETA TIME]` umesto izmišljenih podataka,
4. jednim tasterom (`Ctrl+Enter`) kopira odgovor, koji nalepiš u Intercom.

Sve radi **lokalno na tvom računaru**, bez prijave i **besplatno**. AI dorada (Claude Haiku 5.5 ili lokalni Ollama) je
opciona. Svi makroi i podešavanja su **šifrovani** (AES-256-GCM), a ključ je u sistemskom keychain-u.

> Dokumentacija: [arhitektura](docs/ARHITEKTURA.md) · [šema baze](docs/SEMA-BAZE.md) ·
> [AI promptovi](docs/PROMPTOVI.md) · [plan po fazama](docs/PLAN-FAZA.md)

---

## Pokretanje

### Potrebno

- **Node.js 22.13 ili noviji** ([nodejs.org](https://nodejs.org), verzija „LTS“)
- Windows 10/11, macOS ili Linux
- Internet samo za prvu instalaciju paketa. Posle toga aplikacija radi i bez interneta.

### Najlakše (dvoklik)

| Sistem | Pokreni |
|---|---|
| Windows | `MacroPilot.cmd` |
| macOS | `MacroPilot.command` (prvi put: desni klik → Open) |
| Linux | `./macropilot.sh` |

Pri prvom pokretanju se automatski instaliraju paketi i pravi build (oko 1 minut). Zatim se otvori browser na
`http://localhost:4317`. Prvi put ćeš videti **ključ za oporavak**: sačuvaj ga u password manager i potvrdi.

### Iz terminala

```bash
npm install          # jednom
npm run build        # posle svake izmene koda
npm start            # pokreće server i otvara browser
```

Ostale komande:

```bash
npm run dev          # razvoj: server (tsx watch) + Vite na http://localhost:5173 sa hot reload-om
npm test             # svi testovi (vitest)
npm run typecheck    # TypeScript provera servera i UI-ja
npm run eval         # tačnost preporuka na test skupu poruka
npm run test:e2e     # end-to-end test u headless Chromium-u (zahteva build)
npm run recover      # vraćanje pristupa šifrovanoj bazi pomoću ključa za oporavak
```

---

## Svakodnevni rad (prečice)

| Prečica | Radnja |
|---|---|
| `Ctrl+V` bilo gde | nalepi poruku kupca i odmah dobij preporuke |
| `Ctrl+Shift+V` | pročitaj clipboard |
| `Alt+1` / `Alt+2` / `Alt+3` (ili `1`/`2`/`3`) | izaberi preporuku |
| `Alt+Shift+1..3` | dodaj ili ukloni makro iz spajanja (više pitanja → jedan odgovor) |
| `Alt+↓` / `Alt+↑` | sledeća ili prethodna preporuka |
| `Ctrl+Enter` | **kopiraj odgovor** |
| `Ctrl+J` | AI dorada (ako je AI uključen) |
| `Ctrl+E` / `Alt+M` | fokus na odgovor / na poruku |
| `Ctrl+K` | brza fuzzy pretraga svih makroa (`Enter` koristi, `Ctrl+Enter` kopira, `Alt+Enter` otvara) |
| `Esc` | nova poruka |
| `Alt+Shift+1..4` | Assist / Library / Import / Settings |

Na macOS-u umesto `Ctrl` koristi `⌘`.

---

## Prenos makroa iz Intercoma

Pošto nemaš dozvolu za izvoz, makroe kopiraš ručno u **Import / Export → Paste text**, u ovom formatu:

```text
### Pending crypto withdrawal
Category: Withdrawals
Tags: crypto, pending
Intents: withdrawal_pending
Hi {{first_name | fallback: "there"}},
Thanks for reaching out! ...
---
### Sledeći makro
...
```

Intercom promenljive se automatski pretvaraju (`{{first_name | fallback: "there"}}` → `{{user|there}}`). Podržani su i
CSV i JSON. Duplikati se prepoznaju po naslovu.

Promenljive koje MacroPilot sam popunjava iz poruke: `{{user}}`, `{{username}}`, `{{email}}`, `{{amount}}`,
`{{currency}}`, `{{crypto}}`, `{{network}}`, `{{tx_hash}}`, `{{bet_id}}`, `{{vip_rank}}`, `{{bonus_name}}`,
`{{document_type}}`, `{{game}}`, `{{provider}}`. Vrednosti koje zavise od pravila kompanije (`{{eta_time}}`,
`{{bonus_amount}}`, `{{link}}`, `{{date}}`) nikad se ne pogađaju i ostaju kao prazno mesto `[ENTER …]`.

---

## AI (opciono) i troškovi

| Režim | Cena | Napomena |
|---|---|---|
| **Off** (podrazumevano) | $0 | Preporuke + šablon + ton, odmah |
| **Claude Haiku 5.5** | ≈ $0,0004 po odgovoru, oko $1–2 mesečno | Settings → AI → nalepi Anthropic API ključ. Postoji mesečni limit troška i pseudonimizacija ličnih podataka |
| **Ollama** | $0 | Instaliraj [Ollama](https://ollama.com), pa `ollama pull qwen2.5:3b`. Sporije na računarima bez GPU-a |

Semantička pretraga radi i bez AI-ja. Podrazumevano se koristi ugrađeni vektorizator, a ako je dostupan, i lokalni
neuralni model `bge-small-en-v1.5` (~35 MB, preuzima se jednom). Oba su besplatna.

---

## Bezbednost i privatnost (ukratko)

- Svi makroi, verzije, činjenice, podešavanja, API ključ, analitika i vektori su šifrovani **AES-256-GCM**. Fajl baze
  bez ključa je neupotrebljiv.
- Glavni ključ je u **OS keychain-u** (Windows Credential Manager / macOS Keychain). Ako keychain nije dostupan,
  čuva se u zaštićenom fajlu u drugom folderu od baze.
- **Ključ za oporavak** služi za backup na drugom računaru i za `npm run recover`.
- Poruke kupaca se **ne čuvaju**. Analitika ne sadrži tekst. Pre slanja u cloud AI lični podaci se zamenjuju tokenima.
- Server sluša samo na `127.0.0.1` i odbija zahteve sa drugih sajtova (Host/Origin provera i obavezno zaglavlje).

Detalji su u [docs/ARHITEKTURA.md](docs/ARHITEKTURA.md#6-šifrovanje-predlog-i-odgovor-na-dilemu-šifrovanje-vs-provera-tačnosti).

### Gde su podaci

| Sistem | Baza | Rezervni fajl ključa |
|---|---|---|
| Windows | `%APPDATA%\MacroPilot\data` | `%LOCALAPPDATA%\MacroPilot\keys` |
| macOS | `~/Library/Application Support/MacroPilot/data` | `~/Library/Application Support/MacroPilot Keys` |
| Linux | `~/.local/share/macropilot` | `~/.config/macropilot/keys` |

Putanje se mogu promeniti promenljivama `MACROPILOT_DATA_DIR`, `MACROPILOT_KEY_DIR` i `MACROPILOT_PORT`. U `npm run dev`
režimu podaci su u `.macropilot-data/` u repozitorijumu.

---

## Demo makroi

Pri prvom pokretanju biblioteka se puni demo makroima napravljenim iz **javnih članaka Stake Help Centra**
(`help.stake.com/en`). Svaka činjenica ima link ka članku i doslovni citat. Možeš ih menjati, arhivirati ili obrisati.
Ako ne želiš demo podatke, postavi `MACROPILOT_NO_SEED=1` pre prvog pokretanja.

---

## Struktura projekta

```
src/shared/     tipovi i API ugovor (server ↔ UI), šablon-engine
src/server/     Fastify server: crypto, db, analysis, search, personalize, ai, importexport, services, api
src/web/        React UI (Assist, Library, Import/Export, Settings)
seed/           demo makroi (Stake Help Center)
scripts/        launcher, eval, e2e
docs/           arhitektura, šema baze, promptovi, plan faza
```
