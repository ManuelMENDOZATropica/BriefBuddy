// api/upload.js
import { google } from "googleapis";
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs/promises";
import path from "node:path";

// Vercel/Next
export const config = {
  api: { bodyParser: false },
  runtime: "nodejs",
};

/* ───────────────────────────── Helpers env ───────────────────────────── */
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

/* ───────────────────────────── Google Auth/Drive ───────────────────────────── */
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
  const auth = oauthClient();
  return google.drive({ version: "v3", auth });
}

/* ───────────────────────────── Utilidades varias ───────────────────────────── */
const TITLE_MAX = 64;

const titleCase = (s = "") =>
  s
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());

const formatDateMX = (d = new Date()) => {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
};

const sanitizeName = (s = "") =>
  s
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

function detectCategory(brief = {}, text = "", filename = "") {
  const hay = (needle) =>
    (brief.alcance || "").toLowerCase().includes(needle) ||
    text.toLowerCase().includes(needle) ||
    filename.toLowerCase().includes(needle);
  if (hay("spot") || hay("video") || hay("mp4") || hay("film")) return "Videos";
  if (hay("campaña") || hay("campaign")) return "Campaña";
  if (hay("branding") || hay("marca")) return "Branding";
  if (hay("web") || hay("sitio")) return "Web";
  if (hay("evento")) return "Evento";
  return "Proyecto";
}

function inferClientName(brief = {}, text = "", email = "", filename = "") {
  // 1) Por texto "Empresa:" o "Cliente:"
  const m1 = /(?:Empresa|Cliente)\s*:\s*([^\n]+)/i.exec(text);
  if (m1?.[1]) {
    const raw = m1[1]
      .replace(/\b(S\.?A\.?( de C\.?V\.?)?|SAS|SA|Ltd\.?|LLC|Studio|Estudio)\b/gi, "")
      .trim();
    if (raw) return titleCase(raw).slice(0, TITLE_MAX);
  }
  // 2) Por dominio del correo
  const mail = (brief?.contacto?.correo || email || "").toLowerCase();
  const dom = (mail.split("@")[1] || "").split(".")[0];
  if (dom) return titleCase(dom).slice(0, TITLE_MAX);
  // 3) Por nombre del archivo (primera palabra significativa)
  const base = path.basename(filename || "Proyecto", path.extname(filename || ""));
  return titleCase(base.split(/\W+/)[0] || "Proyecto").slice(0, TITLE_MAX);
}

/* ───────────────────────────── Drive helpers ───────────────────────────── */
async function createOrGetFolder(drive, name, parentId) {
  const safe = sanitizeName(name);
  const q =
    `name = '${safe.replace(/'/g, "\\'")}' and ` +
    `mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`;
  const { data } = await drive.files.list({ q, fields: "files(id,name,webViewLink)", pageSize: 1 });
  if (data.files?.length) return data.files[0];

  const resp = await drive.files.create({
    requestBody: {
      name: safe,
      parents: [parentId],
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id,name,webViewLink",
  });
  return resp.data;
}

async function shareAnyone(drive, fileId) {
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: "reader", type: "anyone" },
    });
  } catch (e) {
    console.warn("permissions.create warning:", e?.message || e);
  }
}

async function moveFileToFolder(drive, fileId, fromParentId, toFolderId) {
  try {
    const resp = await drive.files.update({
      fileId,
      addParents: toFolderId,
      removeParents: fromParentId,
      fields: "id, parents",
    });
    return resp.data;
  } catch (e) {
    console.warn("moveFileToFolder warning:", e?.message || e);
    return null;
  }
}

async function createTextFile(drive, folderId, name, content, mime = "text/markdown") {
  const { Readable } = await import("stream");
  const stream = Readable.from([content]);
  const resp = await drive.files.create({
    requestBody: { name: sanitizeName(name), parents: [folderId] },
    media: { mimeType: mime, body: stream },
    fields: "id,name,webViewLink",
  });
  return resp.data;
}

/* ───────────────────────────── Multipart parser ───────────────────────────── */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: false,
      keepExtensions: true,
      maxFileSize: 100 * 1024 * 1024, // 100MB
    });

    form.parse(req, async (err, fields, files) => {
      try {
        if (err) return reject(err);

        let f =
          files.file ??
          files.upload ??
          files.attachment ??
          Object.values(files)[0];

        if (Array.isArray(f)) f = f[0];
        if (!f || !f.filepath) return resolve({ fields, file: null });

        const buffer = await fs.readFile(f.filepath);

        const filename = f.originalFilename || f.newFilename || "upload";
        const mimeFromForm = (f.mimetype || "").split(";")[0].trim().toLowerCase();
        const ext = path.extname(filename).toLowerCase();
        const guessedMime =
          ext === ".pdf"
            ? "application/pdf"
            : ext === ".docx"
            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            : mimeFromForm || "application/octet-stream";

        resolve({
          fields,
          file: { buffer, filename, mimeType: guessedMime, _tmpPath: f.filepath },
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

/* ───────────────────────────── Extractores ───────────────────────────── */
async function extractText({ buffer, mimeType }) {
  try {
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error("Archivo vacío o no es Buffer válido");
    }
    const mt = (mimeType || "").toLowerCase();

    if (mt.includes("pdf")) {
      // Import directo a la función real para evitar sample path
      const pdfParseModule = await import("pdf-parse/lib/pdf-parse.js");
      const pdfParse = pdfParseModule.default || pdfParseModule;
      const data = await pdfParse(buffer);
      return (data.text || "").trim();
    }
    if (mt.includes("wordprocessingml") || mt.includes("msword") || mt.includes("officedocument")) {
      const mammothModule = await import("mammoth");
      const { extractRawText } = mammothModule;
      const { value } = await extractRawText({ buffer });
      return (value || "").trim();
    }
    return "";
  } catch (err) {
    console.error("extractText error:", err);
    return "";
  }
}

/* ───────────────────────────── Prompts ───────────────────────────── */
function briefPrompt(texto, nombreArchivo, link) {
  return [
    { role: "system", content: "Eres un PM creativo. Devuelve SOLO JSON válido." },
    {
      role: "user",
      content: `
Archivo del cliente:
- Nombre: ${nombreArchivo}
- Link Drive: ${link}

Texto extraído (truncado):
"""
${(texto || "").slice(0, 12000)}
"""

Tarea:
1) Devuelve JSON con:
{
  "contacto": { "nombre": "", "correo": "" },
  "alcance": "",
  "objetivos": [],
  "audiencia": { "descripcion": "", "canales": [] },
  "marca": { "tono": "", "valores": [], "referencias": [] },
  "entregables": [],
  "logistica": { "fechas": [], "presupuesto": null, "aprobaciones": [] },
  "extras": { "riesgos": [], "notas": [] },
  "faltantes": [],
  "siguiente_pregunta": ""
}
2) Rellena solo si estás seguro; no inventes.
3) "faltantes" = campos importantes que faltan.
4) "siguiente_pregunta" = UNA pregunta clara para avanzar.
      `.trim(),
    },
  ];
}

function mkBriefMarkdown({ label, driveLink, brief, textPreview }) {
  const b = brief || {};
  const faltan = Array.isArray(b.faltantes) ? b.faltantes : [];
  const md = `# Brief — ${label}

**Archivo original:** ${driveLink ? `[Link al archivo](${driveLink})` : "—"}

## Contacto
- Nombre: ${b?.contacto?.nombre || "—"}
- Correo: ${b?.contacto?.correo || "—"}

## Alcance
${b.alcance || "—"}

## Objetivos
${Array.isArray(b.objetivos) && b.objetivos.length ? b.objetivos.map((o) => `- ${o}`).join("\n") : "—"}

## Audiencia
- Descripción: ${b?.audiencia?.descripcion || "—"}
- Canales: ${Array.isArray(b?.audiencia?.canales) && b.audiencia.canales.length ? b.audiencia.canales.join(", ") : "—"}

## Marca
- Tono: ${b?.marca?.tono || "—"}
- Valores: ${Array.isArray(b?.marca?.valores) && b.marca.valores.length ? b.marca.valores.join(", ") : "—"}
- Referencias: ${Array.isArray(b?.marca?.referencias) && b.marca.referencias.length ? b.marca.referencias.join(", ") : "—"}

## Entregables
${Array.isArray(b.entregables) && b.entregables.length ? b.entregables.map((e) => `- ${e}`).join("\n") : "—"}

## Logística
- Fechas: ${Array.isArray(b?.logistica?.fechas) && b.logistica.fechas.length ? b.logistica.fechas.join(", ") : "—"}
- Presupuesto: ${b?.logistica?.presupuesto ?? "—"}
- Aprobaciones: ${Array.isArray(b?.logistica?.aprobaciones) && b.logistica.aprobaciones.length ? b.logistica.aprobaciones.join(", ") : "—"}

## Extras
- Riesgos: ${Array.isArray(b?.extras?.riesgos) && b.extras.riesgos.length ? b.extras.riesgos.map((r)=>`- ${r}`).join("\n") : "—"}
- Notas: ${Array.isArray(b?.extras?.notas) && b.extras.notas.length ? b.extras.notas.map((n)=>`- ${n}`).join("\n") : "—"}

## Faltantes
${faltan.length ? faltan.map((f) => `- ${f}`).join("\n") : "—"}

## Siguiente pregunta
${b.siguiente_pregunta || "—"}

---

### Extracto del documento original
\`\`\`
${(textPreview || "").slice(0, 1200) || "—"}
\`\`\`
`;
  return md;
}

function soaPrompt(brief, label) {
  const theme = [
    `Genera un documento en Markdown llamado "State of Art — ${label}".`,
    `Secciones:`,
    `1) **20 proyectos con temáticas similares** al brief. Prioriza campañas ganadoras o destacadas en **Cannes Lions**.`,
    `2) **20 proyectos con técnicas/tecnologías similares** aunque la temática sea distinta.`,
    `Para cada proyecto incluye:`,
    `- Título o nombre de la campaña`,
    `- Marca / Cliente`,
    `- Año (aproximado si no estás seguro)`,
    `- Reconocimiento (indica Cannes Lions si aplica, o "—")`,
    `- 1–2 líneas: por qué es relevante para este brief`,
    `- (Opcional) sugerencia de búsqueda/fuente a validar (no inventes URLs si no estás seguro)`,
    ``,
    `Base tu selección en este brief (resumen):`,
    JSON.stringify(
      {
        alcance: brief?.alcance || "",
        objetivos: brief?.objetivos || [],
        audiencia: brief?.audiencia || {},
        marca: brief?.marca || {},
        entregables: brief?.entregables || [],
        logistica: brief?.logistica || {},
      },
      null,
      2
    ),
  ].join("\n");

  return [
    { role: "system", content: "Eres un investigador creativo senior. Devuelve SOLO Markdown válido." },
    { role: "user", content: theme },
  ];
}

/* ───────────────────────────── Handler principal ───────────────────────────── */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    required("OPENAI_API_KEY");
    required("DRIVE_FOLDER_ID");

    const { file } = await parseMultipart(req);
    if (!file) return res.status(400).json({ error: "No file" });

    const drive = driveClient();
    const rootFolderId = process.env.DRIVE_FOLDER_ID;

    // 0) Subir archivo a carpeta raíz temporalmente
    const { Readable } = await import("stream");
    const tmpStream = new Readable({
      read() {
        this.push(file.buffer);
        this.push(null);
      },
    });

    const uploaded = await drive.files.create({
      requestBody: { name: file.filename, parents: [rootFolderId] },
      media: { mimeType: file.mimeType, body: tmpStream },
      fields: "id,name,mimeType,webViewLink,parents",
    });
    await shareAnyone(drive, uploaded.data.id);

    const { data: meta0 } = await drive.files.get({
      fileId: uploaded.data.id,
      fields: "id,name,mimeType,webViewLink,parents",
    });
    const originalLink = meta0.webViewLink;

    // 1) Extraer texto → brief con OpenAI
    const text = await extractText(file);
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: briefPrompt(text, file.filename, originalLink),
      response_format: { type: "json_object" },
    });

    let brief = {};
    try {
      brief = JSON.parse(ai.choices?.[0]?.message?.content || "{}");
    } catch {
      brief = {};
    }

    // 2) Crear carpeta de proyecto "Categoría | Cliente | DD-MM-YYYY"
    const categoria = detectCategory(brief, text, file.filename);
    const cliente = inferClientName(brief, text, brief?.contacto?.correo || "", file.filename);
    const label = `${categoria} | ${cliente} | ${formatDateMX()}`;
    const projectFolder = await createOrGetFolder(drive, label, rootFolderId);
    await shareAnyone(drive, projectFolder.id); // opcional, hereda a hijos

    // 3) Mover archivo original a la carpeta del proyecto
    await moveFileToFolder(drive, meta0.id, rootFolderId, projectFolder.id);

    // 4) Crear documento del brief (Markdown)
    const briefMD = mkBriefMarkdown({
      label,
      driveLink: originalLink,
      brief,
      textPreview: (text || "").slice(0, 2000),
    });
    const briefDoc = await createTextFile(
      drive,
      projectFolder.id,
      `Brief — ${label}.md`,
      briefMD,
      "text/markdown"
    );
    await shareAnyone(drive, briefDoc.id);

    // 5) Subcarpeta "State of Art" + documento
    const soaFolder = await createOrGetFolder(drive, "State of Art", projectFolder.id);
    await shareAnyone(drive, soaFolder.id);

    const soa = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: soaPrompt(brief, label),
    });
    const soaText = soa.choices?.[0]?.message?.content || "# State of Art\n(Contenido no disponible)";
    const soaDoc = await createTextFile(
      drive,
      soaFolder.id,
      `State of Art — ${label}.md`,
      soaText,
      "text/markdown"
    );
    await shareAnyone(drive, soaDoc.id);

    // Limpia tmp
    try { if (file._tmpPath) await fs.unlink(file._tmpPath).catch(() => {}); } catch {}

    return res.status(200).json({
      drive: {
        id: meta0.id,
        name: meta0.name,
        link: originalLink,
        mimeType: meta0.mimeType,
      },
      projectFolder: {
        id: projectFolder.id,
        name: projectFolder.name,
        link: projectFolder.webViewLink,
      },
      briefDoc: {
        id: briefDoc.id,
        name: briefDoc.name,
        link: briefDoc.webViewLink,
      },
      stateOfArt: {
        folderId: soaFolder.id,
        folderLink: soaFolder.webViewLink,
        docId: soaDoc.id,
        docLink: soaDoc.webViewLink,
      },
      brief,
      textPreview: (text || "").slice(0, 500),
      label,
    });
  } catch (e) {
    console.error("upload handler error:", e?.response?.data || e);
    const message = e?.response?.data?.error || e?.message || "Upload error";
    return res.status(500).json({ error: message });
  }
}
