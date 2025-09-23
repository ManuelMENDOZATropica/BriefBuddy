// api/finalize.js
import { google } from "googleapis";
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs/promises";
import path from "node:path";

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
  const { Readable } = await import("stream");
  const stream = Readable.from([content]);
  const resp = await drive.files.create({
    requestBody: { name: sanitizeName(name), parents: [folderId] },
    media: { mimeType: mime, body: stream },
    fields: "id,name,webViewLink",
  });
  return resp.data;
}

/* ───────────── Markdown builders ───────────── */
function mkBriefMarkdown({ label, fileLink, brief }) {
  const b = brief || {};
  const faltan = Array.isArray(b.faltantes) ? b.faltantes : [];
  return `# Brief — ${label}

**Archivo original:** ${fileLink ? `[Link al archivo](${fileLink})` : "—"}

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
`;
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
  "logistica": { "fechas": [], "presupuesto": null, "aprobaciones": [] },
  "extras": { "riesgos": [], "notas": [] },
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
      const { Readable } = await import("stream");
      const stream = new Readable({ read() { this.push(file.buffer); this.push(null); } });
      const up = await drive.files.create({
        requestBody: { name: file.filename, parents: [projectFolder.id] },
        media: { mimeType: file.mimeType, body: stream },
        fields: "id,name,mimeType,webViewLink",
      });
      await shareAnyone(drive, up.data.id);
      fileMeta = up.data;
    }

    // 4) Brief.md
    const briefMD = mkBriefMarkdown({
      label,
      fileLink: fileMeta?.webViewLink || "",
      brief,
    });
    const briefDoc = await createTextFile(drive, projectFolder.id, `Brief — ${label}.md`, briefMD, "text/markdown");
    await shareAnyone(drive, briefDoc.id);

    // 5) State of Art
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
