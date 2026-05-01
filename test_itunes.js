const q = "Billie jean";
const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=1`;
fetch(searchUrl).then(r => r.json()).then(data => {
  if (data.results && data.results.length > 0) {
    console.log("Match:", data.results[0].previewUrl);
  } else {
    console.log("Not found");
  }
}).catch(console.error);
