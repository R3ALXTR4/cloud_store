import { put, list, del } from "@vercel/blob";
import formidable from "formidable";
import fs from "fs";

export const config = {
  api: { bodyParser: false },
};

const LISTINGS_FILE = "listings.json";

// ---- helpers ----

async function readListings() {
  try {
    const { blobs } = await list({ prefix: LISTINGS_FILE });
    const match = blobs.find((b) => b.pathname === LISTINGS_FILE);
    if (!match) return [];
    const res = await fetch(match.url);
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.error("readListings error:", err);
    return [];
  }
}

async function writeListings(listings) {
  await put(LISTINGS_FILE, JSON.stringify(listings, null, 2), {
    access: "public",
    contentType: "application/json",
    allowOverwrite: true,
  });
}

function checkAdmin(req) {
  const secret = process.env.ADMIN_SECRET;
  const provided = req.headers["x-admin-secret"];
  return secret && provided === secret;
}

// ---- handler ----

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-secret");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // ---- GET: anyone can view listings ----
  if (req.method === "GET") {
    const listings = await readListings();
    return res.status(200).json(listings);
  }

  // ---- POST: admin only, adds a new listing with photos ----
  if (req.method === "POST") {
    if (!checkAdmin(req)) {
      return res.status(401).json({ error: "Unauthorized. Wrong or missing admin password." });
    }

    const form = formidable({ multiples: true, maxFileSize: 8 * 1024 * 1024 });

    form.parse(req, async (err, fields, files) => {
      if (err) {
        console.error("form parse error:", err);
        return res.status(400).json({ error: "Could not read the submitted form." });
      }

      try {
        const get = (f) => (Array.isArray(f) ? f[0] : f);

        const name = get(fields.name) || "";
        const price = get(fields.price) || "";
        const category = get(fields.category) || "";
        const desc = get(fields.desc) || "";
        const loc = get(fields.loc) || "";
        const phone = get(fields.phone) || "";
        const seller = get(fields.seller) || "";

        if (!name || !price || !category) {
          return res.status(400).json({ error: "Missing required fields." });
        }

        // Normalize incoming photos into an array
        let incomingPhotos = files.photos;
        if (!incomingPhotos) incomingPhotos = [];
        if (!Array.isArray(incomingPhotos)) incomingPhotos = [incomingPhotos];

        const photoUrls = [];
        for (const file of incomingPhotos) {
          if (!file || !file.filepath) continue;
          const buffer = fs.readFileSync(file.filepath);
          const safeName = `photos/${Date.now()}-${Math.random().toString(36).slice(2)}-${file.originalFilename || "photo"}`;
          const blob = await put(safeName, buffer, {
            access: "public",
            contentType: file.mimetype || "image/jpeg",
          });
          photoUrls.push(blob.url);
        }

        const listings = await readListings();
        const newListing = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          name,
          price,
          category,
          desc,
          loc,
          phone,
          seller,
          photos: photoUrls,
          createdAt: new Date().toISOString(),
        };
        listings.unshift(newListing);
        await writeListings(listings);

        return res.status(200).json({ ok: true, listing: newListing });
      } catch (e) {
        console.error("POST listings error:", e);
        return res.status(500).json({ error: "Something went wrong saving the listing." });
      }
    });
    return;
  }

  // ---- DELETE: admin only, removes a listing by id ----
  if (req.method === "DELETE") {
    if (!checkAdmin(req)) {
      return res.status(401).json({ error: "Unauthorized." });
    }
    try {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: "Missing id." });

      const listings = await readListings();
      const target = listings.find((l) => l.id === id);
      const remaining = listings.filter((l) => l.id !== id);

      if (target && Array.isArray(target.photos)) {
        for (const url of target.photos) {
          try {
            await del(url);
          } catch (e) {
            console.warn("Could not delete blob:", url, e.message);
          }
        }
      }

      await writeListings(remaining);
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error("DELETE listings error:", e);
      return res.status(500).json({ error: "Something went wrong deleting the listing." });
    }
  }

  return res.status(405).json({ error: "Method not allowed." });
}
