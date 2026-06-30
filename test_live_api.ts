import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function run() {
  const session = await ai.live.connect({
    model: "gemini-3.1-flash-live-preview",
    config: {
      outputAudioTranscription: { model: 'models/gemini-2.0-flash-exp' }, // fallback
      inputAudioTranscription: { model: 'models/gemini-2.0-flash-exp' },
      systemInstruction: "Hello! Reply with exactly one word: 'world'."
    },
    callbacks: {
      onmessage: (msg) => {
        console.log(JSON.stringify(msg, null, 2));
      }
    }
  });
  session.sendRealtimeInput({
    text: "Hello!"
  });
  setTimeout(() => session.sendRealtimeInput({ clientContent: { turnComplete: true } }), 1000);
}
run();
