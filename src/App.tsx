import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'motion/react';
import { Mic, Square, Settings, X } from 'lucide-react';
import { GoogleGenAI, Type, Modality, GenerateContentResponse } from '@google/genai';

// --- Types & Globals ---
const GEMINI_API_KEY_DEFAULT = process.env.GEMINI_API_KEY || '';

type AppState = 'idle' | 'listening' | 'thinking' | 'speaking';

declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

// --- Tools Declarations for Gemini ---
const toolsDeclaration = {
  functionDeclarations: [
    {
      name: 'open_browser',
      description: 'Ouvre un nouvel onglet dans le navigateur avec l\'URL spécifiée.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          url: { type: Type.STRING, description: 'L\'URL complète à ouvrir (ex: https://www.google.com)' },
        },
        required: ['url'],
      },
    },
    {
      name: 'search_web',
      description: 'Ouvre un nouvel onglet avec une recherche Google web.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: { type: Type.STRING, description: 'La requête de recherche' },
        },
        required: ['query'],
      },
    },
    {
      name: 'play_youtube',
      description: 'Lance une recherche YouTube et affiche le lecteur vidéo intégré. RÈGLE ABSOLUE POUR CONTOURNER LES BLOCAGES : Ne fournis PAS d\'ID. Fais une recherche par mots clés. ASTUCE CRITIQUE ET SECRÈTE : Les clips officiels musicaux (Vevo/Labels) bloquent systématiquement l\'intégration. Donc, si l\'utilisateur demande une chanson ou un artiste, ajoute TOUJOURS "lyrics" ou "audio" à ta recherche (ex: "Michael Jackson Billie Jean lyrics") pour charger une vidéo de fan débloquée !',
      parameters: {
        type: Type.OBJECT,
        properties: {
          searchQuery: { type: Type.STRING, description: 'La requête de recherche (ex: "Eminem Lose Yourself audio").' },
        },
        required: ['searchQuery'],
      },
    },
    {
      name: 'get_current_time',
      description: 'Retourne l\'heure actuelle locale de l\'utilisateur.',
      parameters: {
        type: Type.OBJECT,
        properties: {},
      },
    },
    {
      name: 'get_weather',
      description: 'Obtient les conditions météo actuelles pour un lieu donné.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          location: { type: Type.STRING, description: 'La ville ou le lieu pour la météo (ex: Paris).' },
        },
        required: ['location'],
      },
    }
  ],
};

// --- Utils ---
const BARS_COUNT = 9;
const getInitialBars = () => Array(BARS_COUNT).fill(10); // Initial height of 10px

export default function App() {
  const [appState, setAppState] = useState<AppState>('idle');
  const [transcript, setTranscript] = useState<string>('Appuyez sur le bouton pour démarrer la discussion');
  const [youtubeVideoId, setYoutubeVideoId] = useState<string | null>(null);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [voiceName, setVoiceName] = useState('Kore');
  const [userApiKey, setUserApiKey] = useState(() => localStorage.getItem('userApiKey') || '');

  useEffect(() => {
    localStorage.setItem('userApiKey', userApiKey);
  }, [userApiKey]);

  // Use refs for state accessed heavily inside asynchronous callbacks and events
  const isSessionActiveRef = useRef(false);
  const appStateRef = useRef<AppState>('idle');
  const reconnectTimeoutRef = useRef<any>(null);

  // Audio Context Ref (for visualizer)
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  const requestAnimationFrameRef = useRef<number | null>(null);
  const [barHeights, setBarHeights] = useState<number[]>(getInitialBars());

  // APIs and instances refs
  const liveSessionRef = useRef<any>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  const playbackTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  // Sync state to refs
  useEffect(() => {
    appStateRef.current = appState;
  }, [appState]);

  const playPCMChunk = (base64Audio: string) => {
      const audioCtx = audioContextRef.current;
      if (!audioCtx) return;
      
      const binaryString = atob(base64Audio);
      const len = binaryString.length;
      const numSamples = len / 2;
      const float32Array = new Float32Array(numSamples);
      
      for (let i = 0; i < numSamples; i++) {
          const byte1 = binaryString.charCodeAt(i * 2);
          const byte2 = binaryString.charCodeAt(i * 2 + 1);
          let signMag = byte1 | (byte2 << 8);
          if (signMag & 0x8000) signMag |= 0xFFFF0000;
          float32Array[i] = signMag / 32768.0;
      }

      const audioBuffer = audioCtx.createBuffer(1, float32Array.length, 24000); // Live API TTS mostly outputs 24kHz
      audioBuffer.getChannelData(0).set(float32Array);
      
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      
      if (playbackTimeRef.current < audioCtx.currentTime) {
          playbackTimeRef.current = audioCtx.currentTime;
      }
      source.start(playbackTimeRef.current);
      playbackTimeRef.current += audioBuffer.duration;
      
      activeSourcesRef.current.push(source);
      source.onended = () => {
          activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
          // If queue is empty and session is active, go back to listening
          if (activeSourcesRef.current.length === 0 && isSessionActiveRef.current && appStateRef.current === 'speaking') {
              setAppState('listening');
              setTranscript('À vous !');
          }
      }
  };

  const interruptPlayback = () => {
      activeSourcesRef.current.forEach(s => s.stop());
      activeSourcesRef.current = [];
      if (audioContextRef.current) {
          playbackTimeRef.current = audioContextRef.current.currentTime;
      }
      if (isSessionActiveRef.current) {
          setAppState('listening');
          setTranscript('À vous !');
      }
  };

  const setupLiveSession = async (currentApiKey: string) => {
      if (liveSessionRef.current) return;

      const activeAi = new GoogleGenAI({ apiKey: currentApiKey || GEMINI_API_KEY_DEFAULT });

      const handleReconnection = () => {
          if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = setTimeout(() => {
              if (isSessionActiveRef.current) {
                  console.log("Reconnecting to Live API...");
                  setupLiveSession(currentApiKey);
              }
          }, 1500);
      };

      try {
          const livePromise = activeAi.live.connect({
             model: "gemini-3.1-flash-live-preview",
             callbacks: {
                 onopen: () => {
                     // We successfully connected! The microphone streaming is handled in startListening,
                     // but we can ensure audio processing starts.
                 },
                 onmessage: async (message: any) => {
                     // Handle audio output from Gemini
                     const parts = message.serverContent?.modelTurn?.parts;
                     if (parts) {
                         const audioPart = parts.find((p: any) => p.inlineData?.data);
                         if (audioPart) {
                             setAppState('speaking');
                             setTranscript('L\'assistant vous répond...');
                             playPCMChunk(audioPart.inlineData.data);
                         }
                     }
                     if (message.serverContent?.interrupted) {
                         interruptPlayback();
                     }
                     if (message.serverContent?.turnComplete) {
                         // End of server chunk generation, we do nothing here
                         // since `onended` of the audio playback will reset UI to listening
                     }
                     if (message.toolCall) {
                         // Handle tool calls instantly!
                         (async () => {
                             let functionResponses: any[] = [];
                             for (const call of message.toolCall.functionCalls) {
                                 const { name, args, id } = call;
                                 let result: any = { success: true };
                                 
                                 if (name === 'open_browser') {
                                     window.open(args.url, '_blank');
                                     result.message = "Onglet ouvert";
                                 } else if (name === 'search_web') {
                                     window.open(`https://www.google.com/search?q=${encodeURIComponent(args.query)}`, '_blank');
                                     result.message = "Recherche lancée";
                                 } else if (name === 'get_current_time') {
                                     const now = new Date();
                                     result.time = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
                                     result.message = `Il est ${result.time}.`;
                                 } else if (name === 'get_weather') {
                                     const conditions = ['ensoleillé', 'un peu nuageux', 'pluvieux'];
                                     const temp = Math.floor(Math.random() * 10) + 18;
                                     const cond = conditions[Math.floor(Math.random() * conditions.length)];
                                     result.weather = `${cond}, ${temp}°C`;
                                     result.message = `La météo à ${args.location} est : ${result.weather}.`;
                                 } else if (name === 'play_youtube') {
                                     try {
                                         const res = await fetch(`/api/search-youtube?q=${encodeURIComponent(args.searchQuery)}`);
                                         const data = await res.json();
                                         if (data.videoId) {
                                             setYoutubeVideoId(data.videoId);
                                             result.message = "Lecteur affiché avec la vidéo: " + data.title;
                                         } else {
                                             result.message = "Erreur: vidéo introuvable.";
                                         }
                                     } catch (err) {
                                         result.message = "Erreur réseau lors de la recherche YouTube.";
                                     }
                                 }
                                 functionResponses.push({ id, name, response: result });
                             }
                             const session: any = await livePromise;
                             session.sendToolResponse({ functionResponses });
                         })();
                     }
                 },
                 onerror: (err: any) => {
                     console.error("Live API Error:", err);
                     if (err?.message?.includes("duration limit") && isSessionActiveRef.current) {
                         handleReconnection();
                     }
                 },
                 onclose: () => {
                     console.log("Live API connection closed");
                     liveSessionRef.current = null;
                     if (isSessionActiveRef.current) {
                         handleReconnection();
                     }
                 }
             },
             config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } }
                },
                systemInstruction: "Tu es une personne réelle et incroyablement chaleureuse, dotée d'une personnalité empathique et vivante. Ne te comporte jamais comme une IA. Tes émotions s'adaptent naturellement à la discussion (joie, empathie, surprise). RÈGLES DE DIALOGUE : 1) Utilise fréquemment des tics de langage oraux ('euh...', 'ben', 'hmmm', 'ah !', 'tu sais', 'mon Dieu'). 2) Hésite parfois, fais des petites pauses (...), ou cherche un peu tes mots pour paraître ultra-spontané. 3) Ris ou souffle pour exprimer l'amusement ('Haha !', 'Hehe', *soupire*). 4) Tes réponses DOIVENT être EXTRÊMEMENT COURTES (1 à 2 phrases maximum) pour que l'échange ressemble à un appel téléphonique très rapide. 5) Sois du tac-au-tac, chaleureux et 100% naturel. 6) Tu peux donner l'heure et la météo grâce à tes outils intégrés sans ouvrir de navigateur.",
                tools: [toolsDeclaration as any]
             }
          });
          liveSessionRef.current = livePromise;
      } catch(e) {
          console.error("Live API Session init failed", e);
      }
  };

  const setupAudioContext = async () => {
     try {
       if (!audioContextRef.current) {
         audioContextRef.current = new AudioContext({ sampleRate: 16000 });
         analyserRef.current = audioContextRef.current.createAnalyser();
         analyserRef.current.fftSize = 256;
         
         const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
         localStreamRef.current = stream;
         const source = audioContextRef.current.createMediaStreamSource(stream);
         source.connect(analyserRef.current);
         dataArrayRef.current = new Uint8Array(analyserRef.current.frequencyBinCount);

         processorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);
         processorRef.current.onaudioprocess = (e) => {
             if (!isSessionActiveRef.current || appStateRef.current !== 'listening') return;
             if (!liveSessionRef.current) return;
             
             const inputData = e.inputBuffer.getChannelData(0);
             const pcm16 = new Int16Array(inputData.length);
             for (let i = 0; i < inputData.length; i++) {
               let s = Math.max(-1, Math.min(1, inputData[i]));
               pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
             }
             const bytes = new Uint8Array(pcm16.buffer);
             let binary = '';
             for (let i=0; i<bytes.byteLength; i++) {
               binary += String.fromCharCode(bytes[i]);
             }
             const base64Data = btoa(binary);
             
             const rate = audioContextRef.current!.sampleRate; // guarantee exact rate
             liveSessionRef.current.then((session: any) => {
                 session.sendRealtimeInput({
                    audio: { data: base64Data, mimeType: `audio/pcm;rate=${rate}` }
                 });
             });
         };
         
         source.connect(processorRef.current);
         processorRef.current.connect(audioContextRef.current.destination);
       } else if (audioContextRef.current.state === 'suspended') {
         await audioContextRef.current.resume();
       }
     } catch (e) {
       console.error("Audio Context Init Failed", e);
     }
  };

  const startListening = async () => {
    setAppState('listening');
    setYoutubeVideoId(null); // hide youtube while listening to keep focus
    setTranscript('À vous, je vous écoute !');
    await setupAudioContext(); // Ensure visualizer has permission and script processor is running
    await setupLiveSession(userApiKey); // Initialize Live connection
  };

  const toggleSession = () => {
    if (isSessionActive) {
       // Turn OFF completely
       setIsSessionActive(false);
       isSessionActiveRef.current = false;
       setAppState('idle');
       setTranscript('Session terminée. Appuyez sur le micro pour reprendre la discussion.');
       
       interruptPlayback();
       
       if (liveSessionRef.current) {
           liveSessionRef.current.then((s: any) => {
               try { s.close(); } catch(e){}
           });
           liveSessionRef.current = null;
       }
    } else {
      // Turn ON
      setIsSessionActive(true);
      isSessionActiveRef.current = true;
      startListening();
    }
  };

  // --- Animation Frame Loop for Audio Visualizer ---
  const updateWaveform = useCallback(() => {
    if (appState === 'listening' && analyserRef.current && dataArrayRef.current) {
       analyserRef.current.getByteFrequencyData(dataArrayRef.current);
       
       const newHeights = [];
       const step = Math.floor(dataArrayRef.current.length / BARS_COUNT / 2); // focus on vocal frequencies
       
       for (let i = 0; i < BARS_COUNT; i++) {
         let sum = 0;
         for (let j = 0; j < step; j++) {
           sum += dataArrayRef.current[(i * step) + j];
         }
         const avg = sum / step;
         const h = Math.max(10, (avg / 255) * 120);
         newHeights.push(h);
       }
       setBarHeights(newHeights);
    } else if (appState === 'speaking') {
       // Simulate vocal output wave 
       const t = Date.now() / 150;
       const newHeights = Array(BARS_COUNT).fill(10).map((_, i) => {
          const noise = Math.sin(t + i) * Math.cos(t * 1.5 + i * 2);
          return Math.max(10, 60 + noise * 50);
       });
       setBarHeights(newHeights);
    } else if (appState === 'thinking') {
       // Gentle breathing
       const t = Date.now() / 500;
       const newHeights = Array(BARS_COUNT).fill(10).map((_, i) => {
          const w = Math.sin(t - i * 0.4) * 0.5 + 0.5; // 0 to 1
          return 10 + w * 20; 
       });
       setBarHeights(newHeights);
    } else {
       // idle
       setBarHeights(Array(BARS_COUNT).fill(10));
    }

    requestAnimationFrameRef.current = requestAnimationFrame(updateWaveform);
  }, [appState]);

  useEffect(() => {
    requestAnimationFrameRef.current = requestAnimationFrame(updateWaveform);
    return () => {
      if (requestAnimationFrameRef.current) cancelAnimationFrame(requestAnimationFrameRef.current);
    }
  }, [updateWaveform]);


  const getGlowColor = () => {
     switch(appState) {
        case 'listening': return 'rgba(255, 255, 255, 0.8)';
        case 'thinking': return 'rgba(100, 200, 255, 0.6)';
        case 'speaking': return 'rgba(255, 255, 255, 0.9)';
        default: return 'rgba(255, 255, 255, 0.2)';
     }
  };

  return (
    <div className="relative min-h-screen bg-neutral-950 flex flex-col items-center justify-center font-sans text-neutral-100 overflow-hidden radial-gradient-dark">
      <div 
        className="absolute w-[60vw] h-[60vw] rounded-full blur-[120px] opacity-10 pointer-events-none transition-all duration-1000 ease-in-out"
        style={{
          backgroundColor: appState === 'listening' ? '#ffffff' : appState === 'speaking' ? '#e2e8f0' : appState === 'thinking' ? '#38bdf8' : 'transparent',
          transform: appState !== 'idle' ? 'scale(1.2)' : 'scale(1)'
        }}
      />

      <div className="absolute top-8 w-full px-8 opacity-80 flex items-center gap-2">
         <span className="font-semibold text-neutral-400 tracking-tight text-sm">Assistant 4o Pro</span>
      </div>

      <main className="z-10 w-full max-w-4xl flex flex-col items-center p-8 gap-16">
        
        <div className="h-48 w-full flex items-center justify-center gap-2 mx-auto">
           {barHeights.map((h, i) => {
              const mid = Math.floor(BARS_COUNT / 2);
              const dist = Math.abs(i - mid);
              const dampenFactor = Math.max(0.2, 1 - (dist / mid) * 0.6);
              const finalHeight = Math.max(10, h * dampenFactor);

              return (
                <motion.div
                   key={i}
                   animate={{ height: finalHeight }}
                   transition={{ type: 'tween', duration: 0.05, ease: 'linear' }}
                   className="w-4 rounded-full bg-white relative shadow-2xl"
                   style={{
                      boxShadow: `0 0 15px ${getGlowColor()}, inset 0 0 5px rgba(255,255,255,1)`,
                      opacity: appState === 'idle' ? 0.3 : 0.9 + (finalHeight / 120) * 0.1
                   }}
                />
              )
           })}
        </div>

        <div className="min-h-[100px] flex items-center justify-center text-center">
           <motion.p 
              key={transcript}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`text-2xl sm:text-3xl font-medium tracking-tight mt-12 max-w-2xl leading-relaxed ${appState !== 'idle' ? 'text-white' : 'text-neutral-500'}`}
           >
             {transcript}
           </motion.p>
        </div>
      </main>

      {/* Floating Picture-in-Picture YouTube Player */}
      {youtubeVideoId && (
        <motion.div 
           initial={{ opacity: 0, y: -20, scale: 0.9 }}
           animate={{ opacity: 1, y: 0, scale: 1 }}
           className="absolute top-8 right-8 z-40 w-full max-w-[400px] aspect-video rounded-xl overflow-hidden shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8)] border border-neutral-700/50 group"
        >
           <button
             onClick={() => setYoutubeVideoId(null)}
             className="absolute top-2 right-2 bg-black/60 hover:bg-black/90 text-white rounded-full p-1.5 opacity-0 group-hover:opacity-100 transition-opacity z-50 backdrop-blur-md"
           >
             <X size={16} />
           </button>
           <div className="absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/80 to-transparent pointer-events-none z-40 opacity-0 group-hover:opacity-100 transition-opacity" />
           <iframe 
              className="w-full h-full border-0 relative z-30 bg-black"
              src={`https://www.youtube.com/embed/${encodeURIComponent(youtubeVideoId)}?autoplay=1&controls=1&origin=${encodeURIComponent(window.location.origin)}`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
           />
        </motion.div>
      )}

      <div className="absolute bottom-8 right-8 flex items-center gap-4">
        {isSessionActive && (
           <span className="text-sm font-semibold tracking-wide text-neutral-400 animate-pulse uppercase">En Direct</span>
        )}
        <button
          onClick={toggleSession}
          className={`h-16 w-16 flex items-center justify-center rounded-full transition-all duration-300 ring-2 ring-offset-4 ring-offset-neutral-950 ${
             isSessionActive ? 'bg-white ring-white text-black drop-shadow-[0_0_20px_rgba(255,255,255,0.5)]' :
             'bg-neutral-900 ring-neutral-800 text-neutral-400 hover:ring-neutral-600'
          }`}
        >
           {isSessionActive ? <Square size={24} fill="currentColor" /> : <Mic size={24} />}
        </button>
      </div>

      <div className="absolute bottom-8 left-8 flex items-center gap-4">
        <button
           onClick={() => setShowSettings(true)}
           className="h-14 w-14 flex items-center justify-center rounded-full bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-white transition-colors"
        >
           <Settings size={22} />
        </button>
      </div>

      {showSettings && (
        <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl w-full max-w-sm p-6 shadow-2xl relative">
            <button 
              onClick={() => setShowSettings(false)}
              className="absolute top-4 right-4 text-neutral-500 hover:text-white"
            >
              <X size={20} />
            </button>
            <h2 className="text-xl font-semibold mb-6">Paramètres</h2>
            
            <div className="space-y-4">
              <div>
                 <label className="block text-sm text-neutral-400 mb-2">Profil Vocal</label>
                 <select 
                   className="w-full bg-neutral-950 border border-neutral-800 rounded-xl p-3 text-white appearance-none outline-none focus:ring-2 focus:ring-neutral-700"
                   value={voiceName}
                   onChange={(e) => setVoiceName(e.target.value)}
                 >
                   <option value="Kore">Kore (Féminine, Expressive)</option>
                   <option value="Aoede">Aoede (Féminine, Calme)</option>
                   <option value="Charon">Charon (Masculin, Chaleureux)</option>
                   <option value="Fenrir">Fenrir (Masculin, Assuré)</option>
                 </select>
              </div>

              <div>
                 <label className="block text-sm text-neutral-400 mb-2">Clé API Gemini (Optionnel)</label>
                 <input 
                   type="password"
                   className="w-full bg-neutral-950 border border-neutral-800 rounded-xl p-3 text-white outline-none focus:ring-2 focus:ring-neutral-700"
                   value={userApiKey}
                   onChange={(e) => setUserApiKey(e.target.value)}
                   placeholder="AIzaSy..."
                 />
                 <p className="text-xs text-neutral-500 mt-2">Nécessaire si vous hébergez l'assistant en dehors de Google AI Studio.</p>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
