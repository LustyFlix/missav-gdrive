const fs = require("fs");
const path = require("path");
const xml2js = require("xml2js");
const { google } = require("googleapis");

// ================= CONFIG =================
const FLARESOLVERR_URL = "https://mabelle-supervenient-talitha.ngrok-free.dev/v1";
const FOLDER_ID = "1cRW-KEdJlOAHBmVrPqFwc7O2Ol3KSA9R";

// Load credentials from GitHub Secret
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);

// Google Auth
const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ["https://www.googleapis.com/auth/drive"]
});

const drive = google.drive({ version: "v3", auth });

// Sitemaps
const SITEMAP_URLS = [
  "https://missav.ws/sitemap_items_51.xml",
  "https://missav.ws/sitemap_items_52.xml"
];

// Directories
const POSTS_DIR = path.join(__dirname, "../data/posts");
const INDEX_DIR = path.join(__dirname, "../data/index");
const META_DIR = path.join(__dirname, "../data/meta");

[POSTS_DIR, INDEX_DIR, META_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ================= FETCH =================
async function fetchWithFlareSolverr(url) {
  const res = await fetch(FLARESOLVERR_URL, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      cmd: "request.get",
      url,
      maxTimeout: 60000
    })
  });

  const data = await res.json();
  if (!data.solution) throw new Error("FlareSolverr failed");

  return data.solution.response;
}

async function smartFetch(url) {
  try {
    const res = await fetch(url);
    if (res.ok) return await res.text();
  } catch {}

  console.log("⚡ FlareSolverr:", url);
  return await fetchWithFlareSolverr(url);
}

// ================= GOOGLE DRIVE =================
async function uploadToDrive(filePath, fileName) {
  try {
    const res = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [FOLDER_ID]
      },
      media: {
        mimeType: "text/html",
        body: fs.createReadStream(filePath)
      }
    });

    return res.data.id;
  } catch (err) {
    console.error("❌ Drive Upload Error:", err.message);
    return null;
  }
}

// ================= HELPERS =================
function getKey(url) {
  const match = url.match(/([a-z0-9\-]+)$/i);
  return match ? match[1].toLowerCase() : "unknown";
}

function getIndexFile(key) {
  return path.join(INDEX_DIR, key[0] + ".json");
}

function getMetaFile(key) {
  return path.join(META_DIR, key[0] + ".json");
}

function slugFromUrl(url) {
  const clean = url
    .replace(/https?:\/\/[^\/]+\//, "")
    .replace(/\/$/, "");

  const parts = clean.split("/");

  const langs = ["en","cn","zh","ja","ko","ms","th","de","fr","vi","id","fil","pt"];
  let lang = "xx";

  for (const p of parts) {
    if (langs.includes(p)) {
      lang = p;
      break;
    }
  }

  const id = parts[parts.length - 1] || "unknown";
  const safeId = id.replace(/[^a-z0-9\-]/gi, "").toLowerCase();
  const slug = `${lang}-${safeId}.html`;

  const level1 = safeId.slice(0, 2) || "00";
  const level2 = safeId.slice(2, 4) || "00";
  const level3 = safeId.slice(4, 6) || "00";

  const dir = path.join(POSTS_DIR, lang, level1, level2, level3);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return path.join(lang, level1, level2, level3, slug);
}

// ================= SITEMAP =================
async function fetchSitemap(url) {
  const xml = await smartFetch(url);
  const parser = new xml2js.Parser();
  const result = await parser.parseStringPromise(xml);

  return result.urlset.url.map(u => {
    if (u["xhtml:link"]) {
      const en = u["xhtml:link"].find(x => x.$.hreflang === "en");
      return en ? en.$.href : null;
    }
    return null;
  }).filter(Boolean);
}

// ================= MAIN =================
async function downloadPost(url) {
  try {
    const key = getKey(url);
    const indexFile = getIndexFile(key);

    if (fs.existsSync(indexFile)) {
      const data = JSON.parse(fs.readFileSync(indexFile));
      if (data[key]) {
        console.log("⏩ Skip:", key);
        return;
      }
    }

    const html = await smartFetch(url);

    const relativePath = slugFromUrl(url);
    const filePath = path.join(POSTS_DIR, relativePath);

    fs.writeFileSync(filePath, html);

    // 🔥 Upload to Drive
    const fileId = await uploadToDrive(filePath, path.basename(filePath));

    // INDEX
    let idx = fs.existsSync(indexFile)
      ? JSON.parse(fs.readFileSync(indexFile))
      : {};

    idx[key] = fileId; // store Drive ID instead of path
    fs.writeFileSync(indexFile, JSON.stringify(idx));

    // META
    const title = (html.match(/<title>(.*?)<\/title>/i) || [])[1] || key;
    const image = (html.match(/og:image" content="(.*?)"/i) || [])[1] || null;

    const metaFile = getMetaFile(key);
    let meta = fs.existsSync(metaFile)
      ? JSON.parse(fs.readFileSync(metaFile))
      : {};

    meta[key] = { title, image, driveId: fileId };
    fs.writeFileSync(metaFile, JSON.stringify(meta));

    console.log("✅ Uploaded:", key);

  } catch (err) {
    console.error("❌ Error:", url, err.message);
  }
}

// ================= RUN =================
(async () => {
  for (const sitemap of SITEMAP_URLS) {
    console.log("📄", sitemap);
    const urls = await fetchSitemap(sitemap);

    const BATCH = 2; // safer for Drive API
    for (let i = 0; i < urls.length; i += BATCH) {
      await Promise.all(urls.slice(i, i + BATCH).map(downloadPost));
    }
  }
})();
