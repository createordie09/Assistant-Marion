import ytSearch from "yt-search";

export default async function handler(req: any, res: any) {
  try {
    const q = req.query.q as string;
    if (!q) {
      return res.status(400).json({ error: "Missing query" });
    }

    console.log("Searching YouTube for:", q);
    let searchStr = q.toLowerCase();
    if (!searchStr.includes("lyrics") && !searchStr.includes("audio")) {
      searchStr = `${q} lyrics`;
    }
    
    const r = await ytSearch(searchStr);
    
    const nonOfficialVideos = r.videos.filter((v: any) => {
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

    const preferredVideos = nonOfficialVideos.filter((v: any) => {
       const title = v.title.toLowerCase();
       return title.includes("lyric") || title.includes("karaoke") || title.includes("cover") || title.includes("audio");
    });

    let videos = preferredVideos.length > 0 ? preferredVideos : nonOfficialVideos;

    if (videos.length === 0) {
       videos = r.videos;
    }

    if (videos.length === 0) {
      return res.status(404).json({ error: "No video found" });
    }

    res.status(200).json({ videoId: videos[0].videoId, title: videos[0].title });
  } catch (error: any) {
    console.error("YouTube search error:", error);
    res.status(500).json({ error: error.message });
  }
}
