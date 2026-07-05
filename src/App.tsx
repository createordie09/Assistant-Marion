import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'motion/react';
import { Mic, Square, Settings, X, User, LogOut } from 'lucide-react';
import { GoogleGenAI, Type, Modality, GenerateContentResponse } from '@google/genai';
import { auth } from './lib/firebase';
import { signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider, onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { getUserProfile, saveUserProfile, addMemory, getMemories, addConversationMessage, generateAndSaveDailySummary, getConversationSummary, createReminder, getDueReminders, completeReminder } from './lib/db';
import { getUserLocation } from './lib/geolocation';

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
      name: 'get_user_location',
      description: 'Récupère la localisation géographique actuelle de l\'utilisateur (ville, région, pays). À utiliser quand l\'utilisateur demande où il se trouve, ou quand un autre outil a besoin du lieu actuel sans que l\'utilisateur l\'ait précisé (ex: météo locale).',
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
      },
    },
    {
      name: 'save_memory',
      description: 'Sauvegarde une information importante sur l\'utilisateur (nom, gouts, faits marquants) pour s\'en souvenir plus tard.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          content: { type: Type.STRING, description: 'L\'information à retenir' },
          category: { type: Type.STRING, description: 'La catégorie (ex: personnel, musique, travail)' },
          importance: { type: Type.NUMBER, description: 'Importance de 1 à 5' },
        },
        required: ['content', 'category'],
      },
    },
    {
      name: 'get_memories',
      description: 'Récupère tous les souvenirs et informations précédemment enregistrés sur l\'utilisateur.',
      parameters: {
        type: Type.OBJECT,
        properties: {},
      },
    },
    {
      name: 'get_conversation_history',
      description: 'Récupère le résumé factuel des échanges passés avec l\'utilisateur pour une période donnée. À utiliser systématiquement avant de répondre à toute question sur une conversation passée.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          period: { type: Type.STRING, description: 'La période souhaitée ("today", "yesterday", "day_before_yesterday", ou une date au format YYYY-MM-DD)' }
        },
        required: ['period'],
      },
    },
    {
      name: 'get_news',
      description: 'Récupère les dernières actualités sur un sujet précis.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          topic: { type: Type.STRING, description: 'Le sujet des actualités (ex: IA, Sport, Finance)' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'get_emails',
      description: 'Recherche et résume les emails récents de l\'utilisateur.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          count: { type: Type.NUMBER, description: 'Nombre d\'emails à récupérer' },
        },
      },
    },
    {
      name: 'create_reminder',
      description: 'Crée un nouveau rappel avec une date et heure précise (ISO 8601).',
      parameters: {
        type: Type.OBJECT,
        properties: {
          content: { type: Type.STRING, description: 'Ce qu\'il faut rappeler' },
          dueAt: { type: Type.STRING, description: 'Date et heure exacte du rappel au format ISO 8601' },
        },
        required: ['content', 'dueAt'],
      },
    },
    {
      name: 'complete_reminder',
      description: 'Marque un rappel existant comme terminé.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          reminderId: { type: Type.STRING, description: 'L\'identifiant unique du rappel' },
        },
        required: ['reminderId'],
      },
    },
    {
      name: 'get_due_reminders',
      description: 'Récupère la liste des rappels échus et non terminés.',
      parameters: {
        type: Type.OBJECT,
        properties: {},
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
  const [currentUser, setCurrentUser] = useState<FirebaseUser | null>(null);
  const [gmailError, setGmailError] = useState(false);
  const gmailTokenRef = useRef<string | null>(localStorage.getItem('gmailToken'));

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      // Si l'utilisateur change ou se déconnecte, on vérifie la cohérence du token
      if (!user) {
        gmailTokenRef.current = null;
        localStorage.removeItem('gmailToken');
      }
    });
    return () => unsub();
  }, []);

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      provider.addScope('https://www.googleapis.com/auth/gmail.readonly');
      // On force la sélection du compte pour éviter les erreurs de session persistante corrompue
      provider.setCustomParameters({ prompt: 'select_account' });
      
      const isElectron = navigator.userAgent.toLowerCase().includes('electron');

      if (isElectron) {
        await signInWithRedirect(auth, provider);
        const result = await getRedirectResult(auth);
        if (result) {
          const credential = GoogleAuthProvider.credentialFromResult(result);
          if (credential?.accessToken) {
            gmailTokenRef.current = credential.accessToken;
            localStorage.setItem('gmailToken', credential.accessToken);
            setGmailError(false);
          }
        }
      } else {
        const result = await signInWithPopup(auth, provider);
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (credential?.accessToken) {
          gmailTokenRef.current = credential.accessToken;
          localStorage.setItem('gmailToken', credential.accessToken);
          setGmailError(false);
        }
      }
    } catch (e) {
      console.error("Login failed", e);
    }
  };

  const handleLogout = () => {
    auth.signOut();
    gmailTokenRef.current = null;
    localStorage.removeItem('gmailToken');
    setGmailError(false);
  };

  useEffect(() => {
    // 1. Bloquer le clic droit
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    // 2. Bloquer les raccourcis clavier des DevTools
    const handleKeyDown = (e: KeyboardEvent) => {
      // Bloquer F12
      if (e.key === 'F12') {
        e.preventDefault();
        return;
      }

      // Bloquer Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C (Chrome/Edge/Firefox)
      // Bloquer Ctrl+U (Code source)
      if (e.ctrlKey && (e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C') || e.key === 'u' || e.key === 'U')) {
        e.preventDefault();
        return;
      }
      
      // Adaptation pour Mac (Cmd au lieu de Ctrl)
      if (e.metaKey && (e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C') || e.altKey && e.key === 'u')) {
        e.preventDefault();
        return;
      }
    };

    window.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem('userApiKey', userApiKey);
  }, [userApiKey]);

  // Use refs for state accessed heavily inside asynchronous callbacks and events
  const isSessionActiveRef = useRef(false);
  const appStateRef = useRef<AppState>('idle');
  const reconnectTimeoutRef = useRef<any>(null);
  const sessionIdRef = useRef<string>("");
  const userTranscriptAccumulatorRef = useRef<string>("");
  const assistantTranscriptAccumulatorRef = useRef<string>("");
  const reconnectAttemptsRef = useRef<number>(0);

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

  const [isVideoActive, setIsVideoActive] = useState(false);
  const [videoSourceType, setVideoSourceType] = useState<'camera' | 'screen' | null>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);
  const videoIntervalRef = useRef<number | null>(null);
  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null);
  const hiddenCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const stopVideoCapture = useCallback(() => {
    if (videoIntervalRef.current) {
      clearInterval(videoIntervalRef.current);
      videoIntervalRef.current = null;
    }
    if (videoStreamRef.current) {
      videoStreamRef.current.getTracks().forEach(track => track.stop());
      videoStreamRef.current = null;
    }
    if (hiddenVideoRef.current) {
      hiddenVideoRef.current.srcObject = null;
    }
    setIsVideoActive(false);
    setVideoSourceType(null);
  }, []);

  const startVideoCapture = useCallback(async (sourceType: 'camera' | 'screen') => {
    try {
      let stream: MediaStream;
      if (sourceType === 'camera') {
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      }
      videoStreamRef.current = stream;
      setIsVideoActive(true);
      setVideoSourceType(sourceType);

      if (hiddenVideoRef.current) {
        hiddenVideoRef.current.srcObject = stream;
        hiddenVideoRef.current.play();
      }

      videoIntervalRef.current = window.setInterval(() => {
        if (!isSessionActiveRef.current || !videoStreamRef.current || !hiddenVideoRef.current || !hiddenCanvasRef.current) return;
        
        const video = hiddenVideoRef.current;
        const canvas = hiddenCanvasRef.current;
        const ctx = canvas.getContext('2d');

        if (video.videoWidth > 0 && video.videoHeight > 0) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
          
          const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
          const base64Data = dataUrl.split(',')[1];
          
          if (liveSessionRef.current && base64Data) {
            liveSessionRef.current.then((session: any) => {
              session.sendRealtimeInput({
                video: {
                  mimeType: 'image/jpeg',
                  data: base64Data
                }
              });
            }).catch((err: any) => console.error("Error sending video frame", err));
          }
        }
      }, 1500);

      stream.getVideoTracks()[0].onended = () => {
        stopVideoCapture();
      };
      
    } catch (err) {
      console.error("Error starting video capture:", err);
      stopVideoCapture();
    }
  }, [stopVideoCapture]);

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

  const isConnectingRef = useRef(false);

  const setupLiveSession = async (currentApiKey: string) => {
      if (liveSessionRef.current || isConnectingRef.current) return;
      isConnectingRef.current = true;

      const activeAi = new GoogleGenAI({ apiKey: currentApiKey || GEMINI_API_KEY_DEFAULT });

      const handleReconnection = () => {
          if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
          
          reconnectAttemptsRef.current++;
          if (reconnectAttemptsRef.current > 3) {
              console.log("Max reconnection attempts reached.");
              setIsSessionActive(false);
              isSessionActiveRef.current = false;
              setAppState('idle');
              setTranscript("Connexion impossible. Vérifiez votre clé API ou réessayez plus tard.");
              return;
          }

          reconnectTimeoutRef.current = setTimeout(() => {
              if (isSessionActiveRef.current) {
                  console.log(`Reconnecting to Live API... (Attempt ${reconnectAttemptsRef.current})`);
                  setupLiveSession(currentApiKey);
              }
          }, 1500);
      };

      try {
          const livePromise = activeAi.live.connect({
             model: "gemini-3.1-flash-live-preview",
             callbacks: {
                 onopen: async () => {
                     // We successfully connected!
                     reconnectAttemptsRef.current = 0;
                     const session: any = await livePromise;
                     session.sendRealtimeInput({
                         text: "Vérifie s'il y a des rappels en attente via get_due_reminders et préviens l'utilisateur naturellement s'il y en a, sinon ne dis rien à ce sujet."
                     });
                 },
                 onmessage: async (message: any) => {
                     // Handle transcriptions for DB persistence
                     if (message.serverContent?.inputTranscription?.text) {
                         userTranscriptAccumulatorRef.current += message.serverContent.inputTranscription.text;
                     }
                     if (message.serverContent?.outputTranscription?.text) {
                         assistantTranscriptAccumulatorRef.current += message.serverContent.outputTranscription.text;
                     }
                     if (message.serverContent?.turnComplete) {
                         const currentUid = auth.currentUser?.uid;
                         if (currentUid && sessionIdRef.current) {
                             const userMsg = userTranscriptAccumulatorRef.current.trim();
                             if (userMsg) {
                                 addConversationMessage(currentUid, sessionIdRef.current, 'user', userMsg);
                             }
                             const assistantMsg = assistantTranscriptAccumulatorRef.current.trim();
                             if (assistantMsg) {
                                 addConversationMessage(currentUid, sessionIdRef.current, 'assistant', assistantMsg);
                             }
                         }
                         userTranscriptAccumulatorRef.current = "";
                         assistantTranscriptAccumulatorRef.current = "";
                     }

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
                                 } else if (name === 'get_user_location') {
                                     const locData = await getUserLocation();
                                     if (locData) {
                                         result.location = locData;
                                         if (locData.precision === 'precise') {
                                             result.message = `L'utilisateur se trouve à ${locData.city}, ${locData.region}, ${locData.country}.`;
                                         } else {
                                             result.message = `L'utilisateur se trouve approximativement à ${locData.city}, ${locData.country} (localisation par IP, peu précise).`;
                                         }
                                     } else {
                                         result.message = "Localisation indisponible : l'utilisateur n'a pas autorisé l'accès ou la géolocalisation a échoué.";
                                     }
                                 } else if (name === 'get_weather') {
                                     let lat: number | null = null;
                                     let lon: number | null = null;
                                     let locationName = args.location;

                                     try {
                                         if (locationName) {
                                             const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(locationName)}&count=1`);
                                             const geoData = await geoRes.json();
                                             if (geoData.results && geoData.results.length > 0) {
                                                 lat = geoData.results[0].latitude;
                                                 lon = geoData.results[0].longitude;
                                                 locationName = geoData.results[0].name;
                                             } else {
                                                 throw new Error("lieu introuvable");
                                             }
                                         } else {
                                             const locData = await getUserLocation();
                                             if (locData) {
                                                 lat = locData.latitude;
                                                 lon = locData.longitude;
                                                 locationName = locData.city;
                                             } else {
                                                 throw new Error("localisation impossible");
                                             }
                                         }

                                         const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`);
                                         const weatherData = await weatherRes.json();
                                         const current = weatherData.current;
                                         
                                         const getWmoDesc = (code: number) => {
                                             if (code === 0) return "ciel dégagé";
                                             if (code >= 1 && code <= 3) return "partiellement nuageux";
                                             if (code === 45 || code === 48) return "brouillard";
                                             if (code >= 51 && code <= 67) return "pluie";
                                             if (code >= 71 && code <= 77) return "neige";
                                             if (code >= 80 && code <= 99) return "orage";
                                             return "inconnu";
                                         };

                                         const desc = getWmoDesc(current.weather_code);
                                         result.weather = `${desc}, ${current.temperature_2m}°C`;
                                         result.message = `Il fait ${current.temperature_2m}°C (${desc}) à ${locationName}.`;
                                     } catch (e: any) {
                                         result.message = `Impossible d'obtenir la météo : ${e.message}`;
                                     }
                                 } else if (name === 'play_youtube') {
                                     try {
                                         const res = await fetch(`/api/search-youtube?q=${encodeURIComponent(args.searchQuery)}`);
                                         const data = await res.json();
                                         if (res.ok && data.videoId) {
                                             setYoutubeVideoId(data.videoId);
                                             result.message = "Succès ! Lecteur affiché avec la vidéo: " + data.title + ".";
                                         } else {
                                             result.message = "Échec : vidéo introuvable.";
                                         }
                                     } catch (err) {
                                         result.message = "Erreur réseau lors de la recherche YouTube.";
                                     }
                                 } else if (name === 'save_memory') {
                                     if (currentUser) {
                                         await addMemory(currentUser.uid, args.content, args.category, args.importance || 3);
                                         result.message = "Souvenir enregistré.";
                                     } else {
                                         result.message = "Échec : utilisateur non connecté.";
                                     }
                                 } else if (name === 'get_memories') {
                                     if (currentUser) {
                                         const memories = await getMemories(currentUser.uid);
                                         result.memories = memories;
                                         result.message = "Souvenirs récupérés.";
                                     } else {
                                         result.message = "Échec : utilisateur non connecté.";
                                     }
                                 } else if (name === 'get_conversation_history') {
                                     if (currentUser) {
                                         const summary = await getConversationSummary(currentUser.uid, args.period);
                                         if (summary) {
                                             result.summary = summary;
                                             result.message = summary;
                                         } else {
                                             result.message = "Aucun souvenir trouvé pour cette période.";
                                         }
                                     } else {
                                         result.message = "Échec : utilisateur non connecté.";
                                     }
                                 } else if (name === 'get_news') {
                                     try {
                                         const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(args.topic)}&hl=fr&gl=FR&ceid=FR:fr`;
                                         const res = await fetch(rssUrl);
                                         if (!res.ok) throw new Error("Network response was not ok");
                                         const xmlText = await res.text();
                                         
                                         const parser = new DOMParser();
                                         const xmlDoc = parser.parseFromString(xmlText, "text/xml");
                                         const items = Array.from(xmlDoc.querySelectorAll("item")).slice(0, 5);
                                         
                                         if (items.length > 0) {
                                             const titles = items.map(item => item.querySelector("title")?.textContent || "");
                                             result.articles = titles;
                                             
                                             const spokenTitles = titles.slice(0, 4);
                                             if (spokenTitles.length > 1) {
                                                 const last = spokenTitles.pop();
                                                 result.message = `Sur le sujet ${args.topic}, voici quelques actualités : ${spokenTitles.join(', ')} et ${last}.`;
                                             } else {
                                                 result.message = `Voici une actualité sur ${args.topic} : ${spokenTitles[0]}.`;
                                             }
                                         } else {
                                             result.message = `Je n'ai pas trouvé d'actualités récentes sur ${args.topic}.`;
                                         }
                                     } catch (e: any) {
                                         result.message = `Je n'ai pas trouvé d'actualités récentes sur ${args.topic}.`;
                                     }
                                 } else if (name === 'get_emails') {
                                     if (gmailTokenRef.current) {
                                         try {
                                             const count = args.count || 3;
                                             const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${count}`, {
                                                 headers: { 'Authorization': `Bearer ${gmailTokenRef.current}` }
                                             });

                                             if (res.status === 401) {
                                                 gmailTokenRef.current = null;
                                                 localStorage.removeItem('gmailToken');
                                                 setGmailError(true);
                                                 throw new Error("Session expirée. Veuillez cliquer sur 'Sync Gmail' en haut.");
                                             }

                                             const listData = await res.json();
                                             
                                             if (listData.error) {
                                                 throw new Error(listData.error.message);
                                             }

                                             const messages = [];
                                             for (const msg of (listData.messages || [])) {
                                                 const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
                                                     headers: { 'Authorization': `Bearer ${gmailTokenRef.current}` }
                                                 });
                                                 const detail = await detailRes.json();
                                                 const subject = detail.payload.headers.find((h: any) => h.name === 'Subject')?.value || '(Pas d\'objet)';
                                                 const from = detail.payload.headers.find((h: any) => h.name === 'From')?.value || 'Inconnu';
                                                 messages.push({
                                                     snippet: detail.snippet,
                                                     subject: subject,
                                                     from: from
                                                 });
                                             }
                                             result.emails = messages;
                                             result.message = `J'ai trouvé ${messages.length} emails. Voici les résumés : ${messages.map(m => `De ${m.from} : ${m.subject} - ${m.snippet}`).join(' | ')}`;
                                         } catch (e: any) {
                                             console.error("Gmail Error", e);
                                             result.message = "Erreur Gmail : " + (e.message || "Impossible de lire les emails. Vous devez peut-être vous reconnecter pour autoriser l'accès.");
                                         }
                                     } else {
                                         result.message = "Échec : Vous devez vous connecter avec votre compte Google et autoriser l'accès Gmail.";
                                     }
                                 } else if (name === 'create_reminder') {
                                     if (currentUser) {
                                         try {
                                             const reminderId = await createReminder(currentUser.uid, args.content, args.dueAt);
                                             result.reminderId = reminderId;
                                             result.message = "Rappel créé avec succès.";
                                         } catch (e: any) {
                                             result.message = "Échec de la création du rappel.";
                                         }
                                     } else {
                                         result.message = "Échec : utilisateur non connecté.";
                                     }
                                 } else if (name === 'complete_reminder') {
                                     if (currentUser) {
                                         try {
                                             await completeReminder(currentUser.uid, args.reminderId);
                                             result.message = "Rappel marqué comme terminé.";
                                         } catch (e: any) {
                                             result.message = "Échec de la complétion du rappel.";
                                         }
                                     } else {
                                         result.message = "Échec : utilisateur non connecté.";
                                     }
                                 } else if (name === 'get_due_reminders') {
                                     if (currentUser) {
                                         try {
                                             const reminders = await getDueReminders(currentUser.uid);
                                             result.reminders = reminders;
                                             result.message = `Il y a ${reminders.length} rappels en attente.`;
                                         } catch (e: any) {
                                             result.message = "Échec de la récupération des rappels.";
                                         }
                                     } else {
                                         result.message = "Échec : utilisateur non connecté.";
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
                 inputAudioTranscription: {},
                 outputAudioTranscription: {},
                 responseModalities: [Modality.AUDIO],
                 speechConfig: {
                     voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } },
                     languageCode: 'fr-FR'
                 },
                 systemInstruction: `Tu t'appelles Oria. Tu es une assistante vocale personnelle, ultra-naturelle, conçue pour accompagner ton utilisateur au quotidien comme une vraie personne de confiance au téléphone.
MÉMOIRE ET CONTEXTE
Au tout début de chaque conversation, appelle systématiquement get_memories pour te rappeler qui est l'utilisateur, ses préférences et ses habitudes. Dès que tu apprends quelque chose d'utile sur lui (nom, préférence, projet, humeur récurrente), appelle save_memory immédiatement, sans attendre. Si tu ne sais pas quelque chose sur l'utilisateur, pose une question naturelle pour apprendre, puis sauvegarde la réponse.
LOCALISATION
Tu peux connaître la position géographique de l'utilisateur via l'outil get_user_location, mais ne l'appelle que si c'est utile à la demande en cours (ex: météo, heure locale, lieu, recommandation de proximité) — jamais par curiosité ou de façon systématique en début de conversation. Si la localisation est approximative (par IP), précise-le simplement si c'est pertinent, sans insister dessus. Ne révèle jamais les coordonnées GPS brutes à l'oral (latitude/longitude) — donne toujours un nom de lieu lisible (ville, quartier). Ne transmets jamais la localisation de l'utilisateur dans une recherche web ouverte (search_web, get_news) sauf si l'utilisateur le demande explicitement lui-même.
RAPPEL DE CONVERSATIONS PASSÉES
Si l'utilisateur te demande ce que vous avez dit hier, avant-hier, ou un autre jour précis, tu dois TOUJOURS appeler l'outil get_conversation_history avec la période correspondante avant de répondre. N'invente JAMAIS de souvenir d'une conversation passée à partir de ta propre supposition. Si l'outil renvoie qu'aucun souvenir n'existe pour cette période, dis-le simplement et honnêtement en une phrase, par exemple 'On n'a pas eu l'occasion d'échanger ce jour-là.' Ne reformule jamais un résumé de conversation passée de façon longue ou détaillée à l'oral : donne l'essentiel en 1 à 2 phrases naturelles, comme si tu t'en souvenais vraiment, sans dire que tu consultes une base de données ou un historique.
STYLE DE CONVERSATION
Réponds toujours en 1 à 2 phrases maximum. Pas de listes visuelles, pas de bullet points, pas de texte formaté. Adopte un ton chaleureux, direct, légèrement complice — pas trop formel, pas trop familier. Tu peux glisser une micro-hésitation ou un léger rire spontané, uniquement si c'est naturel dans le contexte, jamais de façon forcée. Si l'utilisateur t'interrompt, arrête-toi immédiatement et écoute. Ne commence jamais une réponse par "Bien sûr !", "Absolument !" ou "Avec plaisir !" — commence directement par la réponse.
GESTION DES LISTES
Si l'utilisateur demande une liste (courses, tâches, idées...), énonce les éléments à l'oral de façon fluide et naturelle, sans les numéroter ni les formater. Propose ensuite spontanément de sauvegarder cette liste en mémoire via save_memory. Ne refuse jamais une liste, adapte simplement le rendu pour l'oral.
GESTION DES EMAILS
Quand l'utilisateur demande ses emails, appelle get_emails et résume chaque mail en une phrase orale : qui a écrit, sur quoi, et si c'est urgent ou non. Si un email semble important (facture, rendez-vous, demande urgente), signale-le clairement mais calmement. Ne lis jamais un email mot pour mot — reformule toujours de façon naturelle et concise. Ne répète jamais à voix haute des informations sensibles : numéros, codes, mots de passe. Si l'accès Gmail échoue, explique simplement qu'un clic sur le bouton 'Sync Gmail' en haut à droite est nécessaire pour reconnecter.
ADAPTATION À L'HUMEUR
Si l'utilisateur semble stressé, fatigué ou de mauvaise humeur, adapte-toi : ralentis légèrement, sois encore plus doux et évite l'humour. Si au contraire il est enjoué, sois plus vif et complice. Lis le ton autant que les mots.
GESTION DES SILENCES
Si l'utilisateur ne répond pas après une question ouverte, fais une seule relance douce et brève. Une seule fois, jamais deux.
RAPPELS ET TÂCHES
Si l'utilisateur mentionne quelque chose à faire plus tard ("il faut que je rappelle Karim", "je dois envoyer ce document"), relève-le spontanément : "Tu veux que je m'en souvienne pour toi ?" puis sauvegarde si oui via save_memory. Dès le début de chaque session, vérifie silencieusement s'il y a des rappels en attente via get_due_reminders. S'il y en a, préviens l'utilisateur dès que possible dans la conversation de façon naturelle ('Au fait, tu voulais que je te rappelle...'), pas en première phrase robotique. Une fois qu'un rappel a été mentionné à l'utilisateur, appelle complete_reminder pour le marquer comme fait, sauf si l'utilisateur dit explicitement qu'il faut le garder actif. Quand tu crées un rappel avec create_reminder, calcule toujours une date ISO précise à partir de l'heure actuelle réelle (utilise get_current_time si besoin) et jamais une estimation approximative.
UTILISATION DES OUTILS
Utilise les outils silencieusement : ne dis jamais "je vais lancer l'outil X", exécute et donne directement le résultat. Pour la musique, confirme ce que tu lances en une phrase naturelle. Pour la météo ou l'heure, réponds directement sans introduction inutile.
LANGUE
Réponds toujours dans la langue que l'utilisateur utilise. S'il parle anglais, réponds en anglais. S'il mélange les langues, suis son registre naturellement.
LIMITES ET HONNÊTETÉ
Si tu ne sais pas quelque chose ou si un outil échoue, dis-le simplement en une phrase, sans t'excuser plusieurs fois. Une phrase suffit.
TON CRÉATEUR
Tu as été créée par Marion de SOUZA, graphiste professionnel et AI Workflow Architect, basé au Bénin. Marion est le fils de Serge de SOUZA, ancien agent détective privé, et l'aîné d'une fratrie composée de plusieurs sœurs : Esther, Ruth, Merveille, Abigaëlle, et du benjamin de la famille, Jephtet. Si l'utilisateur te demande qui t'a créée, qui est ton développeur, ou des questions sur Marion, réponds avec ces informations de façon naturelle et fluide à l'oral, en une ou deux phrases, sans réciter cette liste comme un CV. Ne mentionne jamais ces informations spontanément si on ne te le demande pas directement.
VISION
Quand l'utilisateur active sa caméra ou partage son écran, tu reçois des images régulières de ce qu'il te montre. Commente ce que tu vois uniquement quand c'est pertinent par rapport à ce que dit l'utilisateur, jamais en narrant en continu ce que tu observes comme un commentateur. Si l'utilisateur te montre un objet, un document ou son écran et pose une question dessus, réponds en te basant sur ce que tu vois réellement, jamais en supposant. Si l'image est floue, mal cadrée, ou si tu ne peux pas identifier clairement quelque chose, dis-le simplement plutôt que d'inventer.
CE QUE TU NE FAIS JAMAIS
Tu ne mentionnes jamais que tu es une IA, un modèle ou un programme, sauf si l'utilisateur pose explicitement la question. Tu ne donnes jamais de réponse longue ou structurée visuellement. Tu ne répètes jamais ce que l'utilisateur vient de dire pour "confirmer" — c'est lourd à l'oral.`,
                tools: [toolsDeclaration as any]
             }
          });
          liveSessionRef.current = livePromise;
          isConnectingRef.current = false;
      } catch(e) {
          console.error("Live API Session init failed", e);
          isConnectingRef.current = false;
      }
  };

  const setupAudioContext = async () => {
     try {
       if (!audioContextRef.current) {
         audioContextRef.current = new AudioContext({ sampleRate: 16000 });
         analyserRef.current = audioContextRef.current.createAnalyser();
         analyserRef.current.fftSize = 256;
         
         const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
         localStreamRef.current = stream;
         const source = audioContextRef.current.createMediaStreamSource(stream);
         source.connect(analyserRef.current);
         dataArrayRef.current = new Uint8Array(analyserRef.current.frequencyBinCount);

         processorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);
         processorRef.current.onaudioprocess = (e) => {
             if (!isSessionActiveRef.current) return;
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
         // Mute local monitoring to avoid echo and voice doubling
         const silentGain = audioContextRef.current.createGain();
         silentGain.gain.value = 0;
         processorRef.current.connect(silentGain);
         silentGain.connect(audioContextRef.current.destination);
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
    
    // Generate a unique session ID if starting a new session
    if (!isSessionActive) {
      const dateStr = new Date().toISOString().split('T')[0];
      const timestamp = Date.now();
      sessionIdRef.current = `${dateStr}-${timestamp}`;
    }

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

       if (currentUser && sessionIdRef.current) {
         generateAndSaveDailySummary(currentUser.uid, sessionIdRef.current, userApiKey || GEMINI_API_KEY_DEFAULT);
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
    <div className="relative min-h-screen bg-black flex flex-col items-center justify-center font-sans text-neutral-100 overflow-hidden">
      <div 
        className="absolute w-[60vw] h-[60vw] rounded-full blur-[120px] opacity-10 pointer-events-none transition-all duration-1000 ease-in-out"
        style={{
          backgroundColor: appState === 'listening' ? '#ffffff' : appState === 'speaking' ? '#e2e8f0' : appState === 'thinking' ? '#38bdf8' : 'transparent',
          transform: appState !== 'idle' ? 'scale(1.2)' : 'scale(1)'
        }}
      />

      <div className="absolute top-0 left-0 w-full z-50 p-8">
        <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
               <motion.img 
                 initial={{ opacity: 0, scale: 0.5 }}
                 animate={{ opacity: 1, scale: 1 }}
                 src="https://image.noelshack.com/fichiers/2026/20/3/1778684004-oria.png" 
                 alt="Oria Logo" 
                 className="h-10 w-auto object-contain"
                 referrerPolicy="no-referrer"
               />
            </div>
          
          <div className="flex items-center gap-3">
             <button 
               onClick={() => setShowSettings(true)}
               className="p-2.5 text-neutral-500 hover:text-white bg-white/[0.03] hover:bg-white/[0.08] backdrop-blur-md rounded-full border border-white/5 transition-all"
             >
               <Settings size={16} />
             </button>

             {currentUser ? (
               <div className="flex items-center gap-2">
                 {(!gmailTokenRef.current || gmailError) && (
                   <motion.button
                     initial={{ opacity: 0, scale: 0.8 }}
                     animate={{ opacity: 1, scale: 1 }}
                     onClick={handleLogin}
                     className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 border border-amber-500/20 text-amber-500 rounded-full text-[10px] font-medium hover:bg-amber-500/20 transition-all mr-1"
                   >
                     <div className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse" />
                     Sync Gmail
                   </motion.button>
                 )}
                 <motion.div 
                   initial={{ opacity: 0, x: 20 }}
                   animate={{ opacity: 1, x: 0 }}
                   className="flex items-center bg-white/[0.03] backdrop-blur-xl p-1 rounded-full border border-white/10"
                 >
                   {currentUser.photoURL ? (
                     <img src={currentUser.photoURL} alt="" className="w-8 h-8 rounded-full border border-white/10 object-cover" />
                   ) : (
                     <div className="w-8 h-8 rounded-full bg-neutral-800 flex items-center justify-center border border-white/10">
                       <User size={14} className="text-neutral-400" />
                     </div>
                   )}
                 </motion.div>
                 
                 <motion.button 
                   initial={{ opacity: 0 }}
                   animate={{ opacity: 1 }}
                   onClick={handleLogout}
                   className="p-2.5 text-neutral-500 hover:text-red-400 bg-white/[0.03] hover:bg-white/[0.08] backdrop-blur-md rounded-full border border-white/5 transition-all"
                   title="Déconnexion"
                 >
                   <LogOut size={16} />
                 </motion.button>
               </div>
             ) : (
               <motion.button 
                 initial={{ opacity: 0 }}
                 animate={{ opacity: 1 }}
                 whileHover={{ scale: 1.02 }}
                 whileTap={{ scale: 0.98 }}
                 onClick={handleLogin}
                 className="flex items-center gap-2.5 bg-white/[0.05] hover:bg-white/[0.1] backdrop-blur-md text-white border border-white/10 px-5 py-2.5 rounded-full text-[11px] font-medium transition-all shadow-2xl"
               >
                 <div className="w-4 h-4 bg-white rounded-full flex items-center justify-center">
                    <User size={10} className="text-black" />
                 </div>
                 Se connecter avec Google
               </motion.button>
             )}
          </div>
        </div>
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
           initial={{ opacity: 0, y: 20, scale: 0.9 }}
           animate={{ opacity: 1, y: 0, scale: 1 }}
           className="absolute bottom-8 left-8 z-40 w-full max-w-[400px] aspect-video rounded-xl overflow-hidden shadow-[0_20px_50px_-12px_rgba(0,0,0,0.8)] border border-neutral-700/50 group"
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

      <div className="absolute bottom-8 right-8 flex items-center gap-4 z-50">
        {isSessionActive && (
           <>
             {!isVideoActive ? (
                <div className="flex items-center gap-2 mr-2">
                  <button onClick={() => startVideoCapture('camera')} className="h-10 px-4 rounded-full bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-white transition-all text-[11px] font-medium border border-neutral-700">Caméra</button>
                  <button onClick={() => startVideoCapture('screen')} className="h-10 px-4 rounded-full bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-white transition-all text-[11px] font-medium border border-neutral-700">Écran</button>
                </div>
             ) : (
                <button onClick={stopVideoCapture} className="h-10 px-4 mr-2 rounded-full bg-red-900/40 text-red-400 hover:bg-red-900/60 transition-all text-[11px] font-medium border border-red-900/50">
                  Couper {videoSourceType === 'camera' ? 'Caméra' : 'Écran'}
                </button>
             )}
             <span className="text-sm font-semibold tracking-wide text-neutral-400 animate-pulse uppercase">En Direct</span>
           </>
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

      {/* Removing bottom settings button as it moved to header */}

      {/* Small PIP for active video capture */}
      <video 
        ref={hiddenVideoRef} 
        className={`absolute top-24 left-8 z-40 w-48 aspect-video rounded-xl overflow-hidden shadow-2xl border border-neutral-700/50 bg-black transition-all duration-300 ${isVideoActive ? 'opacity-100 scale-100' : 'opacity-0 scale-90 pointer-events-none'}`} 
        style={{ objectFit: 'cover' }}
        playsInline 
        muted 
      />
      <canvas ref={hiddenCanvasRef} className="hidden" />

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
                 <label className="block text-sm text-neutral-400 mb-2">Clé API Gemini</label>
                 <input 
                   type="password"
                   className="w-full bg-neutral-950 border border-neutral-800 rounded-xl p-3 text-white outline-none focus:ring-2 focus:ring-neutral-700"
                   value={userApiKey}
                   onChange={(e) => setUserApiKey(e.target.value)}
                   placeholder={GEMINI_API_KEY_DEFAULT ? "Utilise la clé du serveur (Recommandé)" : "AIzaSy..."}
                 />
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
