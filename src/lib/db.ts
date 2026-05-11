import { 
  collection, 
  doc, 
  getDoc, 
  setDoc, 
  addDoc, 
  query, 
  where, 
  getDocs, 
  serverTimestamp,
  type FieldValue
} from 'firebase/firestore';
import { db, auth } from './firebase';

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
