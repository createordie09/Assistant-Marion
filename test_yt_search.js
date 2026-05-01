import ytSearch from "yt-search";
async function run() {
  const r = await ytSearch("Eminem Lose Yourself lyrics");
  const videos = r.videos.filter(v => {
    const author = v.author.name.toLowerCase();
    return !author.includes("vevo") && !author.includes("topic") && !author.includes("official");
  });
  console.log(videos.length > 0 ? videos[0] : r.videos[0]);
}
run();
