export default function handler(req, res) {
  const root = "https://accounts.google.com/o/oauth2/v2/auth";
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: [
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/userinfo.email"
    ].join(" "),
    access_type: "offline",
    prompt: "consent"
  });
  res.redirect(`${root}?${params.toString()}`);
}
