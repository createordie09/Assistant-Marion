import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import ytSearch from "yt-search";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startServer() {
  const app = express();
  const PORT = 3000;

  // API Route to search YouTube and return a video ID safely
  app.get("/api/search-youtube", async (req, res) => {
    try {
      const q = req.query.q as string;
      if (!q) {
        return res.status(400).json({ error: "Missing query" });
      }

      console.log("Searching YouTube for:", q);
      // Automatically append 'lyrics' or 'audio' to favor non-official fan uploads
      let searchStr = q.toLowerCase();
      if (!searchStr.includes("lyrics") && !searchStr.includes("audio")) {
        searchStr = `${q} lyrics`;
      }
      
      const r = await ytSearch(searchStr);
      
      // Filter out official channels and strongly prefer non-official videos
      const nonOfficialVideos = r.videos.filter(v => {
        const author = v.author.name.toLowerCase();
        const title = v.title.toLowerCase();
        
        const isOfficial = 
          author.includes("vevo") || 
          author.includes("topic") || 
          author.includes("official") || 
          author.includes("records") || 
          title.includes("official video") ||
          title.includes("music video");

        return !isOfficial;
      });

      // Best effort to find videos with lyrics/audio wording in the title
      const preferredVideos = nonOfficialVideos.filter(v => {
         const title = v.title.toLowerCase();
         return title.includes("lyric") || title.includes("karaoke") || title.includes("cover") || title.includes("audio");
      });

      // Prefer videos with explicit lyrics/audio keywords in title, but fallback to any non-official video
      let videos = preferredVideos.length > 0 ? preferredVideos : nonOfficialVideos;

      // If everything is filtered out (which shouldn't happen often), fallback to raw results
      if (videos.length === 0) {
         videos = r.videos;
      }

      if (videos.length === 0) {
        return res.status(404).json({ error: "No video found" });
      }

      // Return the first valid video ID
      res.json({ videoId: videos[0].videoId, title: videos[0].title });
    } catch (error: any) {
      console.error("YouTube search error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development vs production
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
