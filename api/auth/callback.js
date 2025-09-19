import { google } from "googleapis";

export default async function handler(req, res) {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");

  const oauth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  const { tokens } = await oauth.getToken(code);
  // tokens = { access_token, refresh_token, expiry_date, ... }

  // Muestra una mini página con el refresh_token para que lo copies
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
    <h2>Tokens obtenidos</h2>
    <pre>${JSON.stringify(tokens, null, 2)}</pre>
    <p><strong>Copia el refresh_token</strong> y guárdalo como <code>GOOGLE_REFRESH_TOKEN</code> en tus variables de entorno (Vercel y .env.local).</p>
  `);
}
