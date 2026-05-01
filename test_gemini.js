import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function run() {
  const response = await ai.models.generateContent({
    model: "gemini-3.1-flash",
    contents: "Give me the YouTube video ID of Michael Jackson Billie Jean (11 chars). Only the ID."
  });
  console.log(response.text);
}
run();
