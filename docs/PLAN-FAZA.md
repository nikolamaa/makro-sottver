# MacroPilot – plan razvoja po fazama

Plan je prilagođen tvojim odgovorima: aplikacija je lična i lokalna, nema prijave, radi preko clipboard-a, piše samo na
engleskom, a proveravaće tačnost na svaka 2 dana (Faza 3, još nije implementirano). Faza 2 iz originalnog zahteva bila
je Intercom integracija, a pošto ona nije potrebna, Faza 2 je sada posvećena **brzini na desktopu**. Intercom opcije
ostaju opisane kao dodatak.

---

## Faza 1 – MVP (implementirano u ovom repozitorijumu)

**Cilj:** agent nalepi poruku i za manje od sekunde dobije odgovor spreman za kopiranje, potpuno besplatno i lokalno.
Sve u tabeli je implementirano.

| Oblast | Šta je urađeno |
|---|---|
| Biblioteka makroa | Kreiranje, izmena, arhiviranje, vraćanje, trajno brisanje. Kategorije, tagovi, namere, primeri pitanja, interna beleška, kratka šifra, omiljeni |
| Promenljive | `{{user}}`, `{{user\|there}}` (rezervna vrednost), standardni rečnik od 19 promenljivih, pregled uživo sa označenim praznim mestima |
| Činjenice | Lista činjenica po makrou (ključ, tvrdnja, vrednost, link, citat, status) i zbirni status makroa sa upozorenjem pri preporuci |
| Verzije | Svaka izmena sadržaja makroa je nova verzija, sa prikazom razlika reč po reč i vraćanjem na bilo koju verziju. Činjenice se ne verzionišu: menjaju se na mestu, a vraćanje verzije ih ne vraća |
| Uvoz/izvoz | Nalepljen tekst (format za ručno kopiranje iz Intercoma), CSV, JSON, do 30 MB i 20.000 makroa po uvozu. Konverzija Intercom promenljivih, detekcija duplikata po naslovu (i unutar istog uvoza) sa izborom preskoči / nova verzija (zadržava činjenice i metapodatke koje uvoz nema) / kopija. Izvoz u šifrovani backup ili JSON. Vraćanje backup-a zadržava arhivirane, omiljene i boje kategorija |
| Analiza poruke | Lokalno, < 5 ms: 21 iGaming namera, raspoloženje, hitnost, 19 tipova entiteta, sva pitanja, RG rizik, detekcija ne-engleskog teksta |
| Preporuka | Hibridna pretraga (BM25 + vektori + namera + upotreba), 1–3 rezultata sa % i razlogom, upozorenje „nema dobrog poklapanja“, pokrivanje više pitanja. Opciona AI provera preporuka u pozadini |
| Prilagođavanje | Brzo (šablon + entiteti + ton + spajanje do 3 makroa) i AI (Claude Haiku 5.5 / Ollama) uz pseudonimizaciju (entiteti analizatora + PII skener) i guardrail protiv izmišljanja |
| AI nacrt | Kada nijedan makro ne odgovara: AI nacrt (ili prazan kostur bez AI-ja) i čuvanje kao novi makro |
| Brzina i ergonomija | `Ctrl+V` bilo gde na stranici Assist, `Alt+1..3` izbor, `Ctrl+Enter` kopiranje, `Ctrl+K` fuzzy pretraga, `Ctrl+J` AI dorada, omiljeni i najčešće korišćeni. Lista u Library prikazuje samo vidljive redove |
| Bezbednost | AES-256-GCM za sve, ključ u OS keychain-u, ključ za oporavak (i njegova zamena uz potvrdu), `npm run recover`, pristupni token za lokalni API, „Strogo lokalno“ režim, CSP |
| Demo podaci | Makroi i činjenice izvučeni iz javnog Stake Help Centra, svaka činjenica sa linkom i doslovnim citatom |
| Pokretanje | Dvoklik na `MacroPilot.cmd` (Windows) ili `macropilot.sh` / `MacroPilot.command`. Instalacija i build se rade automatski, i ponovo posle ažuriranja paketa. Otvara se pristupni link, a ponovno pokretanje otvara postojeću instancu |

**Kriterijumi prihvatanja:** preporuka za manje od 100 ms na serveru, bez AI-ja (izmereno 2–10 ms; u UI-ju se zbog
debounce-a od 120 ms preporuke pojave oko 0,2 s posle lepljenja) · top-1 tačnost ≥ 85% na test skupu poruka (izmereno
92,6% na originalnom skupu, 93,3% i 85,2% na dva slepa holdout skupa, vidi README „Kvalitet preporuka“) · nijedan tekst
makroa nije čitljiv u fajlu baze · ništa se ne šalje kupcu automatski · sve radi bez interneta i bez API ključa.

---

## Faza 2 – Desktop brzina (umesto Intercom integracije)

**Cilj:** od poruke u Intercomu do odgovora u clipboard-u za 2 tastera, bez prebacivanja prozora mišem.

1. **Desktop omotač (Tauri ili Electron)** oko postojećeg servera:
   - **globalna prečica** (npr. `Ctrl+Shift+Space`): pročita clipboard i otvori mali plutajući prozor sa preporukama
     iznad Intercoma. `Enter` kopira najbolji odgovor i sakrije prozor, pa agent samo nalepi sa `Ctrl+V`,
   - ikonica u tray-u, automatsko pokretanje sa sistemom, jedan instalacioni fajl (`.exe` / `.dmg`), pa Node.js nije
     potreban,
   - automatska ažuriranja.
2. **Opcionalna Chrome ekstenzija:** dugme pored Intercom razgovora „Pošalji poslednju poruku u MacroPilot“ i
   „Nalepi u composer“, preko lokalnog API-ja. Radi preko DOM-a, ne preko Intercom API-ja, pa nisu potrebna admin prava.
   Zavisi od Intercom HTML strukture, zato je opciona.
3. **Pamćenje promenljivih po razgovoru:** ime kupca i VIP rank ostaju upamćeni dok agent ne obriše poruku.
4. **Prečice po makrou:** kratka šifra (npr. `wd-pending`) plus `Tab` u brzoj pretrazi kopira makro direktno.

*Dodatak (ako dobiješ admin prava u Intercomu):* Intercom Inbox aplikacija u bočnom panelu, preko Canvas Kit-a i REST
API-ja: čitanje poslednje poruke i atributa kontakta, ubacivanje kao interna beleška. Arhitektura to podržava, jer bi to
bio novi „ulaz“ u isti AssistService.

**Procena:** 5–8 radnih dana.

---

## Faza 3 – Automatska provera tačnosti (na svaka 2 dana)

**Cilj:** makroi nikad ne šalju zastarele informacije, a svaka izmena prolazi kroz tvoje odobrenje.

**Već postoji:** tabele (`sources`, `source_snapshots`, `accuracy_runs`, `fact_checks`, `update_proposals`, `jobs`),
promptovi „fact check“ i „macro update“ i podešavanja (uključeno, interval 48 h, auto-odobravanje sitnih izmena), koja
se čuvaju, ali još nemaju efekta (u Settings stoji „Coming in Phase 3“). Planer, preuzimanje izvora i sama provera još
ne postoje.

1. **Izvori istine** (tabela `sources`):
   - **Stake Help Center** (`help.stake.com/en`): preuzimanje kolekcija i članaka sa javnog sajta, uz ETag/Last-Modified,
   - **stranice sajta** (URL + opcioni CSS selektor): uslovi, bonusi, VIP, limiti,
   - **Google Docs / Sheets**: link za izvoz (`/export?format=txt|csv`) za dokumente podeljene linkom, ili Google OAuth
     za privatne,
   - **Confluence**: REST API v2 sa tvojim mejlom i API tokenom (lični token je dovoljan),
   - **Slack**: canvas ili zakačene poruke iz izabranih kanala, preko tvog user tokena,
   - **ručne „zvanične činjenice“** koje uneseš u aplikaciji.
2. **Planer:** posao `accuracy_check` na svakih 48 h (podesivo), uz ručno pokretanje. Ako je računar bio ugašen,
   provera se nadoknađuje pri sledećem pokretanju.
3. **Provera po činjenici** (detalji u ARHITEKTURA.md 6.4):
   1. Izvor se deli na pasuse sa HMAC otiscima. Nepromenjen pasus zadržava status *verified* bez AI-ja.
   2. Lokalno poređenje brojeva, procenata, rokova i linkova.
   3. Za dvosmislene slučajeve AI prompt „fact check“ (PROMPTOVI.md 5) dobija samo činjenicu i pasus. Doslovni citat
      dokaza se proverava lokalno.
4. **Predlozi izmena:** prompt „macro update“ (PROMPTOVI.md 6) pravi minimalnu izmenu, a UI je prikazuje kao diff
   staro/novo sa linkom ka izvoru. Ti odobravaš, odbijaš ili menjaš. Opcija „auto-odobri sitne izmene“ pokriva samo
   promenjen link ili formatiranje, nikad promenu pravila ili iznosa.
5. **Upozorenja:** makro sa zastarelom ili kontradiktornom činjenicom dobija crveni ili narandžasti baner kad se
   preporuči.
6. **Obaveštenja:** značka u aplikaciji, sistemska desktop notifikacija i opciono Slack poruka tebi lično (incoming
   webhook).

**Kriterijumi prihvatanja:** ručno pokretanje za 300 činjenica traje manje od 2 minuta · nepromenjeni izvori ne
troše AI · svaki predlog ima link i doslovni citat · ništa se ne menja bez odobrenja, osim uključenih sitnih izmena.

**Procena:** 6–9 radnih dana.

---

## Faza 4 – Analitika i učenje

**Cilj:** biblioteka se sama poboljšava na osnovu tvog rada.

1. **Dashboard:** najčešće preporučeni i korišćeni makroi, koliko često je prva preporuka prihvaćena, prosečan
   procenat izmene teksta pre kopiranja, pouzdanost kroz vreme, teme bez makroa.
2. **„Uvek menjaš isti deo“:** pri kopiranju se lokalno računa diff po rečenicama između generisanog i kopiranog teksta.
   Čuvaju se samo indeksi izmenjenih rečenica makroa, a pseudonimizovan novi tekst samo ako ne sadrži lične podatke.
   Kada se ista rečenica menja u većini korišćenja, aplikacija predlaže trajnu izmenu makroa (kao predlog sa diff-om).
3. **Teme bez makroa:** za poruke bez dobrog poklapanja čuva se samo šifrovan vektor pseudonimizovanog sažetka i namera.
   Grupisanje (klasterovanje) otkriva česte teme, a AI predlaže nov makro (prompt „draft“), uvek na odobrenje.
4. **Kalibracija:** prihvatanje i odbijanje preporuka koristi se za podešavanje težina hibridne pretrage i praga
   „nema dobrog poklapanja“.
5. **Izvoz anonimne statistike** (JSON) za vođu tima, bez ijednog teksta.

**Procena:** 5–7 radnih dana.

---

## Rizici i kako su pokriveni

| Rizik | Mera |
|---|---|
| Gubitak ključa (nov računar, reinstalacija OS-a) | Ključ za oporavak + `npm run recover` + šifrovani backup |
| AI izmisli rok ili iznos | Prompt pravila + guardrail koji označava svaki nepotkrepljen broj ili link + uvek ručni pregled |
| Promena Stake pravila | Provera na 2 dana (Faza 3) + upozorenja + istorija verzija |
| Problematično kockanje | RG detekcija, kritična hitnost, RG pravila u promptovima |
| Troškovi AI-ja | Podrazumevano isključen, Haiku 5.5 (najjeftiniji), mesečni limit, prikaz potrošnje |
| Intercom menja izgled | Rešenje ne zavisi od Intercoma (clipboard). Ekstenzija iz Faze 2 je opciona |
