import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import ytSearch from "yt-search";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startServer() {
  const app = express();
  const PORT = 3000;

  // API Route to search YouTube and return a video ID
  app.get("/api/search-youtube", async (req, res) => {
    try {
      const q = req.query.q as string;
      if (!q) {
        return res.status(400).json({ error: "Missing query" });
      }

      console.log("Searching YouTube for:", q);
      // Automatically append 'lyrics' or 'audio' to avoid VEVO/copyright blocks
      // if the query doesn't explicitly look for something else
      const searchStr = q.toLowerCase().includes("lyrics") ? q : `${q} audio lyrics`;
      
      const r = await ytSearch(searchStr);
      const videos = r.videos.slice(0, 5); // get top 5
      
      if (videos.length === 0) {
        return res.status(404).json({ error: "No video found" });
      }

      // Return the first video ID
      res.json({ videoId: videos[0].videoId, title: videos[0].title });
    } catch (error: any) {
      console.error("YouTube search error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
