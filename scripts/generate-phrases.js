const fs = require("fs");
const path = require("path");

const templates = [];

const a = [
  "Ich bin der Tod. {name} ({age}) hat heute den Termin wahrgenommen, den ich schon ewig im Kalender hatte.",
  "Gregg hier. {name} ist tot. Alter {age}. Punkte: {score}. Wer sich freut: {winners}.",
  "Die Sense hat {name} erwischt. Mit {age} Jahren. {winners} kassieren {score} Punkte — ich kassiere die Seele.",
  "{name} ist verstorben. Ich lächle unter der Kapuze. {age} Jahre Lebenszeit, {score} Punkte Gier.",
  "Wieder ein Leichnam für meine Sammlung: {name}, {age}. Glückwünsche an {winners}.",
  "Ich hole, wen ich will. Heute: {name}. Alter {age}. Die Pool-Hyänen {winners} bekommen {score}.",
  "Kein Mitleid. {name} ist tot. {age}. Wer wetten wollte und gewann: {winners}.",
  "Die Erde bekommt {name} zurück. Ich behalte die Pointe. {winners} behalten {score} Punkte.",
  "{name} hat aufgehört zu atmen. Ich habe aufgehört zu warten. Alter {age}.",
  "Obduktion der Eitelkeit: {name}, {age} Jahre, jetzt still. {winners} jubeln zynisch.",
  "Ich bin der Sensenmann. {name} war fällig. {age} Jahre waren genug. {winners} freuen sich über {score} Zähler — ich über die Stille.",
  "Tod speaking. {name} ist durch. Kein Comeback, kein Spin-off. Nur Asche und {score} Punkte für {winners}.",
  "Meine Liste ist länger als eure Moral. Neuer Eintrag: {name} ({age}).",
  "Heute Nacht flüstere ich {name}. Morgen liest ihr's auf Wikipedia. Alter {age}.",
  "Beerdigt die Illusion, {name} wäre unsterblich. {age} und tot. Punkt.",
  "Ich mag Statistiken. {name}: tot. Alter: {age}. Gewinner: {winners}. Score: {score}.",
  "Die Grimasse hinter der Kapuze gilt {name}. {winners}, nehmt eure schmutzigen Punkte.",
  "{name} hat den Raum verlassen. Permanent. {age} Jahre Show, Finale ohne Applaus.",
  "Ich sammle Prominentenleichen wie ihr Sticker. Neu: {name}.",
  "Kein Requiem von mir. Nur Spott. {name}, {age}, weg. {winners} profitieren.",
  "Ruhet in Unruhe, {name}. Ich ruhe nie. Alter {age}.",
  "Die Todesursache ist egal. Das Ergebnis zählt: {name} ist tot. {winners} +{score}.",
  "Ich klopfe nicht. Ich hole. {name} wurde geholt. {age}.",
  "Euer Todspool ist mein Comedy-Club. Heute Headliner: {name}.",
  "Sarkasmus Level Sensenmann: {name} ({age}) hat die Bühne verlassen — horizontal.",
  "Wer {name} getippt hat, lacht jetzt. Ich lache immer. {winners}.",
  "Der Friedhof hat Zuwachs: {name}. Der Scoreboard auch: {winners} +{score}.",
  "Leben ist temporär. {name} hat das endlich begriffen. {age} Jahre Lernzeit.",
  "Ich bin nicht böse. Ich bin gründlich. Fall {name} geschlossen.",
  "Schwarz wie meine Robe, kalt wie meine Witze: {name} ist tot.",
];

const verbs = ["abgeholt","einkassiert","abgehakt","entsorgt","abgeräumt","eingesammelt","stillgelegt","archiviert","ausgeknipst","abbestellt","abserviert","einkassiert","verstaut","weggebucht","ausgebucht"];
const nouns = ["Promi","Namen auf der Liste","Wettkandidaten","Kalender-Eintrag","Seelen-Termin","Pool-Tipp","Obituary-Futter","Friedhofs-Neuzugang","Medienliebling","Tabellenführer der Sterblichkeit"];
const tails = [
  "Alter {age}. {winners} kassieren {score}.",
  "{winners} bekommen {score} Punkte. Ich bekomme die Pointe.",
  "Kein Blumenstrauß von mir. Nur Spott.",
  "Wikipedia aktualisiert sich. Ich auch.",
  "Die Hyänen im Channel jubeln: {winners}.",
  "Rest in pieces, nicht peace.",
  "Nächster bitte. Die Sense wartet nicht.",
  "Das war's mit der Biografie.",
  "Die Uhr steht. Endgültig.",
  "Schreibt's in den Nekrolog und schweigt.",
  "Ich lächle unter der Kapuze.",
  "Keine Zugabe. Nur Stille.",
  "Der Plot ist vorbei.",
  "Sammelt eure Punkte und euer schlechtes Gewissen.",
  "Morgen seid ihr dran. Heute {name}.",
];

templates.push(...a);
for (const v of verbs) {
  for (const n of nouns) {
    for (const t of tails) {
      templates.push(`Ich habe den ${n} {name} ${v}. ${t}`);
    }
  }
}

const more = [
  "Kapuze auf, Sense raus, {name} rein. {age} Jahre Verschwendung beendet.",
  "Ich bin Gregg, euer freundlicher Sensenmann aus der Nachbarschaft. {name} ist tot. Bussi.",
  "Moral? Gelöscht. {name}? Auch. Alter {age}.",
  "Die einzigen Tränen hier sind Krokodilstränen von Leuten ohne Tipp. Gewonnen haben {winners}.",
  "Ich hasse Überraschungen. {name} war keine. Fällig seit gefühlt immer.",
  "Promi-Status schützt nicht vor mir. Beweis: {name}, {age}.",
  "Euer Mitleid ist peinlich. Mein Humor ist tödlich. {name} versteht das jetzt.",
  "Die Bestattung ist euer Problem. Die Pointe ist meins: {name} tot.",
  "Score {score} für {winners}. Null Sterne für {name}s Timing.",
  "Ich unterschreibe Totenscheine mit Sarkasmus. Heutige Unterschrift: {name}.",
  "Der Tod macht alle gleich. Außer im Discord-Pool — da gewinnen {winners}.",
  "Atemzug Nummer Letzter für {name}. Applaus von der falschen Seite.",
  "Ich sammle letzte Worte. {name} hatte keine lustigen. Pech.",
  "Willkommen im Club, {name}. Austritt unmöglich. Alter bei Eintritt: {age}.",
  "Die Sense quietscht vor Freude. {name} quietscht nicht mehr.",
  "Ob Herz, Krebs oder Karma — mir egal. Ergebnis: {name} weg.",
  "Ich bin nicht die Nachricht. Ich bin der Absender. Betreff: {name} tot.",
  "Lasst die Kerzen. Zündet den Spott an. {name}, {age}.",
  "Der Pool hat Blut gerochen. {winners} waschen sich die Hände an {score} Punkten.",
  "Ich erzähle keine Märchen. {name} ist tot. Ende.",
  "Sarkasmus ist die einzige Blume auf diesem Grab: {name}.",
  "Wer weint, hat nicht getippt. Wer lacht: {winners}.",
  "Mein Tagjob: Sterblichkeit. Heutiger Kunde: {name}.",
  "Die Uhr tickt für alle. Für {name} hat sie aufgehört. {age}.",
  "Kein Hallo, kein Tschüss — nur Abwesenheit. {name}.",
  "Ich bin der Plot-Twist am Ende jeder Biografie. Heute: {name}.",
  "Die Nachrufe werden kitschig. Ich bleibe ehrlich: {name} war überfällig.",
  "Punkte sind euer Trost. Meiner ist die Stille nach {name}.",
  "Der Channel bebt. {name} liegt. {winners} rechnen.",
  "Ich lächle. Das ist selten tröstlich. {name}, {age}, tot.",
  "Kurzer Besuch, langer Abschied: {name}.",
  "Ich räume den Promi-Müll weg. Heute: {name}.",
  "Sterben ist demokratisch. Wetten sind es nicht. {winners} +{score}.",
  "Die Biografie endet mit einem Punkt. Dem Tod. {name}.",
  "Ich komme ohne Terminbestätigung. {name} hätte absagen sollen.",
  "Trauerfeier optional. Spott inklusive. {name}, {age}.",
  "Eure Hashtags sind peinlich. Mein Eintrag ist final: {name}.",
  "Der Himmel hat Warteschlange. {name} steht jetzt drin.",
  "Ich bin unbestechlich. Außer mit guten Witzen über {name}.",
  "Tot ist tot. {name} ist der Beweis. {age}.",
  "Die Sense hat Vorfahrt. {name} hatte Pech auf der Kreuzung Leben.",
  "Glückwunsch an {winners}. Beileid an niemanden. {name} ist tot.",
  "Ich hasse Drama. {name} lieferte trotzdem eins — das letzte.",
  "Ab jetzt nur noch Vergangenheit: {name}.",
  "Der Nekrolog schreibt sich von allein. Ich diktiere: {name} tot.",
  "Kein Afterlife-Support. Ticket für {name} war One-Way.",
  "Ich bin der Epilog. Kapitel {name} geschlossen.",
  "Die Fans heulen. Ich gähne. {name}, {age}.",
  "Wer {name} überlebt hat: Glück. Wer getippt hat: {winners}.",
  "Mein Lieblingsgeräusch: letzte Atemzüge. Heute von {name}.",
];
templates.push(...more);

const shorties = [
  "{name} ist tot. Ich auch amüsiert. {age}.",
  "Erledigt: {name}.",
  "Sense 1, {name} 0.",
  "Nächster: schon in Arbeit. Gerade: {name}.",
  "Tot. {name}. Weiter.",
  "{name} — abgehakt.",
  "Kein Puls, viel Spott: {name}.",
  "Ich war's. {name} merkt's nicht mehr.",
  "Obituary unlocked: {name}.",
  "Friede? Nein. Spott. {name}.",
];
templates.push(...shorties);

const uniq = [...new Set(templates)];
const out = path.join(__dirname, "..", "src", "phrases", "builtin-phrases.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(uniq));
console.log("wrote", uniq.length, "phrases to", out);
