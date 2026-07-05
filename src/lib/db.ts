import { 
  collection, 
  doc, 
  getDoc, 
  setDoc, 
  addDoc, 
  updateDoc,
  deleteDoc,
  query, 
  orderBy,
  where,
  limit,
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

export async function createReminder(userId: string, content: string, dueAt: string) {
  const path = `users/${userId}/reminders`;
  try {
    const remindersRef = collection(db, path);
    const docRef = await addDoc(remindersRef, {
      content,
      dueAt,
      done: false,
      createdAt: serverTimestamp()
    });
    return docRef.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
    throw error;
  }
}

export async function getDueReminders(userId: string) {
  const path = `users/${userId}/reminders`;
  try {
    const remindersRef = collection(db, path);
    const q = query(remindersRef, where("done", "==", false));
    const querySnapshot = await getDocs(q);
    const nowStr = new Date().toISOString();
    
    let dueReminders: { id: string; content: string; dueAt: string; done: boolean }[] = [];
    querySnapshot.forEach((doc) => {
      const data = doc.data();
      if (data.dueAt <= nowStr) {
        dueReminders.push({ id: doc.id, content: data.content, dueAt: data.dueAt, done: data.done });
      }
    });
    
    dueReminders.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    return dueReminders;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
    return [];
  }
}

export async function completeReminder(userId: string, reminderId: string) {
  const path = `users/${userId}/reminders/${reminderId}`;
  try {
    await updateDoc(doc(db, path), {
      done: true,
      updatedAt: serverTimestamp()
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
    throw error;
  }
}

export async function createNote(userId: string, content: string, tags?: string[]) {
  const path = `users/${userId}/notes`;
  try {
    const docRef = await addDoc(collection(db, path), {
      content,
      tags: tags || [],
      createdAt: serverTimestamp()
    });
    return docRef.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
    throw error;
  }
}

export async function getNotes(userId: string, searchQuery?: string) {
  const path = `users/${userId}/notes`;
  try {
    const notesRef = collection(db, path);
    const q = query(notesRef, orderBy('createdAt', 'desc'), limit(20));
    const querySnapshot = await getDocs(q);
    
    let notes: any[] = [];
    querySnapshot.forEach((doc) => {
      notes.push({ noteId: doc.id, ...doc.data() });
    });
    
    if (searchQuery) {
      const sq = searchQuery.toLowerCase();
      notes = notes.filter(n => typeof n.content === 'string' && n.content.toLowerCase().includes(sq));
    }
    
    return notes;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
    return [];
  }
}

export async function deleteNote(userId: string, noteId: string) {
  const path = `users/${userId}/notes/${noteId}`;
  try {
    await deleteDoc(doc(db, path));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
    throw error;
  }
}

export async function saveProject(userId: string, name: string, status: string, lastAction: string, nextSteps?: string) {
  const slug = name.toLowerCase().replace(/\s+/g, '-');
  const path = `users/${userId}/projects/${slug}`;
  try {
    await setDoc(doc(db, path), {
      name,
      status,
      lastAction,
      ...(nextSteps ? { nextSteps } : {}),
      updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
    throw error;
  }
}

export async function getProjects(userId: string) {
  const path = `users/${userId}/projects`;
  try {
    const projectsRef = collection(db, path);
    const q = query(projectsRef, where('status', '!=', 'terminé'), orderBy('status'), orderBy('updatedAt', 'desc'));
    const querySnapshot = await getDocs(q);
    
    const projects: any[] = [];
    querySnapshot.forEach((doc) => {
      projects.push({ id: doc.id, ...doc.data() });
    });
    return projects;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
    return [];
  }
}

export async function getProject(userId: string, name: string) {
  const path = `users/${userId}/projects`;
  try {
    const projectsRef = collection(db, path);
    const querySnapshot = await getDocs(projectsRef);
    const searchName = name.toLowerCase();
    
    let project = null;
    querySnapshot.forEach((doc) => {
      const data = doc.data();
      if (data.name && data.name.toLowerCase() === searchName) {
        project = { id: doc.id, ...data };
      }
    });
    return project;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
    return null;
  }
}
