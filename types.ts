
export interface Task {
  id: string;
  omschrijving: string;
  telefoonnummer?: string;
  notitie: string;
  status: 'open' | 'bezig' | 'voltooid';
}

export interface GroundingSource {
  title?: string;
  uri?: string;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  timestamp: Date;
}

export interface AppState {
  isActive: boolean;
  status: 'idle' | 'connecting' | 'active' | 'error';
  userText: string;
  aiText: string;
  location: { lat: number; lng: number } | null;
  tasks: Task[];
  activeTaskId: string | null;
}
