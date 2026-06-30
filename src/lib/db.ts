import { 
  collection, 
  doc, 
  getDoc, 
  setDoc, 
  addDoc, 
  query, 
  orderBy,
  getDocs, 
  serverTimestamp,
  type FieldValue
} from 'firebase/firestore';
import { db, auth } from './firebase';
import { GoogleGenAI } from '@google/genai';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function getUserProfile(userId: string) {
  const path = `users/${userId}`;
  try {
    const snap = await getDoc(doc(db, path));
    return snap.exists() ? snap.data() : null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function saveUserProfile(userId: string, data: any) {
  const path = `users/${userId}`;
  try {
    await setDoc(doc(db, path), {
      ...data,
      updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function addMemory(userId: string, content: string, category: string, importance: number = 3) {
  const path = `users/${userId}/memories`;
  try {
    await addDoc(collection(db, path), {
      content,
      category,
      importance,
      createdAt: serverTimestamp()
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function addConversationMessage(userId: string, sessionId: string, role: 'user' | 'assistant', content: string) {
  const path = `users/${userId}/conversations/${sessionId}/messages`;
  try {
    await addDoc(collection(db, path), {
      role,
      content,
      createdAt: serverTimestamp()
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function getMemories(userId: string) {
  const path = `users/${userId}/memories`;
  try {
    const q = query(collection(db, path));
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data());
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function generateAndSaveDailySummary(userId: string, sessionId: string, apiKey: string) {
  const messagesPath = `users/${userId}/conversations/${sessionId}/messages`;
  try {
    const q = query(collection(db, messagesPath), orderBy('createdAt', 'asc'));
    const snapshot = await getDocs(q);
    
    if (snapshot.empty) return;
    
    const conversationText = snapshot.docs.map(doc => {
      const data = doc.data();
      return `${data.role}: ${data.content}`;
    }).join('\n');

    const ai = new GoogleGenAI({ apiKey });
    const prompt = `Résume factuellement cette conversation en 3 à 5 phrases courtes, en français, sans interprétation ni ajout d'informations qui n'y figurent pas explicitement, en citant les faits concrets (sujets abordés, décisions, infos personnelles mentionnées, tâches à faire) :\n\n${conversationText}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash',
      contents: prompt,
    });
    
    const summary = response.text;
    if (!summary) return;

    let date = new Date().toISOString().split('T')[0];
    const dateMatch = sessionId.match(/^(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
        date = dateMatch[1];
    }

    const summaryPath = `users/${userId}/daily_summaries/${date}`;
    await setDoc(doc(db, summaryPath), {
      summary,
      sessionId,
      createdAt: serverTimestamp()
    }, { merge: true });

  } catch (error) {
    console.error("Error generating daily summary:", error);
    // Let it fail silently to avoid breaking the UI flow
  }
}

export async function getConversationSummary(userId: string, period: string) {
  let targetDateStr = period;

  const today = new Date();
  
  if (period === 'today') {
    targetDateStr = today.toISOString().split('T')[0];
  } else if (period === 'yesterday') {
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    targetDateStr = yesterday.toISOString().split('T')[0];
  } else if (period === 'day_before_yesterday') {
    const dayBeforeYesterday = new Date(today);
    dayBeforeYesterday.setDate(today.getDate() - 2);
    targetDateStr = dayBeforeYesterday.toISOString().split('T')[0];
  }

  const path = `users/${userId}/daily_summaries/${targetDateStr}`;
  try {
    const snap = await getDoc(doc(db, path));
    if (snap.exists()) {
      return snap.data().summary as string;
    }
    return null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
    return null;
  }
}
