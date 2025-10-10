// api/finalize.js
import { google } from "googleapis";
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

export const config = {
  api: { bodyParser: false },
  runtime: "nodejs",
};

/* ───────────── Env & Auth ───────────── */
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
function oauthClient() {
  const oauth = new google.auth.OAuth2(
    required("GOOGLE_CLIENT_ID"),
    required("GOOGLE_CLIENT_SECRET"),
    required("GOOGLE_REDIRECT_URI")
  );
  oauth.setCredentials({ refresh_token: required("GOOGLE_REFRESH_TOKEN") });
  return oauth;
}
function driveClient() {
  return google.drive({ version: "v3", auth: oauthClient() });
}

/* ───────────── Utils ───────────── */
const TITLE_MAX = 64;
const titleCase = (s = "") =>
  s.toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (m) => m.toUpperCase());
const formatDateMX = (d = new Date()) => {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
};
const sanitizeName = (s = "") => s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);

function detectCategory(brief = {}, filename = "") {
  const txt = JSON.stringify(brief || {}).toLowerCase() + " " + filename.toLowerCase();
  if (/(spot|video|mp4|film)/.test(txt)) return "Videos";
  if (/(campaña|campaign)/.test(txt)) return "Campaña";
  if (/(branding|marca)/.test(txt)) return "Branding";
  if (/(web|sitio)/.test(txt)) return "Web";
  if (/evento/.test(txt)) return "Evento";
  return "Proyecto";
}
function inferClientName(brief = {}, filename = "") {
  const mail = (brief?.contacto?.correo || "").toLowerCase();
  const dom = (mail.split("@")[1] || "").split(".")[0];
  if (dom) return titleCase(dom).slice(0, TITLE_MAX);
  const base = path.basename(filename || "Proyecto", path.extname(filename || ""));
  return titleCase(base.split(/\W+/)[0] || "Proyecto").slice(0, TITLE_MAX);
}

/* ───────────── Drive helpers ───────────── */
async function createOrGetFolder(drive, name, parentId) {
  const safe = sanitizeName(name);
  const q = `name='${safe.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const { data } = await drive.files.list({ q, fields: "files(id,name,webViewLink)", pageSize: 1 });
  if (data.files?.length) return data.files[0];
  const resp = await drive.files.create({
    requestBody: { name: safe, parents: [parentId], mimeType: "application/vnd.google-apps.folder" },
    fields: "id,name,webViewLink",
  });
  return resp.data;
}
async function shareAnyone(drive, fileId) {
  try {
    await drive.permissions.create({ fileId, requestBody: { role: "reader", type: "anyone" } });
  } catch (e) { console.warn("permissions.create warn:", e?.message || e); }
}
async function createTextFile(drive, folderId, name, content, mime = "text/markdown") {
  return upsertDriveFile(drive, {
    folderId,
    name,
    mimeType: mime,
    data: typeof content === "string" ? content : String(content ?? ""),
  });
}

async function upsertDriveFile(drive, { folderId, name, mimeType, data }) {
  const safeName = sanitizeName(name) || "Archivo";
  const mime = mimeType || "application/octet-stream";
  const escaped = safeName.replace(/'/g, "\\'");
  const q = `name='${escaped}' and '${folderId}' in parents and trashed=false`;
  let files = [];
  try {
    const { data: respData } = await drive.files.list({
      q,
      fields: "files(id,name,mimeType,webViewLink)",
      pageSize: 10,
    });
    files = Array.isArray(respData?.files) ? respData.files : [];
  } catch (err) {
    console.warn("drive.list warn:", err?.message || err);
  }

  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""));
  const { Readable } = await import("stream");
  const bodyStream = () => Readable.from(buffer);

  let target = null;
  const [primary, ...duplicates] = files;

  try {
    if (primary?.id) {
      const resp = await drive.files.update({
        fileId: primary.id,
        requestBody: { name: safeName },
        media: { mimeType: mime, body: bodyStream() },
        fields: "id,name,webViewLink,mimeType",
      });
      target = resp.data;
    } else {
      const resp = await drive.files.create({
        requestBody: { name: safeName, parents: [folderId] },
        media: { mimeType: mime, body: bodyStream() },
        fields: "id,name,webViewLink,mimeType",
      });
      target = resp.data;
    }
  } catch (err) {
    console.error("drive upsert error:", err?.response?.data || err);
    throw err;
  }

  if (duplicates.length) {
    await Promise.all(
      duplicates.map(async (dup) => {
        if (!dup?.id) return;
        try {
          await drive.files.delete({ fileId: dup.id });
        } catch (err) {
          console.warn("drive delete warn:", err?.message || err);
        }
      })
    );
  }

  return target;
}

/* ───────────── Markdown builders ───────────── */
function mkBriefMarkdown({ label, fileLink, brief }) {
  const b = brief || {};
  const faltan = Array.isArray(b.faltantes) ? b.faltantes : [];
  const campania = b.campania || {};
  const brandSections = b.brand_sections || {};
  const meliSections = b.meli_sections || {};

  const bulletBlock = (value) => {
    const list = normalizeList(value);
    return list.length ? list.map((item) => `- ${item}`).join("\n") : "—";
  };

  const inlineBlock = (value) => {
    const list = normalizeList(value);
    return list.length ? list.join(", ") : "—";
  };

  const paragraphBlock = (value, fallback) => formatSectionText(value, fallback);

  const campaignOtros = normalizeList([campania?.otro_tipo, campania?.otros_tipos, campania?.otros]);
  const marketOtros = normalizeList([campania?.otros_mercados, campania?.otros]);

  return `# Brief — ${label}

**Archivo original:** ${fileLink ? `[Link al archivo](${fileLink})` : "—"}

## Contacto
- Nombre: ${b?.contacto?.nombre || "—"}
- Correo: ${b?.contacto?.correo || "—"}

## Alcance
${b.alcance || "—"}

## Objetivos
${bulletBlock(b.objetivos)}

## Audiencia
- Descripción: ${b?.audiencia?.descripcion || "—"}
- Canales: ${inlineBlock(b?.audiencia?.canales)}

## Marca
- Tono: ${b?.marca?.tono || "—"}
- Valores: ${inlineBlock(b?.marca?.valores)}
- Referencias: ${inlineBlock(b?.marca?.referencias)}

## Entregables
${bulletBlock(b.entregables)}

## Logística
- Fechas: ${inlineBlock(b?.logistica?.fechas)}
- Duración: ${inlineBlock(b?.logistica?.duracion)}
- Presupuesto: ${inlineBlock(b?.logistica?.presupuesto)}
- Aprobaciones: ${inlineBlock(b?.logistica?.aprobaciones)}

## Extras
- Riesgos:
${bulletBlock(b?.extras?.riesgos)}
- Notas:
${bulletBlock(b?.extras?.notas)}

## Campaign Overview
- Tipo: ${inlineBlock(campania?.tipo)}
- Mercados: ${inlineBlock(campania?.mercados)}
- Otros: ${inlineBlock([...campaignOtros, ...marketOtros])}

## 1. The Challenge
${paragraphBlock(brandSections.challenge, b.alcance)}

## 2. Strategic Foundation
${paragraphBlock(brandSections.strategic_foundation, [b?.audiencia?.descripcion, b?.marca?.valores])}

## 3. Creative Strategy
${paragraphBlock(brandSections.creative_strategy, [b?.marca?.tono, b?.extras?.notas])}

## 4. Campaign Architecture (Brand)
${paragraphBlock(brandSections.campaign_architecture, b.entregables)}

## 5. Appendix (Brand)
${paragraphBlock(brandSections.appendix, b?.extras?.referencias)}

## 6. MELI Ecosystem Integration
${paragraphBlock(meliSections.ecosystem_integration, [b?.extras?.notas, b?.audiencia?.canales])}

## 7. Campaign Architecture (MELI)
${paragraphBlock(meliSections.campaign_architecture, b.entregables)}

## 8. Media Ecosystem
${paragraphBlock(meliSections.media_ecosystem, [b?.audiencia?.canales, b?.logistica?.fechas])}

## 9. Production Considerations
${paragraphBlock(meliSections.production_considerations, [b?.logistica?.fechas, b?.logistica?.aprobaciones, b?.logistica?.presupuesto])}

## 10. Appendix (MELI)
${paragraphBlock(meliSections.appendix, b?.extras?.riesgos)}

## Faltantes
${bulletBlock(faltan)}

## Siguiente pregunta
${b.siguiente_pregunta || "—"}
`;
}

/* ───────────── DOCX helpers ───────────── */
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function flattenList(value) {
  if (value == null) return [];
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized ? [normalized] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenList(item));
  }
  if (typeof value === "object") {
    return Object.values(value).flatMap((item) => flattenList(item));
  }
  return [];
}

function dedupeStrings(values = []) {
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    const value = String(raw || "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalizeList(value) {
  return dedupeStrings(flattenList(value));
}

function bulletList(parts) {
  const normalized = normalizeList(parts);
  if (!normalized.length) return "—";
  return normalized.map((item) => `• ${item}`).join("\n");
}

function inlineList(parts) {
  const normalized = normalizeList(parts);
  return normalized.length ? normalized.join(" · ") : "—";
}

function formatSectionText(value, fallback) {
  const parts = normalizeList(value);
  if (parts.length) return parts.join("\n\n");
  if (fallback !== undefined) {
    const fallbackParts = normalizeList(fallback);
    if (fallbackParts.length) return fallbackParts.join("\n\n");
  }
  return "—";
}

function checkboxLine(label, options, selectedValues = [], otherValues = [], otherLabel = "Other") {
  const selected = normalizeList(selectedValues);
  const others = normalizeList(otherValues);
  const hits = new Set();
  const extras = [];

  selected.forEach((raw) => {
    const lower = raw.toLowerCase();
    const match = options.find((opt) =>
      (opt.match || [opt.key]).some((pattern) => lower.includes(pattern))
    );
    if (match) {
      hits.add(match.key);
    } else if (raw) {
      extras.push(raw);
    }
  });

  const extraValues = dedupeStrings([...extras, ...others]);
  const renderedOptions = options.map((opt) => `${hits.has(opt.key) ? "☑" : "☐"} ${opt.label}`);
  const otherText = extraValues.length
    ? `☑ ${otherLabel}: ${extraValues.join(", ")}`
    : `☐ ${otherLabel}: _________`;

  return `${label}: ${renderedOptions.join("  ")}  ${otherText}`;
}

function formatCampaignTypeLine(campania = {}) {
  return checkboxLine(
    "Campaign Type",
    [
      { key: "product_launch", label: "Product Launch", match: ["product launch", "lanzamiento"] },
      { key: "seasonal", label: "Seasonal Campaign", match: ["seasonal", "temporada", "estacional"] },
      { key: "brand_awareness", label: "Brand Awareness", match: ["brand awareness", "branding", "awareness"] },
      {
        key: "performance",
        label: "Performance/Sales",
        match: ["performance", "ventas", "sales", "conversion"],
      },
    ],
    campania?.tipo,
    campania?.otro_tipo ?? campania?.otros_tipos ?? campania?.otros ?? []
  );
}

function formatMarketsLine(campania = {}) {
  return checkboxLine(
    "Markets",
    [
      { key: "mexico", label: "Mexico", match: ["mexico", "méxico"] },
      { key: "argentina", label: "Argentina", match: ["argentina"] },
      { key: "brazil", label: "Brazil", match: ["brazil", "brasil"] },
      { key: "colombia", label: "Colombia", match: ["colombia"] },
    ],
    campania?.mercados,
    campania?.otros_mercados ?? campania?.otros ?? []
  );
}

function formatContactDocx(contacto) {
  const normalized = normalizeList(contacto);
  if (!normalized.length) return "—";
  const emails = normalized.filter((item) => /@/.test(item));
  const others = normalized.filter((item) => !/@/.test(item));
  return [...others, ...emails].join(" · ");
}

function formatAudienciaDocx(audiencia) {
  if (!audiencia || typeof audiencia !== "object") {
    return bulletList(audiencia);
  }
  const parts = [];
  if (audiencia.descripcion) parts.push(audiencia.descripcion);
  const canales = normalizeList(audiencia.canales);
  if (canales.length) parts.push(`Canales: ${canales.join(", ")}`);
  for (const [key, value] of Object.entries(audiencia)) {
    if (key === "descripcion" || key === "canales") continue;
    const values = normalizeList(value);
    if (!values.length) continue;
    const label = key
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (m) => m.toUpperCase());
    parts.push(`${label}: ${values.join(", ")}`);
  }
  return bulletList(parts);
}

function formatMarcaDocx(marca) {
  if (!marca || typeof marca !== "object") {
    return bulletList(marca);
  }
  const parts = [];
  const tonos = normalizeList(marca.tono);
  if (tonos.length) parts.push(`Tono: ${tonos.join(", ")}`);
  const valores = normalizeList(marca.valores);
  if (valores.length) parts.push(`Valores: ${valores.join(", ")}`);
  const referencias = normalizeList(marca.referencias);
  if (referencias.length) parts.push(`Referencias: ${referencias.join(", ")}`);
  for (const [key, value] of Object.entries(marca)) {
    if (["tono", "valores", "referencias"].includes(key)) continue;
    const values = normalizeList(value);
    if (!values.length) continue;
    const label = key
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (m) => m.toUpperCase());
    parts.push(`${label}: ${values.join(", ")}`);
  }
  return bulletList(parts);
}

function getParagraphText(p) {
  const texts = p.getElementsByTagName("w:t");
  let out = "";
  for (let i = 0; i < texts.length; i += 1) {
    out += texts.item(i)?.textContent || "";
  }
  return out;
}

function setParagraphText(p, text) {
  const doc = p.ownerDocument;
  const pPr = p.getElementsByTagName("w:pPr").item(0);
  const pPrClone = pPr ? pPr.cloneNode(true) : null;
  while (p.firstChild) {
    p.removeChild(p.firstChild);
  }
  if (pPrClone) p.appendChild(pPrClone);
  const run = doc.createElementNS(WORD_NS, "w:r");
  const lines = String(text ?? "—").split(/\r?\n/);
  lines.forEach((line, idx) => {
    const t = doc.createElementNS(WORD_NS, "w:t");
    const safe = line === "" ? " " : line;
    if (/^\s|\s$/.test(safe)) {
      t.setAttribute("xml:space", "preserve");
    }
    t.textContent = safe;
    run.appendChild(t);
    if (idx < lines.length - 1) {
      const br = doc.createElementNS(WORD_NS, "w:br");
      run.appendChild(br);
    }
  });
  p.appendChild(run);
}

function setCellValue(cell, value) {
  const doc = cell.ownerDocument;
  const paragraphs = Array.from(cell.getElementsByTagName("w:p"));
  if (!paragraphs.length) {
    const p = doc.createElementNS(WORD_NS, "w:p");
    cell.appendChild(p);
    setParagraphText(p, value);
    return;
  }
  paragraphs.forEach((para, idx) => {
    if (idx === 0) {
      setParagraphText(para, value);
    } else {
      cell.removeChild(para);
    }
  });
}

function normalizeLabel(text = "") {
  return text.replace(/[\s\u00a0]+/g, " ").trim().toLowerCase();
}

async function buildDocxBriefBuffer({ brief, label, clientName }) {
  try {
    const templatePath = path.join(process.cwd(), "assets", "Brief template.docx");
    const template = await fs.readFile(templatePath);
    const zip = await JSZip.loadAsync(template);
    const xml = await zip.file("word/document.xml").async("string");
    const doc = new DOMParser().parseFromString(xml, "application/xml");

    const contacto = formatContactDocx(brief?.contacto);
    const clientLabel = clientName || inferClientName(brief, "");
    const alcanceInline = inlineList([brief?.alcance]);
    const objetivosList = normalizeList(brief?.objetivos);
    const objetivosBullets = objetivosList.length ? objetivosList.map((o) => `• ${o}`).join("\n") : "—";
    const objetivosInline = objetivosList.length ? objetivosList.join(" · ") : alcanceInline;
    const audience = formatAudienciaDocx(brief?.audiencia);
    const brand = formatMarcaDocx(brief?.marca);
    const deliverables = bulletList(brief?.entregables);
    const notasExtras = normalizeList(brief?.extras?.notas);
    const riesgosExtras = normalizeList(brief?.extras?.riesgos);
    const fechas = normalizeList(brief?.logistica?.fechas);
    const aprobaciones = normalizeList(brief?.logistica?.aprobaciones);
    const presupuestoList = normalizeList(brief?.logistica?.presupuesto);
    const duracionList = normalizeList(brief?.logistica?.duracion);
    const campania = brief?.campania || {};
    const brandSections = brief?.brand_sections || {};
    const meliSections = brief?.meli_sections || {};
    const campaignTypeLine = formatCampaignTypeLine(campania);
    const marketsLine = formatMarketsLine(campania);
    const challengeSection = formatSectionText(brandSections.challenge, brief?.alcance);
    const strategicFoundationSection = formatSectionText(
      brandSections.strategic_foundation,
      [brief?.audiencia?.descripcion, brief?.marca?.valores]
    );
    const creativeStrategySection = formatSectionText(
      brandSections.creative_strategy,
      [brief?.marca?.tono, brief?.extras?.notas]
    );
    const brandCampaignArchitecture = formatSectionText(
      brandSections.campaign_architecture,
      brief?.entregables
    );
    const brandAppendix = formatSectionText(brandSections.appendix, brief?.extras?.referencias);
    const meliEcosystemIntegration = formatSectionText(
      meliSections.ecosystem_integration,
      [brief?.extras?.notas, brief?.audiencia?.canales]
    );
    const meliCampaignArchitecture = formatSectionText(
      meliSections.campaign_architecture,
      brief?.entregables
    );
    const mediaEcosystem = formatSectionText(
      meliSections.media_ecosystem,
      [brief?.audiencia?.canales, brief?.logistica?.fechas]
    );
    const productionConsiderations = formatSectionText(
      meliSections.production_considerations,
      [brief?.logistica?.fechas, brief?.logistica?.aprobaciones, brief?.logistica?.presupuesto]
    );
    const meliAppendix = formatSectionText(meliSections.appendix, brief?.extras?.riesgos);

    const businessParts = [];
    if (alcanceInline !== "—") businessParts.push(`Alcance: ${alcanceInline}`);
    if (objetivosInline && objetivosInline !== "—") {
      businessParts.push(`Objetivos: ${objetivosInline}`);
    }
    if (fechas.length) businessParts.push(`Fechas clave: ${fechas.join(", ")}`);
    if (presupuestoList.length) businessParts.push(`Presupuesto: ${presupuestoList.join(", ")}`);
    if (aprobaciones.length) businessParts.push(`Aprobaciones: ${aprobaciones.join(", ")}`);
    if (notasExtras.length) businessParts.push(`Notas: ${notasExtras.join("; ")}`);
    if (riesgosExtras.length) businessParts.push(`Riesgos: ${riesgosExtras.join(", ")}`);
    const businessContext = bulletList(businessParts);

    const briefTweet = objetivosInline && objetivosInline !== "—" ? objetivosInline : alcanceInline;
    const consumerInsight = bulletList([
      notasExtras.length ? `Notas clave: ${notasExtras.join("; ")}` : null,
      audience !== "—" ? `Audiencia: ${audience.replace(/^[•\s]+/, "")}` : null,
    ]);
    const culturalContext = bulletList([
      notasExtras.length ? notasExtras : null,
      riesgosExtras.length ? riesgosExtras.map((r) => `Riesgo: ${r}`) : null,
    ]);
    const competitiveDiff = bulletList([
      normalizeList(brief?.marca?.valores).length
        ? `Valores clave: ${normalizeList(brief?.marca?.valores).join(", ")}`
        : null,
      normalizeList(brief?.marca?.referencias).length
        ? `Referencias: ${normalizeList(brief?.marca?.referencias).join(", ")}`
        : null,
    ]);
    const keyMessage = objetivosList.length ? objetivosList[0] : alcanceInline;
    const emotionalTerritory = inlineList([brief?.marca?.tono]);
    const campaignTagline = inlineList([
      normalizeList(brief?.extras?.notas).slice(0, 1),
    ]);

    const tableFillers = [
      { key: "project name", value: label },
      { key: "brand", value: clientLabel },
      { key: "project lead @ meli", value: "—" },
      { key: "project lead @ brand", value: contacto },
      { key: "business context", value: businessContext },
      { key: "brief in a tweet", value: briefTweet || "—" },
      { key: "key success metrics", value: objetivosBullets },
      { key: "target audience", value: audience },
      { key: "key consumer insight", value: consumerInsight },
      { key: "brand truth", value: brand },
      { key: "cultural context", value: culturalContext },
      { key: "key competitors", value: bulletList(riesgosExtras.length ? riesgosExtras : []) },
      { key: "competitive differentiation", value: competitiveDiff },
      { key: "creative concept", value: deliverables },
      { key: "key message", value: keyMessage || "—" },
      { key: "emotional territory", value: emotionalTerritory },
      { key: "campaign tagline/theme", value: campaignTagline },
      { key: "content pillars", value: deliverables },
    ];

    const rows = doc.getElementsByTagName("w:tr");
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows.item(i);
      const cells = row.getElementsByTagName("w:tc");
      if (cells.length < 2) continue;
      const labelText = normalizeLabel(getParagraphText(cells.item(0)));
      if (!labelText) continue;
      const filler = tableFillers.find((entry) => labelText.startsWith(entry.key));
      if (!filler) continue;
      const value = filler.value && String(filler.value).trim() ? filler.value : "—";
      setCellValue(cells.item(1), value);
    }

    const preparedBy = inlineList([
      brief?.contacto?.nombre,
      brief?.contacto?.correo,
      clientLabel,
    ]);
    const launchDate = fechas[0] || "—";
    const duration = duracionList.length
      ? duracionList.join(", ")
      : fechas.length > 1
      ? fechas.slice(1).join(", ")
      : "—";
    const presupuesto = presupuestoList.join(", ") || "—";

    const paragraphReplacements = [
      { key: "campaign type :", value: campaignTypeLine },
      { key: "markets:", value: marketsLine },
      {
        key: "brief prepared by:",
        value: `Brief prepared by: ${preparedBy} Date: ${formatDateMX()}`,
      },
      { key: "campaign launch date :", value: `Campaign launch date : ${launchDate}` },
      { key: "campaign duration :", value: `Campaign duration : ${duration || "—"}` },
      {
        key: "media spend on mercado ads :",
        value: `Media spend on Mercado Ads : ${presupuesto}`,
      },
    ];

    const paragraphs = doc.getElementsByTagName("w:p");
    for (let i = 0; i < paragraphs.length; i += 1) {
      const p = paragraphs.item(i);
      const text = normalizeLabel(getParagraphText(p));
      if (!text) continue;
      const replacement = paragraphReplacements.find((entry) => text.startsWith(entry.key));
      if (!replacement) continue;
      setParagraphText(p, replacement.value);
    }

    const sectionFillers = [
      { key: "1. the challenge", value: challengeSection },
      { key: "2. strategic foundation", value: strategicFoundationSection },
      { key: "3. creative strategy", value: creativeStrategySection },
      { key: "4. campaign architecture", value: brandCampaignArchitecture },
      { key: "5. appendix", value: brandAppendix },
      { key: "6. meli ecosystem integration", value: meliEcosystemIntegration },
      { key: "7. campaign architecture", value: meliCampaignArchitecture },
      { key: "8. media ecosystem", value: mediaEcosystem },
      { key: "9. production considerations", value: productionConsiderations },
      { key: "10. appendix", value: meliAppendix },
    ];

    const paragraphList = Array.from(paragraphs);
    for (let i = 0; i < paragraphList.length; i += 1) {
      const current = paragraphList[i];
      const text = normalizeLabel(getParagraphText(current));
      if (!text) continue;
      const filler = sectionFillers.find((entry) => text.startsWith(entry.key));
      if (!filler) continue;

      let target = paragraphList[i + 1];
      const targetText = target ? normalizeLabel(getParagraphText(target)) : "";
      if (!target || targetText) {
        target = current.ownerDocument.createElementNS(WORD_NS, "w:p");
        current.parentNode.insertBefore(target, current.nextSibling);
      }
      setParagraphText(target, filler.value);
    }

    const updatedXml = new XMLSerializer().serializeToString(doc);
    zip.file("word/document.xml", updatedXml);
    return await zip.generateAsync({ type: "nodebuffer" });
  } catch (err) {
    console.warn("docx brief warn:", err?.message || err);
    return null;
  }
}

async function uploadDocxBrief({ drive, folderId, label, brief, clientName }) {
  const buffer = await buildDocxBriefBuffer({ brief, label, clientName });
  if (!buffer) return null;
  return upsertDriveFile(drive, {
    folderId,
    name: `Brief — ${label}.docx`,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    data: buffer,
  });
}

function soaPrompt(brief, label) {
  const theme = [
    `Genera un documento en Markdown llamado "State of Art — ${label}".`,
    `Secciones:`,
    `1) **20 proyectos con temáticas similares** al brief. Prioriza ganadores/destacados en **Cannes Lions**.`,
    `2) **20 proyectos con técnicas/tecnologías similares** aunque la temática sea distinta.`,
    `Por proyecto: Título, Marca/Cliente, Año (aprox), Reconocimiento (Cannes si aplica), 1–2 líneas de relevancia.`,
    `No inventes URLs. Puedes sugerir términos de búsqueda.`,
    ``,
    `Base (resumen del brief):`,
    JSON.stringify({
      alcance: brief?.alcance || "",
      objetivos: brief?.objetivos || [],
      audiencia: brief?.audiencia || {},
      marca: brief?.marca || {},
      entregables: brief?.entregables || [],
      logistica: brief?.logistica || {},
    }, null, 2),
  ].join("\n");

  return [
    { role: "system", content: "Eres un investigador creativo senior. Devuelve SOLO Markdown válido." },
    { role: "user", content: theme },
  ];
}

/* ───────────── Final brief (desde historial) ───────────── */
function finalBriefPrompt(historyJson) {
  return [
    { role: "system", content: "Eres un PM creativo. Devuelve SOLO JSON válido." },
    { role: "user", content: `
A partir de este historial de conversación (JSON) devuelve el **brief FINAL** en el siguiente esquema. No inventes datos; si falta algo, déjalo vacío o enuméralo en "faltantes".
Historial:
\`\`\`json
${historyJson}
\`\`\`

Esquema:
{
  "contacto": { "nombre": "", "correo": "" },
  "alcance": "",
  "objetivos": [],
  "audiencia": { "descripcion": "", "canales": [] },
  "marca": { "tono": "", "valores": [], "referencias": [] },
  "entregables": [],
  "logistica": { "fechas": [], "duracion": [], "presupuesto": null, "aprobaciones": [] },
  "extras": { "riesgos": [], "notas": [] },
  "campania": { "tipo": [], "mercados": [], "otro_tipo": [], "otros_tipos": [], "otros": [], "otros_mercados": [] },
  "brand_sections": {
    "challenge": "",
    "strategic_foundation": "",
    "creative_strategy": "",
    "campaign_architecture": "",
    "appendix": ""
  },
  "meli_sections": {
    "ecosystem_integration": "",
    "campaign_architecture": "",
    "media_ecosystem": "",
    "production_considerations": "",
    "appendix": ""
  },
  "faltantes": [],
  "siguiente_pregunta": ""
}
`.trim() },
  ];
}

/* ───────────── Multipart (file + fields) ───────────── */
function parseFinalizeForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({ multiples: false, keepExtensions: true, maxFileSize: 100 * 1024 * 1024 });
    form.parse(req, async (err, fields, files) => {
      try {
        if (err) return reject(err);
        let f = files.file ?? files.upload ?? files.attachment ?? null;
        if (Array.isArray(f)) f = f[0];

        let file = null;
        if (f?.filepath) {
          const buffer = await fs.readFile(f.filepath);
          const filename = f.originalFilename || f.newFilename || "upload";
          const mime = (f.mimetype || "").split(";")[0].trim();
          file = { buffer, filename, mimeType: mime, _tmpPath: f.filepath };
        }

        resolve({
          fields,
          file,
        });
      } catch (e) { reject(e); }
    });
  });
}

/* ───────────── Handler ───────────── */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    required("OPENAI_API_KEY");
    required("DRIVE_FOLDER_ID");

    const { fields, file } = await parseFinalizeForm(req);
    const messages = fields?.messages ? String(fields.messages) : "[]";
    const categoryOverride = fields?.category ? String(fields.category) : "";
    const clientOverride = fields?.client ? String(fields.client) : "";

    // 1) Consolidar brief final desde historial
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    let brief = {};
    try {
      const ai = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.1,
        messages: finalBriefPrompt(messages),
        response_format: { type: "json_object" },
      });
      brief = JSON.parse(ai.choices?.[0]?.message?.content || "{}");
    } catch (e) {
      console.warn("final brief warn:", e?.message || e);
      brief = {};
    }

    // 2) Carpeta de proyecto
    const drive = driveClient();
    const rootFolderId = process.env.DRIVE_FOLDER_ID;

    const category = categoryOverride || detectCategory(brief, file?.filename || "");
    const client = clientOverride || inferClientName(brief, file?.filename || "");
    const label = `${category} | ${client} | ${formatDateMX()}`;
    const projectFolder = await createOrGetFolder(drive, label, rootFolderId);
    await shareAnyone(drive, projectFolder.id);

    // 3) Subir archivo (si lo mandaron en finalize)
    let fileMeta = null;
    if (file?.buffer) {
      const uploaded = await upsertDriveFile(drive, {
        folderId: projectFolder.id,
        name: file.filename,
        mimeType: file.mimeType,
        data: file.buffer,
      });
      if (uploaded?.id) await shareAnyone(drive, uploaded.id);
      fileMeta = uploaded;
    }

    // 4) Brief.md
    const briefMD = mkBriefMarkdown({
      label,
      fileLink: fileMeta?.webViewLink || "",
      brief,
    });
    const briefDoc = await createTextFile(drive, projectFolder.id, `Brief — ${label}.md`, briefMD, "text/markdown");
    await shareAnyone(drive, briefDoc.id);

    // 5) Plantilla DOCX
    const briefDocx = await uploadDocxBrief({
      drive,
      folderId: projectFolder.id,
      label,
      brief,
      clientName: client,
    });
    if (briefDocx?.id) {
      await shareAnyone(drive, briefDocx.id);
    }

    // 6) State of Art
    const soaFolder = await createOrGetFolder(drive, "State of Art", projectFolder.id);
    await shareAnyone(drive, soaFolder.id);

    const soa = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: soaPrompt(brief, label),
    });
    const soaText = soa.choices?.[0]?.message?.content || "# State of Art\n(Contenido no disponible)";
    const soaDoc = await createTextFile(drive, soaFolder.id, `State of Art — ${label}.md`, soaText, "text/markdown");
    await shareAnyone(drive, soaDoc.id);

    // Limpieza tmp
    try { if (file?._tmpPath) await fs.unlink(file._tmpPath).catch(() => {}); } catch {}

    return res.status(200).json({
      projectFolder: { id: projectFolder.id, name: projectFolder.name, link: projectFolder.webViewLink },
      briefDoc: { id: briefDoc.id, name: briefDoc.name, link: briefDoc.webViewLink },
      briefDocx: briefDocx
        ? { id: briefDocx.id, name: briefDocx.name, link: briefDocx.webViewLink, mimeType: briefDocx.mimeType }
        : null,
      stateOfArt: { folderId: soaFolder.id, folderLink: soaFolder.webViewLink, docId: soaDoc.id, docLink: soaDoc.webViewLink },
      file: fileMeta ? { id: fileMeta.id, name: fileMeta.name, link: fileMeta.webViewLink, mimeType: fileMeta.mimeType } : null,
      label,
      brief,
    });
  } catch (e) {
    console.error("finalize handler error:", e?.response?.data || e);
    const message = e?.response?.data?.error || e?.message || "Finalize error";
    return res.status(500).json({ error: message });
  }
}
