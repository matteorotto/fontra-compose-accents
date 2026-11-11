# Ancore e accentate — plugin per Fontra

Porta in Fontra il modo di lavorare di Glyphs con le lettere accentate:

1. **Ancore** messe da sole nei punti giusti, in tutti i master.
2. **Costruzione automatica** delle lettere accentate con i componenti: lettera base + segni `*comb`.
3. **Allineamento automatico**: sposti un'ancora e tutte le accentate che la usano si aggiornano.

## Dove si trovano i comandi

- **Editor**: menu del tasto destro su un glifo e menu **Glyph**. **⌘U** aggiunge le ancore, **⌥⌘U** le ripristina (Ctrl al posto di ⌘ su Windows e Linux).
- **Panoramica del font**: menu del tasto destro e menu **Edit**, con le stesse scorciatoie. I comandi compaiono dopo che hai aperto un glifo dalla panoramica, come per "Rinomina e duplica glifi".

## 1. Ancore

**Aggiungi ancore (⌘U)** mette nel glifo le ancore che mancano, in **tutti i master**, così restano compatibili. Quelle che ci sono già non vengono toccate.

**Ripristina ancore (⌥⌘U)** rimette nella posizione predefinita le ancore standard. Le ancore con altri nomi restano dove sono.

Le posizioni predefinite, calcolate su ogni master con le sue altezze (x-height, cap height):

| Glifo | Ancore |
|---|---|
| Lettere | `top` al centro, all'altezza x o delle maiuscole (o in cima alle ascendenti: b, d, h, k, l…), e `bottom` al centro sulla linea di base |
| a e i o u (anche maiuscole) | anche `ogonek`, in basso a destra |
| d l t L | anche `topright`, per il caron "a virgola" di ď ľ ť Ľ |
| Segni sopra (`acutecomb`, `caroncomb`…) | `_top` all'altezza x, e `top` in cima al segno per impilarne un altro sopra |
| Segni `.case` | `_top` all'altezza delle maiuscole |
| Segni sotto (`cedillacomb`, `dotbelowcomb`…) | `_bottom` sulla linea di base, `bottom` in fondo al segno |
| `ogonekcomb` | `_ogonek` |
| `caroncomb.alt` | `_topright` |

Le ancore si spostano come sempre in Fontra: trascinale, o doppio clic per scrivere le coordinate. Il trattino basso (`_top`) indica il punto del segno che si appoggia sull'ancora con lo stesso nome della lettera (`top`).

## 2. Lettere accentate

**Nella panoramica**:

- **Componi tutte le accentate latine…**: crea tutte le lettere accentate latine (Latin-1, Latin Extended A e B, Latin Extended Additional) che si possono fare con le lettere e i segni già presenti nel font. Prima di creare ti dice quante sono e quali segni mancano per farne altre, per esempio "mancano: circumflexcomb (56), tildecomb (36)…".
- **Componi accentata / Componi N accentate**: solo i glifi selezionati. Vanno bene anche le caselle vuote dei set di glifi (Project glyph sets).

**Nell'editor**: scrivi la lettera, per esempio `ǎ`, poi tasto destro, **Componi «acaron»**. Finché l'accentata non esiste, Fontra la mostra come lettera + segno: il comando la crea davvero, con il suo Unicode. Su un'accentata che esiste già il comando diventa **Ricomponi**.

Come in Glyphs:

- si costruisce ogni lettera che Unicode scompone in base + segni (á = a + ◌́);
- sotto i segni in alto, `i` e `j` diventano `idotless` e `jdotless`;
- sulle maiuscole si usano i segni `.case`, se ci sono (`acutecomb.case`);
- ď ľ ť Ľ usano `caroncomb.alt`, se c'è;
- ģ usa la virgola rovesciata sopra (`commaturnedabovecomb`); ķ ļ ņ ŗ Ģ Ķ Ļ Ņ Ŗ usano la virgola sotto (`commaaccentcomb`) invece della cediglia;
- la nuova accentata ha gli stessi master della lettera e dei segni, e la larghezza della lettera base;
- se alla lettera o al segno manca l'ancora che serve, il plugin la aggiunge e te lo dice.

I glifi disegnati a mano non vengono mai sostituiti da "Componi tutte". Dall'editor, **Ricomponi** su un glifo disegnato chiede prima conferma.

Le lettere che Unicode non scompone (ø ł đ ħ æ œ ß…) vanno disegnate, come in Glyphs.

## 3. Allineamento automatico

Le accentate create dal plugin hanno l'**allineamento automatico** acceso. Quando nella lettera base o in un segno:

- sposti un'ancora,
- cambi la larghezza (o LSB/RSB),
- aggiungi o ripristini le ancore,

tutte le accentate che li usano si riallineano da sole, in ogni master, appena rilasci il mouse. Anche la larghezza dell'accentata segue quella della lettera base.

Come in Glyphs, in un'accentata allineata in automatico i segni non si spostano a mano: tornano al loro posto. Per spostarli liberamente, tasto destro sull'accentata e togli la spunta da **Allineamento automatico**. Rimettendo la spunta, l'accentata si riallinea subito. Per riallineare una composta fatta a mano (con i componenti già messi), basta accendere la spunta.

## Annulla

- **⌘Z** annulla ogni comando. "Componi tutte le accentate latine" si annulla in un passo solo.
- L'allineamento automatico segue l'annullamento: se annulli lo spostamento di un'ancora, le accentate tornano dov'erano.

## Note

- Il segnale di allineamento automatico è salvato nel glifo, nei dati personalizzati con la chiave `fontra.plugin.composeAccents.autoAlign`, quindi resta anche dopo aver riaperto il font.
- Un segno senza l'ancora corrispondente viene centrato sulla lettera, e il resoconto lo segnala. Dopo ⌘U sul segno si allinea da solo.
- Con molti glifi insieme le modifiche partono a blocchi, perché il server di Fontra ne tiene in memoria 128 per volta.

## Installazione

1. Crea un repository **pubblico** su GitHub, per esempio `fontra-compose-accents`.
2. Carica `plugin.json` e `compose-accents.js` (va bene anche questo README) nella radice del repository.
3. Crea una release con tag `v1.0.0`.
4. In Fontra apri **Fontra → Plugin Manager**, premi **+** e scrivi `https://cdn.jsdelivr.net/gh/TUONOME/fontra-compose-accents@v1.0.0`.
5. Ricarica l'editor.
