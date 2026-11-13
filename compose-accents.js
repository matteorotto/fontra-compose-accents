// Ancore e accentate — plugin per Fontra
//
// Come in Glyphs:
// - Ancore: "Aggiungi ancore" (⌘U) mette le ancore predefinite nel glifo, in tutti
//   i master: top, bottom, ogonek e topright sulle lettere; _top / top,
//   _bottom / bottom, … sui segni diacritici (*comb). "Ripristina ancore" (⌥⌘U)
//   le rimette nella posizione predefinita.
// - Accentate: "Componi" costruisce una lettera accentata con i componenti
//   (base + segni), appoggiando ogni segno sulla sua ancora, in tutti i master.
//   Usa i/j senza puntino sotto i segni in alto, i segni .case sulle maiuscole,
//   caroncomb.alt su d, l, t, L e la virgola sotto al posto della cediglia dove
//   serve (ģ, ķ, ļ, ņ, ŗ, …).
// - Allineamento automatico: nelle accentate composte dal plugin, quando sposti
//   un'ancora o cambi la larghezza della lettera base o del segno, le accentate
//   si riallineano da sole. Si può spegnere glifo per glifo.
// - Gruppi di kerning: l'accentata entra negli stessi gruppi della lettera base
//   (tranne il lato destro quando il segno sporge, come in ď ľ ť Ľ) e li segue
//   quando cambiano.
//
// I comandi sono nel menu del tasto destro e nel menu Glyph dell'editor e, come
// per "Rinomina e duplica glifi", nella panoramica del font.

const EDITOR_KEY = "__composeAccentsPlugin";
const OVERVIEW_KEY = "__composeAccentsOverview";
const AUTO_ALIGN_KEY = "fontra.plugin.composeAccents.autoAlign";
const META_KEY = "composeAccentsPlugin";
const MENU_ANCHOR = "action.find-glyphs-that-use";
const OVERVIEW_POLL_MS = 1500;
const REALIGN_DELAY_MS = 120;

// Intervalli Unicode delle lettere latine (per "Componi tutte le accentate")
const LATIN_RANGES = [
  [0x00c0, 0x024f],
  [0x1e00, 0x1eff],
];

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function round(value) {
  return Math.round(value);
}

function splitName(glyphName) {
  const dot = glyphName.indexOf(".", 1);
  return dot > 0 ? [glyphName.slice(0, dot), glyphName.slice(dot)] : [glyphName, ""];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Raccoglie le modifiche e, in ordine inverso, quelle per annullarle.
class ChangeBuilder {
  constructor() {
    this.forward = [];
    this.backward = [];
  }

  get isEmpty() {
    return !this.forward.length;
  }

  set(path, key, newValue, oldValue) {
    this.forward.push({ p: path, f: "=", a: [key, newValue] });
    this.backward.unshift(
      oldValue === undefined ? { p: path, f: "d", a: [key] } : { p: path, f: "=", a: [key, oldValue] }
    );
  }

  build(meta = {}) {
    return {
      change: { c: this.forward, [META_KEY]: meta },
      rollbackChange: { c: this.backward, [META_KEY]: meta },
    };
  }
}

function combineChanges(builders, meta = {}) {
  const forward = builders.flatMap((b) => b.forward);
  const backward = [...builders].reverse().flatMap((b) => b.backward);
  return {
    change: { c: forward, [META_KEY]: meta },
    rollbackChange: { c: backward, [META_KEY]: meta },
  };
}

// Il server di Fontra tiene in memoria al massimo 128 glifi per volta: una
// modifica che tocca troppi glifi insieme non viene salvata. Le modifiche
// grandi partono quindi a blocchi.
const GLYPHS_PER_CHUNK = 40;

function glyphNameOfChange(change) {
  const path = change.p || [];
  if (path[0] !== "glyphs") return null;
  return path.length > 1 ? path[1] : change.a?.[0] ?? null;
}

function countGlyphs(change) {
  return new Set((change.c || []).map(glyphNameOfChange).filter((n) => n !== null)).size;
}

async function postChunked(fontController, change, label) {
  const meta = change[META_KEY];
  let chunk = [];
  let names = new Set();
  const send = async () => {
    if (!chunk.length) return;
    await fontController.postChange({ c: chunk, [META_KEY]: meta }, { c: [] }, label);
    chunk = [];
    names = new Set();
  };
  for (const sub of change.c || []) {
    const name = glyphNameOfChange(sub);
    if (name !== null && !names.has(name) && names.size >= GLYPHS_PER_CHUNK) await send();
    if (name !== null) names.add(name);
    chunk.push(sub);
  }
  await send();
}

async function postChange(fontController, change, rollbackChange, label, senderID) {
  if (countGlyphs(change) > GLYPHS_PER_CHUNK) await postChunked(fontController, change, label);
  else await fontController.postChange(change, rollbackChange, label, senderID);
}

// ---------------------------------------------------------------------------
// Dati dei glifi di Fontra (nomi, Unicode, categoria): /data/glyph-data.csv
// ---------------------------------------------------------------------------

let glyphDataPromise;
let glyphData = { byName: new Map(), byCodePoint: new Map() };

function loadGlyphData() {
  if (!glyphDataPromise) {
    glyphDataPromise = fetch("/data/glyph-data.csv")
      .then((response) => (response.ok ? response.text() : ""))
      .then((text) => {
        glyphData = parseGlyphData(text);
        return glyphData;
      })
      .catch((error) => {
        console.warn("[Ancore e accentate] Dati dei glifi non disponibili:", error);
        return glyphData;
      });
  }
  return glyphDataPromise;
}

function parseGlyphData(text) {
  const byName = new Map();
  const byCodePoint = new Map();
  if (!text) return { byName, byCodePoint };
  text = text.replaceAll("\r\n", "\n");
  const blocks = text.split("\n\n");
  const lines = (blocks.length > 1 ? blocks.slice(1).join("\n\n") : blocks[0]).split("\n");
  const header = lines.shift().split(";");
  const col = (name) => header.indexOf(name);
  const [iUni, iName, iCat, iSub, iCase] = ["unicode", "name", "category", "subCategory", "case"].map(col);
  for (const line of lines) {
    if (!line) continue;
    const fields = line.split(";");
    const info = {
      name: fields[iName],
      unicode: fields[iUni] ? parseInt(fields[iUni], 16) : undefined,
      category: fields[iCat] || "",
      subCategory: fields[iSub] || "",
      case: fields[iCase] || "",
    };
    if (!info.name) continue;
    if (!byName.has(info.name)) byName.set(info.name, info);
    if (info.unicode !== undefined && !byCodePoint.has(info.unicode)) byCodePoint.set(info.unicode, info);
  }
  return { byName, byCodePoint };
}

// ---------------------------------------------------------------------------
// Che cosa è un glifo: lettera, segno in alto, segno in basso, …
// ---------------------------------------------------------------------------

const BELOW_MARKS = new Set([
  0x0316, 0x0317, 0x0318, 0x0319, 0x031c, 0x031d, 0x031e, 0x031f, 0x0320, 0x0321, 0x0322,
  0x0323, 0x0324, 0x0325, 0x0326, 0x0327, 0x0329, 0x032a, 0x032b, 0x032c, 0x032d, 0x032e,
  0x032f, 0x0330, 0x0331, 0x0332, 0x0333, 0x0339, 0x033a, 0x033b, 0x033c, 0x0345, 0x0347,
  0x0348, 0x0349, 0x034d, 0x034e, 0x0353, 0x0354, 0x0355, 0x0356, 0x0359, 0x035a,
]);

function isCombining(codePoint) {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
  );
}

// Su quale ancora si appoggia un segno con questo codice
function markKindForCodePoint(codePoint) {
  if (codePoint === 0x0328) return "ogonek";
  if (codePoint === 0x031b) return "topright"; // corno (ơ, ư)
  if (codePoint >= 0x0334 && codePoint <= 0x0338) return "center";
  return BELOW_MARKS.has(codePoint) ? "bottom" : "top";
}

function codePointForGlyph(fontController, glyphName) {
  const own = fontController.glyphMap[glyphName]?.[0];
  if (own !== undefined) return own;
  const [base] = splitName(glyphName);
  return fontController.glyphMap[base]?.[0] ?? glyphData.byName.get(base)?.unicode;
}

function describeGlyph(fontController, glyphName) {
  const [base, suffix] = splitName(glyphName);
  const codePoint = codePointForGlyph(fontController, glyphName);
  const info = glyphData.byName.get(base) || (codePoint !== undefined ? glyphData.byCodePoint.get(codePoint) : undefined);
  const isMark =
    info?.category === "Mark" ||
    /comb$/.test(base) ||
    (codePoint !== undefined && isCombining(codePoint));
  if (isMark) {
    let kind = codePoint !== undefined ? markKindForCodePoint(codePoint) : /below/.test(base) ? "bottom" : "top";
    if (base === "caroncomb" && suffix.includes(".alt")) kind = "topright";
    return { type: "mark", kind, isCase: suffix.includes(".case"), base, codePoint };
  }
  const char = codePoint !== undefined ? String.fromCodePoint(codePoint) : base;
  const isUpper =
    info?.case === "upper" ||
    (char.length === 1 && char.toUpperCase() === char && char.toLowerCase() !== char);
  const isLetter = info ? info.category === "Letter" : /^[A-Za-z]/.test(base);
  return { type: isLetter ? "letter" : "other", isUpper, base, char, codePoint };
}

// ---------------------------------------------------------------------------
// Metriche e glifi a una posizione dello spazio di design
// ---------------------------------------------------------------------------

function fontAxisDefaults(fontController) {
  return Object.fromEntries(
    (fontController.fontAxesSourceSpace || []).map((axis) => [axis.name, axis.defaultValue])
  );
}

function fontLocationOf(fontController, location) {
  const result = fontAxisDefaults(fontController);
  for (const name of Object.keys(result)) {
    if (location?.[name] !== undefined) result[name] = location[name];
  }
  return result;
}

function locationKey(location) {
  return JSON.stringify(Object.keys(location).sort().map((k) => [k, location[k]]));
}

function metricsAt(fontController, fontLocation) {
  const upm = fontController.unitsPerEm || 1000;
  let metrics = {};
  try {
    metrics = fontController.fontSourcesInstancer?.instantiate(fontLocation)?.lineMetricsHorizontalLayout || {};
  } catch (error) {
    // nessuna sorgente: valori predefiniti
  }
  const value = (key, fallback) => (Number.isFinite(metrics[key]?.value) ? metrics[key].value : fallback);
  return {
    upm,
    xHeight: value("xHeight", 0.5 * upm),
    capHeight: value("capHeight", 0.7 * upm),
    ascender: value("ascender", 0.75 * upm),
    descender: value("descender", -0.25 * upm),
  };
}

async function instanceAt(fontController, glyphName, fontLocation) {
  try {
    return await fontController.getGlyphInstance(glyphName, fontLocation);
  } catch (error) {
    return null;
  }
}

function anchorTable(instance) {
  const table = {};
  const anchors = instance?.propagatedAnchors || instance?.anchors || [];
  for (const anchor of anchors) {
    if (anchor?.name && !(anchor.name in table)) table[anchor.name] = { x: anchor.x, y: anchor.y };
  }
  return table;
}

// ---------------------------------------------------------------------------
// Ancore predefinite
// ---------------------------------------------------------------------------

const OGONEK_BASES = new Set([..."aeiouAEIOU"]);
const TOPRIGHT_BASES = new Set([..."dltL"]);

// Ancore predefinite per un livello (un master) di un glifo
function defaultAnchorsFor(description, bounds, xAdvance, metrics) {
  const tolerance = 0.03 * metrics.upm;
  const xMin = bounds ? bounds.xMin : 0;
  const xMax = bounds ? bounds.xMax : xAdvance;
  const yMin = bounds ? bounds.yMin : 0;
  const yMax = bounds ? bounds.yMax : metrics.xHeight;
  const centerX = round(bounds ? (xMin + xMax) / 2 : xAdvance / 2);
  const anchors = [];

  if (description.type === "letter") {
    const height = description.isUpper ? metrics.capHeight : metrics.xHeight;
    const topY = round(yMax > height + tolerance ? yMax : height);
    anchors.push({ name: "top", x: centerX, y: topY });
    anchors.push({ name: "bottom", x: centerX, y: 0 });
    const letter = description.char;
    if (OGONEK_BASES.has(letter)) anchors.push({ name: "ogonek", x: round(xMax), y: 0 });
    if (TOPRIGHT_BASES.has(letter)) {
      const x = letter === "L" ? round(xMin + 0.45 * (xMax - xMin)) : round(xMax);
      anchors.push({ name: "topright", x, y: topY });
    }
  } else if (description.type === "mark") {
    const height = description.isCase ? metrics.capHeight : metrics.xHeight;
    switch (description.kind) {
      case "top":
        anchors.push({ name: "_top", x: centerX, y: round(height) });
        anchors.push({ name: "top", x: centerX, y: round(yMax) });
        break;
      case "bottom":
        anchors.push({ name: "_bottom", x: centerX, y: 0 });
        anchors.push({ name: "bottom", x: centerX, y: round(yMin) });
        break;
      case "ogonek":
        anchors.push({ name: "_ogonek", x: round(xMax), y: 0 });
        break;
      case "topright":
        anchors.push({ name: "_topright", x: round(xMin - 0.02 * metrics.upm), y: round(yMax) });
        break;
      case "center":
        anchors.push({ name: "_center", x: centerX, y: round((yMin + yMax) / 2) });
        break;
    }
  }
  return anchors;
}

// Aggiunge (o rimette a posto, con reset) le ancore predefinite in tutti i master
async function planAnchors(fontController, glyphName, builder, { reset = false, onlyIfMissing = null } = {}) {
  const varGlyph = await fontController.getGlyph(glyphName);
  if (!varGlyph) return false;
  const description = describeGlyph(fontController, glyphName);
  if (description.type === "other") return false;
  let changed = false;

  for (const [sourceIndex, source] of varGlyph.sources.entries()) {
    const layer = varGlyph.glyph.layers[source.layerName];
    if (!layer) continue;
    const current = layer.glyph.anchors || [];
    if (onlyIfMissing && current.some((a) => a.name === onlyIfMissing)) continue;

    const fontLocation = fontLocationOf(fontController, varGlyph.getDenseSourceLocationForSource(source));
    const metrics = metricsAt(fontController, fontLocation);
    let bounds;
    try {
      bounds = (await varGlyph.getLayerGlyphController(source.layerName, sourceIndex))?.bounds;
    } catch (error) {
      bounds = undefined;
    }
    const defaults = defaultAnchorsFor(description, bounds, layer.glyph.xAdvance, metrics);

    const result = current.map((a) => ({ ...a }));
    for (const anchor of defaults) {
      const index = result.findIndex((a) => a.name === anchor.name);
      if (index < 0) result.push(anchor);
      else if (reset) result[index] = { ...result[index], x: anchor.x, y: anchor.y };
    }
    if (JSON.stringify(result) === JSON.stringify(current)) continue;
    builder.set(["glyphs", glyphName, "layers", source.layerName, "glyph"], "anchors", result, clone(current));
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Scomposizione delle lettere accentate
// ---------------------------------------------------------------------------

function decompose(codePoint) {
  if (codePoint === undefined) return null;
  const parts = [...String.fromCodePoint(codePoint).normalize("NFD")].map((c) => c.codePointAt(0));
  if (parts.length < 2 || !parts.slice(1).every(isCombining)) return null;
  return parts;
}

function glyphNameForCodePoint(fontController, codePoint) {
  const inFont = fontController.characterMap?.[codePoint];
  if (inFont) return inFont;
  const dataName = glyphData.byCodePoint.get(codePoint)?.name;
  if (dataName && dataName in fontController.glyphMap) return dataName;
  return null;
}

function standardNameForCodePoint(codePoint) {
  return (
    glyphData.byCodePoint.get(codePoint)?.name ||
    `uni${codePoint.toString(16).toUpperCase().padStart(4, "0")}`
  );
}

function firstExisting(fontController, names) {
  return names.find((name) => name && name in fontController.glyphMap) || null;
}

// Le parti di una lettera accentata: { baseName, marks: [{name, kind}], missing }
function resolveParts(fontController, codePoint) {
  const parts = decompose(codePoint);
  if (!parts) return null;
  const glyphMap = fontController.glyphMap;
  const baseChar = String.fromCodePoint(parts[0]);
  const isUpper = baseChar.toUpperCase() === baseChar && baseChar.toLowerCase() !== baseChar;
  const missing = [];

  let baseName = glyphNameForCodePoint(fontController, parts[0]);
  if (!baseName) missing.push(standardNameForCodePoint(parts[0]));

  const marks = [];
  for (let markCode of parts.slice(1)) {
    let kind = markKindForCodePoint(markCode);
    // Lettone, ecc.: virgola sotto al posto della cediglia; ģ: virgola rovesciata sopra
    if (markCode === 0x0327 && "GKLNRklnr".includes(baseChar)) {
      markCode = 0x0326;
      kind = "bottom";
    } else if (markCode === 0x0327 && baseChar === "g") {
      markCode = 0x0312;
      kind = "top";
    }
    let name = null;
    // ď ľ ť Ľ: il caron "a virgola"
    if (markCode === 0x030c && "dltL".includes(baseChar)) {
      name = firstExisting(fontController, ["caroncomb.alt", "uni030C.alt"]);
      if (name) kind = "topright";
    }
    if (!name) {
      const plain = glyphNameForCodePoint(fontController, markCode);
      const standard = standardNameForCodePoint(markCode);
      const candidates = isUpper
        ? [plain && `${plain}.case`, `${standard}.case`, plain, standard]
        : [plain, standard];
      name = firstExisting(fontController, candidates);
      if (!name) missing.push(standard);
    }
    if (name) marks.push({ name, kind });
  }

  // I gruppi di kerning vengono dalla lettera vera (i, non idotless)
  const groupBaseName = baseName;
  // Un segno che sporge a destra (caron a virgola, corno) cambia lo spazio a destra
  const skipRight = marks.some((m) => m.kind === "topright");

  // i e j senza puntino sotto i segni in alto
  if (baseName && (baseChar === "i" || baseChar === "j") && marks.some((m) => m.kind === "top")) {
    const dotless = baseChar === "i"
      ? firstExisting(fontController, ["idotless", "dotlessi", glyphData.byCodePoint.get(0x0131)?.name])
      : firstExisting(fontController, ["jdotless", "dotlessj", "uni0237", glyphData.byCodePoint.get(0x0237)?.name]);
    if (dotless) baseName = dotless;
  }
  return { baseName, groupBaseName, skipRight, marks, missing };
}

// ---------------------------------------------------------------------------
// Posizione dei componenti in un master
// ---------------------------------------------------------------------------

// Restituisce { offsets: [{x, y, attached}], xAdvance, unattached: [nomi] }
async function computeLayout(fontController, baseName, marks, fontLocation, baseOffset = { x: 0, y: 0 }) {
  const base = await instanceAt(fontController, baseName, fontLocation);
  if (!base) return null;
  const metrics = metricsAt(fontController, fontLocation);
  const current = {};
  for (const [name, a] of Object.entries(anchorTable(base))) {
    if (!name.startsWith("_")) current[name] = { x: a.x + baseOffset.x, y: a.y + baseOffset.y };
  }
  const baseDescription = describeGlyph(fontController, baseName);
  const offsets = [];
  const unattached = [];

  for (const mark of marks) {
    const instance = await instanceAt(fontController, mark.name, fontLocation);
    if (!instance) {
      offsets.push(null);
      continue;
    }
    const own = anchorTable(instance);
    let attachName = null;
    if (own[`_${mark.kind}`] && current[mark.kind]) {
      attachName = mark.kind;
    } else {
      attachName = Object.keys(own).find((n) => n.startsWith("_") && current[n.slice(1)])?.slice(1) || null;
    }
    let dx;
    let dy;
    if (attachName) {
      dx = current[attachName].x - own[`_${attachName}`].x;
      dy = current[attachName].y - own[`_${attachName}`].y;
    } else {
      // Senza ancore: centrato sulla lettera, alzato sulle maiuscole
      unattached.push(mark.name);
      const markBounds = instance.bounds;
      const markCenter = markBounds ? (markBounds.xMin + markBounds.xMax) / 2 : instance.xAdvance / 2;
      dx = baseOffset.x + base.xAdvance / 2 - markCenter;
      dy = mark.kind === "top" && baseDescription.isUpper && !mark.name.includes(".case")
        ? metrics.capHeight - metrics.xHeight
        : 0;
    }
    dx = round(dx);
    dy = round(dy);
    offsets.push({ x: dx, y: dy, attached: attachName });
    for (const [name, a] of Object.entries(own)) {
      if (!name.startsWith("_")) current[name] = { x: a.x + dx, y: a.y + dy };
    }
  }
  return { offsets, xAdvance: round(base.xAdvance), unattached };
}

function makeComponent(name, x, y) {
  return {
    name,
    transformation: {
      translateX: x, translateY: y, rotation: 0, scaleX: 1, scaleY: 1,
      skewX: 0, skewY: 0, tCenterX: 0, tCenterY: 0,
    },
    location: {},
  };
}

// Le sorgenti (master) della nuova accentata: quelle della base e dei segni
async function compositeSources(fontController, componentNames) {
  const found = new Map();
  for (const name of componentNames) {
    const varGlyph = await fontController.getGlyph(name);
    if (!varGlyph) continue;
    for (const source of varGlyph.sources) {
      if (source.inactive) continue;
      const fontLocation = fontLocationOf(fontController, varGlyph.getSourceLocation(source));
      const key = locationKey(fontLocation);
      if (!found.has(key)) found.set(key, { source, fontLocation });
    }
  }
  const usedLayerNames = new Set();
  const result = [];
  const defaultKey = locationKey(fontAxisDefaults(fontController));
  const entries = [...found.entries()].sort(([a], [b]) => (a === defaultKey ? -1 : b === defaultKey ? 1 : 0));
  for (const [, { source, fontLocation }] of entries) {
    let layerName = source.locationBase || source.layerName || "default";
    while (usedLayerNames.has(layerName)) layerName += "#";
    usedLayerNames.add(layerName);
    const glyphSource = source.locationBase
      ? { name: "", layerName, location: {}, locationBase: source.locationBase }
      : { name: source.name || "", layerName, location: { ...(source.location || {}) } };
    result.push({ glyphSource, fontLocation });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Costruire e riallineare
// ---------------------------------------------------------------------------

// Assicura che base e segni abbiano le ancore che servono (le aggiunge se mancano)
async function planNeededAnchors(fontController, parts, builder, anchored) {
  const needs = [];
  if (parts.marks.length) {
    for (const mark of parts.marks) {
      needs.push([parts.baseName, mark.kind]);
      needs.push([mark.name, `_${mark.kind}`]);
    }
  }
  for (const [glyphName, anchorName] of needs) {
    const key = `${glyphName}/${anchorName}`;
    if (anchored.has(key)) continue;
    anchored.add(key);
    if (await planAnchors(fontController, glyphName, builder, { onlyIfMissing: anchorName })) {
      anchored.add(`changed:${glyphName}`);
    }
  }
}

// Nuova accentata: restituisce il VariableGlyph (oggetto semplice) o null
async function buildCompositeGlyph(fontController, targetName, parts) {
  const names = [parts.baseName, ...parts.marks.map((m) => m.name)];
  const sources = await compositeSources(fontController, names);
  const layers = {};
  const unattached = new Set();
  for (const { glyphSource, fontLocation } of sources) {
    const layout = await computeLayout(fontController, parts.baseName, parts.marks, fontLocation);
    if (!layout) return null;
    layout.unattached.forEach((n) => unattached.add(n));
    const components = [makeComponent(parts.baseName, 0, 0)];
    parts.marks.forEach((mark, i) => {
      const offset = layout.offsets[i] || { x: 0, y: 0 };
      components.push(makeComponent(mark.name, offset.x, offset.y));
    });
    layers[glyphSource.layerName] = {
      glyph: {
        xAdvance: layout.xAdvance,
        path: { coordinates: [], pointTypes: [], contourInfo: [] },
        components,
        anchors: [],
      },
    };
  }
  return {
    glyph: {
      name: targetName,
      axes: [],
      sources: sources.map((s) => s.glyphSource),
      layers,
      customData: { [AUTO_ALIGN_KEY]: true },
    },
    unattached: [...unattached],
  };
}

function hasContours(varGlyph) {
  return Object.values(varGlyph.glyph.layers).some((layer) => layer.glyph.path?.coordinates?.length);
}

function isComposite(varGlyph) {
  return (
    !hasContours(varGlyph) &&
    Object.values(varGlyph.glyph.layers).some((layer) => (layer.glyph.components || []).length >= 2)
  );
}

function isAutoAligned(varGlyph) {
  return varGlyph?.glyph?.customData?.[AUTO_ALIGN_KEY] === true;
}

// false = l'utente l'ha spento apposta: "Assegna gruppi" non tocca il glifo
function isAutoAlignOff(varGlyph) {
  return varGlyph?.glyph?.customData?.[AUTO_ALIGN_KEY] === false;
}

function markListForComponents(fontController, components) {
  return components.slice(1).map((component) => ({
    name: component.name,
    kind: describeGlyph(fontController, component.name).kind || "top",
  }));
}

// Riallinea un'accentata esistente, in tutti i master
async function planRealign(fontController, glyphName, builder) {
  const varGlyph = await fontController.getGlyph(glyphName);
  if (!varGlyph) return false;
  let changed = false;
  for (const source of varGlyph.sources) {
    const layer = varGlyph.glyph.layers[source.layerName];
    const components = layer?.glyph.components || [];
    if (components.length < 2 || layer.glyph.path?.coordinates?.length) continue;
    const fontLocation = fontLocationOf(fontController, varGlyph.getDenseSourceLocationForSource(source));
    const baseT = components[0].transformation;
    const layout = await computeLayout(
      fontController,
      components[0].name,
      markListForComponents(fontController, components),
      fontLocation,
      { x: baseT.translateX || 0, y: baseT.translateY || 0 }
    );
    if (!layout) continue;
    const layerPath = ["glyphs", glyphName, "layers", source.layerName, "glyph"];
    layout.offsets.forEach((offset, i) => {
      if (!offset) return;
      const t = components[i + 1].transformation;
      const path = [...layerPath, "components", i + 1, "transformation"];
      if (t.translateX !== offset.x) {
        builder.set(path, "translateX", offset.x, t.translateX);
        changed = true;
      }
      if (t.translateY !== offset.y) {
        builder.set(path, "translateY", offset.y, t.translateY);
        changed = true;
      }
    });
    const width = layout.xAdvance + (baseT.translateX || 0);
    if (layer.glyph.xAdvance !== width) {
      builder.set(layerPath, "xAdvance", width, layer.glyph.xAdvance);
      changed = true;
    }
  }
  return changed;
}

function setAutoAlignFlag(varGlyph, glyphName, value, builder) {
  const current = varGlyph.glyph.customData?.[AUTO_ALIGN_KEY];
  if (current === value) return;
  builder.set(["glyphs", glyphName, "customData"], AUTO_ALIGN_KEY, value, current);
}

// ---------------------------------------------------------------------------
// Gruppi di kerning: l'accentata va negli stessi gruppi della lettera base
// ---------------------------------------------------------------------------

// In Fontra: groupsSide2 = lato sinistro del glifo, groupsSide1 = lato destro
const SIDE_LEFT = "groupsSide2";
const SIDE_RIGHT = "groupsSide1";

function groupOf(groups, glyphName) {
  for (const [groupName, members] of Object.entries(groups || {})) {
    if (members.includes(glyphName)) return groupName;
  }
  return null;
}

function insertSorted(list, name) {
  if (list.includes(name)) return list;
  const result = [...list];
  const index = result.findIndex((other) => name < other);
  if (index >= 0) result.splice(index, 0, name);
  else result.push(name);
  return result;
}

const DOTLESS_TO_LETTER = { idotless: "i", dotlessi: "i", jdotless: "j", dotlessj: "j", uni0237: "j" };

// Da quale lettera prende i gruppi un glifo che esiste già
async function groupEntryFor(fontController, glyphName) {
  const codePoint = fontController.glyphMap[glyphName]?.[0];
  const parts = codePoint !== undefined ? resolveParts(fontController, codePoint) : null;
  if (parts?.groupBaseName) {
    return { name: glyphName, baseName: parts.groupBaseName, skipRight: parts.skipRight };
  }
  const varGlyph = await fontController.getGlyph(glyphName);
  const layer = varGlyph?.glyph.layers[varGlyph.sources[0]?.layerName] || Object.values(varGlyph?.glyph.layers || {})[0];
  const components = layer?.glyph.components || [];
  if (components.length < 2) return null;
  const first = components[0].name;
  return {
    name: glyphName,
    baseName: DOTLESS_TO_LETTER[first] && DOTLESS_TO_LETTER[first] in fontController.glyphMap ? DOTLESS_TO_LETTER[first] : first,
    skipRight: markListForComponents(fontController, components).some((m) => m.kind === "topright"),
  };
}

// entries: [{ name, baseName, skipRight }]. Il glifo copia i gruppi della base
// (anche "nessun gruppo"); con skipRight il lato destro non viene toccato.
async function planGroupSync(fontController, entries, builder) {
  const report = { changed: [], skippedRight: [] };
  if (!entries.length) return report;
  let table;
  try {
    table = (await fontController.getKerning())?.kern;
  } catch (error) {
    table = null;
  }
  if (!table) return report;
  const changed = new Set();
  for (const side of [SIDE_LEFT, SIDE_RIGHT]) {
    const original = table[side] || {};
    const work = Object.fromEntries(Object.entries(original).map(([g, members]) => [g, [...members]]));
    for (const { name, baseName, skipRight } of entries) {
      if (!baseName || name === baseName) continue;
      if (side === SIDE_RIGHT && skipRight) {
        report.skippedRight.push(name);
        continue;
      }
      const target = groupOf(work, baseName);
      const current = groupOf(work, name);
      if (target === current) continue;
      if (current) work[current] = work[current].filter((n) => n !== name);
      if (target) work[target] = insertSorted(work[target], name);
      changed.add(name);
    }
    for (const groupName of new Set([...Object.keys(original), ...Object.keys(work)])) {
      const before = original[groupName];
      const after = work[groupName];
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const path = ["kerning", "kern", side];
      if (!after?.length) {
        // Gruppo rimasto vuoto: si toglie, come fa Fontra
        builder.forward.push({ p: path, f: "d", a: [groupName] });
        builder.backward.unshift({ p: path, f: "=", a: [groupName, clone(before)] });
      } else {
        builder.set(path, groupName, after, clone(before));
      }
    }
  }
  report.changed = [...changed];
  return report;
}

// Dopo una modifica del plugin ai gruppi, la cache del kerning va svuotata
// (anche nelle altre finestre)
function listenForGroupChanges(fontController) {
  // La panoramica di Fontra non riceve le modifiche al kerning fatte nelle altre
  // finestre: senza questa iscrizione lavorerebbe su gruppi vecchi.
  Promise.resolve(fontController.getKerning?.())
    .then(() => fontController.subscribeChanges?.({ kerning: null }, false))
    .catch(() => {});
  fontController.addChangeListener(
    { kerning: null },
    (change) => {
      if (!change?.[META_KEY]) return;
      fontController.getKerningController?.("kern")?.then(
        (kc) => kc.clearCaches(),
        () => {}
      );
    },
    false,
    true
  );
}

// Compone (o ricompone) un elenco di lettere: [{ glyphName, codePoint }].
// Opzioni: replaceDrawn = ricomponi anche i glifi disegnati.
async function planCompose(fontController, targets, { replaceDrawn = false } = {}) {
  const anchorsBuilder = new ChangeBuilder();
  const glyphsBuilder = new ChangeBuilder();
  const report = {
    created: [], recomposed: [], skippedDrawn: [], missing: new Map(), unattached: new Set(), anchored: [],
    groups: { changed: [], skippedRight: [] },
  };
  const anchored = new Set();
  const plans = [];

  for (const { glyphName, codePoint } of targets) {
    const cp = codePoint ?? codePointForGlyph(fontController, glyphName);
    const parts = resolveParts(fontController, cp);
    if (!parts) continue;
    if (parts.missing.length) {
      for (const name of parts.missing) report.missing.set(name, (report.missing.get(name) || 0) + 1);
      continue;
    }
    const targetName = glyphName || fontController.characterMap?.[cp] || standardNameForCodePoint(cp);
    const existing = targetName in fontController.glyphMap ? await fontController.getGlyph(targetName) : null;
    if (existing && hasContours(existing) && !replaceDrawn) {
      report.skippedDrawn.push(targetName);
      continue;
    }
    await planNeededAnchors(fontController, parts, anchorsBuilder, anchored);
    plans.push({ targetName, codePoint: cp, parts, existing });
  }

  // Le ancore nuove servono subito per calcolare le posizioni
  if (!anchorsBuilder.isEmpty) {
    await fontController.applyChange({ c: anchorsBuilder.forward });
    report.anchored = [...anchored].filter((k) => k.startsWith("changed:")).map((k) => k.slice(8));
  }

  for (const plan of plans) {
    const built = await buildCompositeGlyph(fontController, plan.targetName, plan.parts);
    if (!built) continue;
    built.unattached.forEach((n) => report.unattached.add(n));
    if (plan.existing) {
      glyphsBuilder.set(["glyphs"], plan.targetName, built.glyph, clone(plan.existing.glyph));
      report.recomposed.push(plan.targetName);
    } else {
      glyphsBuilder.set(["glyphMap"], plan.targetName, [plan.codePoint], undefined);
      glyphsBuilder.set(["glyphs"], plan.targetName, built.glyph, undefined);
      report.created.push(plan.targetName);
    }
  }

  // Gruppi di kerning della lettera base
  const groupEntries = plans
    .filter((plan) => report.created.includes(plan.targetName) || report.recomposed.includes(plan.targetName))
    .map((plan) => ({ name: plan.targetName, baseName: plan.parts.groupBaseName, skipRight: plan.parts.skipRight }));
  report.groups = await planGroupSync(fontController, groupEntries, glyphsBuilder);
  return { anchorsBuilder, glyphsBuilder, report };
}

// ---------------------------------------------------------------------------
// Finestre (messaggi, conferme)
// ---------------------------------------------------------------------------

const DIALOG_CSS = `
  .ca-backdrop {
    position: fixed; inset: 0; z-index: 1000;
    background: #0003;
    display: flex; align-items: center; justify-content: center;
    font-family: fontra-ui-regular, -apple-system, system-ui, sans-serif;
    font-size: 13px;
  }
  .ca-box {
    width: 380px; max-height: 80vh; overflow: auto; padding: 16px 18px 14px; border-radius: 12px;
    background: var(--ui-element-background-color, #fff);
    color: var(--ui-element-foreground-color, #222);
    box-shadow: 0 8px 30px #0004, 0 0 0 0.5px #0003;
  }
  .ca-title { font-weight: bold; margin-bottom: 8px; }
  .ca-body p { margin: 0 0 7px; line-height: 1.4; }
  .ca-body .muted { opacity: 0.65; font-size: 11.5px; }
  .ca-body .warn { color: #d97706; }
  .ca-buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .ca-buttons button {
    font: inherit; padding: 4px 12px; border-radius: 6px; cursor: pointer;
    border: 1px solid #8885; background: transparent; color: inherit;
  }
  .ca-buttons button.primary { background: #3b82f6; border-color: #3b82f6; color: #fff; }
`;

// paragraphs: [{ text, cls }]; buttons: [{ label, value, primary }]
function showDialog(title, paragraphs, buttons) {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${DIALOG_CSS}</style>
      <div class="ca-backdrop"><div class="ca-box" role="dialog">
        <div class="ca-title"></div><div class="ca-body"></div><div class="ca-buttons"></div>
      </div></div>`;
    root.querySelector(".ca-title").textContent = title;
    const body = root.querySelector(".ca-body");
    for (const { text, cls } of paragraphs) {
      const p = document.createElement("p");
      p.textContent = text;
      if (cls) p.className = cls;
      body.appendChild(p);
    }
    const close = (value) => {
      host.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const buttonRow = root.querySelector(".ca-buttons");
    let primary = null;
    for (const { label, value, primary: isPrimary } of buttons) {
      const button = document.createElement("button");
      button.textContent = label;
      if (isPrimary) {
        button.className = "primary";
        primary = value;
      }
      button.addEventListener("click", () => close(value));
      buttonRow.appendChild(button);
    }
    const onKey = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close(primary);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    root.querySelector(".ca-backdrop").addEventListener("pointerdown", (event) => {
      if (event.target === event.currentTarget) close(null);
    });
    document.body.appendChild(host);
  });
}

function listNames(names, max = 12) {
  const list = [...names];
  return list.length > max ? `${list.slice(0, max).join(", ")} e altri ${list.length - max}` : list.join(", ");
}

function reportParagraphs(report) {
  const out = [];
  if (report.created.length) out.push({ text: `Creati ${report.created.length}: ${listNames(report.created)}.` });
  if (report.recomposed.length) out.push({ text: `Ricomposti ${report.recomposed.length}: ${listNames(report.recomposed)}.` });
  if (report.anchored.length) {
    out.push({ text: `Ho aggiunto le ancore che mancavano a: ${listNames(report.anchored)}. Puoi spostarle: le accentate le seguono.` });
  }
  if (report.groups?.changed.length) {
    out.push({ text: `Gruppi di kerning presi dalla lettera base: ${listNames(report.groups.changed)}.` });
  }
  if (report.groups?.skippedRight.length) {
    out.push({
      cls: "muted",
      text: `Lato destro lasciato fuori dai gruppi perché il segno sporge: ${listNames(report.groups.skippedRight)}.`,
    });
  }
  if (report.unattached.size) {
    out.push({
      cls: "warn",
      text: `Senza ancora corrispondente, centrati a occhio: ${listNames(report.unattached)}. Aggiungi le ancore (⌘U) e si allineano.`,
    });
  }
  if (report.missing.size) {
    const missing = [...report.missing.entries()].map(([name, n]) => `${name} (${n})`);
    out.push({ cls: "warn", text: `Non costruite perché nel font manca il segno o la lettera base: ${listNames(missing, 10)}.` });
  }
  if (report.skippedDrawn.length) {
    out.push({ cls: "muted", text: `Lasciate com'erano perché disegnate a mano: ${listNames(report.skippedDrawn)}.` });
  }
  if (!out.length) out.push({ text: "Niente da comporre." });
  return out;
}

function showError(error) {
  console.error("[Ancore e accentate]", error);
  showDialog("Ancore e accentate", [{ text: `Operazione non riuscita: ${error?.message || error}`, cls: "warn" }], [
    { label: "OK", value: true, primary: true },
  ]);
}

function isTyping() {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return !!element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable);
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

// ⌘U aggiunge le ancore, ⌥⌘U le ripristina (come in Glyphs)
function installAnchorShortcut(callback) {
  window.addEventListener(
    "keydown",
    (event) => {
      const commandKey = IS_MAC ? event.metaKey : event.ctrlKey;
      if (!commandKey || event.shiftKey || event.code !== "KeyU" || isTyping()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      callback(event.altKey);
    },
    true
  );
}

// ---------------------------------------------------------------------------
// Allineamento automatico: dopo ogni modifica alle ancore o alle larghezze
// ---------------------------------------------------------------------------

const RELEVANT_KEYS = new Set(["anchors", "xAdvance", "components", "sources", "layers", "customData"]);

function collectRelevantGlyphNames(change, prefix = [], names = new Set()) {
  const path = [...prefix, ...(change.p || [])];
  if (path[0] === "glyphs") {
    if (path.length === 1) {
      if (change.f && change.a?.[0] !== undefined) names.add(change.a[0]);
    } else if (change.f) {
      const relevant =
        path.length <= 3 ||
        path.some((element) => RELEVANT_KEYS.has(element)) ||
        RELEVANT_KEYS.has(change.a?.[0]);
      if (relevant) names.add(path[1]);
    }
  }
  for (const child of change.c || []) collectRelevantGlyphNames(child, path, names);
  return names;
}

class AutoAligner {
  constructor(fontController) {
    this.fontController = fontController;
    this.pending = new Set();
    this.running = false;
    fontController.addChangeListener(
      { glyphs: null },
      (change, isExternalChange) => {
        if (isExternalChange || !change) return; // la finestra che ha fatto la modifica riallinea
        for (const name of collectRelevantGlyphNames(change)) this.pending.add(name);
        if (this.pending.size) this.schedule();
      },
      false
    );
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), REALIGN_DELAY_MS);
  }

  async run() {
    if (this.running) {
      this.schedule();
      return;
    }
    this.running = true;
    try {
      const changed = [...this.pending];
      this.pending.clear();
      const candidates = new Set();
      for (const name of changed) {
        if (name in this.fontController.glyphMap) candidates.add(name);
        try {
          for (const user of (await this.fontController.findGlyphsThatUseGlyph(name)) || []) candidates.add(user);
        } catch (error) {
          for (const user of this.fontController.glyphUsedBy?.[name] || []) candidates.add(user);
        }
      }
      const builder = new ChangeBuilder();
      for (const name of candidates) {
        const varGlyph = await this.fontController.getGlyph(name);
        if (isAutoAligned(varGlyph)) await planRealign(this.fontController, name, builder);
      }
      if (!builder.isEmpty) {
        const { change, rollbackChange } = builder.build({ realign: true });
        await this.fontController.applyChange(change);
        await postChange(this.fontController, change, rollbackChange, "Allinea accentate");
      }
    } catch (error) {
      console.error("[Ancore e accentate] Allineamento automatico:", error);
    } finally {
      this.running = false;
    }
  }
}

// Quando cambia il gruppo di kerning di una lettera (per esempio dalla Barra
// info), le sue accentate con l'allineamento automatico la seguono.
function snapshotGroups(table) {
  const snapshot = {};
  for (const side of [SIDE_LEFT, SIDE_RIGHT]) {
    snapshot[side] = new Map();
    for (const [groupName, members] of Object.entries(table?.[side] || {})) {
      for (const member of members) snapshot[side].set(member, groupName);
    }
  }
  return snapshot;
}

class GroupFollower {
  constructor(fontController) {
    this.fontController = fontController;
    this.snapshot = null;
    fontController.getKerning?.().then(
      (kerning) => (this.snapshot = snapshotGroups(kerning?.kern)),
      () => {}
    );
    fontController.addChangeListener(
      { kerning: null },
      (change, isExternalChange) => this.onChange(change, isExternalChange),
      false
    );
  }

  async onChange(change, isExternalChange) {
    try {
      const kerning = await this.fontController.getKerning();
      const next = snapshotGroups(kerning?.kern);
      const previous = this.snapshot;
      this.snapshot = next;
      // Solo la finestra che ha fatto la modifica, e non per le modifiche del plugin
      if (!previous || isExternalChange || !change || change[META_KEY]) return;

      const moved = new Set();
      for (const side of [SIDE_LEFT, SIDE_RIGHT]) {
        for (const name of new Set([...previous[side].keys(), ...next[side].keys()])) {
          if (previous[side].get(name) !== next[side].get(name)) moved.add(name);
        }
      }
      if (!moved.size) return;

      const entries = [];
      for (const [glyphName, codePoints] of Object.entries(this.fontController.glyphMap)) {
        const codePoint = codePoints?.[0];
        if (codePoint === undefined || !decompose(codePoint)) continue;
        const parts = resolveParts(this.fontController, codePoint);
        if (!parts?.groupBaseName || !moved.has(parts.groupBaseName)) continue;
        if (!isAutoAligned(await this.fontController.getGlyph(glyphName))) continue;
        entries.push({ name: glyphName, baseName: parts.groupBaseName, skipRight: parts.skipRight });
      }
      const builder = new ChangeBuilder();
      await planGroupSync(this.fontController, entries, builder);
      if (builder.isEmpty) return;
      const built = builder.build({ groups: true });
      await this.fontController.applyChange(built.change);
      await postChange(this.fontController, built.change, built.rollbackChange, "Gruppi di kerning delle accentate");
    } catch (error) {
      console.error("[Ancore e accentate] Gruppi di kerning:", error);
    }
  }
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

class EditorComposeAccents {
  constructor(editor, moduleURL) {
    this.editor = editor;
    this.fontController = editor.fontController;
    this.sc = editor.sceneController;
    this.moduleURL = moduleURL;
    loadGlyphData();
    this.aligner = new AutoAligner(this.fontController);
    this.groupFollower = new GroupFollower(this.fontController);
    listenForGroupChanges(this.fontController);
    this.installMenuItems();
    installAnchorShortcut((reset) => {
      if (this.selectedExistingName) this.setAnchors(reset);
    });
    this.linkOverviewWindows();
  }

  get sceneSettings() {
    return this.sc.sceneSettings;
  }

  get selectedPositionedGlyph() {
    return this.sceneSettings.selectedGlyph ? this.sc.sceneModel.getSelectedPositionedGlyph?.() : undefined;
  }

  get selectedExistingName() {
    const name = this.sceneSettings.selectedGlyph ? this.sceneSettings.selectedGlyphName : undefined;
    return name && name in this.fontController.glyphMap ? name : undefined;
  }

  // La lettera selezionata (anche non ancora creata) e le sue parti
  get selectedTarget() {
    const positioned = this.selectedPositionedGlyph;
    if (!positioned?.glyphName) return null;
    // Se l'accentata non esiste, Fontra mostra "ǎ" come a + caron: il carattere
    // scritto resta nel testo, ed è quello che va composto.
    const lineIndex = this.sceneSettings.selectedGlyph?.lineIndex;
    const typed = this.sceneSettings.characterLines?.[lineIndex]?.[positioned.cluster];
    const typedCodePoint = typed?.character?.codePointAt(0);
    if (typedCodePoint !== undefined && [...typed.character].length === 1 && decompose(typedCodePoint)) {
      const parts = resolveParts(this.fontController, typedCodePoint);
      if (parts) {
        const glyphName =
          this.fontController.characterMap?.[typedCodePoint] || typed.glyphName || standardNameForCodePoint(typedCodePoint);
        return { glyphName, codePoint: typedCodePoint, parts, exists: glyphName in this.fontController.glyphMap };
      }
    }
    const glyphName = positioned.glyphName;
    const codePoint =
      this.fontController.glyphMap[glyphName]?.[0] ?? positioned.character?.codePointAt(0) ?? codePointForGlyph(this.fontController, glyphName);
    const parts = resolveParts(this.fontController, codePoint);
    if (!parts) return null;
    return { glyphName, codePoint, parts, exists: glyphName in this.fontController.glyphMap };
  }

  makeMenuItems() {
    const plugin = this;
    return [
      {
        title: () => {
          const target = this.selectedTarget;
          if (!target) return "Componi accentata";
          return `${target.exists ? "Ricomponi" : "Componi"} «${target.glyphName}»`;
        },
        enabled: () => {
          const target = this.selectedTarget;
          return !this.fontController.readOnly && !!target && !target.parts.missing.length;
        },
        callback: () => this.composeSelected(),
      },
      {
        title: "Allineamento automatico",
        get checked() {
          const name = plugin.selectedExistingName;
          return !!name && plugin.autoAlignCache.get(name) === true;
        },
        enabled: () => {
          const name = this.selectedExistingName;
          this.refreshAutoAlignCache(name);
          return !this.fontController.readOnly && !!name && this.compositeCache.get(name) === true;
        },
        callback: () => this.toggleAutoAlign(),
      },
      {
        title: "Aggiungi ancore  (⌘U)",
        enabled: () => !this.fontController.readOnly && !!this.selectedExistingName,
        callback: () => this.setAnchors(false),
      },
      {
        title: "Ripristina ancore  (⌥⌘U)",
        enabled: () => !this.fontController.readOnly && !!this.selectedExistingName,
        callback: () => this.setAnchors(true),
      },
    ];
  }

  // Il menu chiede "spuntato?" in modo sincrono: teniamo una piccola cache
  refreshAutoAlignCache(name) {
    if (!name) return;
    this.fontController.getGlyph(name).then((varGlyph) => {
      if (!varGlyph) return;
      this.autoAlignCache.set(name, isAutoAligned(varGlyph));
      this.compositeCache.set(name, Object.values(varGlyph.glyph.layers).some((l) => (l.glyph.components || []).length >= 1));
    });
  }

  installMenuItems() {
    this.autoAlignCache = new Map();
    this.compositeCache = new Map();
    const refresh = () => this.refreshAutoAlignCache(this.selectedExistingName);
    this.sc.sceneSettingsController?.addKeyListener?.(["selectedGlyph", "selectedGlyphName"], refresh);
    this.fontController.addChangeListener({ glyphs: null }, () => setTimeout(refresh, 0), false);

    const items = this.editor.glyphSelectedContextMenuItems;
    if (Array.isArray(items)) {
      const anchor = items.findIndex((item) => item?.actionIdentifier === MENU_ANCHOR);
      items.splice(anchor >= 0 ? anchor + 1 : items.length, 0, { title: "-" }, ...this.makeMenuItems());
    } else {
      console.warn("[Ancore e accentate] Menu contestuale di Fontra non trovato: voci non aggiunte.");
    }
    const originalGlyphMenu = this.editor.getGlyphMenuItems;
    if (typeof originalGlyphMenu === "function") {
      const extraItems = this.makeMenuItems();
      this.editor.getGlyphMenuItems = (...args) => [
        ...(originalGlyphMenu.apply(this.editor, args) || []),
        { title: "-" },
        ...extraItems,
      ];
    }
  }

  async commit(builders, label, undoGlyphName) {
    const { change, rollbackChange } = combineChanges(builders, { label });
    if (!change.c.length) return false;
    await postChange(this.fontController, change, rollbackChange, label, this);
    if (undoGlyphName) {
      const selection = new Set(this.sc.selection);
      this.fontController.pushUndoRecordForGlyph(undoGlyphName, change, rollbackChange, {
        label,
        undoSelection: selection,
        redoSelection: selection,
      });
    }
    return true;
  }

  async setAnchors(reset) {
    const name = this.selectedExistingName;
    if (!name || this.fontController.readOnly) return;
    try {
      await loadGlyphData();
      const builder = new ChangeBuilder();
      const changed = await planAnchors(this.fontController, name, builder, { reset });
      if (!changed) return;
      const { change } = builder.build();
      await this.fontController.applyChange(change);
      await this.commit([builder], reset ? "Ripristina ancore" : "Aggiungi ancore", name);
    } catch (error) {
      showError(error);
    }
  }

  async composeSelected() {
    const target = this.selectedTarget;
    if (!target || this.fontController.readOnly) return;
    try {
      await loadGlyphData();
      let replaceDrawn = false;
      if (target.exists) {
        const varGlyph = await this.fontController.getGlyph(target.glyphName);
        if (hasContours(varGlyph)) {
          const answer = await showDialog(
            `Ricomponi «${target.glyphName}»`,
            [{ text: "Questo glifo è disegnato a mano. Ricomponendolo il disegno viene sostituito dai componenti (puoi annullare con ⌘Z)." }],
            [
              { label: "Annulla", value: false },
              { label: "Ricomponi", value: true, primary: true },
            ]
          );
          if (!answer) return;
          replaceDrawn = true;
        }
      }
      const wasEditing = !!this.sceneSettings.selectedGlyph?.isEditing;
      const { anchorsBuilder, glyphsBuilder, report } = await planCompose(
        this.fontController,
        [{ glyphName: target.glyphName, codePoint: target.codePoint }],
        { replaceDrawn }
      );
      if (glyphsBuilder.isEmpty) {
        if (!anchorsBuilder.isEmpty) await this.commit([anchorsBuilder], "Aggiungi ancore", null);
        showDialog("Componi accentata", reportParagraphs(report), [{ label: "OK", value: true, primary: true }]);
        return;
      }
      await this.fontController.applyChange({ c: glyphsBuilder.forward });
      await this.commit([anchorsBuilder, glyphsBuilder], `Componi ${target.glyphName}`, target.glyphName);
      if (report.anchored.length || report.unattached.size) {
        showDialog("Componi accentata", reportParagraphs(report), [{ label: "OK", value: true, primary: true }]);
      }
      if (wasEditing) {
        await sleep(0);
        this.sceneSettings.selectedGlyph = { ...this.sceneSettings.selectedGlyph, isEditing: true };
      }
    } catch (error) {
      showError(error);
    }
  }

  async toggleAutoAlign() {
    const name = this.selectedExistingName;
    if (!name) return;
    try {
      await loadGlyphData();
      const varGlyph = await this.fontController.getGlyph(name);
      const turnOn = !isAutoAligned(varGlyph);
      const builder = new ChangeBuilder();
      setAutoAlignFlag(varGlyph, name, turnOn, builder);
      await this.fontController.applyChange({ c: builder.forward });
      if (turnOn) {
        const realign = new ChangeBuilder();
        await planRealign(this.fontController, name, realign);
        await this.fontController.applyChange({ c: realign.forward });
        builder.forward.push(...realign.forward);
        builder.backward.unshift(...realign.backward);
        // e i gruppi di kerning della lettera base
        const groups = new ChangeBuilder();
        const entry = await groupEntryFor(this.fontController, name);
        if (entry) await planGroupSync(this.fontController, [entry], groups);
        if (!groups.isEmpty) {
          await this.fontController.applyChange({ c: groups.forward });
          builder.forward.push(...groups.forward);
          builder.backward.unshift(...groups.backward);
        }
      }
      this.autoAlignCache.set(name, turnOn);
      await this.commit([builder], turnOn ? "Attiva allineamento automatico" : "Disattiva allineamento automatico", name);
    } catch (error) {
      showError(error);
    }
  }

  // --- panoramica (come nel plugin "Rinomina e duplica glifi") ----------------

  linkOverviewWindows() {
    if (!this.moduleURL) return;
    this.overviewWindows = new Set();
    try {
      if (window.opener) this.overviewWindows.add(window.opener);
    } catch (error) {
      // finestra di un altro sito: ignorata
    }
    const originalOpen = window.open;
    const windows = this.overviewWindows;
    const plugin = this;
    window.open = function (...args) {
      const opened = originalOpen.apply(this, args);
      if (opened && /fontoverview/.test(`${args[0] ?? ""} ${args[1] ?? ""}`)) {
        windows.add(opened);
        setTimeout(() => plugin.installInOverviews(), 500);
      }
      return opened;
    };
    this.installInOverviews();
    setInterval(() => this.installInOverviews(), OVERVIEW_POLL_MS);
  }

  installInOverviews() {
    const project = new URL(window.location.href).searchParams.get("project");
    for (const win of this.overviewWindows) {
      try {
        if (!win || win.closed) {
          this.overviewWindows.delete(win);
          continue;
        }
        if (win[OVERVIEW_KEY] || !win.fontOverviewController) continue;
        if (new URL(win.location.href).searchParams.get("project") !== project) continue;
        win[OVERVIEW_KEY] = "loading";
        const script = win.document.createElement("script");
        script.type = "module";
        script.textContent =
          `import(${JSON.stringify(this.moduleURL)})` +
          `.then((m) => m.startOverview(window.fontOverviewController))` +
          `.catch((e) => console.error("[Ancore e accentate]", e));`;
        win.document.head.appendChild(script);
      } catch (error) {
        // finestra non raggiungibile
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Panoramica del font
// ---------------------------------------------------------------------------

class OverviewComposeAccents {
  constructor(controller) {
    this.controller = controller;
    this.fontController = controller.fontController;
    loadGlyphData();
    listenForGroupChanges(this.fontController);
    this.installMenuItems();
    this.installChunkedUndo();
    installAnchorShortcut((reset) => this.setAnchors(reset));
  }

  // Glifi selezionati, anche quelli dei set di glifi non ancora creati
  get selectedInfos() {
    const infos = this.controller.glyphCellView?.getSelectedGlyphInfo?.() || [];
    const seen = new Set();
    return infos.filter((info) => !seen.has(info.glyphName) && seen.add(info.glyphName));
  }

  get selectedExistingNames() {
    return this.selectedInfos.map((i) => i.glyphName).filter((n) => n in this.fontController.glyphMap);
  }

  get composableSelection() {
    return this.selectedInfos.filter((info) => {
      const codePoint = info.codePoints?.[0] ?? codePointForGlyph(this.fontController, info.glyphName);
      return !!decompose(codePoint);
    });
  }

  installMenuItems() {
    const original = this.controller.getEditMenuItems;
    if (typeof original !== "function") {
      console.warn("[Ancore e accentate] Questa versione di Fontra non ha il menu nella panoramica: aggiornala.");
      return;
    }
    const readOnly = () => this.fontController.readOnly;
    const extraItems = [
      { title: "-" },
      {
        title: () => {
          const n = this.composableSelection.length;
          return n > 1 ? `Componi ${n} accentate` : "Componi accentata";
        },
        enabled: () => !readOnly() && this.composableSelection.length > 0,
        callback: () => this.composeSelection(),
      },
      {
        title: "Componi tutte le accentate latine…",
        enabled: () => !readOnly(),
        callback: () => this.composeAllLatin(),
      },
      {
        title: () =>
          this.selectedExistingNames.length
            ? "Assegna gruppi di kerning dalle lettere base (selezione)"
            : "Assegna gruppi di kerning dalle lettere base",
        enabled: () => !readOnly(),
        callback: () => this.assignGroups(),
      },
      {
        title: () => {
          const n = this.selectedExistingNames.length;
          return n > 1 ? `Aggiungi ancore a ${n} glifi  (⌘U)` : "Aggiungi ancore  (⌘U)";
        },
        enabled: () => !readOnly() && this.selectedExistingNames.length > 0,
        callback: () => this.setAnchors(false),
      },
      {
        title: "Ripristina ancore  (⌥⌘U)",
        enabled: () => !readOnly() && this.selectedExistingNames.length > 0,
        callback: () => this.setAnchors(true),
      },
    ];
    this.controller.getEditMenuItems = (...args) => [
      ...(original.apply(this.controller, args) || []),
      ...extraItems,
    ];
  }

  async commit(builders, label, selectionAfter) {
    const { change, rollbackChange } = combineChanges(builders, { label });
    if (!change.c.length) return;
    const cellView = this.controller.glyphCellView;
    const selectionBefore = new Set(cellView?.glyphSelection || []);
    if (typeof this.controller.postChange !== "function" || !this.controller.undoStack) {
      await postChange(this.fontController, change, rollbackChange, label);
      return;
    }
    if (cellView && selectionAfter) cellView.glyphSelection = selectionAfter;
    const contextCallbacks = {
      undoCallback: () => cellView && (cellView.glyphSelection = selectionBefore),
      redoCallback: () => cellView && selectionAfter && (cellView.glyphSelection = selectionAfter),
    };
    if (countGlyphs(change) <= GLYPHS_PER_CHUNK) {
      await this.controller.postChange({ change, rollbackChange }, label, contextCallbacks);
      return;
    }
    // Modifica grande: a blocchi, ma un solo passo di annullamento
    this.controller.undoStack.pushUndoRecord({ change, rollbackChange, info: { label, contextCallbacks } });
    await postChunked(this.fontController, change, label);
  }

  // ⌘Z / ripeti per le modifiche grandi: anche l'annullamento parte a blocchi
  installChunkedUndo() {
    const controller = this.controller;
    const original = controller.doUndoRedo;
    if (typeof original !== "function" || !controller.undoStack) return;
    controller.doUndoRedo = async (isRedo) => {
      const top = controller.undoStack.getTopUndoRedoRecord(isRedo);
      const isOurs = top?.change?.[META_KEY] && countGlyphs(top.change) > GLYPHS_PER_CHUNK;
      if (!isOurs) return original.call(controller, isRedo);
      const record = controller.undoStack.popUndoRedoRecord(isRedo);
      const change = isRedo ? record.change : record.rollbackChange;
      await this.fontController.applyChange(change);
      await postChunked(this.fontController, change, record.info.label);
      await sleep(0);
      record.info.contextCallbacks?.[isRedo ? "redoCallback" : "undoCallback"]?.();
    };
  }

  async setAnchors(reset) {
    const names = this.selectedExistingNames;
    if (!names.length || this.fontController.readOnly) return;
    try {
      await loadGlyphData();
      const builder = new ChangeBuilder();
      for (const name of names) await planAnchors(this.fontController, name, builder, { reset });
      if (builder.isEmpty) return;
      await this.fontController.applyChange({ c: builder.forward });
      // Le accentate che usano questi glifi si riallineano
      const realign = await this.planDependentsRealign(names);
      if (!realign.isEmpty) await this.fontController.applyChange({ c: realign.forward });
      await this.commit([builder, realign], reset ? "Ripristina ancore" : "Aggiungi ancore");
    } catch (error) {
      showError(error);
    }
  }

  async planDependentsRealign(names) {
    const builder = new ChangeBuilder();
    const users = new Set();
    for (const name of names) {
      try {
        for (const user of (await this.fontController.findGlyphsThatUseGlyph(name)) || []) users.add(user);
      } catch (error) {
        // ricerca non disponibile
      }
    }
    for (const user of users) {
      const varGlyph = await this.fontController.getGlyph(user);
      if (isAutoAligned(varGlyph)) await planRealign(this.fontController, user, builder);
    }
    return builder;
  }

  async composeTargets(targets, label) {
    const { anchorsBuilder, glyphsBuilder, report } = await planCompose(this.fontController, targets);
    if (!glyphsBuilder.isEmpty) {
      await this.fontController.applyChange({ c: glyphsBuilder.forward });
    }
    const touched = [...report.created, ...report.recomposed];
    await this.commit([anchorsBuilder, glyphsBuilder], label, touched.length ? new Set(touched) : null);
    return report;
  }

  async composeSelection() {
    const targets = this.composableSelection.map((info) => ({
      glyphName: info.glyphName,
      codePoint: info.codePoints?.[0],
    }));
    if (!targets.length) return;
    try {
      await loadGlyphData();
      const report = await this.composeTargets(targets, targets.length > 1 ? "Componi accentate" : `Componi ${targets[0].glyphName}`);
      if (targets.length > 1 || report.anchored.length || report.unattached.size || report.missing.size || report.skippedDrawn.length) {
        showDialog("Componi accentate", reportParagraphs(report), [{ label: "OK", value: true, primary: true }]);
      }
    } catch (error) {
      showError(error);
    }
  }

  // Le accentate selezionate (o tutte) prendono i gruppi della loro lettera base
  async assignGroups() {
    try {
      await loadGlyphData();
      const fc = this.fontController;
      let names = this.selectedExistingNames;
      const all = !names.length;
      if (all) {
        names = Object.entries(fc.glyphMap)
          .filter(([, codePoints]) => codePoints?.[0] !== undefined && decompose(codePoints[0]))
          .map(([name]) => name);
      }
      const entries = [];
      const skippedOff = [];
      for (const name of names) {
        const varGlyph = await fc.getGlyph(name);
        if (isAutoAlignOff(varGlyph)) {
          skippedOff.push(name);
          continue;
        }
        const entry = await groupEntryFor(fc, name);
        if (entry) entries.push(entry);
      }
      const builder = new ChangeBuilder();
      const report = await planGroupSync(fc, entries, builder);
      if (!builder.isEmpty) {
        await fc.applyChange({ c: builder.forward });
        await this.commit([builder], "Assegna gruppi di kerning");
      }
      const paragraphs = [];
      if (report.changed.length) {
        const n = report.changed.length;
        paragraphs.push({ text: `Gruppi della lettera base assegnati a ${n} ${n === 1 ? "glifo" : "glifi"}: ${listNames(report.changed)}.` });
      } else {
        paragraphs.push({
          text: entries.length
            ? "Niente da cambiare: le accentate sono già nei gruppi delle lettere base (o le lettere base non hanno gruppi)."
            : "Nessuna lettera accentata da sistemare" + (all ? " nel font." : " nella selezione."),
        });
      }
      if (report.skippedRight.length) {
        paragraphs.push({ cls: "muted", text: `Lato destro lasciato fuori perché il segno sporge: ${listNames(report.skippedRight)}.` });
      }
      if (skippedOff.length) {
        paragraphs.push({ cls: "muted", text: `Non toccate perché hai spento l'allineamento automatico: ${listNames(skippedOff)}.` });
      }
      showDialog("Gruppi di kerning", paragraphs, [{ label: "OK", value: true, primary: true }]);
    } catch (error) {
      showError(error);
    }
  }

  async composeAllLatin() {
    try {
      await loadGlyphData();
      const fc = this.fontController;
      const targets = [];
      const missing = new Map();
      for (const [from, to] of LATIN_RANGES) {
        for (let cp = from; cp <= to; cp++) {
          if (fc.characterMap?.[cp]) continue; // c'è già
          const parts = resolveParts(fc, cp);
          if (!parts) continue;
          if (parts.missing.length) {
            for (const name of parts.missing) missing.set(name, (missing.get(name) || 0) + 1);
            continue;
          }
          targets.push({ glyphName: null, codePoint: cp });
        }
      }
      const paragraphs = [
        { text: `Posso creare ${targets.length} lettere accentate latine che mancano, con le lettere e i segni che il font ha già.` },
        { cls: "muted", text: "I glifi che esistono già non vengono toccati. Puoi annullare tutto con ⌘Z." },
      ];
      if (missing.size) {
        const top = [...missing.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} (${c})`);
        paragraphs.push({ cls: "warn", text: `Altre restano fuori perché nel font mancano: ${listNames(top, 10)}.` });
      }
      if (!targets.length) {
        await showDialog("Componi tutte le accentate latine", paragraphs, [{ label: "OK", value: true, primary: true }]);
        return;
      }
      const answer = await showDialog("Componi tutte le accentate latine", paragraphs, [
        { label: "Annulla", value: false },
        { label: `Crea ${targets.length} glifi`, value: true, primary: true },
      ]);
      if (!answer) return;
      const report = await this.composeTargets(targets, "Componi accentate latine");
      showDialog("Componi tutte le accentate latine", reportParagraphs(report), [{ label: "OK", value: true, primary: true }]);
    } catch (error) {
      showError(error);
    }
  }
}

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------

export function start(editor, pluginPath) {
  if (editor[EDITOR_KEY]) return;
  editor[EDITOR_KEY] = new EditorComposeAccents(editor, import.meta.url);
}

export function startOverview(controller) {
  if (!controller || window[OVERVIEW_KEY] === true) return;
  window[OVERVIEW_KEY] = true;
  controller[OVERVIEW_KEY] = new OverviewComposeAccents(controller);
}

// Per i test
export { decompose, resolveParts, defaultAnchorsFor, describeGlyph, loadGlyphData };
