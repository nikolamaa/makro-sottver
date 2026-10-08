# MacroPilot

**Pametni asistent za makro poruke za agente korisničke podrške u Intercomu (iGaming / Stake.com).**

Nalepiš poruku kupca i MacroPilot za delić sekunde:

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
- Internet samo za instalaciju paketa. Posle toga aplikacija radi i bez interneta.

### Najlakše (dvoklik)

| Sistem | Pokreni |
|---|---|
| Windows | `MacroPilot.cmd` |
| macOS | `MacroPilot.command` (prvi put: desni klik → Open) |
| Linux | `./macropilot.sh` |

Pri prvom pokretanju se automatski instaliraju paketi i pravi build (oko 1 minut). Posle ažuriranja koje promeni
`package.json` ili `package-lock.json` launcher ponovo instalira pakete i pravi nov build.

Zatim se otvori browser na **pristupnom linku** `http://localhost:4317/#/assist?k=<token>`. Isti link se ispisuje i u
prozoru launchera (konzoli). Token je izveden iz glavnog ključa, isti je pri svakom pokretanju i **ne deli ga**: ko
ima link, ima pristup biblioteci. Browser zapamti token (localStorage) i odmah ga ukloni iz adresne linije, pa u istom
browseru posle toga radi i obična adresa `http://localhost:4317`. U drugom browseru ili profilu bez tokena pojavljuje
se ekran „Open MacroPilot from the launcher …“: pokreni launcher ponovo ili otvori link iz konzole.

Prvi put ćeš videti **ključ za oporavak**: sačuvaj ga u password manager i potvrdi.

Za jedan folder sa podacima radi **samo jedan MacroPilot**. Ako launcher pokreneš ponovo dok aplikacija radi, on otvori
postojeću instancu i završi se, umesto da pokrene drugi server nad istom bazom.

### Iz terminala

```bash
npm install          # jednom i posle ažuriranja koje menja pakete
npm run build        # posle svake izmene koda
npm start            # pokreće server, ispisuje pristupni link i otvara browser
```

Ostale komande:

```bash
npm run dev          # razvoj: server (tsx watch) + Vite sa hot reload-om; otvori Vite link sa tokenom
                     # koji server ispiše (http://localhost:5173/#/assist?k=…)
npm test             # svi testovi (vitest)
npm run typecheck    # TypeScript provera servera i UI-ja
npm run eval         # tačnost preporuka na tri skupa poruka (vidi „Kvalitet preporuka“)
npm run test:e2e     # end-to-end test u headless Chromium-u (vidi napomenu ispod)
npm run recover      # vraćanje pristupa šifrovanoj bazi pomoću ključa za oporavak (unos se ne prikazuje)
npm run docs:prompts # ponovo generiše docs/PROMPTOVI.md iz koda
```

`npm run test:e2e` traži Chromium: postavi `E2E_CHROMIUM=<putanja do chrome/chromium>` ili jednom pokreni
`npx playwright-core install chromium`. Build se pravi sam samo ako `dist/` ne postoji, pa posle izmena koda prvo
pokreni `npm run build`.

---

## Svakodnevni rad (prečice)

Na stranici **Assist**:

| Prečica | Radnja |
|---|---|
| `Ctrl+V` | nalepi poruku kupca i odmah dobij preporuke. Radi bilo gde na stranici Assist van tekstualnih polja, a u polju za poruku kada je prazno ili je ceo tekst označen. Sa drugih stranica prvo `Alt+Shift+A` |
| `Ctrl+Shift+V` | pročitaj clipboard kao novu poruku (ne u drugim tekstualnim poljima, gde ostaje „nalepi kao običan tekst“) |
| `Alt+1` / `Alt+2` / `Alt+3` | izaberi preporuku (radi i dok je fokus u poruci). Tasteri `1`/`2`/`3` bez Alt-a rade samo kada fokus nije u tekstualnom polju, a u poruci se upisuju kao tekst |
| `Alt+4` (ili `4` van tekstualnih polja) | izaberi makro koji „AI suggests“ predlaže van liste (samo uz AI proveru preporuka) |
| `Alt+Shift+1..3` | dodaj ili ukloni makro iz spajanja (više pitanja → jedan odgovor) |
| `Alt+↓` / `Alt+↑` | sledeća ili prethodna preporuka |
| `Ctrl+Enter` | **kopiraj odgovor** |
| `Ctrl+J` | AI dorada (ako je AI uključen) |
| `Ctrl+E` / `Alt+M` | fokus na odgovor / na poruku |
| `Esc` | nova poruka: iz polja za poruku (gde je fokus posle `Ctrl+V`) ili van tekstualnih polja. U polju za odgovor i ostalim poljima prvi `Esc` samo izlazi iz polja, a drugi briše |

Na svim stranicama:

| Prečica | Radnja |
|---|---|
| `Ctrl+K` | brza fuzzy pretraga svih makroa (`Enter` koristi u Assist-u, `Ctrl+Enter` kopira tekst, `Alt+Enter` otvara u Library, `Esc` zatvara) |
| `Alt+Shift+A` / `L` / `I` / `S` | Assist / Library / Import / Settings |

Ostalo: u **Library** `/` je pretraga, `↑`/`↓` i `Enter` otvaraju makro, `Alt+N` pravi nov, `Ctrl+S` čuva, a `Alt+I`
ubacuje promenljivu u tekst. U **Import** `Ctrl+O` bira fajl, `Ctrl+Enter` pravi pregled, a `Ctrl+Shift+Enter` uvozi.
U **Settings** `Ctrl+S` odmah čuva.

Na macOS-u umesto `Ctrl` koristi `⌘`, a umesto `Alt` taster `⌥ Option`.

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
CSV i JSON. Jedan uvoz može imati do 30 MB i 20.000 makroa.

Duplikati se prepoznaju po naslovu, i prema postojećim makroima i unutar istog uvoza. Za duplikat biraš **Skip**,
**Save as new version** ili **Create a copy**. „Save as new version“ pravi novu verziju sa uvezenim tekstom, a
činjenice, kategoriju, tagove, namere, primere pitanja, belešku i šifru koje uvoz ne sadrži zadržava od postojećeg
makroa.

Promenljive koje MacroPilot sam popunjava iz poruke: `{{user}}`, `{{username}}`, `{{email}}`, `{{amount}}`,
`{{currency}}`, `{{crypto}}`, `{{network}}`, `{{tx_hash}}`, `{{bet_id}}`, `{{vip_rank}}`, `{{bonus_name}}`,
`{{document_type}}`, `{{game}}`, `{{provider}}`. Vrednosti koje zavise od pravila kompanije (`{{eta_time}}`,
`{{bonus_amount}}`, `{{link}}`, `{{date}}`) nikad se ne pogađaju i ostaju kao prazno mesto `[ENTER …]`.

### Backup i vraćanje

**Import / Export → Encrypted backup** pravi šifrovan `.mpbackup` sa svim makroima (i arhiviranim), njihovim
činjenicama i kategorijama. **Restore a backup** ga otvara uz ključ za oporavak, a makroi se pojave u pregledu za
uvoz. Radi i za velike biblioteke (fajl do oko 40 MB, do 20.000 makroa). Arhivirani makroi se vraćaju kao arhivirani,
omiljeni ostaju omiljeni, a nove kategorije dobijaju izvezenu boju. Ako isti backup vratiš dvaput, arhivirani makroi
se ne dupliraju. Istorija verzija, brojači korišćenja i podešavanja nisu deo backup-a.

---

## AI (opciono) i troškovi

| Režim | Cena | Napomena |
|---|---|---|
| **Off** (podrazumevano) | $0 | Preporuke + šablon + ton, odmah |
| **Claude Haiku 5.5** | ≈ $0,0004 po AI doradi + ≈ $0,0002–0,0003 po poruci za AI proveru preporuka. Za 150 poruka dnevno oko **$2–3 mesečno** | Settings → AI → nalepi Anthropic API ključ. Postoji mesečni limit troška (podrazumevano $5) i pseudonimizacija ličnih podataka |
| **Ollama** | $0 | Instaliraj [Ollama](https://ollama.com), pa `ollama pull qwen2.5:3b`. Sporije na računarima bez GPU-a |

Cene su za Claude Haiku 5.5 ($0,10 / $0,50 po milion ulaznih/izlaznih tokena). Iznos od $2–3 mesečno pretpostavlja AI
doradu i AI proveru za svaku poruku. Bez AI dorade ostaje samo provera, oko $1 mesečno.

**AI provera preporuka** (Settings → AI → „AI double-check of recommendations“, podrazumevano uključena kad je AI
podešen): posle trenutne lokalne preporuke AI u pozadini ponovo oceni do 8 najboljih kandidata i objasni najbolji
izbor, bez menjanja redosleda kartica, izbora i teksta odgovora. Pokreće se za svaku novu poruku.

Semantička pretraga radi i bez AI-ja. Podrazumevano se koristi ugrađeni vektorizator, a ako je dostupan, i lokalni
neuralni model `bge-small-en-v1.5` (~35 MB, preuzima se jednom sa Hugging Face-a). Može i Ollama embeddings model, ali
samo kada je Ollama na ovom računaru (`localhost`). Za Ollama adresu na drugom računaru pretraga koristi ugrađene
vektore. Sve tri opcije su besplatne.

---

## Kvalitet preporuka

`npm run eval` meri preporuke nad 60 demo makroa sa ugrađenim vektorizatorom (bez AI-ja). Rezultati trenutnog koda:

| Skup poruka | Poruke sa makroom | Top-1 | Top-3 | „Nema dobrog poklapanja“ prepoznato | Lažno „nema poklapanja“ |
|---|---|---|---|---|---|
| Originalni (na njemu je podešavana pretraga) | 81 | 92,6% | 100% | 7 od 12 | 0 od 81 |
| Slepi holdout 1 | 30 | 93,3% | 96,7% | 10 od 16 | 1 od 30 |
| Slepi holdout 2 | 61 | 85,2% | 96,7% | 10 od 19 | 6 od 61 |

Na slepim skupovima, koji nisu korišćeni za podešavanje, prvi predlog je tačan u 85–93% slučajeva, a tačan makro je
među tri prikazana u oko 97%. Slabija tačka su pitanja blizu teme za koja nema makroa: lokalna provera „nema dobrog
poklapanja“ prepozna otprilike polovinu takvih pitanja (27 od 47 u sva tri skupa). Ostala dobiju preporuku, obično sa
nižim procentom. Opciona AI provera preporuka je namenjena upravo tome, jer prikazuje napomenu kada nijedan makro ne
odgovara u potpunosti.

Analiza i pretraga na serveru traju 2–10 ms po poruci. U UI-ju se zahtev šalje posle 120 ms debounce-a, pa se
preporuke pojave oko 0,2 s posle lepljenja.

---

## Bezbednost i privatnost (ukratko)

- Svi makroi, verzije, činjenice, podešavanja, API ključ, analitika i vektori su šifrovani **AES-256-GCM**. Fajl baze
  bez ključa je neupotrebljiv.
- Glavni ključ je u **OS keychain-u** (Windows Credential Manager / macOS Keychain). Ako keychain nije dostupan,
  čuva se u zaštićenom fajlu u drugom folderu od baze.
- **Ključ za oporavak** služi za backup na drugom računaru i za `npm run recover`. Novi ključ (Settings → Security)
  menja samo zaštitu istog glavnog ključa: `npm run recover` i novi backup-ovi traže novi ključ, a stariji backup-ovi
  i stare kopije foldera sa podacima i dalje se otvaraju starim. Zato novi ključ ne štiti od starog ključa koji je
  već procureo: ako se to desi, napravi nov backup i obriši stare backup-ove i kopije foldera. Novi ključ se prikazuje
  ponovo („Show recovery key“) dok ne potvrdiš da si ga sačuvao.
- Poruke kupaca se **ne čuvaju**. Analitika ne sadrži tekst.
- Pre slanja u cloud AI (doradu, nacrt i AI proveru preporuka) lični podaci se zamenjuju tokenima, a u odgovoru
  vraćaju lokalno (Settings → AI → „Pseudonymize personal data“, podrazumevano uključeno). Pokriveni su mejl, korisničko
  ime, telefon, tx hash, adresa novčanika, Bet ID, ime iz poruke („I'm Ana“, „My name is …“, potpis) i ime kupca koje
  agent upiše, kao i IBAN, broj kartice, datum rođenja, broj pasoša ili lične karte i adresa stanovanja. Ograničenja:
  ime napisano malim ili samo velikim slovima („im jovana“) i ime treće osobe („my brother Marko“) se ne prepoznaju,
  osim kada ga agent upiše u „Customer name“ tačno kako piše u poruci (poređenje razlikuje velika i mala slova).
- „Strogo lokalno“ (Settings → Privacy → „Never send anything to cloud services“) blokira AI pozive van ovog
  računara: Claude i Ollama na drugom računaru. Ollama embeddings se ionako koriste samo sa lokalnim Ollama-om. Jedini
  izlazak na mrežu koji ostaje je jednokratno preuzimanje lokalnog modela za pretragu (bez ikakvih podataka).
- Server sluša samo na `127.0.0.1`. Svaki API zahtev mora da nosi pristupni token iz linka koji otvara launcher, pa
  drugi korisnici istog računara (npr. na RDS/Citrix serveru) i tuđi sajtovi ne mogu da koriste aplikaciju. Uz to se
  proveravaju `Host` i `Origin` zaglavlja.

Detalji su u [docs/ARHITEKTURA.md](docs/ARHITEKTURA.md#6-šifrovanje-predlog-i-odgovor-na-dilemu-šifrovanje-vs-provera-tačnosti).

### Gde su podaci

| Sistem | Baza | Rezervni fajl ključa |
|---|---|---|
| Windows | `%APPDATA%\MacroPilot\data` | `%LOCALAPPDATA%\MacroPilot\keys` |
| macOS | `~/Library/Application Support/MacroPilot/data` | `~/Library/Application Support/MacroPilot Keys` |
| Linux | `~/.local/share/macropilot` | `~/.config/macropilot/keys` |

Putanje se mogu promeniti promenljivama `MACROPILOT_DATA_DIR`, `MACROPILOT_KEY_DIR` i `MACROPILOT_PORT`, a
`MACROPILOT_NO_OPEN=1` sprečava otvaranje browsera (link je i dalje u konzoli). Podrazumevani port je 4317. Ako je
zauzet, koristi se sledeći slobodan (do +10). Dok server radi, u folderu sa podacima stoji `macropilot.lock` (PID, port,
vreme pokretanja, bez tokena), po kome sledeće pokretanje nalazi postojeću instancu. Fajl koji ostane posle pada
aplikacije se prepoznaje i zamenjuje: kada proces više ne postoji ili kada se na portu niko ne javi ni posle 60 s. U
`npm run dev` režimu podaci su u `.macropilot-data/` u repozitorijumu.

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
seed/           demo makroi (Stake Help Center) i skupovi poruka za eval
scripts/        launcher, eval, e2e, generator dokumentacije promptova
docs/           arhitektura, šema baze, promptovi, plan faza
```
