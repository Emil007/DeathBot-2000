function parseSheetTable(text) {
  const lines = String(text)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length) return { error: "Leere Liste." };

  const splitLine = (line) => {
    if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
    // fallback: multiple spaces
    return line.split(/\s{2,}/).map((c) => c.trim());
  };

  let start = 0;
  let cols = splitLine(lines[0]).map((c) => c.toLowerCase());
  const hasHeader =
    cols.some((c) => c.includes("name")) &&
    (cols.some((c) => c.includes("alter")) || cols.some((c) => c === "age"));

  let idxName = 1;
  let idxAge = 2;
  let idxDesc = 4;
  let idxDied = 5;

  if (hasHeader) {
    idxName = cols.findIndex((c) => c === "name" || c.includes("name"));
    idxAge = cols.findIndex((c) => c === "alter" || c === "age");
    idxDesc = cols.findIndex((c) => c.includes("beschreib") || c.includes("desc"));
    idxDied = cols.findIndex((c) => c.includes("gestorben") || c.includes("died") || c.includes("dead"));
    start = 1;
  } else {
    // Assume: #, Name, Alter, Punkte, Beschreibung, gestorben
    const sample = splitLine(lines[0]);
    if (sample.length >= 3 && /^\d+$/.test(sample[0])) {
      idxName = 1;
      idxAge = 2;
      idxDesc = sample.length >= 5 ? 4 : -1;
      idxDied = sample.length >= 6 ? 5 : -1;
    } else {
      idxName = 0;
      idxAge = 1;
      idxDesc = sample.length >= 3 ? 2 : -1;
      idxDied = -1;
    }
  }

  if (idxName < 0 || idxAge < 0) {
    return { error: "Konnte Name/Alter-Spalten nicht finden." };
  }

  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const name = cells[idxName];
    if (!name) continue;
    const ageRaw = cells[idxAge];
    const age = ageRaw != null && ageRaw !== "" ? parseInt(String(ageRaw).replace(/\D/g, ""), 10) : null;
    const description = idxDesc >= 0 ? cells[idxDesc] || "" : "";
    const died = idxDied >= 0 ? cells[idxDied] || "" : "";
    rows.push({
      name: name.trim(),
      age: Number.isFinite(age) ? age : null,
      description: description.trim(),
      diedAt: died.trim() || null,
    });
  }

  return { rows };
}

module.exports = { parseSheetTable };
