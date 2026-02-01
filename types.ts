
export interface Task {
  id: string;
  name: string;
  organization: string;
  subject: string;
  phoneNumber: string;
  status: 'open' | 'bezig' | 'voltooid';
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

// Added missing ChatMessage interface
export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  timestamp: Date;
}
