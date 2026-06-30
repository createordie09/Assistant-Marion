import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function run() {
  const session = await ai.live.connect({
    model: "gemini-3.1-flash-live-preview",
    config: {
      outputAudioTranscription: { model: 'models/gemini-2.0-flash-exp' },
      inputAudioTranscription: { model: 'models/gemini-2.0-flash-exp' },
    },
    callbacks: {
      onmessage: (msg) => {
        console.log(JSON.stringify(msg, null, 2));
      }
    }
  });
  console.log("Connected");
  session.sendRealtimeInput([{text: "Hello!"}]);
  
  await new Promise(r => setTimeout(r, 4000));
  console.log("Done");
  process.exit(0);
}
run();
