/**
 * `npm run docs:prompts` - regenerates docs/PROMPTOVI.md from src/server/ai/prompts.ts, so the documentation
 * always shows the exact prompts the app sends (system prompt + an example user turn + output schema).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Analysis } from '../src/shared/types.js';
import {
  analysisPrompt,
  draftPrompt,
  factCheckPrompt,
  macroUpdatePrompt,
  OUTPUT_TOKEN_LIMITS,
  personalizePrompt,
  PROMPT_VERSION,
  rankPrompt,
  type PromptSpec,
} from '../src/server/ai/prompts.js';

const message = "hey my btc withdrawal is pending for 2 days!! and when do i get my weekly bonus? my email is ⟦EMAIL_1⟧";
const analysis: Analysis = {
  intents: [
    { intent: 'withdrawal_pending', score: 0.86 },
    { intent: 'bonus_inquiry', score: 0.55 },
  ],
  sentiment: 'frustrated',
  sentimentScore: -0.5,
  urgency: 'high',
  urgencyReasons: ['waiting 2 days'],
  entities: [],
  questions: [
    { text: 'my btc withdrawal is pending for 2 days', intent: 'withdrawal_pending' },
    { text: 'when do i get my weekly bonus?', intent: 'bonus_inquiry' },
  ],
  keywords: ['withdrawal', 'pending', 'btc', 'weekly', 'bonus'],
  rgRisk: false,
  rgSignals: [],
  isLikelyNonEnglish: false,
  wordCount: 20,
  source: 'local',
};

const sections: { title: string; purpose: keyof typeof OUTPUT_TOKEN_LIMITS; when: string; safety: string; spec: PromptSpec<z.ZodType> }[] = [
  {
    title: '1. Analiza poruke',
    purpose: 'analyze',
    when:
      'Opciono. Podrazumevano poruku analizira lokalni deterministički analizator (< 5 ms, besplatno). Ovaj prompt je LLM alternativa za teže poruke: prepoznaje nameru, raspoloženje, hitnost, sva pitanja, entitete i rizik od problematičnog kockanja.',
    safety: 'Poruka je označena kao nepouzdan podatak. Sažetak ne sme da sadrži lične podatke.',
    spec: analysisPrompt(message),
  },
  {
    title: '2. Rangiranje makroa',
    purpose: 'rerank',
    when:
      'Opciona „AI provera preporuka“ (Settings → AI → „AI double-check of recommendations“, podrazumevano uključena kada je AI podešen). Lokalna preporuka se uvek prikaže odmah. Kratko posle toga (`POST /api/rerank`) AI u pozadini ponovo oceni do 8 lokalnih kandidata, kalibriše pouzdanost (90+ / 70–89 / 50–69 / <50) i napiše razlog specifičan za kupca. Kartice se ne preraspoređuju, pa `Alt+1..3` ostaju isti makroi: menjaju se samo procenat i razlog, najbolji izbor dobija oznaku „AI pick“, a ako je to makro van prikazanih kartica, nudi se kao „AI suggests“ (`Alt+4` ili klik). Ako AI oceni da nijedan makro ne odgovara u potpunosti, a lokalna pretraga je mislila da odgovara, prikazuje se diskretna napomena. Izbor makroa i tekst odgovora se nikad ne menjaju automatski. Ako agent promeni poruku dok provera traje, prekida se i zahtev i sam AI poziv na serveru. Ako AI nije spreman, provera je isključena, budžet je potrošen ili poziv ne uspe, ostaje lokalni rezultat bez poruke o grešci.',
    safety:
      'Može da vrati samo ID-jeve kandidata koje je dobio. Nepoznati ID-jevi se odbacuju. Važe ista pravila kao za ostale AI pozive: pseudonimizacija ličnih podataka, režim „Strogo lokalno“ i mesečni limit troška, a potrošnja se beleži.',
    spec: rankPrompt(message, analysis, [
      { id: 'm1', title: 'Crypto Withdrawal Pending or Not Received', intents: ['withdrawal_pending'], summary: 'Every transaction has to be confirmed before it is credited…', verification: 'verified' },
      { id: 'm2', title: 'Weekly Bonus - When It\'s Sent & How to Claim', intents: ['bonus_inquiry'], summary: 'The Weekly Bonus is sent out…', verification: 'verified' },
    ]),
  },
  {
    title: '3. Prilagođavanje odgovora',
    purpose: 'personalize',
    when:
      'Kada agent pritisne „AI polish“ (Ctrl+J) ili je uključeno automatsko poliranje. Brza verzija bez AI-ja je uvek prikazana odmah, a AI verzija je zamenjuje tek ako je agent nije već menjao.',
    safety:
      'Pre slanja u oblak lični podaci se menjaju tokenima (⟦EMAIL_1⟧, ⟦NAME_1⟧ …) i vraćaju lokalno. Šalju se samo činjenice sa statusom verified/unchecked. Posle odgovora lokalni guardrail proverava svaki broj, procenat, rok, link i „obećanje“ u odgovoru i upozorava agenta ako nisu potkrepljeni izvorima.',
    spec: personalizePrompt({
      message,
      analysis,
      macros: [
        { title: 'Crypto Withdrawal Pending or Not Received', body: 'Hi {{user}},\n\nThank you for your patience regarding your {{amount}} {{crypto}} withdrawal. Every transaction has to be confirmed before it is credited to the destination address…' },
        { title: "Weekly Bonus - When It's Sent & How to Claim", body: 'Hi {{user}},\n\nThe Weekly Bonus is …' },
      ],
      facts: [{ id: 'f1', statement: 'Every withdrawal transaction must be confirmed before it is credited to the destination address.', value: 'Confirmation required before crediting', status: 'verified' }],
      variables: { crypto: 'BTC', email: '⟦EMAIL_1⟧' },
      greeting: 'Hi there,',
      userFallback: 'there',
    }),
  },
  {
    title: '4. Nacrt odgovora od nule',
    purpose: 'draft',
    when:
      'Kada nijedan makro ne pređe prag pouzdanosti. AI piše odgovor samo iz proverenih činjenica najbližih makroa. Sve ostalo postaje [ENTER ANSWER ABOUT …], a predlaže se i naslov i namere za čuvanje kao novi makro. Bez AI-ja aplikacija pravi prazan kostur sa pozdravom, tonom i praznim mestima.',
    safety: 'Iste zabrane izmišljanja kao kod prilagođavanja. Koriste se samo činjenice sa statusom verified.',
    spec: draftPrompt({
      message: 'Do you have a referral program for streamers?',
      analysis: { ...analysis, intents: [{ intent: 'affiliate', score: 0.7 }], sentiment: 'neutral', urgency: 'low', questions: [{ text: 'Do you have a referral program for streamers?', intent: 'affiliate' }] },
      facts: [{ id: 'f9', statement: 'Anyone can join the Stake affiliate program from the Affiliate page.', value: 'Affiliate page', sourceUrl: 'https://help.stake.com/en/articles/9995632-how-to-become-a-stake-affiliate' }],
      greeting: 'Hi there,',
      userFallback: 'there',
    }),
  },
  {
    title: '5. Provera tačnosti činjenice (Faza 3)',
    purpose: 'fact_check',
    when:
      'Na svaka 2 dana, samo za činjenice čiji se pasus u izvoru promenio i čiju razliku lokalno poređenje brojeva i linkova nije jasno rešilo. Nepromenjeni izvori se ne šalju AI-ju.',
    safety:
      'Šalje se samo jedna činjenica i javni pasusi, nikad ceo makro ni podaci kupaca. Doslovnost citata dokaza se proverava lokalno. Pasusi su označeni kao nepouzdan sadržaj.',
    spec: factCheckPrompt({
      fact: { key: 'crypto.withdrawal.min_btc', statement: 'The minimum BTC withdrawal is 0.0002 BTC.', value: '0.0002 BTC' },
      passages: [{ sourceName: 'Stake Help Center', url: 'https://help.stake.com/en/articles/4793601-crypto-what-are-the-withdrawal-limits', heading: 'Withdrawal limits', text: '…' }],
    }),
  },
  {
    title: '6. Predlog izmene makroa (Faza 3)',
    purpose: 'macro_update',
    when:
      'Kada provera nađe zastarelu ili kontradiktornu činjenicu: AI pravi minimalnu izmenu teksta makroa, a aplikacija prikazuje diff staro/novo sa linkom ka izvoru i čeka odobrenje.',
    safety: 'Menja se samo tekst pogođen ispravkama. Promenljive i linkovi ostaju netaknuti. Ništa ne ulazi u upotrebu bez odobrenja.',
    spec: macroUpdatePrompt({
      title: 'Crypto Withdrawal Limits and Fees',
      body: 'Hi {{user}},\n\nThe minimum BTC withdrawal is 0.0002 BTC …',
      corrections: [{ statement: 'The minimum BTC withdrawal is 0.0003 BTC.', oldValue: '0.0002 BTC', newValue: '0.0003 BTC', sourceUrl: 'https://help.stake.com/en/articles/4793601-crypto-what-are-the-withdrawal-limits', evidenceQuote: '…' }],
    }),
  },
];

function fence(text: string, lang = 'text'): string {
  const ticks = text.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

let md = `# MacroPilot – AI promptovi

> Ovaj dokument je **generisan iz koda** (\`npm run docs:prompts\` iz \`src/server/ai/prompts.ts\`, verzija promptova ${PROMPT_VERSION}).
> Prikazuje tačan tekst koji aplikacija šalje modelu.

## Opšta pravila

- **Model:** podrazumevano \`claude-haiku-5-5\`, najjeftiniji Claude model ($0,10 / $0,50 po milion tokena). Može i Sonnet 5.5 / Opus 5.5, ili lokalni Ollama.
- **Strukturisan izlaz:** svaki prompt ima zod šemu. Kod Claude-a se koristi \`messages.parse\` sa \`output_config.format\`, a kod Ollama-e JSON šema u \`format\`. Odgovor koji ne prođe šemu se odbacuje (\`invalid_output\`) i aplikacija ostaje na brzoj verziji.
- **Brzina i cena:** \`output_config.effort\` je podrazumevano \`low\`. Sistemski promptovi su statični i keširani (\`cache_control: ephemeral\`), a svi promenljivi podaci idu u korisničku poruku u XML tagovima.
- **Bezbednost:** poruka kupca je uvek u \`<customer_message>\` i označena kao nepouzdan podatak. Pokušaji da se iz podataka „zatvori“ tag se neutrališu. Temperatura i prefill se ne šalju (Haiku 5.5 ih odbija). Odbijanje modela (\`refusal\`) se hvata i agent dobija poruku.
- **Troškovi:** mesečni limit (podrazumevano $5) i evidencija tokena po zahtevu. Kada je limit dostignut, AI se isključuje do sledećeg meseca.
- **Privatnost:** pseudonimizacija ličnih podataka pre slanja u oblak. U režimu „Strogo lokalno“ cloud provajderi su zabranjeni.

| Namena | max_tokens |
|---|---|
${Object.entries(OUTPUT_TOKEN_LIMITS)
  .map(([k, v]) => `| \`${k}\` | ${v} |`)
  .join('\n')}

`;

for (const s of sections) {
  const schema = JSON.stringify(z.toJSONSchema(s.spec.schema), null, 2);
  md += `---

## ${s.title}

**Kada se koristi:** ${s.when}

**Zaštite:** ${s.safety}

### Sistemski prompt

${fence(s.spec.system)}

### Primer korisničke poruke (dinamički podaci)

${fence(s.spec.user, 'xml')}

<details><summary>Izlazna JSON šema</summary>

${fence(schema, 'json')}

</details>

`;
}

writeFileSync(fileURLToPath(new URL('../docs/PROMPTOVI.md', import.meta.url)), md);
console.log('docs/PROMPTOVI.md written');
